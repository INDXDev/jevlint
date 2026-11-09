/** Renders fix prompts for coding agents. */
import {
  describeFinding,
  formatScore,
  withoutControlCharacters,
  worstAnswers,
  worstFindings,
} from './report.ts';
import { WEAK_COMPLIANCE } from './scoring.ts';
import type { AuditReport, FileReport } from './types.ts';

const NOTHING_TO_FIX =
  'jevlint found nothing to fix in the selected files. Pinned scores are left out.';

const INSTRUCTIONS = `## How to work

1. Read each file, its callers and its tests before changing anything.
2. Preserve behaviour. This is a refactor, not a rewrite or a feature.
3. Keep public APIs unless a fix requires changing one, and then update every caller.
4. Make the smallest clean change that resolves the issues. Leave unrelated code alone.
5. Fix the cause. Do not suppress findings, add or change jevlint-score comments, or move the mess to another file.
6. Run the project's tests, plus its lint and type checks if it has them, and fix what you broke.
7. Do not commit. Leave your changes in the working tree for review.
8. Finish with a short summary of what changed and anything you chose to leave.`;

const QUICKFIX_INSTRUCTIONS = `## How to work

This is a quick fix: edit files and stop.

1. Work on the file above. Open other files only to keep its callers working.
2. Preserve behaviour and public APIs. Extracting functions, flattening nesting, renaming locals and splitting the file are in scope. A rewrite is not.
3. If you move code to a new file, update every import of it, or re-export it from the original file.
4. Make the smallest clean change that resolves the issues. Leave unrelated code alone.
5. Fix the cause. Do not suppress findings, add or change jevlint-score comments, or move the mess to another file.
6. Only read and edit files. Do not run tests, builds, linters, formatters or any other command, and install nothing.
7. Do not commit, stage or create branches. Leave your changes in the working tree for review.
8. Finish in one turn if you can, and in a few at most. End with one line saying what changed.`;

/** Returns a file's unpinned answers poor enough to act on, lowest compliance first. */
export const weakAnswers = (file: Pick<FileReport, 'model'>) =>
  worstAnswers(file).filter(({ compliance }) => compliance < WEAK_COMPLIANCE);

/** Says whether a file has anything worth handing to an agent. A pinned score is settled. */
export function hasIssues(file: FileReport): boolean {
  if (file.pin) return false;
  return worstFindings(file).length > 0 || weakAnswers(file).length > 0;
}

function renderList(title: string, items: string[]): string[] {
  return items.length > 0 ? [`${title}:\n\n${items.join('\n')}`] : [];
}

function renderFile(file: FileReport, scale: number): string {
  // Each stays on its own line, so a file name or preset cannot add headings for the agent to obey.
  const path = withoutControlCharacters(file.path);
  const findings = worstFindings(file).map((finding) => {
    const fix = finding.fix ? `: ${finding.fix}` : '';
    return withoutControlCharacters(
      `- \`${path}:${finding.line}\`: ${describeFinding(finding)}${fix}`,
    );
  });
  const answers = weakAnswers(file).map(({ title, compliance, fix }) =>
    withoutControlCharacters(`- **${title}** (compliance ${compliance.toFixed(2)}): ${fix}`),
  );
  return [
    `## \`${path}\` (score ${formatScore(file.score)}/${scale})`,
    ...renderList('Measured issues, worst first', findings),
    ...renderList('Weakest principles, with how to fix them', answers),
  ].join('\n\n');
}

function renderIntro(count: number, { presets, scale }: AuditReport): string {
  const subject = count === 1 ? 'the file below' : `the ${count} files below, in order`;
  const principles = presets.length > 0 ? ` against these principles: ${presets.join(', ')}` : '';
  return `# Refactor for cleanliness

Refactor ${subject}. jevlint, a code quality linter, audited this repository${principles}. Scores run from 0 to ${scale} and compliance from 0 to 1. Higher is cleaner.`;
}

/** Renders a Markdown prompt naming paths and problems, never file contents. */
export function renderPrompt(
  files: FileReport[],
  report: AuditReport,
  instructions = INSTRUCTIONS,
): string {
  const actionable = files.filter(hasIssues);
  if (actionable.length === 0) return NOTHING_TO_FIX;
  return [
    renderIntro(actionable.length, report),
    ...actionable.map((file) => renderFile(file, report.scale)),
    instructions,
  ].join('\n\n');
}

/** Renders the prompt for `quickfix`: the same issues, for an agent that only edits files. */
export const renderQuickfixPrompt = (file: FileReport, report: AuditReport) =>
  renderPrompt([file], report, QUICKFIX_INSTRUCTIONS);
