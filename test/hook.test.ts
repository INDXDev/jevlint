import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { editedPath } from '../src/hook.ts';

// Each case starts a real process, which is slow while the whole suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 });

const CLI = join(import.meta.dirname, '../src/cli.ts');
const CLEAN = 'export const add = (a, b) => a + b;\n';
const MESSY = 'export function f(a, b, c, d, e, g) { return a + b + c + d + e + g; }\n';

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), 'jevlint-hook-')));

let dir: string;

const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd: dir,
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();

function write(files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

function commit(files: Record<string, string>): void {
  write(files);
  git('add', '.');
  git('commit', '-m', 'change');
}

/** Spawned with a temporary home, so a run cannot read real keys. */
function jevlintIn(cwd: string, input: string, ...args: string[]) {
  const home = tempDir();
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home };
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, input, encoding: 'utf8' });
}

const jevlint = (...args: string[]) => jevlintIn(dir, '', ...args);
const edited = (file_path: string) => JSON.stringify({ tool_input: { file_path } });
const afterEdit = (path: string) => jevlintIn(dir, edited(path), 'hook');

function expectSilentPass(result: ReturnType<typeof jevlint>): void {
  expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' });
}

beforeEach(() => {
  dir = tempDir();
  git('init', '-q', '-b', 'main');
});

describe('editedPath', () => {
  it('reads Claude Code and flat payloads', () => {
    expect(editedPath('{"tool_input":{"file_path":"a.ts"},"cwd":"/x"}')).toBe('a.ts');
    expect(editedPath('{"file_path":"a.ts"}')).toBe('a.ts');
  });

  it.each(['{}', '[]', 'null', '{"tool_input":{}}', '{"file_path":""}', '{"file_path":1}'])(
    'finds no path in %s',
    (text) => {
      expect(editedPath(text)).toBeUndefined();
    },
  );

  it('rejects invalid JSON', () => {
    expect(() => editedPath('not json')).toThrow('expects JSON');
  });
});

describe('jevlint hook after an edit', () => {
  it('tells the agent on stderr with exit 2 when the edit made the file worse', () => {
    commit({ 'a.ts': CLEAN });
    write({ 'a.ts': MESSY });
    const { status, stdout, stderr } = afterEdit(join(dir, 'a.ts'));
    expect(status).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('Edited a.ts');
    expect(stderr).toContain('Line 1');
  });

  it('accepts the flat shape and a path relative to the current directory', () => {
    commit({ 'src/a.ts': CLEAN });
    write({ 'src/a.ts': MESSY });
    const { status } = jevlintIn(join(dir, 'src'), '{"file_path":"a.ts"}', 'hook');
    expect(status).toBe(2);
  });

  it('reports every finding of a new file', () => {
    commit({ 'a.ts': CLEAN });
    write({ 'b.ts': MESSY });
    expect(afterEdit('b.ts').status).toBe(2);
  });

  it('stays silent when problems already at HEAD are unchanged', () => {
    commit({ 'a.ts': MESSY });
    write({ 'a.ts': `${MESSY}export const b = 1;\n` });
    expectSilentPass(afterEdit('a.ts'));
  });

  it('stays silent when the edit improved the file', () => {
    commit({ 'a.ts': MESSY });
    write({ 'a.ts': CLEAN });
    expectSilentPass(afterEdit('a.ts'));
  });

  it('applies .gitignore, exclude and the extension allowlist', () => {
    commit({ '.gitignore': 'ignored.ts\n', 'jevlint.toml': 'exclude = ["gen/**"]\n' });
    write({ 'ignored.ts': MESSY, 'gen/a.ts': MESSY, 'notes.txt': MESSY });
    expectSilentPass(afterEdit('ignored.ts'));
    expectSilentPass(afterEdit('gen/a.ts'));
    expectSilentPass(afterEdit('notes.txt'));
  });

  it('stays silent on a path it should not review', () => {
    const outside = tempDir();
    writeFileSync(join(outside, 'a.ts'), MESSY);
    commit({ 'src/a.ts': CLEAN });
    symlinkSync(join(outside, 'a.ts'), join(dir, 'link.ts'));
    expectSilentPass(afterEdit(join(outside, 'a.ts')));
    expectSilentPass(afterEdit('link.ts'));
    expectSilentPass(afterEdit('missing.ts'));
    expectSilentPass(afterEdit('src'));
    expectSilentPass(jevlintIn(dir, '{"tool_input":{"command":"ls"}}', 'hook'));
    expectSilentPass(jevlintIn(dir, edited('a\0.ts'), 'hook'));
  });

  it('stays silent outside a git repository, where there is no HEAD', () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, 'a.ts'), MESSY);
    expectSilentPass(jevlintIn(cwd, edited('a.ts'), 'hook'));
  });

  it('stops reading stdin at its limit and lets the edit pass', () => {
    expectSilentPass(jevlintIn(dir, ' '.repeat(33 * 1024 * 1024), 'hook'));
  });

  it('treats invalid JSON as a usage error', () => {
    const { status, stderr } = jevlintIn(dir, 'not json', 'hook');
    expect(status).toBe(2);
    expect(stderr).toContain('expects JSON');
  });

  it('wants a provider only with --model', () => {
    commit({ 'a.ts': CLEAN });
    write({ 'a.ts': MESSY });
    expect(jevlintIn(dir, edited('a.ts'), 'hook').stderr).not.toContain('No API key');
    expect(jevlintIn(dir, edited('a.ts'), 'hook', '--model').stderr).toContain('No API key');
  });
});

