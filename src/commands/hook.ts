/** `jevlint hook`: tells an agent or a commit what a change made worse. */
import { resolve } from 'node:path';
import { defineCommand } from 'citty';
import type { AuditOptions } from '../audit.ts';
import { type Config, UserError } from '../config.ts';
import { stagedChange } from '../git.ts';
import { editedPath, reviewEdit } from '../hook.ts';
import { formatReview } from '../report.ts';
import { madeWorse, reviewChange } from '../review.ts';
import type { ChangeReview } from '../types.ts';
import { askAboutEnvKeys } from './auth.ts';
import { printFallbackNotice, printNoKeyNotice, projectConfig } from './shared.ts';

// Claude Code's Write payload carries the whole file, and more than once.
const MAX_STDIN_BYTES = 32 * 1024 * 1024;
// Claude Code passes a PostToolUse hook's stderr to the agent only on this code.
const EXIT_TELL_AGENT = 2;

/** Undefined above the limit, which only a huge generated file reaches. */
async function readStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) {
    throw new UserError('jevlint hook reads JSON from stdin. For a commit, pass --staged.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_STDIN_BYTES) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function printNotices(config: Config, review: ChangeReview, options: AuditOptions): void {
  if (review.model === null && !options.astOnly) printNoKeyNotice(config);
  printFallbackNotice(config, review.provider);
}

async function reviewEditedFile(options: AuditOptions): Promise<void> {
  const text = await readStdin();
  const path = text === undefined ? undefined : editedPath(text);
  if (path === undefined) return;
  const config = await projectConfig();
  const review = await reviewEdit(config, resolve(path), options);
  if (!review) return;
  printNotices(config, review, options);
  if (!madeWorse(review)) return;
  console.error(formatReview(review));
  process.exitCode = EXIT_TELL_AGENT;
}

async function reviewStaged(options: AuditOptions): Promise<void> {
  const config = await projectConfig();
  const review = await reviewChange(config, await stagedChange(config.root), options);
  printNotices(config, review, options);
  if (!madeWorse(review)) return;
  console.log(formatReview(review));
  console.error('The staged change made this worse. To commit anyway: git commit --no-verify');
  process.exitCode = 1;
}

/** The `hook` command. */
export const hookCommand = defineCommand({
  meta: { name: 'jevlint hook', description: 'Report what an edit or a staged change made worse' },
  args: {
    staged: { type: 'boolean', description: 'Review the staged change, for a pre-commit hook' },
    model: { type: 'boolean', description: 'Also ask the provider, which sends file contents' },
  },
  async run({ args }) {
    if (args.model) await askAboutEnvKeys();
    const options = { astOnly: !args.model };
    await (args.staged ? reviewStaged(options) : reviewEditedFile(options));
  },
});
