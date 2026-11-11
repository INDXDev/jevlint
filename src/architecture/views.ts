/**
 * Checks the views and chapters of the SSOT against the code: whether each drawn arrow has an
 * import behind it, whether cited files and lines exist, and which chapters cite changed files.
 * Pure: the pipeline supplies the modules and file lookups.
 */
import { posix } from 'node:path';
import type {
  ArchitectureChapter,
  ArchitectureSsot,
  DriftItem,
  Evidence,
  FactModule,
  GraphView,
  ViewNode,
} from '../types.ts';
import { assign } from './conformance.ts';
import { matchesPackage } from './externals.ts';

/** Whether an arrow has an import behind it, in its direction. */
export type EdgeSupport = 'supported' | 'reversed' | 'unsupported' | 'unchecked';

/** One arrow's support, with the import that shows it. */
export interface EdgeCheck {
  support: EdgeSupport;
  evidence?: Evidence;
}

/** What checking needs from the code. */
export interface DocumentInput {
  modules: FactModule[];
  /** Whether a root-relative path exists. */
  exists: (path: string) => boolean;
  /** How many lines a root-relative file has, or undefined when it cannot be read. */
  lineCount: (path: string) => number | undefined;
}

const covers = (pattern: string, path: string) =>
  path === pattern ||
  path.startsWith(`${pattern.replace(/\/$/, '')}/`) ||
  posix.matchesGlob(path, pattern);

/** The files a node stands for, or null when it stands for none, as an actor does. */
function filesOf(
  node: ViewNode,
  ssot: ArchitectureSsot,
  modules: FactModule[],
): Set<string> | null {
  if (node.path)
    return new Set(
      modules.filter(({ path }) => covers(node.path as string, path)).map(({ path }) => path),
    );
  if (node.component) {
    const { componentOf } = assign(ssot);
    return new Set(
      modules.filter(({ path }) => componentOf(path) === node.component).map(({ path }) => path),
    );
  }
  return null;
}

function importBetween(
  modules: FactModule[],
  from: Set<string>,
  to: Set<string>,
): Evidence | undefined {
  for (const module of modules) {
    if (!from.has(module.path)) continue;
    const found = module.imports.find((target) => to.has(target.path));
    if (found) return { path: module.path, line: found.line, target: found.path };
  }
  return undefined;
}

function packageImport(
  modules: FactModule[],
  from: Set<string>,
  packages: string[],
): Evidence | undefined {
  for (const module of modules) {
    if (!from.has(module.path)) continue;
    const found = module.externals.find((external) =>
      packages.some((pattern) => matchesPackage(pattern, external.package)),
    );
    if (found) return { path: module.path, line: found.line, target: found.package };
  }
  return undefined;
}

/** Checks every arrow of a graph view: the caller's files must import the callee's. */
export function checkEdges(
  view: GraphView,
  ssot: ArchitectureSsot,
  modules: FactModule[],
): EdgeCheck[] {
  const nodes = new Map(view.nodes.map((node) => [node.id, node]));
  const files = new Map(view.nodes.map((node) => [node.id, filesOf(node, ssot, modules)]));
  return view.edges.map(({ from, to }): EdgeCheck => {
    const [source, target] = [files.get(from), files.get(to)];
    const packages = nodes.get(to)?.packages;
    if (source && packages) {
      const evidence = packageImport(modules, source, packages);
      return evidence ? { support: 'supported', evidence } : { support: 'unsupported' };
    }
    if (!source || !target || source.size === 0 || target.size === 0)
      return { support: 'unchecked' };
    const evidence = importBetween(modules, source, target);
    if (evidence) return { support: 'supported', evidence };
    const back = importBetween(modules, target, source);
    return back ? { support: 'reversed', evidence: back } : { support: 'unsupported' };
  });
}

/** A citation: `path`, `path:12`, `path:12-30` or `commit:<hash>`. */
export interface Citation {
  path?: string;
  line?: number;
  end?: number;
  commit?: string;
}

/** Parses a citation, or returns null when it is neither a path nor a commit. */
export function parseCitation(text: string): Citation | null {
  const commit = text.match(/^commit:([0-9a-f]{7,40})$/);
  if (commit) return { commit: commit[1] };
  const match = text.match(/^([\w.@/+-]+?)(?::(\d+)(?:-(\d+))?)?$/);
  if (!match || match[1]?.includes('..') || match[1]?.startsWith('/')) return null;
  return {
    path: match[1],
    ...(match[2] ? { line: Number(match[2]) } : {}),
    ...(match[3] ? { end: Number(match[3]) } : {}),
  };
}

/** Backticked `path:line` references in a chapter's text, which must point at real lines. */
/** Only references with a line are checked: a bare path may name a file made at run time. */
const INLINE_REFERENCE = /`([\w.@+-]+(?:\/[\w.@+-]+)+\.\w+:\d+(?:-\d+)?)`/g;

