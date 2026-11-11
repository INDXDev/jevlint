/**
 * Turns resolved modules into architecture facts: component candidates, layers, externals, entry
 * points, interfaces, flows and co-changes. Pure: the pipeline reads files and git.
 */
import { dirname, posix } from 'node:path';
import type {
  ArchitectureFacts,
  CandidateFlow,
  CoChange,
  ComponentCandidate,
  ComponentDependency,
  EntryPoint,
  Evidence,
  ExternalUse,
  FactModule,
} from '../types.ts';
import { classifyPackage } from './externals.ts';
import {
  communities,
  cyclicNodes,
  type Dependencies,
  layersOf,
  longestPath,
  pageRank,
  stronglyConnected,
  type WeightedEdge,
} from './graph.ts';

/** A directory this small stays one candidate, whatever its subdirectories. */
const SMALL_DIRECTORY = 6;
/** The most candidates the facts propose, so the SSOT stays small enough to read. */
export const MAX_COMPONENTS = 25;
const MAX_EVIDENCE = 5;
const MAX_CENTRAL = 5;
const MAX_INTERFACE = 12;
const MAX_FLOWS = 10;
const MAX_CO_CHANGES = 10;
/** Pairs that change together fewer times than this are coincidence. */
const MIN_CO_CHANGES = 3;

/** What `buildFacts` is given. */
export interface FactsInput {
  root: string;
  commit: string | null;
  modules: FactModule[];
  /** Entry points found from paths, sources and package.json. */
  entrypoints: { path: string; kind: string }[];
  /** Commits per file over the churn window. */
  churn: Map<string, number>;
  /** The files of each recent commit, for co-change. */
  commits: string[][];
  warnings: string[];
}

// `spec/` holds tests only at the top, as in Ruby and Jasmine; deeper, it is often a feature.
const TEST_DIRECTORY =
  /(^|\/)([\w.-]*[-_.])?(tests?|__tests__|__mocks__|testdata|fixtures|e2e)\/|^spec\//;
const TEST_FILE =
  /(\.(test|spec)\.[cm]?[jt]sx?|_test\.(go|py)|(^|\/)test_[^/]*\.py|(^|\/)conftest\.py)$/;

/** Whether a path is a test, a fixture or test data, which the facts keep out of components. */
export const isTestPath = (path: string) => TEST_DIRECTORY.test(path) || TEST_FILE.test(path);

function testGlobs(paths: string[]): string[] {
  const globs = paths.filter(isTestPath).map((path) => {
    const directory = path.match(TEST_DIRECTORY);
    if (directory?.index !== undefined) {
      const end = directory.index + directory[0].length;
      return `${path.slice(0, end)}**`;
    }
    const extension = posix.extname(path);
    if (path.endsWith(`_test${extension}`)) return `**/*_test${extension}`;
    if (/(^|\/)test_[^/]*\.py$/.test(path)) return '**/test_*.py';
    if (path.endsWith('conftest.py')) return '**/conftest.py';
    return `**/*.${path.match(/\.(test|spec)\./)?.[1]}${extension}`;
  });
  return [...new Set(globs)].sort();
}

interface DirectoryTree {
  files: Map<string, string[]>;
  children: Map<string, Set<string>>;
}

function directoryTree(paths: string[]): DirectoryTree {
  const files = new Map<string, string[]>();
  const children = new Map<string, Set<string>>();
  for (const path of paths) {
    const directory = dirname(path);
    files.set(directory, [...(files.get(directory) ?? []), path]);
    for (let child = directory; child !== '.'; child = dirname(child)) {
      const parent = dirname(child);
      children.set(parent, (children.get(parent) ?? new Set()).add(child));
    }
  }
  return { files, children };
}

function filesUnder(tree: DirectoryTree, directory: string): string[] {
  const own = tree.files.get(directory) ?? [];
  const nested = [...(tree.children.get(directory) ?? [])].flatMap((child) =>
    filesUnder(tree, child),
  );
  return [...own, ...nested];
}

