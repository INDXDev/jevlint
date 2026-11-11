/** Runs coding agents and the project's fixers, then re-scores or diffs what they change. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import ignore from 'ignore';
import { audit } from './audit.ts';
import { type Config, type Fixer, ifExists, readRegularFile, UserError } from './config.ts';
import type { FileChange } from './diff.ts';
import { fileAt, uncommittedFiles, workingTreeChanges } from './git.ts';
import {
  type FailedCheck,
  renderPrompt,
  renderQuickfixPrompt,
  renderRetryPrompt,
} from './prompt.ts';
import type { AuditReport, FileReport } from './types.ts';

type Agent = Config['agents'][string];

function findAgent(config: Config, name: string | undefined): Agent {
  const agent =
    name !== undefined && Object.hasOwn(config.agents, name) ? config.agents[name] : undefined;
  if (agent) return agent;
  const configured = Object.keys(config.agents).join(', ');
  const problem = name === undefined ? 'Pass --agent <name>.' : `Unknown agent "${name}".`;
  throw new UserError(`${problem} Configured agents: ${configured}`);
}

/** How to start an agent, for `fix` or `quickfix`. */
export interface AgentLaunch {
  name: string;
  command: string[];
  /** Variables with an API key that would take the place of the agent's own login. */
  keyEnv: string[];
  /** True when `keyEnv` is left out of the agent's environment, so it uses its own login. */
  login: boolean;
}

/**
 * Looks up how to start an agent, listing the options when the name is missing or unknown.
 * `quickfix` runs `quickfix_command` when there is one, and `login` forces the agent's own login.
 */
export function launchAgent(
  config: Config,
  name: string | undefined,
  use: 'fix' | 'quickfix',
  login = false,
): AgentLaunch {
  const agent = findAgent(config, name);
  const command = use === 'quickfix' ? (agent.quickfix_command ?? agent.command) : agent.command;
  const keyEnv = agent.key_env ?? [];
  return { name: name as string, command, keyEnv, login: login || agent.use_login === true };
}

/** How `runAgent` starts the agent. */
export interface RunAgentOptions {
  /** `stderr` sends the agent's output there, keeping stdout for jevlint's results. */
  output?: 'inherit' | 'stderr';
  /** Variables to leave out of the agent's environment. */
  unsetEnv?: string[];
}

/** Windows names variables without regard to case, so `Anthropic_Api_Key` must go too. */
function envWithout(names: string[]): NodeJS.ProcessEnv {
  const unset = new Set(names.map((name) => name.toUpperCase()));
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !unset.has(name.toUpperCase())),
  );
}

/** Runs an agent with the prompt on stdin, resolving to its exit code. Never uses a shell. */
export function runAgent(
  command: string[],
  prompt: string,
  cwd: string,
  { output = 'inherit', unsetEnv = [] }: RunAgentOptions = {},
): Promise<number> {
  const [bin = '', ...args] = command;
  const stdout = output === 'stderr' ? 2 : 'inherit';
  const env = envWithout(unsetEnv);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ['pipe', stdout, 'inherit'] });
    child.on('error', (error: NodeJS.ErrnoException) => {
      const missing = `Agent command not found: ${bin}. Install it, or change its command in your user config.`;
      reject(error.code === 'ENOENT' ? new UserError(missing) : error);
    });
    child.on('close', (code) => resolve(code ?? 1));
    // An agent may exit without reading its prompt, and its exit code tells that story better.
    child.stdin?.on('error', () => {});
    child.stdin?.end(prompt);
  });
}

/**
 * Explains a failed agent. An API key in the environment is the usual cause, because an agent
 * prefers it to the login of a subscription, so the hint says how to leave it out.
 */
