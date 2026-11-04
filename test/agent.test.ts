import { realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixFile, resolveAgent, runAgent } from '../src/agent.ts';
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
