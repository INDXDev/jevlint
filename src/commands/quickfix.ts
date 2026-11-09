/** `jevlint quickfix`: has a coding agent only edit the worst files, then shows and scores the diff. */
import { defineCommand } from 'citty';
import { agentFailure, quickfixFile, rescoreFiles } from '../agent.ts';
import { diffFiles } from '../diff.ts';
import { type DiffView, formatDiffStat, formatDiffs, SPLIT_MIN_WIDTH } from '../diff-view.ts';
import { formatScore, withoutControlCharacters } from '../report.ts';
import type { FileDiff, QuickfixFileResult } from '../types.ts';
import {
  AGENT_RUN_ARGS,
  type AgentRun,
  prepareAgentRun,
  printJson,
  withSpinner,
} from './shared.ts';

const NOTHING_TO_FIX = 'Nothing to fix in the selected files. Pinned scores are left out.';
/** Side by side output for a pipe or file has no terminal width to fill. */
const PIPED_WIDTH = 160;

/** Colour only for a person: `NO_COLOR`, a pipe or a file gets a patch `git apply` takes. */
const wantsColor = (stream: NodeJS.WriteStream) => Boolean(stream.isTTY) && !process.env.NO_COLOR;

/** Side by side when asked, or in a terminal wide enough for two panels. */
function chooseView(sideBySide: boolean | undefined): DiffView {
  const color = wantsColor(process.stdout);
  const width = process.stdout.columns || PIPED_WIDTH;
  const split = sideBySide ?? (color && width >= SPLIT_MIN_WIDTH);
  return { color, layout: split ? 'split' : 'unified', width };
}

/** Re-audits what the agent left, and records each file's score before and after. */
async function scoreDiffs(
  run: AgentRun,
  diffs: FileDiff[],
  known: Map<string, number>,
): Promise<FileDiff[]> {
  const kept = diffs.filter(({ status }) => status !== 'deleted').map(({ path }) => path);
  console.error('Re-scoring with jevlint audit');
  const fresh = await withSpinner(() => rescoreFiles(run.config, kept));
  return diffs.map((diff) => {
    const scoreBefore = known.get(diff.path) ?? null;
    const scoreAfter = fresh.get(diff.path)?.score ?? null;
    if (scoreAfter !== null) known.set(diff.path, scoreAfter);
    return { ...diff, scoreBefore, scoreAfter };
  });
}

function printDiffs(diffs: FileDiff[], view: DiffView): void {
  console.log(formatDiffs(diffs, view));
  const scores = new Map(
    diffs.map(({ path, scoreBefore = null, scoreAfter = null }) => [
      path,
      { before: scoreBefore, after: scoreAfter },
    ]),
  );
  console.error(formatDiffStat(diffs, wantsColor(process.stderr), scores));
}

/** The `quickfix` command. */
export const quickfixCommand = defineCommand({
  meta: {
    name: 'jevlint quickfix',
    description:
      'Have an agent only edit the worst files, one at a time, then show and score the diff',
  },
  args: {
    ...AGENT_RUN_ARGS,
    'side-by-side': {
      type: 'boolean',
      description: `Show old and new side by side. Default: in a terminal at least ${SPLIT_MIN_WIDTH} columns wide`,
    },
    json: { type: 'boolean', description: 'Print each file, its diffs and their scores as JSON' },
  },
  async run({ args }) {
    const run = await prepareAgentRun(args, 'quickfix');
    const results: QuickfixFileResult[] = [];
    if (run.files.length === 0) {
      console.error(NOTHING_TO_FIX);
      if (args.json) printJson({ files: results });
      return;
    }
    const view = chooseView(args['side-by-side']);
    const known = new Map(run.report.files.map(({ path, score }) => [path, score]));

    // One file at a time, so each agent sees the last one's edits and no two edit at once.
    for (const [index, file] of run.files.entries()) {
      const shownPath = withoutControlCharacters(file.path);
      const step = run.files.length > 1 ? `[${index + 1}/${run.files.length}] ` : '';
      console.error(
        `${step}Running ${args.agent} on ${shownPath} (score ${formatScore(file.score)})`,
      );
      const { code, changes } = await quickfixFile(file, run.report, run.config, run.launch);
      let diffs = diffFiles(changes);
      if (code === 0 && diffs.length > 0) diffs = await scoreDiffs(run, diffs, known);
      const after = diffs.find(({ path }) => path === file.path)?.scoreAfter ?? null;
      results.push({ path: file.path, score: file.score, after, diffs });
      if (!args.json && diffs.length > 0) printDiffs(diffs, view);
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