interface Seeds {
  /** Whole directories, each kept together. */
  directories: Map<string, string[]>;
  /** Files directly in a directory that was split, which clustering places. */
  loose: string[];
}

/** The most whole directories seeding the candidates, leaving room for loose files and splits. */
const MAX_DIRECTORY_SEEDS = 12;
const MIN_DIRECTORY_SEEDS = 4;

/**
 * Splits directories that have subdirectories and more than a few files; the rest stay whole.
 * While that gives too many, the split directory with the most seeds under it is kept whole
 * instead, so `src/middleware/*` becomes `src/middleware` rather than being merged at random.
 */
function seedGroups(paths: string[]): Seeds {
  const tree = directoryTree(paths);
  const whole = new Set<string>();
  const seed = (): Seeds => {
    const seeds: Seeds = { directories: new Map(), loose: [] };
    const expand = (directory: string) => {
      const all = filesUnder(tree, directory);
      if (all.length === 0) return;
      const children = [...(tree.children.get(directory) ?? [])].sort();
      if (children.length === 0 || all.length <= SMALL_DIRECTORY || whole.has(directory)) {
        seeds.directories.set(directory, all);
        return;
      }
      for (const child of children) expand(child);
      seeds.loose.push(...(tree.files.get(directory) ?? []));
    };
    expand('.');
    return seeds;
  };
  let seeds = seed();
  while (seeds.directories.size > MAX_DIRECTORY_SEEDS) {
    const under = new Map<string, number>();
    for (const directory of seeds.directories.keys()) {
      const parent = dirname(directory);
      if (directory !== '.' && parent !== '.') under.set(parent, (under.get(parent) ?? 0) + 1);
    }
    // The deepest directory with two or more seeds right under it, so collapsing stays local,
    // and never one whose collapse would leave too few candidates to say anything.
    const depth = (directory: string) => directory.split('/').length;
    const [parent] = [...under]
      .filter(
        ([, count]) => count >= 2 && seeds.directories.size - count + 1 >= MIN_DIRECTORY_SEEDS,
      )
      .sort((a, b) => depth(b[0]) - depth(a[0]) || b[1] - a[1] || a[0].localeCompare(b[0]));
    if (!parent) break;
    whole.add(parent[0]);
    seeds = seed();
  }
  return seeds;
}

function undirectedEdges(modules: FactModule[], inside: Set<string>): WeightedEdge[] {
  return modules.flatMap(({ path, imports }) =>
    inside.has(path)
      ? imports
          .filter((target) => inside.has(target.path) && target.path !== path)
          .map((target): WeightedEdge => [path, target.path, 1])
      : [],
  );
}

/**
 * Loose files that clustering left alone are grouped by directory, so `src/utils/*.ts` is one
 * candidate rather than one per file. Untangling splits such a group again if it makes a cycle.
 */
function groupLeftovers(groups: string[][], seeds: Seeds): string[][] {
  const fixed = new Set([...seeds.directories.values()].flat());
  const alone = (group: string[]) => group.length === 1 && !fixed.has(group[0] as string);
  const byDirectory = Map.groupBy(groups.filter(alone).flat(), (path) => dirname(path));
  return [...groups.filter((group) => !alone(group)), ...byDirectory.values()];
}

/** Lowercase letters, digits and `-`, as SSOT ids are. */
export const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/\.[^./]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'root';

interface Named {
  files: string[];
  paths: string[];
  base: string;
}

