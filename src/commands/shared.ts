/** Flag parsing, prompts and the audit flow shared by commands. */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { isCancel, spinner } from '@clack/prompts';
import { type AuditOptions, audit, PROVIDER_ERROR } from '../audit.ts';
import { type Config, type ConfigOverrides, loadConfig, UserError } from '../config.ts';
import { envKeysAllowed, KEY_ENV } from '../credentials.ts';
import { createDecisionModel } from '../decision/providers.ts';
import { discoverFiles } from '../files.ts';
import { OUTPUT_FORMATS, type OutputFormat } from '../formats.ts';
import { hasIssues } from '../prompt.ts';
import { withoutControlCharacters } from '../report.ts';
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

/** Unwraps a clack answer, treating Ctrl-C as the end of the command. */
export function answered<T>(answer: T): Exclude<T, symbol> {
  if (isCancel(answer)) throw new UserError('Cancelled.');
  return answer as Exclude<T, symbol>;
}

/** Prints a value as the only JSON on stdout. */
export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
