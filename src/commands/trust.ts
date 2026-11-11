/** `jevlint trust`, and the approval `quickfix` asks for before it runs a repository's commands. */
import { confirm } from '@clack/prompts';
import { defineCommand } from 'citty';
import { type Config, type Fixer, REPO_CONFIG, UserError } from '../config.ts';
import { withoutControlCharacters } from '../report.ts';
import { isTrusted, trust, untrust } from '../trust.ts';
import { answered, PROMPT_IO, projectConfig } from './shared.ts';

/** One command as a line, for the terminal or a commit message. Repository text, so made safe. */
export const commandLine = (command: string[]): string =>
  withoutControlCharacters(command.join(' '));

function printFixers(fixers: Fixer[]): void {
  for (const { command, files, retry } of fixers) {
    const on = files ? ` on ${withoutControlCharacters(files.join(', '))}` : '';
    console.error(`  ${commandLine(command)}${on}${retry ? ' (retry)' : ''}`);
  }
}

/**
 * Picks the `quickfix.after` commands a run may use. The user's own run without asking. A
 * repository's run once approved for this root and this exact list: in a terminal without
 * `--yes`, it asks, and otherwise it skips them and says how to approve them.
 */
export async function fixersToRun(config: Config, yes: boolean): Promise<Fixer[]> {
  const fixers = config.quickfix.after;
  if (fixers.length === 0 || !config.repoFixers) return fixers;
  if (await isTrusted(config.root, fixers)) return fixers;
  console.error(`${REPO_CONFIG} asks to run these commands on the files the agent changes:`);
  printFixers(fixers);
  if (yes || !process.stdin.isTTY) {
    console.error(
      'Skipping them, because you have not approved them. --yes does not approve them. To approve, run: jevlint trust',
    );
    return [];
  }
  const approve = answered(
    await confirm({ message: 'Trust these commands in this repository?', ...PROMPT_IO }),
  );
  if (!approve) {
    console.error('Skipping them. Approve them later with: jevlint trust');
    return [];
  }
  await trust(config.root, fixers);
  return fixers;
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
    if (await isTrusted(config.root, fixers)) {
      console.error(`These commands are already approved in ${root}.`);
      return;
    }
    console.error(`${REPO_CONFIG} in ${root} declares these commands:`);
    printFixers(fixers);
    if (!args.yes) {
      if (!process.stdin.isTTY) throw new UserError('Pass --yes to approve outside a terminal.');
      const approve = answered(
        await confirm({ message: 'Trust these commands in this repository?', ...PROMPT_IO }),
      );
      if (!approve) throw new UserError('Cancelled.');
    }
    await trust(config.root, fixers);
    console.error(`Approved. jevlint quickfix will run them until ${REPO_CONFIG} changes them.`);
  },
});
