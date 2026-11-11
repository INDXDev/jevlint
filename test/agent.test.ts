import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AgentLaunch,
  agentFailure,
  fixerPaths,
  fixFile,
  launchAgent,
  quickfixFile,
  runAgent,
  runFixers,
  TIMED_OUT_CODE,
} from '../src/agent.ts';
import { type Config, loadConfig, UserError } from '../src/config.ts';
import { diffFiles } from '../src/diff.ts';
import type { AuditReport, FileReport } from '../src/types.ts';

const node = (script: string) => [process.execPath, '-e', script];
const launch = (command: string[], extra: Partial<AgentLaunch> = {}): AgentLaunch => ({
  name: 'stub',
  command,
  keyEnv: [],
  login: false,
  ...extra,
});

describe('runAgent', () => {
  it('passes the prompt on stdin and returns the exit code', async () => {
    const script = `
      let input = '';
      process.stdin.on('data', (chunk) => (input += chunk));
      process.stdin.on('end', () => process.exit(input === 'fix it' ? 7 : 1));`;
    expect(await runAgent(node(script), 'fix it', process.cwd())).toBe(7);
  });

  it('runs in the given directory', async () => {
    const cwd = realpathSync(tmpdir());
    const script = `process.exit(process.cwd() === ${JSON.stringify(cwd)} ? 0 : 1)`;
    expect(await runAgent(node(script), '', cwd)).toBe(0);
  });

  it('survives an agent that ignores its prompt', async () => {
    expect(await runAgent(node('process.exit(3)'), 'x'.repeat(1_000_000), process.cwd())).toBe(3);
  });

  it('never interprets the command through a shell', async () => {
    const script = 'process.exit(process.argv[1] === "$(exit 9); ls" ? 0 : 1)';
    const command = [...node(script), '$(exit 9); ls'];
    expect(await runAgent(command, '', process.cwd())).toBe(0);
  });

  it('leaves the named variables out of the environment, whatever their case', async () => {
    vi.stubEnv('JEVLINT_TEST_KEY', 'secret');
    vi.stubEnv('JEVLINT_TEST_KEPT', 'kept');
    const script =
      'process.exit(!process.env.JEVLINT_TEST_KEY && process.env.JEVLINT_TEST_KEPT ? 0 : 1)';
    expect(
      await runAgent(node(script), '', process.cwd(), { unsetEnv: ['jevlint_test_key'] }),
    ).toBe(0);
    expect(await runAgent(node(script), '', process.cwd())).toBe(1);
    vi.unstubAllEnvs();
  });

  it('explains a missing command', async () => {
    const run = runAgent(['jevlint-no-such-agent'], '', process.cwd());
    await expect(run).rejects.toThrow(UserError);
    await expect(run).rejects.toThrow('Agent command not found: jevlint-no-such-agent');
  });
});

describe('fixFile', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns undefined when the agent deletes the file', async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'jevlint-agent-')));
    vi.stubEnv('XDG_CONFIG_HOME', root);
    await writeFile(join(root, 'gone.ts'), 'const a = 1;\n');
    const config = await loadConfig({ cwd: root });
    const file = { path: 'gone.ts', ast: null, model: null } as FileReport;
    const command = node("require('node:fs').rmSync('gone.ts')");
    const report = { presets: [] } as unknown as AuditReport;
    const after = await fixFile(file, report, config, launch(command));
    await rm(root, { recursive: true });
    expect(after).toBeUndefined();
  });
});

describe('launchAgent', () => {
  const config = {
    agents: {
      claude: { command: ['claude', '-p'], key_env: ['ANTHROPIC_API_KEY'] },
      quick: { command: ['a'], quickfix_command: ['a', '--max-turns', '3'], use_login: true },
    },
  } as unknown as Config;

  it('returns the command for each use', () => {
    expect(launchAgent(config, 'claude', 'fix').command).toEqual(['claude', '-p']);
    expect(launchAgent(config, 'claude', 'quickfix').command).toEqual(['claude', '-p']);
    expect(launchAgent(config, 'quick', 'quickfix').command).toEqual(['a', '--max-turns', '3']);
    expect(launchAgent(config, 'quick', 'fix').command).toEqual(['a']);
  });

  it('uses the agent login when the flag or the config asks', () => {
    expect(launchAgent(config, 'claude', 'fix')).toMatchObject({
      keyEnv: ['ANTHROPIC_API_KEY'],
      login: false,
    });
    expect(launchAgent(config, 'claude', 'fix', true).login).toBe(true);
    expect(launchAgent(config, 'quick', 'fix')).toMatchObject({ keyEnv: [], login: true });
  });

  it('lists agents when the name is missing or unknown', () => {
    expect(() => launchAgent(config, undefined, 'fix')).toThrow('Configured agents: claude, quick');
    expect(() => launchAgent(config, 'nope', 'fix')).toThrow('Unknown agent "nope"');
    expect(() => launchAgent(config, 'constructor', 'fix')).toThrow(UserError);
  });

  it('runs the built-in agents with few turns and file tools only', async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'jevlint-agent-')));
    vi.stubEnv('XDG_CONFIG_HOME', root);
    const defaults = await loadConfig({ cwd: root });
    vi.unstubAllEnvs();
    await rm(root, { recursive: true });
    const claude = launchAgent(defaults, 'claude', 'quickfix');
    expect(claude.command).toEqual(
      expect.arrayContaining(['--max-turns', '--tools', 'Read,Edit,Write,Glob,Grep']),
    );
    expect(claude.keyEnv).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
    const codex = launchAgent(defaults, 'codex', 'quickfix');
    expect(codex.command).toContain('model_reasoning_effort="low"');
    expect(codex.keyEnv).toEqual(['OPENAI_API_KEY', 'CODEX_API_KEY']);
  });
});

