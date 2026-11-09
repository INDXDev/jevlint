/** Runs coding agents, then re-scores or diffs what they change. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { audit } from './audit.ts';
import { type Config, ifExists, readRegularFile, UserError } from './config.ts';
import type { FileChange } from './diff.ts';
import { fileAt, uncommittedFiles, workingTreeChanges } from './git.ts';
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

/** What a quick fix did: the agent's exit code and every file it changed. */
export interface QuickfixResult {
  code: number;
  changes: FileChange[];
  /** Files with uncommitted changes from before the run, which a commit must not take in. */
  uncommittedBefore: string[];
}

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
  const snapshot = new Map(
    await Promise.all(
      changedBefore.map(async (path) => [path, await contentOf(root, path)] as const),
    ),
  );
  const prompt = renderQuickfixPrompt(file, report);
  const code = await runAgent(launch.command, prompt, root, runOptions(launch, 'stderr'));
  const paths = [...new Set([...changedBefore, ...(await workingTreeChanges(root))])];
  const changes = await Promise.all(
    paths.map(async (path) => ({
      path,
      before: snapshot.has(path)
        ? (snapshot.get(path) ?? null)
        : ((await fileAt(root, 'HEAD', path)) ?? null),
      after: await contentOf(root, path),
    })),
  );
  return { code, changes, uncommittedBefore };
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
