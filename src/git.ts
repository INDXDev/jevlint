/** Churn, working-tree status and the commits under review, read from git and GitHub. */
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { UserError } from './config.ts';
import type { Change } from './types.ts';

const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const SHORT_SHA_LENGTH = 7;
const LOG_FIELDS = 4;
const GH_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 5 * 60_000;

const execFileAsync = promisify(execFile);

async function git(root: string, args: string[], timeout = 0): Promise<string> {
  // A clone can deliver a bare repository as plain files, with a config naming programs to run.
  const safe = ['-c', 'safe.bareRepository=explicit', '-c', 'core.fsmonitor=false'];
  const { stdout } = await execFileAsync('git', [...safe, ...args], {
    cwd: root,
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout,
    // A lazy fetch runs the upload-pack program named in the repository's own config.
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
  });
  return stdout;
}

/** Counts commits per root-relative file over recent days. Empty outside a git repository. */
export async function commitCounts(root: string, days: number): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const log = await git(root, [
    'log',
    // A repository's config can make `log` run gpg.program on each signature.
    '--no-show-signature',
    // Rename detection reads blobs, which a partial clone may lack.
    '--no-renames',
    `--since=${days} days ago`,
    '--name-only',
    '--relative',
    '--format=',
    '-z',
  ]).catch(() => '');
  for (const file of log.split('\0').filter(Boolean)) {
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
}

/**
 * The repository's root commits, sorted, which tell one history from another at the same path.
 * Empty outside git or before the first commit.
 */
export async function rootCommits(root: string): Promise<string[]> {
  const list = await git(root, ['rev-list', '--max-parents=0', 'HEAD']).catch(() => '');
  return list.split('\n').filter(Boolean).sort();
}

/** Says why a git command failed, in git's own words when it gave any. */
export function gitFailureReason(error: unknown): string {
  const { code, stderr } = error as NodeJS.ErrnoException & { stderr?: string };
  if (code === 'ENOENT') return 'git is not installed or not on PATH';
  const message = stderr
    ?.trim()
    .split('\n')[0]
    ?.replace(/^fatal: /, '');
  return message || 'git failed';
}

/**
 * Lists changes under the root that are not committed: staged, unstaged or untracked, as
 * `git status` names them, relative to the top of the repository. Changes elsewhere in the
 * repository do not count. Rejects when git cannot read a repository here.
 */
export async function dirtyFiles(root: string): Promise<string[]> {
  const status = await git(root, [
    'status',
    '--porcelain',
    '-z',
    '--untracked-files=normal',
    '--',
    '.',
  ]);
  const entries = status.split('\0');
  const files: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index] ?? '';
    if (entry === '') continue;
    files.push(entry.slice(3));
    // A rename or copy is followed by the path it came from.
    if (/^[RC]|^.[RC]/.test(entry)) index++;
  }
  return files;
}

/**
 * Lists files under the root that differ from the index or are untracked and not ignored,
 * root-relative. Empty outside a git repository.
 */
export async function workingTreeChanges(root: string): Promise<string[]> {
  // `ls-files`, because its paths are relative to the root, as status's are not.
  const names = await git(root, [
    'ls-files',
    '-z',
    '--modified',
    '--others',
    '--exclude-standard',
  ]).catch(() => '');
  return [...new Set(names.split('\0').filter(Boolean))];
}

/** Lists files under the root with changes not yet committed, staged or not. */
export async function uncommittedFiles(root: string): Promise<string[]> {
  // Plumbing reads only the index and HEAD's tree, so no filter program runs. No HEAD means none.
  const staged = await git(root, [
    'diff-index',
    '--cached',
    '--name-only',
    '-z',
    '--relative',
    '--no-renames',
    'HEAD',
  ]).catch(() => '');
  const all = [...(await workingTreeChanges(root)), ...staged.split('\0').filter(Boolean)];
  return [...new Set(all)];
}

/** True inside a git working tree. */
export function isWorkTree(root: string): Promise<boolean> {
  return git(root, ['rev-parse', '--is-inside-work-tree']).then(
    (answer) => answer.trim() === 'true',
    () => false,
  );
}

/**
 * Commits only `paths`, root-relative, including new and deleted files, and returns the short hash.
 * Anything else already staged stays staged. Hooks and signing run as the user's config says.
 */
export async function commitPaths(root: string, paths: string[], message: string): Promise<string> {
  const pathspecs = paths.map((path) => `:(literal)${path}`);
  try {
    await git(root, ['add', '--all', '--', ...pathspecs]);
    await git(root, ['commit', '--quiet', '--only', '-m', message, '--', ...pathspecs]);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new UserError(`git commit failed${stderr ? `: ${stderr}` : '.'}`);
  }
  return (await git(root, ['rev-parse', '--short', 'HEAD'])).trim();
}