describe('jevlint hook --staged', () => {
  it('exits 1 with the report on stdout when the staged change made a file worse', () => {
    commit({ 'a.ts': CLEAN });
    write({ 'a.ts': MESSY });
    git('add', 'a.ts');
    const { status, stdout, stderr } = jevlint('hook', '--staged');
    expect(status).toBe(1);
    expect(stdout).toContain('Staged changes');
    expect(stdout).toContain('a.ts');
    expect(stderr).toContain('--no-verify');
  });

  it('reads the index, not the working tree', () => {
    commit({ 'a.ts': CLEAN, 'b.ts': MESSY });
    write({ 'a.ts': MESSY });
    expectSilentPass(jevlint('hook', '--staged'));
    write({ 'b.ts': CLEAN });
    git('add', 'b.ts');
    expectSilentPass(jevlint('hook', '--staged'));

    write({ 'c.ts': MESSY });
    git('add', 'c.ts');
    write({ 'c.ts': CLEAN });
    expect(jevlint('hook', '--staged').status).toBe(1);
  });

  it('treats everything as new before the first commit', () => {
    write({ 'src/a.ts': MESSY });
    git('add', '.');
    const { status, stdout } = jevlint('hook', '--staged');
    expect(status).toBe(1);
    expect(stdout).toContain('src/a.ts  new');
  });

  it('passes an empty index before the first commit', () => {
    expectSilentPass(jevlint('hook', '--staged'));
  });

  it('works with the config in a subdirectory of the repository', () => {
    commit({ 'pkg/jevlint.toml': '', 'pkg/a.ts': CLEAN, 'other.ts': CLEAN });
    write({ 'pkg/a.ts': MESSY, 'other.ts': MESSY });
    git('add', '.');
    const { status, stdout } = jevlintIn(join(dir, 'pkg'), '', 'hook', '--staged');
    expect(status).toBe(1);
    expect(stdout).toContain(' a.ts');
    expect(stdout).not.toContain('other.ts');
  });

  it('is a usage error outside a repository', () => {
    const { status, stderr } = jevlintIn(tempDir(), '', 'hook', '--staged');
    expect(status).toBe(2);
    expect(stderr).toContain('Could not read the index');
  });
});