/** A whole directory gets `dir/**`; anything else lists its directories and files. */
function describeGroup(files: string[], seeds: Seeds, modules: FactModule[]): Named {
  const wholeDirectories = [...seeds.directories].filter(([, members]) =>
    members.every((member) => files.includes(member)),
  );
  const covered = new Set(wholeDirectories.flatMap(([, members]) => members));
  const paths = [
    ...wholeDirectories.map(([directory]) => (directory === '.' ? '**' : `${directory}/**`)),
    ...files.filter((file) => !covered.has(file)),
  ];
  const [largest] = wholeDirectories.toSorted((a, b) => b[1].length - a[1].length);
  if (largest) return { files, paths, base: largest[0] };
  // A part of a directory is named after the file the rest of the code imports most.
  const inside = new Set(files);
  const importers = new Map<string, number>();
  for (const { path, imports } of modules) {
    if (inside.has(path)) continue;
    for (const { path: target } of imports) {
      if (inside.has(target)) importers.set(target, (importers.get(target) ?? 0) + 1);
    }
  }
  const [central = files[0] as string] = mostFirst(importers);
  const directories = new Set(files.map((file) => dirname(file)));
  // Part of one directory reads best as `<directory>-<file>`, such as `architecture-check`.
  const directory = dirname(central);
  if (directories.size === 1 && seeds.directories.has(directory)) {
    return { files, paths, base: `${directory}-${posix.basename(central)}` };
  }
  return { files, paths, base: central };
}

/** Ids from the last path segment, falling back to more of the path when two would clash. */
function uniqueIds(groups: Named[]): string[] {
  const tail = (path: string, segments: number) => slug(path.split('/').slice(-segments).join('-'));
  const ids = groups.map(({ base }) => tail(base, 1));
  for (let segments = 2; segments <= 6; segments++) {
    const counts = Map.groupBy(ids, (id) => id);
    ids.forEach((id, index) => {
      if ((counts.get(id)?.length ?? 0) > 1)
        ids[index] = tail((groups[index] as Named).base, segments);
    });
  }
  const seen = new Map<string, number>();
  return ids.map((id) => {
    const count = (seen.get(id) ?? 0) + 1;
    seen.set(id, count);
    return count === 1 ? id : `${id}-${count}`;
  });
}

interface Grouped {
  componentOf: Map<string, string>;
  groups: (Named & { id: string })[];
}

/** Module-level layers, which are exact where directories are not. */
function moduleLayers(modules: FactModule[]): Map<string, number> {
  const graph: Dependencies = new Map(
    modules.map(({ path, imports }) => [path, new Set(imports.map((target) => target.path))]),
  );
  const paths = modules.map(({ path }) => path);
  return layersOf(stronglyConnected(paths, graph), graph);
}

/** How many files sit in groups that form a cycle: what untangling drives down. */
function filesInCycles(groups: string[][], modules: FactModule[]): number {
  const groupOf = new Map(
    groups.flatMap((members, index) => members.map((path) => [path, String(index)])),
  );
  const graph: Dependencies = new Map();
  for (const { path, imports } of modules) {
    const from = groupOf.get(path);
    if (from === undefined) continue;
    for (const { path: target } of imports) {
      const to = groupOf.get(target);
      if (to !== undefined && to !== from) graph.set(from, (graph.get(from) ?? new Set()).add(to));
    }
  }
  const ids = groups.map((_, index) => String(index));
  return stronglyConnected(ids, graph)
    .filter((component) => component.length > 1)
    .flat()
    .reduce((sum, id) => sum + (groups[Number(id)] as string[]).length, 0);
}

/**
 * Directories often mix layers, which makes candidates import each other in a cycle. While one
 * does, this splits the group whose split by module layer removes the most files from cycles,
 * until none is left, no split helps, or there are `MAX_COMPONENTS` groups.
 */
function untangle(groups: string[][], modules: FactModule[]): string[][] {
  const layerOf = moduleLayers(modules);
  const level = (path: string) => layerOf.get(path) ?? 0;
  let current = groups;
  let tangled = filesInCycles(current, modules);
  while (tangled > 0 && current.length < MAX_COMPONENTS) {
    let best: { groups: string[][]; tangled: number } | null = null;
    current.forEach((group, index) => {
      const thresholds = [...new Set(group.map(level))].sort((a, b) => a - b).slice(0, -1);
      for (const threshold of thresholds) {
        const parts = [
          group.filter((p) => level(p) <= threshold),
          group.filter((p) => level(p) > threshold),
        ];
        const next = [...current.slice(0, index), ...parts, ...current.slice(index + 1)];
        const left = filesInCycles(next, modules);
        if (left < (best?.tangled ?? tangled)) best = { groups: next, tangled: left };
      }
    });
    if (!best) break;
    ({ groups: current, tangled } = best as { groups: string[][]; tangled: number });
  }
  return current;
}

