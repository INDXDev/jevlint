/**
 * `jevlint architecture check`: decides the SSOT's structural rules from the AST, then judges its
 * checklists with the decision model. See docs/architecture-reference.md#check.
 */
import { join, relative, sep } from 'node:path';
import { newViolations, readBaseline } from '../baseline.ts';
import { type Config, readRegularFile } from '../config.ts';
import { parseDirectives } from '../directives.ts';
import { changedSince, resolveCommit } from '../git.ts';
import { ask, eachPath, type SpecRun, startRun, usageOf, verdicts } from '../spec/run.ts';
import type {
  ArchitectureCheckReport,
  ArchitectureFileResult,
  ArchitectureSsot,
  ArchitectureViolation,
  AuditReport,
  CheckVerdict,
  FactModule,
} from '../types.ts';
import { type Collected, collect, existsIn, matchCalls } from './collect.ts';
import { addedViolations, assign, callSearches, conformance } from './conformance.ts';
import { allChecklistRefs, checklistRefs, checkRequest } from './questions.ts';

/** Narrows and observes a check. */
export interface ArchitectureCheckOptions {
  paths?: string[];
  /** Report only what changed since this revision. */
  diff?: string;
  /** Decide the structural rules only, with no model. */
  static?: boolean;
  /** Leave out violations `.jevlint/baseline.json` records. */
  new?: boolean;
  noCache?: boolean;
  onProgress?: (done: number, total: number, path: string) => void;
}

const NO_USAGE: AuditReport['usage'] = {
  inputTokens: 0,
  estimatedCostUsd: null,
  cacheHits: 0,
  modelCalls: 0,
};

/** The structural violations of one collected tree. */
export function violationsOf(ssot: ArchitectureSsot, collected: Collected, root: string) {
  const calls = matchCalls(callSearches(ssot, collected.modules), collected.sources);
  return conformance(ssot, { modules: collected.modules, exists: existsIn(root), calls });
}

/** The violations a change from `base` to `head` added. Both sides are read from git. */
export async function changeViolations(
  config: Config,
  ssot: ArchitectureSsot,
  base: string | null,
  head: string,
): Promise<ArchitectureViolation[]> {
  const options = { keepSources: true, skipHistory: true } as const;
  const after = violationsOf(
    ssot,
    await collect(config, { ...options, commit: head }),
    config.root,
  );
  if (base === null) return after;
  const before = violationsOf(
    ssot,
    await collect(config, { ...options, commit: base }),
    config.root,
  );
  return addedViolations(before, after);
}

const toRootRelative = (root: string, path: string) => relative(root, path).split(sep).join('/');

function underAny(path: string, targets: string[] | undefined): boolean {
  if (!targets) return true;
  return targets.some(
    (target) => target === '' || path === target || path.startsWith(`${target}/`),
  );
}

async function checkFile(
  run: SpecRun,
  ssot: ArchitectureSsot,
  path: string,
  component: string | null,
): Promise<ArchitectureFileResult> {
  const result: ArchitectureFileResult = { path, component, items: [], warnings: [] };
  const owner = ssot.components.find(({ id }) => id === component) ?? null;
  const items = [...checklistRefs(ssot, null), ...(owner ? checklistRefs(ssot, owner) : [])];
  if (items.length === 0) return result;
  let raw: string;
  try {
    raw = await readRegularFile(join(run.config.root, path));
  } catch (error) {
    return { ...result, warnings: [`Could not read file: ${(error as Error).message}`] };
  }
  const source = parseDirectives(raw, run.config.scoring.scale).code;
  const answers = await ask(run, checkRequest(ssot, owner, items), source, result.warnings);
  if (!answers) return result;
  return { ...result, items: verdicts<CheckVerdict>(answers, items, run.config.spec.threshold) };
}