describe('jevlint init --pre-commit', () => {
  const hook = () => join(dir, '.git/hooks/pre-commit');

  it('installs an executable hook and nothing else', () => {
    const { status, stderr } = jevlint('init', '--pre-commit');
    expect(status).toBe(0);
    expect(stderr).toContain(hook());
    expect(readFileSync(hook(), 'utf8')).toContain('exec jevlint hook --staged');
    expect(lstatSync(hook()).mode & 0o111).toBe(0o111);
    expect(existsSync(join(dir, 'jevlint.toml'))).toBe(false);
  });

  it('leaves a plain init without a hook', () => {
    jevlint('init', '--yes');
    expect(existsSync(join(dir, 'jevlint.toml'))).toBe(true);
    expect(existsSync(hook())).toBe(false);
  });

  it('runs again without --force, but keeps a different hook unless forced', () => {
    expect(jevlint('init', '--pre-commit').status).toBe(0);
    expect(jevlint('init', '--pre-commit').status).toBe(0);

    writeFileSync(hook(), '#!/bin/sh\necho mine\n');
    const { status, stderr } = jevlint('init', '--pre-commit');
    expect(status).toBe(2);
    expect(stderr).toContain('--force');
    expect(readFileSync(hook(), 'utf8')).toContain('echo mine');

    expect(jevlint('init', '--pre-commit', '--force').status).toBe(0);
    expect(readFileSync(hook(), 'utf8')).toContain('jevlint hook');
  });

  it('replaces a planted symlink rather than writing through it', () => {
    const target = join(tempDir(), 'victim');
    writeFileSync(target, 'precious');
    mkdirSync(join(dir, '.git/hooks'), { recursive: true });
    symlinkSync(target, hook());
    expect(jevlint('init', '--pre-commit').status).toBe(2);
    expect(jevlint('init', '--pre-commit', '--force').status).toBe(0);
    expect(lstatSync(hook()).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('precious');
  });

  it('refuses a core.hooksPath outside the repository', () => {
    const outside = tempDir();
    git('config', 'core.hooksPath', outside);
    const { status, stderr } = jevlint('init', '--pre-commit', '--force');
    expect(status).toBe(2);
    expect(stderr).toContain('outside the repository');
    expect(existsSync(join(outside, 'pre-commit'))).toBe(false);
  });

  it('cannot be talked out of that by other repository config', () => {
    const outside = tempDir();
    git('config', 'core.hooksPath', `${outside}\n${outside}`);
    expect(jevlint('init', '--pre-commit', '--force').status).toBe(2);
    git('config', 'core.hooksPath', outside);
    git('config', 'core.worktree', outside);
    expect(jevlint('init', '--pre-commit', '--force').status).toBe(2);
    expect(existsSync(join(outside, 'pre-commit'))).toBe(false);
  });

  it('refuses a hooks directory that a symlink leads out of the repository', () => {
    const outside = tempDir();
    symlinkSync(outside, join(dir, 'hooks'));
    git('config', 'core.hooksPath', 'hooks/sub/dir');
    expect(jevlint('init', '--pre-commit', '--force').status).toBe(2);
    expect(existsSync(join(outside, 'sub'))).toBe(false);
  });

  it('accepts a core.hooksPath inside the repository, creating it if needed', () => {
    git('config', 'core.hooksPath', '.githooks');
    expect(jevlint('init', '--pre-commit').status).toBe(0);
    expect(existsSync(join(dir, '.githooks/pre-commit'))).toBe(true);
  });

  it('installs from a linked worktree, whose hooks live in the main repository', () => {
    commit({ 'a.ts': CLEAN });
    const linked = join(tempDir(), 'linked');
    git('worktree', 'add', '-q', linked);
    expect(jevlintIn(linked, '', 'init', '--pre-commit').status).toBe(0);
    expect(existsSync(hook())).toBe(true);
  });

  it('is a usage error outside a repository', () => {
    const { status, stderr } = jevlintIn(tempDir(), '', 'init', '--pre-commit');
    expect(status).toBe(2);
    expect(stderr).toContain('needs a git repository');
  });

  it('stops a real commit that makes a file worse', () => {
    commit({ 'a.ts': CLEAN });
    const bin = tempDir();
    const shim = join(bin, 'jevlint');
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
    chmodSync(shim, 0o755);
    expect(jevlint('init', '--pre-commit').status).toBe(0);
    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` };
    const commitAll = () =>
      spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.com', 'commit', '-qam', 'm'], {
        cwd: dir,
        env,
        encoding: 'utf8',
      });

    write({ 'a.ts': MESSY });
    const blocked = commitAll();
    expect(blocked.status).toBe(1);
    // git sends a hook's stdout to stderr.
    expect(blocked.stderr).toContain('a.ts');

    write({ 'a.ts': 'export const add = (a, b) => b + a;\n' });
    expect(commitAll().status).toBe(0);
  });
});

describe('Claude Code plugin', () => {
  const root = join(import.meta.dirname, '..');
  const json = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));

  it('names the same plugin in its manifest and marketplace', () => {
    const plugin = json('.claude-plugin/plugin.json');
    const marketplace = json('.claude-plugin/marketplace.json');
    expect(marketplace.name).toBe('jevlint');
    expect(marketplace.plugins.map(({ name }: { name: string }) => name)).toEqual([plugin.name]);
  });

  it('keeps the edit hook off until the user turns it on', () => {
    const { userConfig } = json('.claude-plugin/plugin.json');
    expect(userConfig.edit_hook.default).toBe(false);
    const { hooks } = json('hooks/hooks.json');
    const [{ command }] = hooks.PostToolUse[0].hooks;
    expect(command).toContain('CLAUDE_PLUGIN_OPTION_EDIT_HOOK');
    // npx would prefer a copy in the audited repository's node_modules.
    expect(command).not.toContain('npx');
  });
});