type Commits = Pick<Change, 'base' | 'head'>;

const commitRange = ({ base, head }: Commits) => (base ? [base, head] : ['--root', head]);

async function namesInDiff(root: string, commits: Commits, filter: string[]): Promise<string[]> {
  // Plumbing, because `git diff` can run a diff.external or textconv program from the config.
  // shortcut: a renamed file counts as new, as renames are off; pass -M and map old paths if that gets noisy.
  const names = await git(root, [
    'diff-tree',
    '-r',
    '-z',
    '--name-only',
    '--no-commit-id',
    '--relative',
    ...filter,
    ...commitRange(commits),
  ]);
  return names.split('\0').filter(Boolean);
}

/** Lists files a change added or modified, root-relative. A null base means a root commit. */
export function changedFiles(root: string, commits: Commits): Promise<string[]> {
  return namesInDiff(root, commits, ['--diff-filter=d']);
}

/** Lists every file a change touched, deleted ones included, root-relative. */
export function touchedFiles(root: string, commits: Commits): Promise<string[]> {
  return namesInDiff(root, commits, []);
}

/** Returns a change's unified diff under the root, without the root-relative `excluded` files. */
export function changeDiff(root: string, commits: Commits, excluded: string[]): Promise<string> {
  return git(root, [
    'diff-tree',
    '-r',
    '-p',
    '--no-commit-id',
    '--relative',
    '--no-ext-diff',
    '--no-textconv',
    // Rename detection reads blobs, which a partial clone may lack.
    '--no-renames',
    ...commitRange(commits),
    '--',
    ...excluded.map((path) => `:(exclude,literal)${path}`),
  ]).catch(() => {
    throw new UserError(
      `Could not read the diff of ${commits.head}. A partial clone may lack its files, so use a full clone.`,
    );
  });
}

/** Reads a root-relative file at a commit, or undefined if it has none there. */
export function fileAt(root: string, commit: string, path: string): Promise<string | undefined> {
  // `cat-file`, because `git show` can run a textconv program.
  return git(root, ['cat-file', 'blob', `${commit}:./${path}`]).catch(() => undefined);
}

/** Writes the index as a tree, so the staged change reads like a commit against HEAD. */
export async function stagedChange(root: string): Promise<Change> {
  const tree = await git(root, ['write-tree']).catch(() => {
    throw new UserError('Could not read the index. Is this a git repository with no conflicts?');
  });
  const base = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() =>
    // `diff-tree --root` silently lists nothing for a tree, so an unborn HEAD needs an empty side.
    git(root, ['hash-object', '-t', 'tree', '--no-filters', '/dev/null']),
  );
  return { title: 'Staged changes', base: base.trim(), head: tree.trim() };
}

/** Finds where git reads hooks from, and the git directory shared by all worktrees. */
export async function hookLocations(root: string): Promise<{ hooks: string; gitDir: string }> {
  // One call each, as a newline in core.hooksPath could otherwise forge the line after it.
  const absolutePath = (...args: string[]) =>
    git(root, ['rev-parse', ...args]).then(
      (path) => resolve(root, path.replace(/\n$/, '')),
      () => {
        throw new UserError('Installing a pre-commit hook needs a git repository.');
      },
    );
  const [hooks, gitDir] = await Promise.all([
    absolutePath('--git-path', 'hooks'),
    absolutePath('--git-common-dir'),
  ]);
  return { hooks, gitDir };
}

/** Lists non-merge commits from `revision` backwards, newest first, each against its parent. */
export async function commitsFrom(
  root: string,
  revision: string,
  count: number,
): Promise<Change[]> {
  const log = await git(root, [
    'log',
    '--no-show-signature',
    // A merge would review its whole branch again, at the cost of a second model run.
    '--no-merges',
    `--max-count=${count}`,
    // NUL-separated throughout, because a message body has line breaks.
    '-z',
    '--format=%H%x00%P%x00%s%x00%B',
    '--end-of-options',
    revision,
  ]).catch(() => {
    throw new UserError(
      `Could not read commits from ${revision}. Is it a revision in this repository?`,
    );
  });
  // A shallow clone's oldest commit looks like a root commit, so every file in it would seem new.
  if ((await git(root, ['rev-parse', '--is-shallow-repository'])).trim() === 'true') {
    throw new UserError('This is a shallow clone. Run: git fetch --unshallow');
  }
  const fields = log.split('\0');
  return Array.from({ length: Math.floor(fields.length / LOG_FIELDS) }, (_, index) => {
    const [head = '', parents = '', subject = '', message = ''] = fields.slice(index * LOG_FIELDS);
    return {
      title: `${head.slice(0, SHORT_SHA_LENGTH)} ${subject}`,
      base: parents.split(' ')[0] || null,
      head,
      message: message.trim(),
    };
  });
}

