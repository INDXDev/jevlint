import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fixFile,
  quickfixFile,
  resolveAgent,
  resolveQuickfixAgent,
  runAgent,
} from '../src/agent.ts';
import { type Config, loadConfig, UserError } from '../src/config.ts';
import type { AuditReport, FileReport } from '../src/types.ts';

const node = (script: string) => [process.execPath, '-e', script];

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
    const after = await fixFile(file, { presets: [] } as unknown as AuditReport, config, command);
    await rm(root, { recursive: true });
    expect(after).toBeUndefined();
  });
});

describe('resolveAgent', () => {
  const config = { agents: { claude: { command: ['claude', '-p'] } } } as unknown as Config;

  it('returns the configured command', () => {
    expect(resolveAgent(config, 'claude')).toEqual(['claude', '-p']);
  });

  it('lists agents when the name is missing or unknown', () => {
    expect(() => resolveAgent(config, undefined)).toThrow('Configured agents: claude');
    expect(() => resolveAgent(config, 'nope')).toThrow('Unknown agent "nope"');
    expect(() => resolveAgent(config, 'constructor')).toThrow(UserError);
  });
});

describe('resolveQuickfixAgent', () => {
  it('prefers quickfix_command, and falls back to command', () => {
    const config = {
      agents: {
        quick: { command: ['a'], quickfix_command: ['a', '--max-turns', '3'] },
        plain: { command: ['b'] },
      },
    } as unknown as Config;
    expect(resolveQuickfixAgent(config, 'quick')).toEqual(['a', '--max-turns', '3']);
    expect(resolveQuickfixAgent(config, 'plain')).toEqual(['b']);
    expect(() => resolveQuickfixAgent(config, 'nope')).toThrow('Unknown agent "nope"');
  });

  it('runs the built-in agents with few turns and file tools only', async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'jevlint-agent-')));
    vi.stubEnv('XDG_CONFIG_HOME', root);
    const config = await loadConfig({ cwd: root });
    vi.unstubAllEnvs();
    await rm(root, { recursive: true });
    expect(resolveQuickfixAgent(config, 'claude')).toEqual(
      expect.arrayContaining(['--max-turns', '--tools', 'Read,Edit,Write,Glob,Grep']),
    );
    expect(resolveQuickfixAgent(config, 'codex')).toContain('model_reasoning_effort="low"');
  });
});

describe('quickfixFile', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns the edited file and the files the agent added, not ones changed before', async () => {
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
    await writeFile(join(root, 'mine.ts'), 'mine\n');
    const config = await loadConfig({ cwd: root });
    const file = { path: 'a.ts', ast: null, model: null } as FileReport;
    const script = `
      const fs = require('node:fs');
      fs.writeFileSync('a.ts', 'const a = 2;\\n');
      fs.writeFileSync('b.ts', 'const b = 1;\\n');
      fs.writeFileSync('mine.ts', 'agent\\n');
      process.exit(4);`;
    const report = { presets: [], scale: 100 } as unknown as AuditReport;
    const result = await quickfixFile(file, report, config, node(script));
    await rm(root, { recursive: true });
    expect(result.code).toBe(4);
    expect(result.changes.toSorted((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: 'a.ts', before: 'const a = 1;\n', after: 'const a = 2;\n' },
      { path: 'b.ts', before: null, after: 'const b = 1;\n' },
    ]);
  });
});
