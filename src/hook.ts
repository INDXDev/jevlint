/** Agent and git hooks: finds the file an edit touched and installs the pre-commit hook. */
import { mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { AuditOptions } from './audit.ts';
import {
  type Config,
  findUp,
  ifExists,
  isTable,
  readRegularFile,
  UserError,
  writeFileAtomic,
} from './config.ts';
import { isOutsideRoot } from './files.ts';
import { hookLocations } from './git.ts';
import { reviewFile } from './review.ts';
import type { ChangeReview } from './types.ts';

// Runs jevlint from PATH, not npx, which prefers a copy in the repository's own node_modules.
const PRE_COMMIT_HOOK = `#!/bin/sh
# Written by jevlint init --pre-commit. Skip it once with: git commit --no-verify
exec jevlint hook --staged
`;

/** Reads the edited path from a hook's JSON, in Claude Code's shape or flat. */
export function editedPath(text: string): string | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new UserError(
      'jevlint hook expects JSON on stdin, such as {"file_path":"src/a.ts"}. For a commit, pass --staged.',
    );
  }
  const input = isTable(payload) && isTable(payload.tool_input) ? payload.tool_input : payload;
  const path = isTable(input) ? input.file_path : undefined;
  return typeof path === 'string' && path !== '' ? path : undefined;
}

/** Resolves links first, so a path through one cannot lead the review out of the root. */
async function fileInRoot(root: string, path: string): Promise<string | undefined> {
  const file = await realpath(path).catch(() => undefined);
  if (!file || !(await stat(file)).isFile()) return undefined;
  const relativePath = relative(await realpath(root), file);
  return isOutsideRoot(relativePath) ? undefined : relativePath.split(sep).join('/');
}

/**
 * Reviews an edited file against HEAD. Null for anything that is not an auditable file in this
 * repository, because a hook must not block an unrelated edit.
 */
export async function reviewEdit(
  config: Config,
  path: string,
  options: AuditOptions = {},
): Promise<ChangeReview | null> {
  // With no repository there is no HEAD, and every finding in the file would look new.
  if (!(await findUp(config.root, '.git'))) return null;
  const file = await fileInRoot(config.root, path);
  return file === undefined ? null : reviewFile(config, file, options);
}

async function realpathOfExisting(path: string): Promise<string> {
  return (await ifExists(realpath(path))) ?? realpathOfExisting(dirname(path));
}

async function refuseOutsideRepository(hooks: string, ...repository: string[]): Promise<void> {
  const real = await realpathOfExisting(hooks);
  const roots = await Promise.all(repository.map((path) => realpath(path)));
  if (roots.some((root) => !isOutsideRoot(relative(root, real)))) return;
  throw new UserError(`Refusing to install a hook outside the repository: ${hooks}`);
}

/** Writes the pre-commit hook and returns its path. Its text is fixed, with nothing from the repository. */
export async function installPreCommitHook(root: string, force: boolean): Promise<string> {
  const { hooks, gitDir } = await hookLocations(root);
  // A repository's config can set core.hooksPath, which must not choose where this writes. It can
  // also set core.worktree, so the working tree is found on disk and not by asking git.
  await refuseOutsideRepository(hooks, (await findUp(root, '.git')) ?? root, gitDir);
  const target = join(hooks, 'pre-commit');
  const existing = force ? undefined : await ifExists(readRegularFile(target));
  if (existing !== undefined && existing !== PRE_COMMIT_HOOK) {
    throw new UserError(`${target} already exists. Pass --force to replace it.`);
  }
  await mkdir(hooks, { recursive: true });
  // Atomic, so a symlink planted here is replaced, not written through.
  await writeFileAtomic(target, PRE_COMMIT_HOOK, 0o755);
  return target;
}
