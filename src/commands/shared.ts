/** Flag parsing, prompts and the audit flow shared by commands. */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { confirm, isCancel, spinner } from '@clack/prompts';
import { type AgentLaunch, launchAgent } from '../agent.ts';
import { type AuditOptions, audit } from '../audit.ts';
import { type Config, type ConfigOverrides, loadConfig, UserError } from '../config.ts';
import { envKeysAllowed, KEY_ENV } from '../credentials.ts';
import { PROVIDER_ERROR } from '../decision/decide.ts';
import { createDecisionModel } from '../decision/providers.ts';
import { discoverFiles } from '../files.ts';
import { OUTPUT_FORMATS, type OutputFormat } from '../formats.ts';
import { dirtyFiles, gitFailureReason } from '../git.ts';
import { presetsInArgs } from '../presets.ts';
import { hasIssues } from '../prompt.ts';
import { formatScore, withoutControlCharacters } from '../report.ts';
import type { AuditReport, FileReport } from '../types.ts';

/** Sends clack prompts to stderr, so stdout carries only results. */
export const PROMPT_IO = { output: process.stderr };

/** The `[files...]` and `--top` arguments of commands that pick files to fix. */
export const FILE_SELECTION_ARGS = {
  files: {
    type: 'positional',
    required: false,
    description: 'Files to use, instead of the highest-priority ones',
  },
  top: { type: 'string', valueHint: 'n', description: 'Number of files to use (default 1)' },
} as const;

/** The `--format` flag of commands that report findings. */
export const FORMAT_ARG = {
  type: 'string',
  valueHint: 'format',
  description: `Output format: ${OUTPUT_FORMATS.join(', ')} (default text)`,
} as const;

/** The `--preset` flag of commands that audit. */
export const PRESET_ARG = {
  type: 'string',
  valueHint: 'names',
  description: 'Comma-separated presets, replacing the configured ones',
} as const;

/** The arguments of commands that run a coding agent on the worst files: `fix` and `quickfix`. */
export const AGENT_RUN_ARGS = {
  ...FILE_SELECTION_ARGS,
  preset: PRESET_ARG,
  agent: { type: 'string', valueHint: 'name', description: 'Agent to run, such as claude' },
  yes: { type: 'boolean', description: 'Skip the confirmation. Required outside a terminal' },
  'allow-dirty': { type: 'boolean', description: 'Run even if the git working tree has changes' },
  'agent-login': {
    type: 'boolean',
    description:
      "Use the agent's own login, such as a subscription, not an API key in the environment",
  },
} as const;

/** The parsed `AGENT_RUN_ARGS`. */
export interface AgentRunFlags {
  _: string[];
  top?: string;
  preset?: string;
  agent?: string;
  yes?: boolean;
  'allow-dirty'?: boolean;
  'agent-login'?: boolean;
}

/** What an agent run works on, after its checks and confirmation. `files` is empty with nothing to fix. */
export interface AgentRun {
  config: Config;
  launch: AgentLaunch;
  report: AuditReport;
  files: FileReport[];
}

/** Loads the config for the current directory. */
export function projectConfig(overrides?: ConfigOverrides): Promise<Config> {
  return loadConfig({ cwd: process.cwd(), overrides });
}

function parseNumber(
  flag: string,
  value: string,
  expected: string,
  isValid: (n: number) => boolean,
): number {
  const parsed = Number(value);
  if (value.trim() === '' || !isValid(parsed)) {
    throw new UserError(`${flag} must be ${expected}, got "${value}".`);
  }
  return parsed;
}

/** Parses comma-separated preset names, as `--preset` takes them. */
export function parsePresetList(value: string): string[] {
  const presets = value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (presets.length === 0) throw new UserError('--preset needs at least one preset name.');
  return presets;
}

/** Turns `--preset` and any presets named as arguments into the override for one run. */
export function presetOverride(flag: string | undefined, named: string[] = []): ConfigOverrides {
  const flagged = flag === undefined ? [] : parsePresetList(flag);
  const presets = [...new Set([...flagged, ...named])];
  return presets.length > 0 ? { presets } : {};
}