export function agentFailure(
  launch: AgentLaunch,
  code: number,
  path: string,
  note = '',
): UserError {
  const keys = launch.login ? [] : launch.keyEnv.filter((name) => process.env[name]);
  const hint =
    keys.length > 0
      ? ` ${keys.join(' and ')} ${keys.length === 1 ? 'is' : 'are'} set, and ${launch.name} uses ${keys.length === 1 ? 'it' : 'them'} instead of its own login. If the key was rejected, retry with --agent-login, or set use_login = true under [agents.${launch.name}] in your user config.`
      : launch.login
        ? ` It ran without the API keys in your environment, so it needs its own login. Log in to ${launch.name} once, outside jevlint.`
        : '';
  return new UserError(`Agent exited with code ${code} on ${path}.${note}${hint} Stopping.`);
}

const runOptions = (launch: AgentLaunch, output?: RunAgentOptions['output']) => ({
  output,
  unsetEnv: launch.login ? launch.keyEnv : [],
});

/** Runs an agent on one file and returns its fresh report, or undefined if the file is gone. */
export async function fixFile(
  file: FileReport,
  report: AuditReport,
  config: Config,
  launch: AgentLaunch,
): Promise<FileReport | undefined> {
  const prompt = renderPrompt([file], report);
  const code = await runAgent(launch.command, prompt, config.root, runOptions(launch));
  if (code !== 0) throw agentFailure(launch, code, file.path);
  // audit() rejects a named path that does not exist.
  if (!existsSync(join(config.root, file.path))) return undefined;
  const { files } = await audit(config, { paths: [file.path] });
  return files[0];
}

const contentOf = async (root: string, path: string) =>
  (await ifExists(readRegularFile(join(root, path)))) ?? null;

/** File contents from before a quick fix, to diff against. A null content is no file. */
export type Snapshot = Map<string, string | null>;

/** What a quick fix did: the agent's exit code and every file it changed. */
export interface QuickfixResult {
  code: number;
  changes: FileChange[];
  /** Files with uncommitted changes from before the run, which a commit must not take in. */
  uncommittedBefore: string[];
  /** The files as they were before the run, for `collectChanges` after a later step. */
  snapshot: Snapshot;
}

/**
 * Lists every file that differs from before the run: the snapshot's files, and any other file
 * in the working tree, compared with HEAD.
 */
export async function collectChanges(root: string, snapshot: Snapshot): Promise<FileChange[]> {
  const paths = [...new Set([...snapshot.keys(), ...(await workingTreeChanges(root))])];
  return Promise.all(
    paths.map(async (path) => ({
      path,
      before: snapshot.has(path)
        ? (snapshot.get(path) ?? null)
        : ((await fileAt(root, 'HEAD', path)) ?? null),
      after: await contentOf(root, path),
    })),
  );
}

/** The paths a run left with new content, leaving out deleted and unchanged files. */
export const editedPaths = (changes: FileChange[]): string[] =>
  changes.filter(({ before, after }) => after !== null && after !== before).map(({ path }) => path);

/**
 * Runs an agent on one file with an edit-only prompt, and collects what changed. Files that
 * already had changes are read first, so an earlier run's edits are not counted again. Every other
 * file is compared with HEAD.
 */
export async function quickfixFile(
  file: FileReport,
  report: AuditReport,
  config: Config,
  launch: AgentLaunch,
): Promise<QuickfixResult> {
  const { root } = config;
  const uncommittedBefore = await uncommittedFiles(root);
  const changedBefore = [...new Set([file.path, ...uncommittedBefore])];
  const snapshot: Snapshot = new Map(
    await Promise.all(
      changedBefore.map(async (path) => [path, await contentOf(root, path)] as const),
    ),
  );
  const prompt = renderQuickfixPrompt(file, report);
  const code = await runAgent(launch.command, prompt, root, runOptions(launch, 'stderr'));
  const changes = await collectChanges(root, snapshot);
  return { code, changes, uncommittedBefore, snapshot };
}

/** Runs the agent once more, with only the output of the checks that still fail. */
export function retryQuickfix(
  config: Config,
  launch: AgentLaunch,
  paths: string[],
  failures: FailedCheck[],
): Promise<number> {
  const prompt = renderRetryPrompt(paths, failures);
  return runAgent(launch.command, prompt, config.root, runOptions(launch, 'stderr'));
}