describe('agentFailure', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('points at --agent-login when a key in the environment may have replaced the login', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'bad');
    const { message } = agentFailure(
      launch([], { name: 'claude', keyEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] }),
      1,
      'a.ts',
    );
    expect(message).toContain('Agent exited with code 1 on a.ts.');
    expect(message).toContain(
      'ANTHROPIC_API_KEY is set, and claude uses it instead of its own login.',
    );
    expect(message).toContain('--agent-login');
    expect(message).toContain('use_login = true under [agents.claude]');
  });

  it('asks for a login when the keys were already left out', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'bad');
    const failed = launch([], { name: 'claude', keyEnv: ['ANTHROPIC_API_KEY'], login: true });
    expect(agentFailure(failed, 1, 'a.ts').message).toContain('Log in to claude once');
  });

  it('adds nothing when no key is set', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const { message } = agentFailure(launch([], { keyEnv: ['ANTHROPIC_API_KEY'] }), 2, 'a.ts');
    expect(message).toBe('Agent exited with code 2 on a.ts. Stopping.');
  });
});

describe('quickfixFile', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('diffs each file the agent touched against what it held just before the run', async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'jevlint-agent-')));
    vi.stubEnv('XDG_CONFIG_HOME', root);
    const git = (...args: string[]) =>
      spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
        cwd: root,
      });
    await writeFile(join(root, 'a.ts'), 'const a = 1;\n');
    git('init', '-q');
    git('add', '.');
    git('commit', '-qm', 'first');
    // Changed before the run, as an earlier file's run or --allow-dirty leaves them.
    await writeFile(join(root, 'mine.ts'), 'mine\n');
    await writeFile(join(root, 'untouched.ts'), 'mine too\n');
    const config = await loadConfig({ cwd: root });
    const file = { path: 'a.ts', ast: null, model: null } as FileReport;
    const script = `
      const fs = require('node:fs');
      fs.writeFileSync('a.ts', 'const a = 2;\\n');
      fs.writeFileSync('b.ts', 'const b = 1;\\n');
      fs.writeFileSync('mine.ts', 'agent\\n');
      process.exit(4);`;
    const report = { presets: [], scale: 100 } as unknown as AuditReport;
    const result = await quickfixFile(file, report, config, launch(node(script)));
    await rm(root, { recursive: true });
    expect(result.code).toBe(4);
    const changed = diffFiles(result.changes).map(({ path }) => path);
    expect(changed.toSorted()).toEqual(['a.ts', 'b.ts', 'mine.ts']);
    const byPath = (path: string) => result.changes.find((change) => change.path === path);
    expect(byPath('a.ts')).toEqual({
      path: 'a.ts',
      before: 'const a = 1;\n',
      after: 'const a = 2;\n',
    });
    expect(byPath('b.ts')).toEqual({ path: 'b.ts', before: null, after: 'const b = 1;\n' });
    expect(byPath('mine.ts')).toEqual({ path: 'mine.ts', before: 'mine\n', after: 'agent\n' });
    expect(result.changes[0]?.path).toBe('a.ts');
  });
});

describe('fixerPaths', () => {
  const paths = ['a.ts', 'src/b.tsx', 'c.py', '.hidden/d.ts'];

  it('takes every path with no patterns', () => {
    expect(fixerPaths({ command: ['x'] }, paths)).toEqual(paths);
  });

  it('takes the paths matching gitignore-style patterns', () => {
    expect(fixerPaths({ command: ['x'], files: ['**/*.ts', '*.tsx'] }, paths)).toEqual([
      'a.ts',
      'src/b.tsx',
      '.hidden/d.ts',
    ]);
    expect(fixerPaths({ command: ['x'], files: ['*.rs'] }, paths)).toEqual([]);
  });
});

describe('runFixers', () => {
  // Prints its arguments as JSON, then exits with the code.
  const echo = (code: number) =>
    node(`console.log(JSON.stringify(process.argv.slice(1))); process.exit(${code})`);

  it('appends each path as one argument, never through a shell', async () => {
    const cwd = realpathSync(tmpdir());
    const output: string[] = [];
    const runs = await runFixers(cwd, [{ command: echo(0) }], ['a;rm -rf x.ts', '$(id).ts'], {
      onOutput: (text) => output.push(text),
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.code).toBe(0);
    expect(JSON.parse(output.join(''))).toEqual(['./a;rm -rf x.ts', './$(id).ts']);
    expect(runs[0]?.output).toBe(output.join(''));
  });

  it('runs only fixers that match a path, and reports failures without throwing', async () => {
    const cwd = realpathSync(tmpdir());
    const started: string[][] = [];
    const runs = await runFixers(
      cwd,
      [
        { command: echo(3), retry: true },
        { command: echo(0), files: ['*.py'] },
        { command: ['jevlint-no-such-command'] },
      ],
      ['a.ts'],
      { onStart: (_, paths) => started.push(paths) },
    );
    expect(started).toEqual([['a.ts'], ['a.ts']]);
    expect(runs.map(({ code, retry }) => ({ code, retry }))).toEqual([
      { code: 3, retry: true },
      { code: 127, retry: false },
    ]);
    expect(runs[1]?.output).toContain('Command not found: jevlint-no-such-command');
  });

  it('stops a command that runs past its timeout, and counts it as failed', async () => {
    const cwd = realpathSync(tmpdir());
    const started = Date.now();
    const runs = await runFixers(
      cwd,
      [{ command: node('setTimeout(() => {}, 60000)'), timeout: 0.3, retry: true }],
      ['a.ts'],
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(runs[0]).toMatchObject({ code: TIMED_OUT_CODE, timedOut: true });
    expect(runs[0]?.output).toContain('Timed out after 0.3s');
  });
});