function citationProblem(citation: Citation, input: DocumentInput): string | null {
  if (!citation.path) return null;
  if (!input.exists(citation.path)) return `${citation.path} does not exist`;
  const last = citation.end ?? citation.line;
  if (last === undefined) return null;
  const lines = input.lineCount(citation.path);
  return lines !== undefined && last > lines
    ? `${citation.path} has only ${lines} lines, not ${last}`
    : null;
}

function chapterProblems(
  chapter: ArchitectureChapter,
  dir: string,
  input: DocumentInput,
): string[] {
  const where = posix.join(dir, 'chapters', `${chapter.id}.md`);
  const cited = chapter.evidence.map((text) => {
    const citation = parseCitation(text);
    if (!citation) return `${where}: evidence "${text}" is neither a path nor commit:<hash>`;
    const problem = citationProblem(citation, input);
    return problem ? `${where}: evidence ${problem}` : null;
  });
  const inline = [...chapter.body.matchAll(INLINE_REFERENCE)].map((match) => {
    const citation = parseCitation(match[1] as string);
    const problem = citation && citationProblem(citation, input);
    return problem ? `${where}: ${problem}` : null;
  });
  const missing =
    chapter.evidence.length === 0
      ? [`${where}: no evidence; cite the files the chapter is based on`]
      : [];
  return [...missing, ...cited, ...inline].filter((problem): problem is string => problem !== null);
}

function viewProblems(ssot: ArchitectureSsot, input: DocumentInput): string[] {
  return ssot.views.flatMap((view) => {
    const where = posix.join(ssot.dir, 'views', `${view.id}.yaml`);
    if (view.kind === 'data') {
      return view.entities.flatMap(({ id, name, path }) => {
        if (!input.exists(path)) return [`${where}: entity ${id}: ${path} does not exist`];
        const module = input.modules.find((candidate) => candidate.path === path);
        // A union or alias such as `type Question = A | B` is a top-level name, if not a data type.
        const declared =
          module === undefined ||
          (module.types ?? []).some((type) => type.name === name) ||
          module.symbols.includes(name);
        return declared ? [] : [`${where}: entity ${id}: ${path} declares no data type ${name}`];
      });
    }
    const paths = view.nodes.flatMap(({ id, path }) =>
      path && !input.exists(path) && !input.modules.some((m) => covers(path, m.path))
        ? [`${where}: node ${id}: ${path} matches nothing`]
        : [],
    );
    const nodes = new Map(view.nodes.map((node) => [node.id, node]));
    const edges = checkEdges(view, ssot, input.modules).flatMap(({ support, evidence }, index) => {
      const edge = view.edges[index];
      if (!edge || edge.style === 'dashed') return [];
      const name = `${nodes.get(edge.from)?.label} → ${nodes.get(edge.to)?.label}`;
      if (support === 'reversed') {
        return [
          `${where}: ${name}: the import runs the other way (${evidence?.path}:${evidence?.line}); the caller owns the arrow`,
        ];
      }
      return support === 'unsupported'
        ? [`${where}: ${name}: no import in the code; draw it dashed if it is real but indirect`]
        : [];
    });
    return [...paths, ...edges];
  });
}

/** Problems with the views and chapters, as warnings for `list` and the agent's repair. */
export function documentProblems(ssot: ArchitectureSsot, input: DocumentInput): string[] {
  return [
    ...viewProblems(ssot, input),
    ...ssot.chapters.flatMap((chapter) => chapterProblems(chapter, ssot.dir, input)),
  ];
}

/** Drift in the document: chapters citing files that changed, and views that no longer fit. */
export function documentDrift(
  ssot: ArchitectureSsot,
  input: DocumentInput,
  changed: Set<string>,
): DriftItem[] {
  const chapters = ssot.chapters.flatMap((chapter): DriftItem[] => {
    const cited = chapter.evidence.flatMap((text) => parseCitation(text)?.path ?? []);
    const touched = [...new Set(cited)].filter((path) =>
      [...changed].some((file) => covers(path, file)),
    );
    if (touched.length === 0) return [];
    return [
      {
        kind: 'stale-chapter',
        component: null,
        path: posix.join(ssot.dir, 'chapters', `${chapter.id}.md`),
        target: touched[0],
        message: `"${chapter.title}" cites ${touched.join(', ')}, which changed`,
      },
    ];
  });
  const views = viewProblems(ssot, input).map((problem): DriftItem => {
    const [path = '', ...rest] = problem.split(': ');
    return { kind: 'stale-view', component: null, path, message: rest.join(': ') };
  });
  return [...chapters, ...views];
}
