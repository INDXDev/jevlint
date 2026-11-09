import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserError } from '../src/config.ts';
import {
  changeDiff,
  commitCounts,
  commitPaths,
  commitsFrom,
  isClean,
  isWorkTree,
  pullRequestChange,
  pullRequestOfRef,
  touchedFiles,
  uncommittedFiles,
} from '../src/git.ts';

let dir: string;
const scratch: string[] = [];

const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd: dir,
    stdio: 'ignore',
  });

const commit = async (files: string[]) => {
  for (const file of files) await writeFile(join(dir, file), `${Math.random()}`);
  git('add', '.');
  git('commit', '-m', 'change');
};

/** A program that leaves a file behind when run, outside `dir` so that `git add .` skips it. */
const hookScript = async (name: string) => {
  const hooks = await mkdtemp(join(tmpdir(), 'jevlint-git-hook-'));
  scratch.push(hooks);
  const script = join(hooks, name);
  await writeFile(script, `#!/bin/sh\ntouch "${script}.ran"\nexit 1\n`);
  await chmod(script, 0o755);
  return { script, ran: async () => (await readdir(hooks)).length > 1 };
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jevlint-git-'));
});

describe('a bare repository committed inside a clone', () => {
  it('is not used, because a clone delivers its config and so its fsmonitor program', async () => {
    const { script, ran } = await hookScript('fsmonitor');
    await mkdir(join(dir, 'objects'));
    await mkdir(join(dir, 'refs'));
    await writeFile(join(dir, 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(
      join(dir, 'config'),
      `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = .\n\tfsmonitor = ${script}\n`,
    );
    expect(await isClean(dir)).toBe(false);
    expect(await ran()).toBe(false);
  });
});

afterEach(async () => {
  for (const path of [dir, ...scratch.splice(0)]) await rm(path, { recursive: true, force: true });
});

describe('outside git', () => {
  it('reports no commits and not clean', async () => {
    expect(await commitCounts(dir, 30)).toEqual(new Map());
    expect(await isClean(dir)).toBe(false);
  });
});

describe('inside git', () => {
  beforeEach(() => git('init'));

  it('reports no commits for an empty repository', async () => {
    expect(await commitCounts(dir, 30)).toEqual(new Map());
  });

  it('knows a working tree from a plain directory', async () => {
    expect(await isWorkTree(dir)).toBe(true);
    const plain = await mkdtemp(join(tmpdir(), 'jevlint-plain-'));
    scratch.push(plain);
    expect(await isWorkTree(plain)).toBe(false);
  });

  it('lists uncommitted files, staged or not', async () => {
    await commit(['a.ts', 'b.ts', 'c.ts']);
    await writeFile(join(dir, 'a.ts'), 'edited');
    await writeFile(join(dir, 'b.ts'), 'staged');
    git('add', 'b.ts');
    await writeFile(join(dir, 'new.ts'), 'new');
    expect((await uncommittedFiles(dir)).toSorted()).toEqual(['a.ts', 'b.ts', 'new.ts']);
  });

  it('commits only the named paths, new and deleted ones included', async () => {
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@example.com');
    await commit(['a.ts', 'gone.ts', 'mine.ts']);
    await writeFile(join(dir, 'a.ts'), 'fixed');
    await writeFile(join(dir, 'new.ts'), 'new');
    await rm(join(dir, 'gone.ts'));
    await writeFile(join(dir, 'mine.ts'), 'staged by the user');
    git('add', 'mine.ts');
    const hash = await commitPaths(dir, ['a.ts', 'new.ts', 'gone.ts'], 'Refactor a.ts\n\nBody.');
    const show = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    expect(show('rev-parse', '--short', 'HEAD')).toBe(hash);
    expect(show('log', '-1', '--format=%B')).toBe('Refactor a.ts\n\nBody.');
    expect(show('show', '--name-status', '--format=', 'HEAD').split('\n').toSorted()).toEqual([
      'A\tnew.ts',
      'D\tgone.ts',
      'M\ta.ts',
    ]);
    expect(show('diff', '--cached', '--name-only')).toBe('mine.ts');
  });

  it('reports a failed commit as something the user can fix', async () => {
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@example.com');
    await commit(['a.ts']);
    const { script } = await hookScript('pre-commit');
    git('config', 'core.hooksPath', join(script, '..'));
    await writeFile(join(dir, 'a.ts'), 'fixed');
    await expect(commitPaths(dir, ['a.ts'], 'm')).rejects.toThrow(UserError);
  });

  it('counts commits per file, including awkward names', async () => {
    await commit(['a.ts', 'é b.ts']);
    await commit(['a.ts']);
    expect(await commitCounts(dir, 30)).toEqual(
      new Map([
        ['a.ts', 2],
        ['é b.ts', 1],
      ]),
    );
  });

  it('reports paths relative to a root below the git root', async () => {
    await mkdir(join(dir, 'pkg'));
    await commit(['pkg/a.ts', 'b.ts']);
    expect(await commitCounts(join(dir, 'pkg'), 30)).toEqual(new Map([['a.ts', 1]]));
  });

  it('does not run the gpg program a repository configures', async () => {
    const marker = await hookScript('gpg');
    await writeFile(join(dir, 'a.ts'), '');
    git('add', '.');
    const tree = execFileSync('git', ['write-tree'], { cwd: dir, encoding: 'utf8' }).trim();
    const stamp = `${Math.floor(Date.now() / 1000)} +0000`;
    const signature = '-----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----';
    const signed = `tree ${tree}\nauthor t <t@e> ${stamp}\ncommitter t <t@e> ${stamp}\ngpgsig ${signature}\n\nm\n`;
    const commit = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
      cwd: dir,
      encoding: 'utf8',
      input: signed,
    }).trim();
    git('update-ref', 'HEAD', commit);
    git('config', 'log.showSignature', 'true');
    git('config', 'gpg.program', marker.script);

    await commitCounts(dir, 30);
    expect(await marker.ran()).toBe(false);
  });

  it.each([
    [
      'blob:none',
      new Map([
        ['a.ts', 2],
        ['b.ts', 1],
      ]),
    ],
    ['tree:0', new Map()],
  ])('never fetches from the remote of a %s clone', async (filter, counts) => {
    const marker = await hookScript('upload-pack');
    await writeFile(join(dir, 'a.ts'), 'x\n'.repeat(100));
    git('add', '.');
    git('commit', '-m', 'add');
    git('mv', 'a.ts', 'b.ts');
    await writeFile(join(dir, 'b.ts'), `${'x\n'.repeat(100)}y\n`);
    git('add', '.');
    git('commit', '-m', 'rename, which needs both blobs to detect');
    git('config', 'uploadpack.allowFilter', 'true');
    git('clone', '--no-checkout', `--filter=${filter}`, `file://${dir}`, 'clone');
    const clone = join(dir, 'clone');
    execFileSync('git', ['config', 'remote.origin.uploadpack', marker.script], { cwd: clone });

    expect(await commitCounts(clone, 30)).toEqual(counts);
    expect(await marker.ran()).toBe(false);
  });

  it('sees untracked files whatever status.showUntrackedFiles says', async () => {
    await commit(['a.ts']);
    git('config', 'status.showUntrackedFiles', 'no');
    await writeFile(join(dir, 'b.ts'), '');
    expect(await isClean(dir)).toBe(false);
  });

  it('tracks whether the working tree is clean', async () => {
    await commit(['a.ts']);
    expect(await isClean(dir)).toBe(true);
    await writeFile(join(dir, 'b.ts'), '');
    expect(await isClean(dir)).toBe(false);
  });
});