function ghFailure(
  number: number | undefined,
  error: NodeJS.ErrnoException & { stderr?: string; signal?: string },
): UserError {
  if (error.code === 'ENOENT') {
    return new UserError('jevlint pr needs the GitHub CLI: https://cli.github.com');
  }
  const subject = number ? `pull request #${number}` : "this branch's pull request";
  // A killed process has nothing on stderr, and a stalled network is what kills it.
  if (error.signal) {
    return new UserError(`gh stopped reading ${subject}. It has ${GH_TIMEOUT_MS / 1000} seconds.`);
  }
  return new UserError(`gh could not read ${subject}: ${error.stderr?.trim()}`);
}

/** Reads the pull request number from a ref such as `refs/pull/7/merge`, as CI runs have. */
export const pullRequestOfRef = (ref: string | undefined): string | undefined =>
  ref?.match(/^refs\/pull\/(\d+)\//)?.[1];

/**
 * Finds what a pull request changes, as GitHub shows it: from the merge base to its head. With no
 * number, `gh` picks the pull request of the current branch.
 */
export async function pullRequestChange(root: string, requested?: number): Promise<Change> {
  const fields = 'number,title,body,baseRefName,baseRefOid,headRefOid';
  const target = requested === undefined ? [] : [String(requested)];
  const { stdout } = await execFileAsync('gh', ['pr', 'view', ...target, '--json', fields], {
    cwd: root,
    timeout: GH_TIMEOUT_MS,
  }).catch((error) => {
    throw ghFailure(requested, error);
  });
  const { number, title, body, baseRefName, baseRefOid, headRefOid } = JSON.parse(stdout);
  await git(
    root,
    [
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-write-fetch-head',
      '--no-recurse-submodules',
      'origin',
      `refs/pull/${number}/head`,
      `refs/heads/${baseRefName}`,
    ],
    FETCH_TIMEOUT_MS,
    // Commits gh named may already be here, as when the pull request's repository is not `origin`.
  ).catch(() => undefined);
  const base = await git(root, ['merge-base', baseRefOid, headRefOid]).catch(() => {
    throw new UserError(
      `Could not find the commits of pull request #${number}. Run: git fetch <remote> pull/${number}/head ${baseRefName}, with full history.`,
    );
  });
  return {
    title: `Pull request #${number}: ${title}`,
    base: base.trim(),
    head: headRefOid,
    message: [title, body].filter(Boolean).join('\n\n'),
  };
}

/** The full hash of HEAD, or null outside git or before the first commit. */
export async function headCommit(root: string): Promise<string | null> {
  const head = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(
    () => '',
  );
  return head.trim() || null;
}

/** Resolves a revision the user or the SSOT named to a full commit hash, or throws a UserError. */
export async function resolveCommit(root: string, revision: string): Promise<string> {
  // A revision starting with `-` would be read as an option.
  const fail = () => new UserError(`${revision} is not a commit in this repository.`);
  if (revision.startsWith('-') || revision === '') throw fail();
  const hash = await git(root, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]).catch(
    () => '',
  );
  if (!hash.trim()) throw fail();
  return hash.trim();
}

/** Lists the root-relative files a commit holds under the root. */
export async function filesAt(root: string, commit: string): Promise<string[]> {
  const names = await git(root, ['ls-tree', '-r', '-z', '--name-only', commit]);
  return names.split('\0').filter(Boolean);
}

/** Lists files that differ between `base` and the working tree, root-relative. Untracked files are not listed. */
export async function changedSince(root: string, base: string): Promise<string[]> {
  const names = await git(root, [
    'diff',
    '--name-only',
    '-z',
    '--relative',
    '--no-renames',
    '--no-ext-diff',
    '--no-textconv',
    base,
    '--',
  ]);
  return names.split('\0').filter(Boolean);
}

/** The root-relative files of each of the last `count` non-merge commits, newest first. */
export async function recentCommitFiles(root: string, count: number): Promise<string[][]> {
  const log = await git(root, [
    'log',
    '--no-show-signature',
    '--no-renames',
    '--no-merges',
    `--max-count=${count}`,
    '--name-only',
    '--relative',
    '--format=%x01',
    '-z',
  ]).catch(() => '');
  return log
    .split('\x01')
    .map((chunk) =>
      chunk
        .split('\0')
        .map((name) => name.replace(/^\n/, ''))
        .filter(Boolean),
    )
    .filter((files) => files.length > 0);
}