/** Tells preset names from paths, and stops on a near miss of a preset name. */
export async function splitPositionals(positionals: string[]) {
  const { root } = await projectConfig();
  const {
    presets: named,
    paths,
    shadowed,
    typos,
  } = await presetsInArgs(positionals, {
    root,
    cwd: process.cwd(),
  });
  const [typo, meant] = Object.entries(typos)[0] ?? [];
  if (typo !== undefined) {
    throw new UserError(`No file or preset named "${typo}". Did you mean the preset "${meant}"?`);
  }
  for (const name of shadowed) {
    console.error(
      withoutControlCharacters(
        `${name} is both a path and a preset, so it is audited as a path. For the preset, use --preset ${name}.`,
      ),
    );
  }
  return { named, paths };
}

/** Parses a flag that must be a positive integer. */
export function parseCount(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  return parseNumber(flag, value, 'a positive integer', (n) => Number.isInteger(n) && n > 0);
}

/** Parses a flag that must be a number of 0 or more. */
export function parseThreshold(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  return parseNumber(flag, value, 'a number of 0 or more', (n) => Number.isFinite(n) && n >= 0);
}

/** Reads `--format`, and `--json` as its alias. */
export function parseFormat(flags: { format?: string; json?: boolean }): OutputFormat {
  const { format = flags.json ? 'json' : 'text' } = flags;
  const known = OUTPUT_FORMATS.find((name) => name === format);
  if (!known) {
    throw new UserError(`--format must be one of ${OUTPUT_FORMATS.join(', ')}, got "${format}".`);
  }
  if (flags.json && known !== 'json') {
    throw new UserError(`--json means --format json, so it cannot go with --format ${known}.`);
  }
  return known;
}

/** Lets a path work from the current directory; anything else is tried from the root by audit. */
export function resolvePaths(paths: string[]): string[] | undefined {
  if (paths.length === 0) return undefined;
  return paths.map((path) => (existsSync(path) ? resolve(path) : path));
}

/** Warns on stderr, before any spinner or provider call, about a run wider than a project. */
export async function warnAboutScope(config: Config, paths?: string[]): Promise<void> {
  if (!paths && config.root === homedir()) {
    console.error(
      'Warning: running in your home directory, so every project under it is in scope. Run jevlint inside a project, or pass paths.',
    );
  }
  const { length } = await discoverFiles(config, paths);
  if (length > config.warn_file_count) {
    console.error(
      `Warning: ${length} files are in scope, which may be slow and costly. Narrow it with paths, include or exclude. Press Ctrl-C to stop.`,
    );
  }
}

/** Runs a task with a progress spinner when stderr is a terminal. */
export async function withSpinner<T>(
  task: (onProgress?: AuditOptions['onProgress']) => Promise<T>,
) {
  if (!process.stderr.isTTY) return task();
  const progress = spinner({ output: process.stderr, withGuide: false });
  progress.start('Auditing');
  try {
    return await task((done, total, path) =>
      progress.message(withoutControlCharacters(`${done}/${total} ${path}`)),
    );
  } finally {
    progress.clear();
  }
}

/** Explains why a run that wanted a model stayed on this machine. */
export function printNoKeyNotice({ provider: { name } }: Config): void {
  const variable = KEY_ENV[name];
  const fix = process.env[variable]
    ? `${variable} is set but not allowed. Run: jevlint auth env on`
    : `Run: jevlint auth set ${name}`;
  console.error(`No API key found for ${name}, running AST-only. ${fix}`);
}

/**
 * Stops a gated run that would lose its model only because nobody answered the environment key
 * question, as in CI. A user who answered no chose this, so their run goes ahead.
 */
export async function refuseUnansweredEnvKey(config: Config): Promise<void> {
  const variable = Object.values(KEY_ENV).find((name) => process.env[name]);
  if (!variable || (await envKeysAllowed()) !== undefined) return;
  if (await createDecisionModel(config)) return;
  throw new UserError(
    `${variable} is set but not allowed, so this gate would run without a model. Run: jevlint auth env on, or pass --ast-only.`,
  );
}

/** True when a model was in use and no file got an answer from it, so scores are AST-only. */
export function everyProviderCallFailed({ model, files }: AuditReport): boolean {
  const hitError = files.some(({ warnings }) =>
    warnings.some((warning) => warning.startsWith(PROVIDER_ERROR)),
  );
  return model !== null && hitError && !files.some((file) => file.model || file.ruleUsage);
}

