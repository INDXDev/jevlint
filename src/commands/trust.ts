/** `jevlint trust`, and the approval `quickfix` asks for before it runs a repository's commands. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { confirm } from '@clack/prompts';
import { defineCommand } from 'citty';
import { type Config, type Fixer, REPO_CONFIG, UserError } from '../config.ts';
import { commandLine, withoutControlCharacters } from '../report.ts';
import { approval, referencedFiles, trust, untrust } from '../trust.ts';
import { answered, PROMPT_IO, projectConfig } from './shared.ts';

function printFixers(fixers: Fixer[], root: string): void {
  for (const { command, files, retry } of fixers) {
    const on = files ? ` on ${withoutControlCharacters(files.join(', '))}` : '';
    console.error(`  ${commandLine(command)}${on}${retry ? ' (retry)' : ''}`);
  }
  // Missing files count too, so adding one asks again, but listing every name tried is noise.
  const read = referencedFiles(root, fixers).filter((path) => existsSync(join(root, path)));
  const files = read.length > 0 ? ` and ${withoutControlCharacters(read.join(', '))}` : '';
  console.error(
    `The approval covers this repository's history${files}. Installed tools, such as node_modules, are not covered.`,
  );
}

const CHANGED = 'They, or a file they read, changed since you approved them.';

/** The `quickfix.after` commands a run may use, and a check that they may still run. */
export interface RunnableFixers {
  fixers: Fixer[];
  /** False, with a warning, when what the approval covers changed during the run. */
  stillApproved: () => Promise<boolean>;
}

const always = async () => true;

/**
 * Picks the `quickfix.after` commands a run may use. The user's own run without asking. A
 * repository's run once approved for this root, these commands and the files they read: in a
 * terminal without `--yes`, it asks, and otherwise it skips them and says how to approve them.
 */
export async function fixersToRun(config: Config, yes: boolean): Promise<RunnableFixers> {
  const fixers = config.quickfix.after;
  const none = { fixers: [], stillApproved: always };
  if (fixers.length === 0 || !config.repoFixers) return { fixers, stillApproved: always };
  const { root } = config;
  const stillApproved = async () => {
    if ((await approval(root, fixers)) === 'approved') return true;
    console.error(
      `Skipping ${REPO_CONFIG}'s quickfix.after commands: a file they read changed during the run. Review it, then approve them again with: jevlint trust`,
    );
    return false;
  };
  const status = await approval(root, fixers);
  if (status === 'approved') return { fixers, stillApproved };
  console.error(`${REPO_CONFIG} asks to run these commands on the files the agent changes:`);
  printFixers(fixers, root);
  if (status === 'changed') console.error(CHANGED);
  if (yes || !process.stdin.isTTY) {
    console.error(
      'Skipping them, because you have not approved them. --yes does not approve them. To approve, run: jevlint trust',
    );
    return none;
  }
  const approve = answered(
    await confirm({ message: 'Trust these commands in this repository?', ...PROMPT_IO }),
  );
  if (!approve) {
    console.error('Skipping them. Approve them later with: jevlint trust');
    return none;
  }
  await trust(root, fixers);
  return { fixers, stillApproved };
}

/** The `trust` command. */
export const trustCommand = defineCommand({
  meta: {
    name: 'jevlint trust',
    description: `Approve the quickfix.after commands in this repository's ${REPO_CONFIG}`,
  },
  args: {
    yes: { type: 'boolean', description: 'Approve without asking. Required outside a terminal' },
    revoke: { type: 'boolean', description: 'Withdraw the approval for this repository' },
  },
  async run({ args }) {
    const config = await projectConfig();
    const root = withoutControlCharacters(config.root);
    if (args.revoke) {
      const removed = await untrust(config.root);
      console.error(
        removed ? `No longer trusting commands in ${root}.` : `Nothing approved in ${root}.`,
      );
      return;
    }
    const fixers = config.quickfix.after;
    if (!config.repoFixers || fixers.length === 0) {
      console.error(`No quickfix.after commands from ${REPO_CONFIG} need approval in ${root}.`);
      return;
    }
    const status = await approval(config.root, fixers);
    if (status === 'approved') {
      console.error(`These commands are already approved in ${root}.`);
      return;
    }
    console.error(`${REPO_CONFIG} in ${root} declares these commands:`);
    printFixers(fixers, config.root);
    if (status === 'changed') console.error(CHANGED);
    if (!args.yes) {
      if (!process.stdin.isTTY) throw new UserError('Pass --yes to approve outside a terminal.');
      const approve = answered(
        await confirm({ message: 'Trust these commands in this repository?', ...PROMPT_IO }),
      );
      if (!approve) throw new UserError('Cancelled.');
    }
    await trust(config.root, fixers);
    console.error(
      `Approved. jevlint quickfix will run them until they, or a file they read, change.`,
    );
  },
});
