/** Builds the module, directory and class graphs, and finds structural problems. */
import { dirname } from 'node:path/posix';
import { overLimit } from '../ast/analyze.ts';
import type { Config } from '../config.ts';
import type {
  ArchitectureEdge,
  ArchitectureFinding,
  ArchitectureReport,
  AstFinding,
  ClassNode,
  DirectoryNode,
  ModuleNode,
} from '../types.ts';
import type { ClassOutline, ModuleOutline } from './extract.ts';
import { cyclicNodes, type Dependencies, layersOf, stronglyConnected } from './graph.ts';

type Limits = Omit<Config['architecture'], 'dir'>;

/** A file outline whose imports are resolved to repository paths. */
export type ResolvedOutline = Omit<ModuleOutline, 'imports'> & { imports: string[] };

/** Everything the AST can tell about a repository's structure. */
export interface Structure extends Pick<ArchitectureReport, 'modules' | 'classes' | 'edges'> {
  directories: DirectoryNode[];
  findings: ArchitectureFinding[];
}

interface Analysis {
  layers: Map<string, number>;
  cycles: Map<string, string[]>;
}

function analyze(nodes: string[], dependencies: Dependencies): Analysis {
  const components = stronglyConnected(nodes, dependencies);
  return { layers: layersOf(components, dependencies), cycles: cyclicNodes(components) };
}

const inSameCycle = ({ cycles }: Analysis, from: string, to: string) =>
  cycles.get(from)?.includes(to) ?? false;

const uniqueCycles = ({ cycles }: Analysis) => [...new Set(cycles.values())];

function addDependency(dependencies: Dependencies, from: string, to: string): void {
  dependencies.set(from, (dependencies.get(from) ?? new Set()).add(to));
}

function locate(finding: AstFinding, path: string, directories: string[]): ArchitectureFinding {
  return { ...finding, path, directories: [...new Set(directories)] };
}

function moduleGraph(files: ResolvedOutline[], limits: Limits) {
  const dependencies: Dependencies = new Map(
    files.map(({ path, imports }) => [path, new Set(imports)]),
  );
  const analysis = analyze(
    files.map(({ path }) => path),
    dependencies,
  );
  const fanIn = new Map<string, number>();
  for (const { imports } of files) {
    for (const target of imports) fanIn.set(target, (fanIn.get(target) ?? 0) + 1);
  }
  const modules: ModuleNode[] = files.map(({ path, language, lines, imports, symbols }) => ({
    path,
    directory: dirname(path),
    language,
    lines,
    layer: analysis.layers.get(path) ?? 0,
    fanIn: fanIn.get(path) ?? 0,
    fanOut: imports.length,
    symbols,
  }));
  const edges = files.flatMap(({ path: from, imports }) =>
    imports.map((to) => ({ from, to, weight: 1, cyclic: inSameCycle(analysis, from, to) })),
  );
  const cycleFindings = uniqueCycles(analysis).flatMap((cycle) =>
    overLimit([['dependency-cycle', 'modules in a cycle', cycle.length, 1]], {
      line: 1,
      symbol: cycle.join(', '),
    }).map((finding) =>
      locate(
        finding,
        cycle[0] as string,
        cycle.map((path) => dirname(path)),
      ),
    ),
  );
  const moduleFindings = modules.flatMap(({ path, directory, fanIn, fanOut }) =>
    overLimit(
      [
        ['fan-out', 'imports', fanOut, limits.max_fan_out],
        // A hub both uses and serves many modules, so a change there ripples both ways.
        ['hub', 'links both ways', Math.min(fanIn, fanOut), limits.max_hub_links],
      ],
      { line: 1 },
    ).map((finding) => locate(finding, path, [directory])),
  );
  return { modules, edges, findings: [...cycleFindings, ...moduleFindings] };
}

const isNested = (a: string, b: string) =>
  a === '.' || b === '.' || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