/** How much of a fixer's output is kept for the retry prompt, from the end. */
const FIXER_OUTPUT_KEPT = 64 * 1024;
/** How long a fixer may run when its entry sets no `timeout`. */
export const DEFAULT_FIXER_TIMEOUT_SECONDS = 300;
/** The exit code of a fixer stopped for running too long, as `timeout(1)` reports it. */
export const TIMED_OUT_CODE = 124;
/** The longest delay `setTimeout` takes. A longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** One fixer that ran: its command, exit code and the end of what it printed. */
export interface FixerRun {
  command: string[];
  code: number;
  /** True when a failure asks the agent to fix what the command printed. */
  retry: boolean;
  /** True when it ran past its timeout and was killed. */
  timedOut: boolean;
  /** Its stdout and stderr together, as printed, keeping the end. */
  output: string;
}

/** A failure the agent can fix: a `retry` check that exited non-zero, not one that hung. */
const needsRetry = ({ retry, code, timedOut }: FixerRun) => retry && code !== 0 && !timedOut;

/** Picks the paths a fixer takes: those matching its `files` patterns, or all of them. */
export function fixerPaths(fixer: Fixer, paths: string[]): string[] {
  if (fixer.files === undefined) return paths;
  const matcher = ignore().add(fixer.files);
  return paths.filter((path) => matcher.ignores(path));
}

/** Reports a fixer's progress to the interface layer, which decides what to print. */
export interface FixerEvents {
  onStart?: (command: string[], paths: string[]) => void;
  /** Output as the command prints it, stdout and stderr alike. */
  onOutput?: (text: string) => void;
}

function runFixer(
  fixer: Fixer,
  paths: string[],
  root: string,
  { onOutput }: FixerEvents,
): Promise<{ code: number; output: string; timedOut: boolean }> {
  const [bin = '', ...args] = fixer.command;
  const seconds = fixer.timeout ?? DEFAULT_FIXER_TIMEOUT_SECONDS;
  // `./`, so a file named like an option reaches the tool as a path.
  const argv = [...args, ...paths.map((path) => `./${path}`)];
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const keep = (text: string) => {
      onOutput?.(text);
      output = `${output}${text}`.slice(-FIXER_OUTPUT_KEPT);
    };
    const child = spawn(bin, argv, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (code: number, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    };
    const timer = setTimeout(
      () => {
        keep(`Timed out after ${seconds}s, so jevlint stopped it.\n`);
        child.kill('SIGKILL');
        // A process it started may still hold the pipes open, so do not wait for them to close.
        child.stdout.destroy();
        child.stderr.destroy();
        finish(TIMED_OUT_CODE, true);
      },
      Math.min(seconds * 1000, MAX_TIMER_MS),
    );
    child.stdout.setEncoding('utf8').on('data', keep);
    child.stderr.setEncoding('utf8').on('data', keep);
    child.on('error', (error: NodeJS.ErrnoException) => {
      keep(error.code === 'ENOENT' ? `Command not found: ${bin}\n` : `${error.message}\n`);
      // 127 is what a shell reports for a missing command.
      finish(error.code === 'ENOENT' ? 127 : 1);
    });
    child.on('close', (code) => finish(code ?? 1));
  });
}

/**
 * Runs each fixer, in order and never through a shell, on the paths it matches, with the paths
 * appended to its command. A fixer that matches no path does not run. A failing or hung fixer
 * does not throw: its exit code is in the result.
 */
export async function runFixers(
  root: string,
  fixers: Fixer[],
  paths: string[],
  events: FixerEvents = {},
): Promise<FixerRun[]> {
  const runs: FixerRun[] = [];
  for (const fixer of fixers) {
    const matched = fixerPaths(fixer, paths);
    if (matched.length === 0) continue;
    events.onStart?.(fixer.command, matched);
    const { code, output, timedOut } = await runFixer(fixer, matched, root, events);
    runs.push({ command: fixer.command, code, retry: fixer.retry === true, timedOut, output });
  }
  return runs;
}

