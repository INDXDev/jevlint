/** Runs coding agents and re-scores what they change. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { audit } from './audit.ts';
import { type Config, UserError } from './config.ts';
import { renderPrompt } from './prompt.ts';
import type { AuditReport, FileReport } from './types.ts';

/** Looks up a configured agent's command, listing the options when the name is missing or unknown. */
export function resolveAgent(config: Config, name: string | undefined): string[] {
  const agent =
    name !== undefined && Object.hasOwn(config.agents, name) ? config.agents[name] : undefined;
  if (agent) return agent.command;
  const configured = Object.keys(config.agents).join(', ');
  const problem = name === undefined ? 'Pass --agent <name>.' : `Unknown agent "${name}".`;
  throw new UserError(`${problem} Configured agents: ${configured}`);
}

/** Runs an agent with the prompt on stdin, resolving to its exit code. Never uses a shell. */
export function runAgent(command: string[], prompt: string, cwd: string): Promise<number> {
  const [bin = '', ...args] = command;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', (error: NodeJS.ErrnoException) => {
      const missing = `Agent command not found: ${bin}. Install it, or change its command in your user config.`;
      reject(error.code === 'ENOENT' ? new UserError(missing) : error);
    });
    child.on('close', (code) => resolve(code ?? 1));
    // An agent may exit without reading its prompt, and its exit code tells that story better.
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
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