/** Says when a run went to a provider other than the configured one. */
export function printFallbackNotice({ provider: { name } }: Config, used: string | null): void {
  if (used && used !== name) console.error(`No API key found for ${name}, using ${used}.`);
}

/** Runs an audit for a command: resolves paths, shows progress and prints the no-key notice. */
export async function auditProject(
  config: Config,
  { paths = [], ...options }: AuditOptions = {},
): Promise<AuditReport> {
  const resolvedPaths = resolvePaths(paths);
  await warnAboutScope(config, resolvedPaths);
  const report = await withSpinner((onProgress) =>
    audit(config, { ...options, paths: resolvedPaths, onProgress }),
  );
  if (report.model === null && !options.astOnly) printNoKeyNotice(config);
  printFallbackNotice(config, report.provider);
  if (paths.length > 0 && report.files.length === 0 && report.skipped.length === 0) {
    throw new UserError(
      `No files matched ${paths.join(', ')}. Check the path, and include and exclude in your config.`,
    );
  }
  return report;
}

/** Picks files with issues to work on: `top` if given, else every named file, else the first. */
export function selectFiles(
  report: AuditReport,
  named: string[],
  top: number | undefined,
): FileReport[] {
  const files = report.files.filter(hasIssues);
  return files.slice(0, top ?? (named.length > 0 ? files.length : 1));
}

async function confirmPlan(files: FileReport[], agent: string): Promise<void> {
  for (const { score, path } of withoutControlCharacters(files)) {
    console.error(`  ${formatScore(score)}  ${path}`);
  }
  const message = `Let ${agent} edit ${files.length === 1 ? 'this file' : `these ${files.length} files`}?`;
  if (!answered(await confirm({ message, ...PROMPT_IO }))) throw new UserError('Cancelled.');
}

const SHOWN_DIRTY_FILES = 5;

/**
 * Stops a run that git cannot protect: outside a repository, when git fails, or with uncommitted
 * changes under the root, naming the first few. Changes elsewhere in the repository do not count,
 * because the run only edits and commits files under the root.
 */
async function requireCleanTree(root: string, use: 'fix' | 'quickfix'): Promise<void> {
  const dirty = await dirtyFiles(root).catch((error: unknown) => {
    const reason = withoutControlCharacters(gitFailureReason(error));
    throw new UserError(
      `jevlint ${use} needs a git repository: ${reason}. Pass --allow-dirty to run anyway.`,
    );
  });
  if (dirty.length === 0) return;
  const shown = withoutControlCharacters(dirty.slice(0, SHOWN_DIRTY_FILES)).join(', ');
  const more =
    dirty.length > SHOWN_DIRTY_FILES ? ` and ${dirty.length - SHOWN_DIRTY_FILES} more` : '';
  throw new UserError(
    `The git working tree has uncommitted changes: ${shown}${more}. Commit or stash them, or pass --allow-dirty.`,
  );
}

/**
 * Prepares an agent run: checks the flags and the working tree, audits, picks the files and asks
 * before going on.
 */
export async function prepareAgentRun(
  args: AgentRunFlags,
  use: 'fix' | 'quickfix',
): Promise<AgentRun> {
  const top = parseCount('--top', args.top);
  const { named, paths } = await splitPositionals(args._);
  const config = await projectConfig(presetOverride(args.preset, named));
  const launch = launchAgent(config, args.agent, use, args['agent-login']);
  if (!args.yes && !process.stdin.isTTY) {
    throw new UserError(`Pass --yes to run ${use} outside a terminal.`);
  }
  if (!args['allow-dirty']) await requireCleanTree(config.root, use);
  const report = await auditProject(config, { paths });
  const files = selectFiles(report, paths, top);
  if (files.length > 0 && !args.yes) await confirmPlan(files, String(args.agent));
  return { config, launch, report, files };
}

/** Unwraps a clack answer, treating Ctrl-C as the end of the command. */
export function answered<T>(answer: T): Exclude<T, symbol> {
  if (isCancel(answer)) throw new UserError('Cancelled.');
  return answer as Exclude<T, symbol>;
}

/** Prints a value as the only JSON on stdout. */
export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
