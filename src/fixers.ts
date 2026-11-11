/** Runs the project's `quickfix.after` commands on changed files, without a shell. */
import { spawn } from 'node:child_process';
import ignore from 'ignore';
import type { Fixer } from './config.ts';

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
export const needsRetry = ({ retry, code, timedOut }: FixerRun) => retry && code !== 0 && !timedOut;

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
