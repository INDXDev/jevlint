/** `jevlint quickfix`: has a coding agent only edit the worst file, then shows the diff. */
import { defineCommand } from 'citty';
import { agentFailure, quickfixFile } from '../agent.ts';
import { diffFiles, formatDiffStat, formatDiffs } from '../diff.ts';
import { formatScore, withoutControlCharacters } from '../report.ts';
import type { FileDiff } from '../types.ts';
import { AGENT_RUN_ARGS, prepareAgentRun, printJson } from './shared.ts';

const NOTHING_TO_FIX = 'Nothing to fix in the selected files. Pinned scores are left out.';

/** Colour only for a person: `NO_COLOR`, a pipe or a file gets a patch `git apply` takes. */
const wantsColor = (stream: NodeJS.WriteStream) => Boolean(stream.isTTY) && !process.env.NO_COLOR;

/** The `quickfix` command. */
export const quickfixCommand = defineCommand({
  meta: {
    name: 'jevlint quickfix',
    description: 'Have an agent only edit the worst file, in a few turns, then show the diff',
  },
  args: {
    ...AGENT_RUN_ARGS,
    json: { type: 'boolean', description: 'Print each file and its diffs as JSON' },
  },
  async run({ args }) {
    const run = await prepareAgentRun(args, 'quickfix');
    const results: { path: string; score: number; diffs: FileDiff[] }[] = [];
    if (run.files.length === 0) {
      console.error(NOTHING_TO_FIX);
      if (args.json) printJson({ files: results });
      return;
    }

    for (const file of run.files) {
      const shownPath = withoutControlCharacters(file.path);
      console.error(`Running ${args.agent} on ${shownPath} (score ${formatScore(file.score)})`);
      const { code, changes } = await quickfixFile(file, run.report, run.config, run.launch);
      const diffs = diffFiles(changes);
      results.push({ path: file.path, score: file.score, diffs });
      if (!args.json && diffs.length > 0) {
        console.log(formatDiffs(diffs, wantsColor(process.stdout)));
        console.error(formatDiffStat(diffs, wantsColor(process.stderr)));
      }
      if (diffs.length === 0) console.error(`${args.agent} changed nothing for ${shownPath}.`);
      if (code !== 0) {
        if (args.json) printJson({ files: results });
        const note = diffs.length > 0 ? ' Its changes so far are shown.' : '';
        throw agentFailure(run.launch, code, shownPath, note);
      }
    }
    if (args.json) printJson({ files: results });
  },
});