/** The paths whose content in `later` differs from `earlier`, or from before the run. */
function changedSince(earlier: FileChange[], later: FileChange[]): string[] {
  const contents = new Map(earlier.map(({ path, after }) => [path, after]));
  return later
    .filter(
      ({ path, before, after }) => (contents.has(path) ? contents.get(path) : before) !== after,
    )
    .map(({ path }) => path);
}

/** Reports a quick fix's steps after the agent to the interface layer. */
export interface QuickfixEvents extends FixerEvents {
  /** A fixer exited non-zero or timed out. */
  onFixerFailed?: (run: FixerRun) => void;
  /** Checks marked `retry` failed, so the agent runs once more. */
  onRetry?: (failing: FixerRun[]) => void;
  /** Checks marked `retry` still fail after the one retry. */
  onStillFailing?: (failing: FixerRun[]) => void;
}

/** The fixers a quick fix runs after the agent, and how to tell whether they may still run. */
export interface QuickfixOptions {
  fixers: Fixer[];
  /** Asked before each round of fixers. False skips that round, as when an approval lapsed. */
  fixersAllowed?: () => Promise<boolean>;
  events?: QuickfixEvents;
}

/** A quick fix with the project's fixers: what ran after the agent, and what the agent edited. */
export interface FixedQuickfix extends QuickfixResult {
  /** Each fixer's last run. */
  fixers: FixerRun[];
  /** The failing checks that gave the agent its one retry. Empty when it had none. */
  retriedFor: FixerRun[];
  /** The paths the agent itself changed. Any other changed path, only a fixer changed. */
  agentPaths: string[];
}

/**
 * Runs a quick fix, then the fixers on the files the agent edited. When a check marked `retry`
 * still fails, the agent gets one more run with its output, and the fixers run again. The changes
 * cover the whole run.
 */
export async function quickfixWithFixers(
  file: FileReport,
  report: AuditReport,
  config: Config,
  launch: AgentLaunch,
  { fixers, fixersAllowed, events = {} }: QuickfixOptions,
): Promise<FixedQuickfix> {
  const { root } = config;
  const first = await quickfixFile(file, report, config, launch);
  const agentPaths = new Set(changedSince([], first.changes));
  const done = (code: number, changes: FileChange[], runs: FixerRun[], retriedFor: FixerRun[]) => ({
    ...first,
    code,
    changes,
    fixers: runs,
    retriedFor,
    agentPaths: [...agentPaths],
  });
  const agentEdited = (changes: FileChange[]) =>
    editedPaths(changes).filter((path) => agentPaths.has(path));
  const fix = async (changes: FileChange[]) => {
    const paths = agentEdited(changes);
    if (paths.length === 0 || (fixersAllowed && !(await fixersAllowed()))) return [];
    const runs = await runFixers(root, fixers, paths, events);
    for (const run of runs.filter(({ code }) => code !== 0)) events.onFixerFailed?.(run);
    return runs;
  };
  if (first.code !== 0 || fixers.length === 0) return done(first.code, first.changes, [], []);
  const runs = await fix(first.changes);
  const fixed = await collectChanges(root, first.snapshot);
  const failing = runs.filter(needsRetry);
  if (failing.length === 0) return done(0, fixed, runs, []);
  events.onRetry?.(failing);
  const code = await retryQuickfix(config, launch, agentEdited(fixed), failing);
  const retried = await collectChanges(root, first.snapshot);
  for (const path of changedSince(fixed, retried)) agentPaths.add(path);
  if (code !== 0) return done(code, retried, runs, failing);
  const rerun = await fix(retried);
  const still = rerun.filter(needsRetry);
  if (still.length > 0) events.onStillFailing?.(still);
  return done(code, await collectChanges(root, first.snapshot), rerun, failing);
}

/** Re-audits files an agent left behind, keyed by path. A file no audit covers has no entry. */
export async function rescoreFiles(
  config: Config,
  paths: string[],
): Promise<Map<string, FileReport>> {
  if (paths.length === 0) return new Map();
  const { files } = await audit(config, { paths });
  return new Map(files.map((scored) => [scored.path, scored]));
}
