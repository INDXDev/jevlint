/** `jevlint fix`: runs a coding agent on the worst files. */
import { confirm } from '@clack/prompts';
import { defineCommand } from 'citty';
import { fixFile, resolveAgent } from '../agent.ts';
import { UserError } from '../config.ts';
import { isClean } from '../git.ts';
import { formatScore, withoutControlCharacters } from '../report.ts';
import type { FileReport } from '../types.ts';
import {
  answered,
  auditProject,
  FILE_SELECTION_ARGS,
  PROMPT_IO,
  parseCount,
  projectConfig,
  selectFiles,
} from './shared.ts';

async function confirmPlan(files: FileReport[], agent: string): Promise<void> {
  for (const { score, path } of withoutControlCharacters(files)) {
    console.error(`  ${formatScore(score)}  ${path}`);
  }
  const message = `Let ${agent} edit ${files.length === 1 ? 'this file' : `these ${files.length} files`}?`;
  if (!answered(await confirm({ message, ...PROMPT_IO }))) throw new UserError('Cancelled.');
}

/** The `fix` command. */
export const fixCommand = defineCommand({
  meta: { name: 'jevlint fix', description: 'Run an agent on the worst files, then re-score them' },
  args: {
    ...FILE_SELECTION_ARGS,
    agent: { type: 'string', valueHint: 'name', description: 'Agent to run, such as claude' },
    yes: { type: 'boolean', description: 'Skip the confirmation. Required outside a terminal' },
    'allow-dirty': { type: 'boolean', description: 'Run even if the git working tree has changes' },
  },
  async run({ args }) {
    const top = parseCount('--top', args.top);
    const config = await projectConfig();
    const command = resolveAgent(config, args.agent);
    if (!args.yes && !process.stdin.isTTY) {
      throw new UserError('Pass --yes to run fix outside a terminal.');
    }
    if (!args['allow-dirty'] && !(await isClean(config.root))) {
      throw new UserError(
        'The git working tree is not clean. Commit or stash your changes, or pass --allow-dirty.',
      );
    }

    const report = await auditProject(config, { paths: args._ });
    const files = selectFiles(report, args._, top);
    if (files.length === 0)
      return console.error('Nothing to fix in the selected files. Pinned scores are left out.');
    if (!args.yes) await confirmPlan(files, String(args.agent));

    for (const file of files) {
      const shownPath = withoutControlCharacters(file.path);
      console.error(`Running ${args.agent} on ${shownPath}`);
      const after = await fixFile(file, report, config, command);
      const score = after ? formatScore(after.score) : 'removed';
      console.log(`${shownPath} ${formatScore(file.score)} -> ${score}`);
    }
  },
});
