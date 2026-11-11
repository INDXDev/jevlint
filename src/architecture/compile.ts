/**
 * `jevlint architecture compile`: collects the facts and, when an SSOT exists, what changed since
 * it was compiled, for the prompt that asks a coding agent to write or update it.
 */
import { basename } from 'node:path';
import { type Config, UserError } from '../config.ts';
import { discoverDocs } from '../files.ts';
import { changedSince, resolveCommit, significantCommits } from '../git.ts';
import type { ArchitectureFacts, ArchitectureSsot, CommitSummary, DriftItem } from '../types.ts';
import { collect, existsIn, filesOfCommit, lineCountIn } from './collect.ts';
import { staticDrift } from './conformance.ts';
import { draftSsot } from './draft.ts';
import { architectureFiles, budgetWarnings, loadArchitecture, ssotDir } from './load.ts';
import { documentDrift, documentProblems } from './views.ts';

const COMMITS_SCANNED = 400;
const COMMITS_SHOWN = 25;
const COMMENTS_SHOWN = 60;
const INSTRUCTION_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  'ARCHITECTURE.md',
  'docs/architecture.md',
];

/** Comments from the files other parts use most, where a reason matters most. */
function centralComments(facts: ArchitectureFacts): CompileInput['comments'] {
  const central = new Set(facts.components.flatMap(({ central: files }) => files));
  return facts.modules
    .filter(({ path }) => central.has(path))
    .flatMap(({ path, comments = [] }) => comments.map(({ line, text }) => ({ path, line, text })))
    .slice(0, COMMENTS_SHOWN);
}

/** What changed in the code since the SSOT was compiled. */
export interface CompileDelta {
  base: string;
  added: string[];
  removed: string[];
  items: DriftItem[];
}

/** Everything the compile prompt is built from: facts, paths and line numbers, never contents. */
export interface CompileInput {
  dir: string;
  facts: ArchitectureFacts;
  draft: ArchitectureSsot;
  ssot: ArchitectureSsot | null;
  /** Root-relative paths of the current SSOT's files. */
  ssotFiles: string[];
  loadError?: string;
  /** Set when an SSOT exists and a base is known. */
  delta: CompileDelta | null;
  /** Root-relative document paths, with `--docs`. */
  docs: string[];
  /** Commits most worth reading for the reasons behind the design. */
  commits: CommitSummary[];
  /** Comments in the central files, which often say why. */
  comments: { path: string; line: number; text: string }[];
  /** Instruction files for agents, such as AGENTS.md, that exist. */
  instructions: string[];
}

/** Narrows a compile. */
export interface CompileOptions {
  paths?: string[];
  /** Documents to add as context. An empty list means `spec.docs`; undefined means none. */
  docs?: string[];
  /** The base of an update, instead of `compiled_at`. */
  since?: string;
  noCache?: boolean;
}

async function loadExisting(config: Config) {
  try {
    return { ssot: await loadArchitecture(config) };
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    return { ssot: null, loadError: error.message };
  }
}

async function deltaOf(
  config: Config,
  ssot: ArchitectureSsot,
  current: { paths: string[]; modules: Parameters<typeof staticDrift>[1]['modules'] },
  since?: string,
): Promise<CompileDelta | null> {
  const named = since ?? ssot.index.compiled_at;
  if (named === undefined) return null;
  const base = await resolveCommit(config.root, named).catch((error) => {
    if (since !== undefined) throw error;
    return null;
  });
  if (base === null) return null;
  const before = await filesOfCommit(config, base);
  const known = new Set(before);
  const now = new Set(current.paths);
  const added = current.paths.filter((path) => !known.has(path));
  const items = staticDrift(ssot, {
    modules: current.modules,
    exists: existsIn(config.root),
    added: new Set(added),
  });
  const changed = new Set([...(await changedSince(config.root, base)), ...added]);
  const lookup = {
    modules: current.modules,
    exists: existsIn(config.root),
    lineCount: lineCountIn(config.root),
  };
  items.push(...documentDrift(ssot, lookup, changed));
  return { base, added, removed: before.filter((path) => !now.has(path)), items };
}

/** Collects what the compile prompt needs. Never fails because the existing SSOT does not load. */
export async function prepareCompile(
  config: Config,
  options: CompileOptions = {},
): Promise<CompileInput> {
  const dir = ssotDir(config);
  const collected = await collect(config, { paths: options.paths, noCache: options.noCache });
  const { ssot, loadError } = await loadExisting(config);
  const delta = ssot ? await deltaOf(config, ssot, collected, options.since) : null;
  const docs = options.docs
    ? await discoverDocs(config, options.docs.length > 0 ? options.docs : undefined)
    : [];
  return {
    dir,
    facts: collected.facts,
    draft: draftSsot(collected.facts, basename(config.root), dir),
    ssot,
    ssotFiles: ssot ? architectureFiles(ssot) : [],
    loadError,
    delta,
    docs,
    commits: await significantCommits(config.root, COMMITS_SCANNED, COMMITS_SHOWN),
    comments: centralComments(collected.facts),
    instructions: INSTRUCTION_FILES.filter((path) => existsIn(config.root)(path)),
  };
}

/** What `list` and the compile repair loop report: why the SSOT does not load, or its problems. */
export interface SsotValidation {
  ssot: ArchitectureSsot | null;
  /** Why it does not load, when it does not. */
  error?: string;
  /** Problems with a loaded SSOT: the size budget, and views and chapters that do not fit the code. */
  problems: string[];
}

/** Loads the SSOT and checks its views and chapters against the code. */
export async function validateSsot(
  config: Config,
  options: { noCache?: boolean } = {},
): Promise<SsotValidation> {
  const { ssot, loadError } = await loadExisting(config);
  if (!ssot) return { ssot: null, ...(loadError ? { error: loadError } : {}), problems: [] };
  const needsCode = ssot.views.length > 0 || ssot.chapters.length > 0;
  const modules = needsCode
    ? (await collect(config, { skipHistory: true, noCache: options.noCache })).modules
    : [];
  const problems = [
    ...budgetWarnings(ssot),
    ...(needsCode
      ? documentProblems(ssot, {
          modules,
          exists: existsIn(config.root),
          lineCount: lineCountIn(config.root),
        })
      : []),
  ];
  return { ssot, problems };
}
