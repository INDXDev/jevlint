import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Config, loadConfig } from '../src/config.ts';
import { reviewChange, worseFindings } from '../src/review.ts';

const CLEAN = 'export const add = (a, b) => a + b;\n';
const MESSY = 'export function f(a, b, c, d, e, g) { return a + b + c + d + e + g; }\n';
const MESSIER = 'export function f(a, b, c, d, e, g, h, i) { return a + h + i; }\n';

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), 'jevlint-review-test-')));

let dir: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

function commit(files: Record<string, string>, message = 'change'): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

const config = (cwd = dir): Promise<Config> => loadConfig({ cwd });

const review = async (base: string | null, head: string) =>
  reviewChange(await config(), { title: 't', base, head }, { astOnly: true });

beforeEach(() => {
  dir = tempDir();
  git(dir, 'init', '-q', '-b', 'main');
  // Keeps the tests off any real user config.
  vi.stubEnv('XDG_CONFIG_HOME', dir);
  writeFileSync(join(dir, 'jevlint.toml'), '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('worseFindings', () => {
  it('reports only the extra hit when a semantic rule hits once more', () => {
    const hit = (line: number, probability: number) => ({
      rule: 'r',
      message: 'm',
      line,
      probability,
    });
    expect(worseFindings([hit(5, 0.9)], [hit(1, 0.8)])).toEqual([]);
    expect(worseFindings([hit(1, 0.9), hit(5, 0.9)], [hit(1, 0.8)])).toHaveLength(1);
  });

  const finding = (line: number, value?: number, symbol?: string) => ({
    rule: 'params',
    message: `m${value}`,
    line,
    symbol,
    value,
  });

  it('drops a finding that only moved', () => {
    expect(worseFindings([finding(9, 6, 'f')], [finding(1, 6, 'f')])).toEqual([]);
  });

  it('drops a finding that improved, and keeps one that got worse', () => {
    expect(worseFindings([finding(1, 5, 'f')], [finding(1, 6, 'f')])).toEqual([]);
    expect(worseFindings([finding(1, 7, 'f')], [finding(1, 6, 'f')])).toHaveLength(1);
  });

  it('counts repeats, so one more match of a pattern is new', () => {
    expect(worseFindings([finding(1), finding(2)], [finding(1)])).toHaveLength(1);
  });
});

describe('reviewChange', () => {
  it('reports only what the change made worse, at the commits rather than the working tree', async () => {
    const base = commit({ 'old.ts': MESSY, 'a.ts': MESSY });
    const head = commit({ 'a.ts': MESSIER, 'new.ts': MESSY });
    writeFileSync(join(dir, 'a.ts'), CLEAN);

    const { files } = await review(base, head);

    expect(files.map(({ path }) => path).sort()).toEqual(['a.ts', 'new.ts']);
    const modified = files.find(({ path }) => path === 'a.ts');
    expect(modified?.before).toBeGreaterThanOrEqual(modified?.after as number);
    expect(modified?.findings.map(({ value }) => value)).toEqual([8]);
    expect(files.find(({ path }) => path === 'new.ts')?.before).toBeNull();
  });

  it('leaves out a pre-existing finding in a file the change only added to', async () => {
    const base = commit({ 'a.ts': MESSY });
    const head = commit({ 'a.ts': `${MESSY}${CLEAN}` });
    expect((await review(base, head)).files[0]?.findings).toEqual([]);
  });

  it('leaves out deleted files, and treats a root commit as all new', async () => {
    const root = commit({ 'a.ts': MESSY, 'b.ts': CLEAN });
    git(dir, 'rm', '-q', 'b.ts');
    const head = commit({ 'a.ts': MESSIER });

    expect((await review(root, head)).files.map(({ path }) => path)).toEqual(['a.ts']);
    const { files } = await review(null, root);
    expect(files.map(({ before }) => before)).toEqual([null, null]);
  });

  it('stops a change from hiding its own files with a .gitignore', async () => {
    const base = commit({ 'a.ts': CLEAN });
    const head = commit({ '.gitignore': '*.ts\n', 'a.ts': MESSY });
    expect((await review(base, head)).files.map(({ path }) => path)).toEqual(['a.ts']);
  });

  it('judges a change by the current config, not the one it commits', async () => {
    const base = commit({ 'a.ts': CLEAN });
    const head = commit({ 'jevlint.toml': 'exclude = ["a.ts"]\n', 'a.ts': MESSY });
    git(dir, 'checkout', '-q', base);
    expect((await review(base, head)).files.map(({ path }) => path)).toEqual(['a.ts']);
  });

  it('works from a subdirectory, on that directory alone', async () => {
    const base = commit({ 'pkg/jevlint.toml': '', 'pkg/a.ts': CLEAN, 'b.ts': CLEAN });
    const head = commit({ 'pkg/a.ts': MESSY, 'b.ts': MESSY });
    const pkg = await config(join(dir, 'pkg'));
    const { files } = await reviewChange(pkg, { title: 't', base, head }, { astOnly: true });
    expect(files.map(({ path }) => path)).toEqual(['a.ts']);
  });

  it('removes its snapshots', async () => {
    const tmp = tempDir();
    vi.stubEnv('TMPDIR', tmp);
    const base = commit({ 'a.ts': CLEAN });
    await review(base, commit({ 'a.ts': MESSY }));
    expect(readdirSync(tmp)).toEqual([]);
  });
});