function filesToJudge(
  ssot: ArchitectureSsot,
  modules: FactModule[],
  keep: (path: string) => boolean,
) {
  const { componentOf, ignored } = assign(ssot);
  const hasGlobal = ssot.index.checklist.length > 0;
  const withItems = new Set(
    ssot.components.filter(({ checklist }) => checklist.length > 0).map(({ id }) => id),
  );
  return modules
    .filter(({ path }) => keep(path) && !ignored(path))
    .map(({ path }) => ({ path, component: componentOf(path) }))
    .filter(({ component }) => hasGlobal || (component !== null && withItems.has(component)));
}

async function judgeChecklists(
  config: Config,
  ssot: ArchitectureSsot,
  files: { path: string; component: string | null }[],
  options: ArchitectureCheckOptions,
) {
  if (files.length === 0) return { files: [], usage: NO_USAGE, run: null };
  const run = await startRun(
    config,
    'architecture check',
    options.noCache,
    'Run: jevlint auth set <provider name>, or pass --static',
  );
  const results = await eachPath(
    run,
    files.map(({ path }) => path),
    options.onProgress,
    (path) =>
      checkFile(run, ssot, path, files.find((file) => file.path === path)?.component ?? null),
  );
  return { files: results, usage: usageOf(run), run };
}

const violationCount = (file: ArchitectureFileResult) =>
  file.items.filter(({ verdict }) => verdict === 'violates').length;

/** Checks the code, or only `options.paths` or a change, against the SSOT. */
export async function checkArchitecture(
  config: Config,
  ssot: ArchitectureSsot,
  options: ArchitectureCheckOptions = {},
): Promise<ArchitectureCheckReport> {
  const { root } = config;
  const targets = options.paths?.map((path) => toRootRelative(root, path));
  const collected = await collect(config, {
    keepSources: true,
    skipHistory: true,
    noCache: options.noCache,
  });
  let violations = violationsOf(ssot, collected, root);
  let changed: Set<string> | null = null;
  let base: string | undefined;
  if (options.diff !== undefined) {
    base = await resolveCommit(root, options.diff);
    const atBase = await collect(config, { keepSources: true, skipHistory: true, commit: base });
    violations = addedViolations(violationsOf(ssot, atBase, root), violations);
    // `git diff` lists no untracked file, so a new one is found by its absence at the base.
    const before = new Set(atBase.paths);
    const tracked = await changedSince(root, base);
    changed = new Set([...tracked, ...collected.paths.filter((path) => !before.has(path))]);
  }
  violations = violations.filter(({ path }) => underAny(path, targets));
  let baselined = 0;
  if (options.new) {
    const { fresh, known } = newViolations(violations, await readBaseline(root));
    violations = fresh;
    baselined = known;
  }
  const keep = (path: string) => underAny(path, targets) && (!changed || changed.has(path));
  const judged = options.static
    ? { files: [], usage: NO_USAGE, run: null }
    : await judgeChecklists(config, ssot, filesToJudge(ssot, collected.modules, keep), options);
  const complete = !targets && options.diff === undefined;
  const satisfied = new Set(
    judged.files.flatMap(({ items }) =>
      items.filter((i) => i.verdict === 'satisfies').map((i) => i.id),
    ),
  );
  return {
    root,
    dir: ssot.dir,
    provider: judged.run?.resolved.provider ?? null,
    model: judged.run?.resolved.modelId ?? null,
    complete,
    ...(base ? { base } : {}),
    violations: violations.filter(({ status }) => status === 'current'),
    targetGaps: violations.filter(({ status }) => status === 'target'),
    baselined,
    files: judged.files
      .filter((file) => file.items.length > 0 || file.warnings.length > 0)
      .toSorted((a, b) => violationCount(b) - violationCount(a) || a.path.localeCompare(b.path)),
    checklistViolations: judged.files.reduce((sum, file) => sum + violationCount(file), 0),
    unimplemented:
      complete && !options.static
        ? allChecklistRefs(ssot).filter(({ id }) => !satisfied.has(id))
        : [],
    usage: judged.usage,
    warnings: collected.warnings,
  };
}