function directoryGraph(modules: ModuleNode[], moduleEdges: ArchitectureEdge[], limits: Limits) {
  const directoryOf = new Map(modules.map(({ path, directory }) => [path, directory]));
  const weights = new Map<string, { from: string; to: string; weight: number }>();
  for (const edge of moduleEdges) {
    const from = directoryOf.get(edge.from) as string;
    const to = directoryOf.get(edge.to) as string;
    if (from === to) continue;
    const key = `${from}\0${to}`;
    const weight = (weights.get(key)?.weight ?? 0) + 1;
    weights.set(key, { from, to, weight });
  }
  const links = [...weights.values()];
  // A folder and its own subfolder are one unit, so links between them are not a cycle.
  const dependencies: Dependencies = new Map();
  for (const { from, to } of links) {
    if (!isNested(from, to)) addDependency(dependencies, from, to);
  }
  const paths = [...new Set(directoryOf.values())].sort();
  const analysis = analyze(paths, dependencies);
  const directories = paths.map((path) => {
    const members = modules.filter(({ directory }) => directory === path);
    return {
      path,
      files: members.length,
      lines: members.reduce((sum, { lines }) => sum + lines, 0),
      layer: analysis.layers.get(path) ?? 0,
    };
  });
  const cycleFindings = uniqueCycles(analysis).flatMap((cycle) =>
    overLimit([['directory-cycle', 'directories in a cycle', cycle.length, 1]], {
      line: 1,
      symbol: cycle.join(', '),
    }).map((finding) => locate(finding, cycle[0] as string, cycle)),
  );
  const sizeFindings = directories.flatMap(({ path, files }) =>
    overLimit([['directory-files', 'files', files, limits.max_directory_files]], { line: 1 }).map(
      (finding) => locate(finding, path, [path]),
    ),
  );
  return {
    directories,
    edges: links.map((link) => ({
      ...link,
      cyclic: inSameCycle(analysis, link.from, link.to),
    })),
    findings: [...cycleFindings, ...sizeFindings],
  };
}

const classId = (path: string, name: string) => `${path}#${name}`;

/** shortcut: a name declared twice is ambiguous and links nothing; resolve via imports if needed. */
function uniqueClassIds(files: ResolvedOutline[]): Map<string, string> {
  const owners = new Map<string, string[]>();
  for (const { path, classes } of files) {
    for (const { name } of classes) {
      owners.set(name, [...(owners.get(name) ?? []), classId(path, name)]);
    }
  }
  return new Map(
    [...owners].flatMap(([name, ids]) => (ids.length === 1 ? [[name, ids[0] as string]] : [])),
  );
}

function classLinks(id: string, { bases, references }: ClassOutline, ids: Map<string, string>) {
  const linked = (names: string[]) => names.flatMap((name) => ids.get(name) ?? []);
  const parents = linked(bases).filter((parent) => parent !== id);
  const used = linked(references).filter((target) => target !== id && !parents.includes(target));
  return { parents, used };
}

function classGraph(files: ResolvedOutline[], limits: Limits) {
  const ids = uniqueClassIds(files);
  const owned = files.flatMap(({ path, classes }) =>
    classes.map((outline) => {
      const id = classId(path, outline.name);
      return { id, path, outline, ...classLinks(id, outline, ids) };
    }),
  );
  const inheritance: Dependencies = new Map(owned.map(({ id, parents }) => [id, new Set(parents)]));
  const depth = analyze(
    owned.map(({ id }) => id),
    inheritance,
  ).layers;
  const references: Dependencies = new Map(
    owned.map(({ id, parents, used }) => [id, new Set([...parents, ...used])]),
  );
  const analysis = analyze(
    owned.map(({ id }) => id),
    references,
  );
  const classes: ClassNode[] = owned.map(({ id, path, outline }) => ({
    id,
    name: outline.name,
    path,
    line: outline.line,
    lines: outline.lines,
    methods: outline.methods,
    layer: analysis.layers.get(id) ?? 0,
  }));
  const edgeTo = (from: string, kind: 'inherits' | 'uses') => (to: string) => ({
    from,
    to,
    weight: 1,
    kind,
    cyclic: inSameCycle(analysis, from, to),
  });
  const edges: ArchitectureEdge[] = owned.flatMap(({ id, parents, used }) => [
    ...parents.map(edgeTo(id, 'inherits')),
    ...used.map(edgeTo(id, 'uses')),
  ]);
  const findings = classes.flatMap(({ id, name, path, line, lines, methods }) =>
    overLimit(
      [
        ['class-methods', 'methods', methods.length, limits.max_class_methods],
        ['class-lines', 'class length', lines, limits.max_class_lines],
        [
          'inheritance-depth',
          'inheritance depth',
          depth.get(id) ?? 0,
          limits.max_inheritance_depth,
        ],
      ],
      { line, symbol: name },
    ).map((finding) => locate(finding, path, [dirname(path)])),
  );
  return { classes, edges, findings };
}

/** Builds every graph and lists what is wrong with them. */
export function buildStructure(files: ResolvedOutline[], limits: Limits): Structure {
  const modules = moduleGraph(files, limits);
  const directories = directoryGraph(modules.modules, modules.edges, limits);
  const classes = classGraph(files, limits);
  return {
    directories: directories.directories,
    modules: modules.modules,
    classes: classes.classes,
    edges: {
      directories: directories.edges,
      modules: modules.edges,
      classes: classes.edges,
    },
    findings: [...modules.findings, ...directories.findings, ...classes.findings],
  };
}
