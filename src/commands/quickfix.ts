/** `jevlint quickfix`: has a coding agent only edit the worst files, then shows and scores the diff. */
import { defineCommand } from 'citty';
import { agentFailure, quickfixFile, rescoreFiles } from '../agent.ts';
import { diffFiles } from '../diff.ts';
import { type DiffView, formatDiffStat, formatDiffs, SPLIT_MIN_WIDTH } from '../diff-view.ts';
import { commitPaths, isWorkTree } from '../git.ts';
import { formatScore, plural, withoutControlCharacters } from '../report.ts';
import type { FileDiff, FileReport, QuickfixFileResult } from '../types.ts';
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
function chooseView(sideBySide: boolean | undefined, stream: NodeJS.WriteStream): DiffView {
  const color = wantsColor(stream);
  const width = stream.columns || PIPED_WIDTH;
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

/** Prints the diffs to stdout, and their summary with each file's score change to stderr. */
function printDiffs(diffs: FileDiff[], view: DiffView): void {
  console.log(formatDiffs(diffs, view));
  const scores = new Map(
    diffs.map(({ path, scoreBefore, scoreAfter }) => [
      path,
      { before: scoreBefore ?? null, after: scoreAfter ?? null },
    ]),
  );
  console.error(formatDiffStat(diffs, wantsColor(process.stderr), scores));
}

/** The file's new score, or null when the agent left it alone or no audit covers it now. */
function scoreAfterOf(file: FileReport, diffs: FileDiff[]): number | null {
  return diffs.find(({ path }) => path === file.path)?.scoreAfter ?? null;
}

/** The commit message: what was refactored, how its score moved, and that nothing was tested. */
export function commitMessage(file: FileReport, diffs: FileDiff[], agent: string): string {
  // Repository paths stay on one line each, so a name cannot add lines or trailers to the message.
  const path = withoutControlCharacters(file.path);
  const after = scoreAfterOf(file, diffs);
  const score =
    after === null ? [] : [`Score ${formatScore(file.score)} -> ${formatScore(after)}.`];
  const paths = diffs.map((diff) => withoutControlCharacters(diff.path)).join(', ');
  return [
    `Refactor ${path} with jevlint quickfix`,
    '',
    ...score,
    `${agent} edited ${plural(diffs.length, 'file')}: ${paths}.`,
    'jevlint quickfix ran no tests on this change.',
  ].join('\n');
}

/**
 * Commits one run's files with git and says so. Returns the short hash, or null when it left the
 * run uncommitted, as it does when the run touched changes that were there before it.
 */
async function commitRun(
  run: AgentRun,
  file: FileReport,
  diffs: FileDiff[],
  uncommittedBefore: string[],
): Promise<string | null> {
  const earlier = diffs.filter(({ path }) => uncommittedBefore.includes(path));
  if (earlier.length > 0) {
    const names = withoutControlCharacters(earlier.map(({ path }) => path).join(', '));
    console.error(
      `Not committed: ${names} already had uncommitted changes, which the commit would take in. Review and commit them yourself.`,
    );
    return null;
  }
  const message = commitMessage(file, diffs, run.launch.name);
  const hash = await commitPaths(
    run.config.root,
    diffs.map(({ path }) => path),
    message,
  );
  const [subject] = message.split('\n');
  console.error(
    `Committed ${hash} "${subject}" (${plural(diffs.length, 'file')}). Undo with: git reset --soft HEAD~1`,
  );
  return hash;
}

/** What every file's run shares. */
interface QuickfixContext {
  run: AgentRun;
  view: DiffView;
  /** Print JSON at the end instead of the diffs. */
  json: boolean;
  /** Commit each run that succeeded and changed something. */
  commit: boolean;
  /** Each file's latest score, updated as runs re-score files. */
  known: Map<string, number>;
}

/** One file's run: what goes in the JSON report, and the agent's exit code. */
interface FileOutcome {
  result: QuickfixFileResult;
  code: number;
}

/** Whether to commit: only when asked to and inside a git work tree. Says why it will not. */
async function willCommit(wanted: boolean, root: string): Promise<boolean> {
  if (!wanted) return false;
  if (await isWorkTree(root)) return true;
  console.error('Not committing: this is not a git repository.');
  return false;
}

/** `[2/5] ` when there are several files to fix, or nothing for one. */
function stepLabel(index: number, total: number): string {
  return total > 1 ? `[${index + 1}/${total}] ` : '';
}

/**
 * Runs the agent on one file, then re-scores, shows and commits what it changed. A failed run is
 * shown but neither re-scored nor committed.
 */
async function fixFile(
  file: FileReport,
  step: string,
  context: QuickfixContext,
): Promise<FileOutcome> {
  const { run } = context;
  const agent = run.launch.name;
  const shownPath = withoutControlCharacters(file.path);
  console.error(`${step}Running ${agent} on ${shownPath} (score ${formatScore(file.score)})`);
  const { code, changes, uncommittedBefore } = await quickfixFile(
    file,
    run.report,
    run.config,
    run.launch,
  );
  const unchanged = { path: file.path, score: file.score, after: null, diffs: [], commit: null };
  const changed = diffFiles(changes);
  if (changed.length === 0) {
    console.error(`${agent} changed nothing for ${shownPath}.`);
    return { result: unchanged, code };
  }
  const succeeded = code === 0;
  const diffs = succeeded ? await scoreDiffs(run, changed, context.known) : changed;
  if (!context.json) printDiffs(diffs, context.view);
  const commit =
    context.commit && succeeded ? await commitRun(run, file, diffs, uncommittedBefore) : null;
  return { result: { ...unchanged, after: scoreAfterOf(file, diffs), diffs, commit }, code };
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
    commit: {
      type: 'boolean',
      default: true,
      description:
        "Commit each file's changes with git, one commit per file. --no-commit leaves them",
    },
    json: { type: 'boolean', description: 'Print each file, its diffs and their scores as JSON' },
  },
  async run({ args }) {
    const run = await prepareAgentRun(args, 'quickfix');
    if (run.files.length === 0) {
      console.error(NOTHING_TO_FIX);
      if (args.json) printJson({ files: [] });
      return;
    }
    const context: QuickfixContext = {
      run,
      view: chooseView(args['side-by-side'], process.stdout),
      json: Boolean(args.json),
      commit: await willCommit(args.commit !== false, run.config.root),
      known: new Map(run.report.files.map(({ path, score }) => [path, score])),
    };
    const results: QuickfixFileResult[] = [];
    // One file at a time, so each agent sees the last one's edits and no two edit at once.
    for (const [index, file] of run.files.entries()) {
      const { result, code } = await fixFile(file, stepLabel(index, run.files.length), context);
      results.push(result);
      if (code !== 0) {
        if (context.json) printJson({ files: results });
        const note = result.diffs.length > 0 ? ' Its changes so far are shown.' : '';
        throw agentFailure(run.launch, code, withoutControlCharacters(file.path), note);
      }
    }
    if (context.json) printJson({ files: results });
  },
});
