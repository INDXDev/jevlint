/** Runs coding agents, then re-scores or diffs what they change. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { audit } from './audit.ts';
import { type Config, ifExists, readRegularFile, UserError } from './config.ts';
import type { FileChange } from './diff.ts';
import { fileAt, workingTreeChanges } from './git.ts';
import { renderPrompt, renderQuickfixPrompt } from './prompt.ts';
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

/** Looks up a configured agent's command, listing the options when the name is missing or unknown. */
export const resolveAgent = (config: Config, name: string | undefined): string[] =>
  findAgent(config, name).command;

/** Looks up the command `quickfix` runs: the agent's `quickfix_command`, else its `command`. */
export function resolveQuickfixAgent(config: Config, name: string | undefined): string[] {
  const { command, quickfix_command } = findAgent(config, name);
  return quickfix_command ?? command;
}

/** Where an agent's own output goes. `stderr` keeps stdout for jevlint's results. */
export type AgentOutput = 'inherit' | 'stderr';

/** Runs an agent with the prompt on stdin, resolving to its exit code. Never uses a shell. */
export function runAgent(
  command: string[],
  prompt: string,
  cwd: string,
  output: AgentOutput = 'inherit',
): Promise<number> {
  const [bin = '', ...args] = command;
  const stdout = output === 'stderr' ? 2 : 'inherit';
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ['pipe', stdout, 'inherit'] });
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

/** Runs an agent on one file and returns its fresh report, or undefined if the file is gone. */
export async function fixFile(
  file: FileReport,
  report: AuditReport,
  config: Config,
  command: string[],
): Promise<FileReport | undefined> {
  const code = await runAgent(command, renderPrompt([file], report), config.root);
  if (code !== 0) throw new UserError(`Agent exited with code ${code} on ${file.path}. Stopping.`);
  // audit() rejects a named path that does not exist.
  if (!existsSync(join(config.root, file.path))) return undefined;
  const { files } = await audit(config, { paths: [file.path] });
  return files[0];
}

const contentOf = async (root: string, path: string) =>
  (await ifExists(readRegularFile(join(root, path)))) ?? null;

/** What a quick fix did: the agent's exit code, and every file it changed. */
export interface QuickfixResult {
  code: number;
  changes: FileChange[];
}

/**
 * Runs an agent on one file with an edit-only prompt, and collects what changed. Other files are
 * found through git and compared with HEAD, so one that was already changed is not seen.
 */
export async function quickfixFile(
  file: FileReport,
  report: AuditReport,
  config: Config,
  command: string[],
): Promise<QuickfixResult> {
  const { root } = config;
  const changedBefore = new Set(await workingTreeChanges(root));
  const before = await contentOf(root, file.path);
  const code = await runAgent(command, renderQuickfixPrompt(file, report), root, 'stderr');
  const others = (await workingTreeChanges(root)).filter(
    (path) => path !== file.path && !changedBefore.has(path),
  );
  const changes = await Promise.all(
    others.map(async (path) => ({
      path,
      before: (await fileAt(root, 'HEAD', path)) ?? null,
      after: await contentOf(root, path),
    })),
  );
  const target = { path: file.path, before, after: await contentOf(root, file.path) };
  return { code, changes: [target, ...changes] };
}