describe('changes to review', () => {
  const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), 'jevlint-git-change-')));
  const CLEAN = 'export const add = (a, b) => a + b;\n';
  const MESSY = 'export function f(a, b, c, d, e, g) { return a + b + c + d + e + g; }\n';

  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd,
      encoding: 'utf8',
    }).trim();

  function commitFiles(files: Record<string, string>, message = 'change'): string {
    for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
    run(dir, 'add', '.');
    run(dir, 'commit', '-m', message);
    return run(dir, 'rev-parse', 'HEAD');
  }

  beforeEach(() => {
    run(dir, 'init', '-q', '-b', 'main');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('commitsFrom', () => {
    it('walks back from a revision, skipping merges, each against its parent', async () => {
      const first = commitFiles({ 'a.ts': CLEAN }, 'first');
      const second = commitFiles({ 'a.ts': MESSY }, 'second');
      run(dir, 'checkout', '-q', '-b', 'side', first);
      const side = commitFiles({ 'b.ts': CLEAN }, 'side');
      run(dir, 'checkout', '-q', 'main');
      run(dir, 'merge', '-q', '--no-edit', 'side');

      const commits = await commitsFrom(dir, 'HEAD', 10);

      expect(commits.map(({ head }) => head).sort()).toEqual([first, second, side].sort());
      expect(commits.find(({ head }) => head === second)?.base).toBe(first);
      expect(commits.find(({ head }) => head === first)?.base).toBeNull();
      expect(await commitsFrom(dir, second, 1)).toEqual([
        { title: `${second.slice(0, 7)} second`, base: first, head: second, message: 'second' },
      ]);
    });

    it('reads the whole message, keeping commits apart when a body has odd lines', async () => {
      commitFiles({ 'a.ts': CLEAN }, 'first');
      const message = 'Subject line\n\nBody one\n\ndeadbeef\nBody two';
      const head = commitFiles({ 'a.ts': MESSY }, message);
      const commits = await commitsFrom(dir, 'HEAD', 10);
      expect(commits).toHaveLength(2);
      expect(commits[0]).toMatchObject({
        title: `${head.slice(0, 7)} Subject line`,
        message,
      });
      expect(commits[1]?.message).toBe('first');
    });

    it('refuses a bad revision, and one that looks like a flag', async () => {
      commitFiles({ 'a.ts': CLEAN });
      await expect(commitsFrom(dir, 'nope', 1)).rejects.toThrow(UserError);
      await expect(commitsFrom(dir, '--output=x', 1)).rejects.toThrow(UserError);
    });

    it('refuses a shallow clone, whose oldest commit would look like a root', async () => {
      commitFiles({ 'a.ts': CLEAN });
      commitFiles({ 'a.ts': MESSY });
      const clone = tempDir();
      run(clone, 'clone', '-q', '--depth=1', `file://${dir}`, '.');
      await expect(commitsFrom(clone, 'HEAD', 1)).rejects.toThrow('shallow');
    });
  });

  describe('changeDiff', () => {
    it('gives the diff between two commits, and a root commit against nothing', async () => {
      const first = commitFiles({ 'a.ts': CLEAN });
      const second = commitFiles({ 'a.ts': MESSY });
      const diff = await changeDiff(dir, { base: first, head: second }, []);
      expect(diff).toContain(`-${CLEAN.trim()}`);
      expect(diff).toContain(`+${MESSY.trim()}`);
      const root = await changeDiff(dir, { base: null, head: first }, []);
      expect(root).toContain(`+${CLEAN.trim()}`);
      expect(root).not.toContain(first);
    });

    it('takes excluded names literally, however they look', async () => {
      const first = commitFiles({ 'a.ts': CLEAN });
      const second = commitFiles({ 'a.ts': MESSY, '*.ts': 'hidden', ':(top)b': 'hidden too' });
      const change = { base: first, head: second };
      const diff = await changeDiff(dir, change, ['*.ts', ':(top)b']);
      expect(diff).toContain('a/a.ts');
      expect(diff).not.toContain('hidden');
    });

    it('stays under a root below the git root, as changedFiles does', async () => {
      await mkdir(join(dir, 'pkg'));
      const first = commitFiles({ 'pkg/a.ts': CLEAN, 'b.ts': CLEAN });
      const second = commitFiles({ 'pkg/a.ts': MESSY, 'pkg/x.env': 'hidden', 'b.ts': 'outside' });
      const pkg = join(dir, 'pkg');
      const diff = await changeDiff(pkg, { base: first, head: second }, ['x.env']);
      expect(diff).toContain('a/a.ts');
      expect(diff).not.toContain('hidden');
      expect(diff).not.toContain('outside');
    });

    it('runs neither an external diff program nor a textconv filter', async () => {
      const marker = await hookScript('differ');
      const first = commitFiles({ 'a.ts': CLEAN, '.gitattributes': '*.ts diff=evil\n' });
      const second = commitFiles({ 'a.ts': MESSY });
      run(dir, 'config', 'diff.external', marker.script);
      run(dir, 'config', 'diff.evil.command', marker.script);
      run(dir, 'config', 'diff.evil.textconv', marker.script);
      expect(await changeDiff(dir, { base: first, head: second }, [])).toContain(MESSY.trim());
      expect(await marker.ran()).toBe(false);
    });

    it('refuses a revision it cannot read, with a user error', async () => {
      const first = commitFiles({ 'a.ts': CLEAN });
      await expect(changeDiff(dir, { base: first, head: 'nope' }, [])).rejects.toThrow(UserError);
    });
  });

  describe('touchedFiles', () => {
    it('includes deleted files', async () => {
      const first = commitFiles({ 'a.ts': CLEAN, 'b.ts': CLEAN });
      run(dir, 'rm', '-q', 'b.ts');
      const second = commitFiles({ 'a.ts': MESSY });
      expect(await touchedFiles(dir, { base: first, head: second })).toEqual(['a.ts', 'b.ts']);
    });
  });

  describe('pullRequestOfRef', () => {
    it.each([
      ['refs/pull/7/merge', '7'],
      ['refs/heads/pull/7/merge', undefined],
      ['refs/heads/main', undefined],
      [undefined, undefined],
    ])('reads %s', (ref, number) => {
      expect(pullRequestOfRef(ref)).toBe(number);
    });
  });

  describe('pullRequestChange', () => {
    /** Puts a fake `gh` first on the PATH. */
    function fakeGh(script: string) {
      const bin = tempDir();
      writeFileSync(join(bin, 'gh'), `#!/bin/sh\n${script}\n`);
      chmodSync(join(bin, 'gh'), 0o755);
      vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH}`);
    }

    /** A clone that lacks a pull request `origin` serves at refs/pull/7/head. */
    function pullRequest() {
      const mergeBase = commitFiles({ 'a.ts': CLEAN });
      const clone = tempDir();
      run(clone, 'clone', '-q', dir, '.');
      run(dir, 'checkout', '-q', '-b', 'topic');
      const head = commitFiles({ 'a.ts': MESSY });
      run(dir, 'update-ref', 'refs/pull/7/head', head);
      run(dir, 'checkout', '-q', 'main');
      const baseTip = commitFiles({ 'b.ts': CLEAN });
      const json = {
        number: 7,
        title: 'T',
        body: 'Why',
        baseRefName: 'main',
        baseRefOid: baseTip,
        headRefOid: head,
      };
      fakeGh(`echo '${JSON.stringify(json)}'`);
      return { clone, mergeBase, head };
    }

    it('fetches the commits and diffs from the merge base, as GitHub does', async () => {
      const { clone, mergeBase, head } = pullRequest();
      const before = run(clone, 'status', '--porcelain') + run(clone, 'rev-parse', 'HEAD');

      const change = await pullRequestChange(clone, 7);

      expect(change).toEqual({
        title: 'Pull request #7: T',
        base: mergeBase,
        head,
        message: 'T\n\nWhy',
      });
      expect(run(clone, 'status', '--porcelain') + run(clone, 'rev-parse', 'HEAD')).toBe(before);
    });

    it("lets gh pick the current branch's pull request when no number is given", async () => {
      const { clone, head } = pullRequest();
      const change = await pullRequestChange(clone);
      expect(change).toMatchObject({ title: 'Pull request #7: T', head });
    });

    it('names the branch, not a number, when gh finds no pull request for it', async () => {
      fakeGh('echo "no pull requests found" >&2; exit 1');
      await expect(pullRequestChange(dir)).rejects.toThrow(
        "this branch's pull request: no pull requests found",
      );
    });

    it('says how to fetch when the commits cannot be found', async () => {
      const { clone } = pullRequest();
      run(clone, 'remote', 'set-url', 'origin', join(dir, 'missing'));
      await expect(pullRequestChange(clone, 7)).rejects.toThrow('git fetch <remote> pull/7/head');
    });

    it('passes on what gh says when it fails', async () => {
      fakeGh('echo "no such pull request" >&2; exit 1');
      await expect(pullRequestChange(dir, 7)).rejects.toThrow('no such pull request');
    });

    it('says so when gh is stopped, as a timeout does', async () => {
      fakeGh('kill -TERM $$');
      await expect(pullRequestChange(dir, 7)).rejects.toThrow('gh stopped reading');
    });

    it('says gh is needed when it is missing', async () => {
      vi.stubEnv('PATH', tempDir());
      await expect(pullRequestChange(dir, 7)).rejects.toThrow('GitHub CLI');
    });
  });
});
