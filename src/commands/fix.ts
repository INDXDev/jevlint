/** `jevlint fix`: runs a coding agent on the worst files. */
import { defineCommand } from 'citty';
import { fixFile } from '../agent.ts';
import { renderPrompt } from '../prompt.ts';
import { formatScore, withoutControlCharacters } from '../report.ts';
import { AGENT_RUN_ARGS, prepareAgentRun } from './shared.ts';

/** The `fix` command. */
export const fixCommand = defineCommand({
  meta: { name: 'jevlint fix', description: 'Run an agent on the worst files, then re-score them' },
  args: AGENT_RUN_ARGS,
  async run({ args }) {
    const { config, launch, report, files } = await prepareAgentRun(args, 'fix');
    if (files.length === 0)
      return console.error('Nothing to fix in the selected files. Pinned scores are left out.');

    for (const file of files) {
      const shownPath = withoutControlCharacters(file.path);
      console.error(`Running ${args.agent} on ${shownPath}`);
      const after = await fixFile(file, renderPrompt([file], report), config, launch);
      const score = after ? formatScore(after.score) : 'removed';
      console.log(`${shownPath} ${formatScore(file.score)} -> ${score}`);
    }
  },
});