function groupModules(modules: FactModule[]): Grouped {
  const paths = modules.map(({ path }) => path);
  const seeds = seedGroups(paths);
  const edges = undirectedEdges(modules, new Set(paths));
  const fixed = new Set([...seeds.directories.values()].flat());
  const isFixed = (group: string[]) => group.some((member) => fixed.has(member));
  const clustered = communities(
    [...seeds.directories.values(), ...seeds.loose.map((path) => [path])],
    edges,
    // A directory is a decision someone made, so clustering only places the loose files.
    (a, b) => !isFixed(a) && !isFixed(b),
    MAX_COMPONENTS,
  );
  const named = untangle(groupLeftovers(clustered, seeds), modules)
    .map((files) => describeGroup(files.toSorted(), seeds, modules))
    .toSorted((a, b) => a.base.localeCompare(b.base));
  const ids = uniqueIds(named);
  const groups = named.map((group, index) => ({ ...group, id: ids[index] as string }));
  const componentOf = new Map(groups.flatMap(({ id, files }) => files.map((file) => [file, id])));
  return { componentOf, groups };
}

function pushEvidence(list: Evidence[], evidence: Evidence): void {
  if (list.length < MAX_EVIDENCE) list.push(evidence);
}

/** Component dependencies, each with the imports behind it. */
export function componentDependencies(
  modules: FactModule[],
  componentOf: (path: string) => string | null,
): ComponentDependency[] {
  const found = new Map<string, ComponentDependency>();
  for (const { path, imports } of modules) {
    const from = componentOf(path);
    if (from === null) continue;
    for (const target of imports) {
      const to = componentOf(target.path);
      if (to === null || to === from) continue;
      const key = `${from}\0${to}`;
      const dependency = found.get(key) ?? { from, to, weight: 0, evidence: [] };
      dependency.weight += 1;
      pushEvidence(dependency.evidence, { path, line: target.line, target: target.path });
      found.set(key, dependency);
    }
  }
  return [...found.values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
}

/** The dependency map of a list of component dependencies. */
export function dependencyMap(dependencies: { from: string; to: string }[]): Dependencies {
  const map: Dependencies = new Map();
  for (const { from, to } of dependencies) map.set(from, (map.get(from) ?? new Set()).add(to));
  return map;
}

/** Every external the modules import, classified, with who imports it. */
export function externalUses(
  modules: FactModule[],
  componentOf: (path: string) => string | null,
): ExternalUse[] {
  const found = new Map<string, ExternalUse>();
  for (const { path, externals } of modules) {
    const user = componentOf(path);
    for (const { package: name, line } of externals) {
      const { id, title, kind } = classifyPackage(name);
      const use = found.get(id) ?? { id, title, kind, packages: [], users: [], evidence: [] };
      if (!use.packages.includes(name)) use.packages.push(name);
      if (user !== null && !use.users.includes(user)) use.users.push(user);
      pushEvidence(use.evidence, { path, line, target: name });
      found.set(id, use);
    }
  }
  return [...found.values()]
    .map((use) => ({ ...use, packages: use.packages.sort(), users: use.users.sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

const countBy = <T>(items: T[]) => {
  const counts = new Map<T, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
};

const mostFirst = <T>(counts: Map<T, number>) =>
  [...counts]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([key]) => key);

/** The files and names other components use, most used first. */
function surfaceOf(id: string, modules: FactModule[], componentOf: Map<string, string>) {
  const symbolsOf = new Map(modules.map(({ path, symbols }) => [path, symbols]));
  const usedFiles: string[] = [];
  const usedNames: string[] = [];
  for (const { path, imports } of modules) {
    if (componentOf.get(path) === id) continue;
    for (const target of imports) {
      if (componentOf.get(target.path) !== id) continue;
      usedFiles.push(target.path);
      usedNames.push(
        ...(target.names ?? symbolsOf.get(target.path) ?? []).filter((n) => n !== 'default'),
      );
    }
  }
  return {
    central: mostFirst(countBy(usedFiles)).slice(0, MAX_CENTRAL),
    names: mostFirst(countBy(usedNames)).slice(0, MAX_INTERFACE),
  };
}

function coChangesOf(
  commits: string[][],
  componentOf: Map<string, string>,
  dependencies: Dependencies,
): CoChange[] {
  const linked = (a: string, b: string) =>
    dependencies.get(a)?.has(b) === true || dependencies.get(b)?.has(a) === true;
  const pairs = commits.flatMap((files) => {
    const touched = [...new Set(files.flatMap((file) => componentOf.get(file) ?? []))].sort();
    return touched.flatMap((a, index) =>
      touched
        .slice(index + 1)
        .filter((b) => !linked(a, b))
        .map((b) => `${a}\0${b}`),
    );
  });
  return mostFirst(countBy(pairs))
    .map((key) => {
      const [a = '', b = ''] = key.split('\0');
      return { a, b, commits: countBy(pairs).get(key) as number };
    })
    .filter(({ commits: count }) => count >= MIN_CO_CHANGES)
    .slice(0, MAX_CO_CHANGES);
}

function flowsOf(
  entrypoints: EntryPoint[],
  ids: string[],
  dependencies: Dependencies,
): CandidateFlow[] {
  const starts = [...new Set(entrypoints.flatMap(({ component }) => component ?? []))];
  return starts
    .map((start) => ({
      entry: entrypoints.find(({ component }) => component === start)?.path as string,
      components: longestPath(start, ids, dependencies),
    }))
    .filter(({ components }) => components.length > 1)
    .sort((a, b) => b.components.length - a.components.length || a.entry.localeCompare(b.entry))
    .slice(0, MAX_FLOWS);
}

/** Builds the facts. Test files stay out of components and are listed as globs. */
export function buildFacts(input: FactsInput): ArchitectureFacts {
  const code = input.modules.filter(({ path }) => !isTestPath(path));
  const { componentOf, groups } = groupModules(code);
  const lookup = (path: string) => componentOf.get(path) ?? null;
  const dependencies = componentDependencies(code, lookup);
  const graph = dependencyMap(dependencies);
  const ids = groups.map(({ id }) => id);
  const sccs = stronglyConnected(ids, graph);
  const layers = layersOf(sccs, graph);
  const ranks = pageRank(ids, graph);
  const externals = externalUses(code, lookup);
  const linesOf = new Map(code.map(({ path, lines }) => [path, lines]));
  const components: ComponentCandidate[] = groups.map(({ id, paths, files }) => {
    const surface = surfaceOf(id, code, componentOf);
    return {
      id,
      paths,
      files,
      lines: files.reduce((sum, file) => sum + (linesOf.get(file) ?? 0), 0),
      layer: layers.get(id) ?? 0,
      rank: Number((ranks.get(id) ?? 0).toFixed(4)),
      fanIn: dependencies.filter(({ to }) => to === id).length,
      fanOut: dependencies.filter(({ from }) => from === id).length,
      central: surface.central,
      interface: surface.names,
      externals: externals
        .filter(({ kind, users }) => kind !== 'runtime' && users.includes(id))
        .map(({ id: external }) => external),
      churn: files.reduce((sum, file) => sum + (input.churn.get(file) ?? 0), 0),
    };
  });
  const entrypoints = input.entrypoints
    .map(({ path, kind }) => ({ path, kind, component: lookup(path) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    version: 1,
    root: input.root,
    commit: input.commit,
    files: code.length,
    lines: code.reduce((sum, { lines }) => sum + lines, 0),
    components,
    layers: components.reduce((most, { layer }) => Math.max(most, layer + 1), 0),
    dependencies,
    externals,
    entrypoints,
    flows: flowsOf(entrypoints, ids, graph),
    cycles: [...new Set(cyclicNodes(sccs).values())],
    coChanges: coChangesOf(input.commits, componentOf, graph),
    tests: testGlobs(input.modules.map(({ path }) => path)),
    modules: input.modules,
    warnings: input.warnings,
  };
}
