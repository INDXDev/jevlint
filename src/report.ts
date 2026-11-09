/** Formats audit results for the terminal. */
// jevlint-score 76 -- Reviewed; splitting table, explain and plan output is the real fix, not more renames
import pc from 'picocolors';
import type { AuditPlan } from './audit.ts';
import type { FixtureReport, FixtureResult } from './fixtures.ts';
import { WEAK_COMPLIANCE } from './scoring.ts';
import type {
  AstFinding,
  AuditReport,
  ChangedFile,
  ChangeReview,
  FileReport,
  ModelAnswer,
} from './types.ts';

const SEPARATOR = '  ·  ';
const MIN_COLUMN_WIDTH = 16;
const NEXT_PROMPT_TOP = 3;
/** The file column's guaranteed share of the width left after rank and score. */
const FILE_COLUMN_SHARE = 0.55;
/** Two spaces before each of a row's four columns. */
const ROW_PADDING_WIDTH = 8;
/** Pattern findings carry no value or limit, so they rank as moderately bad. */
const PATTERN_HEALTH = 0.5;

interface ColumnWidths {
  file: number;
  issue: number;
}

interface TableRow {
  rank: string;
  score: string;
  location: string;
  issue: string;
}

/** For multi-line text: drops what could drive a terminal or disguise a file name, keeping layout. */
export const withoutEscapes = (text: string) =>
  text.replace(/[^\P{Cc}\n\t]|[\u202A-\u202E\u2066-\u2069]/gu, '?');

/** Paths, names and messages come from the repository, and could drive the terminal if printed raw. */
export const withoutControlCharacters = <T>(data: T): T =>
  JSON.parse(JSON.stringify(data), (_, value) =>
    typeof value === 'string' ? withoutEscapes(value).replace(/[\n\t]/g, '?') : value,
  );

/** Colours text by how healthy a 0 to 1 ratio is. */
export function colorByRatio(text: string, ratio: number): string {
  if (ratio < 0.5) return pc.red(text);
  return ratio < 0.8 ? pc.yellow(text) : pc.green(text);
}

/** Formats a score for display. Audits already round to `scoring.precision`. */
export const formatScore = (score: number) => String(score);

/** Formats a count with its noun, which needs its own plural when `s` is not enough. */
export const plural = (count: number, noun: string, nouns = `${noun}s`) =>
  `${count} ${count === 1 ? noun : nouns}`;

/** Puts a finding on the same 0 to 1 footing as a question's compliance. */
export function findingHealth({ value, limit }: AstFinding): number {
  return value && limit ? limit / value : PATTERN_HEALTH;
}

/** Returns a file's AST findings, worst first. */
export function worstFindings(file: Pick<FileReport, 'ast'>): AstFinding[] {
  const findings = file.ast?.findings ?? [];
  return findings.toSorted((a, b) => findingHealth(a) - findingHealth(b));
}

/** Returns a file's unpinned question answers, lowest compliance first. */
export function worstAnswers(file: Pick<FileReport, 'model'>): ModelAnswer[] {
  const answers = file.model?.answers.filter(({ pin }) => !pin) ?? [];
  return answers.toSorted((a, b) => a.compliance - b.compliance);
}

/** Describes a finding in one line, naming its symbol when there is one. */
export function describeFinding({ message, symbol }: AstFinding): string {
  return symbol ? `${message} in ${symbol}` : message;
}

/** Names the worst thing about a file or directory, from either engine. */
export function worstIssue(file: Pick<FileReport, 'ast' | 'model' | 'pin'>): string {
  if (file.pin) return `pinned: ${file.pin.reason}`;
  const [finding] = worstFindings(file);
  const [answer] = worstAnswers(file);
  if (!finding) return answer?.title ?? 'no issues found';
  if (!answer) return describeFinding(finding);
  const findingIsWorse = findingHealth(finding) <= answer.compliance;
  return findingIsWorse ? describeFinding(finding) : answer.title;
}

function locate(file: FileReport): string {
  const line = file.pin?.line ?? worstFindings(file)[0]?.line;
  return line ? `${file.path}:${line}` : file.path;
}

const truncateEnd = (text: string, width: number) =>
  text.length <= width ? text : `${text.slice(0, width - 1)}…`;

/** Keeps the end of a path, because the file name and line matter most. */
const truncateStart = (text: string, width: number) =>
  text.length <= width ? text : `…${text.slice(text.length - width + 1)}`;

const longest = (texts: string[]) => texts.reduce((max, text) => Math.max(max, text.length), 0);

/** Splits the space left for the file and issue columns. An issue width of 0 hides that column. */
function columnWidths(locations: string[], issues: string[], available: number): ColumnWidths {
  const widestFile = longest(['File', ...locations]);
  const spareAfterIssues = available - longest(issues);
  const guaranteedFileWidth = Math.floor(available * FILE_COLUMN_SHARE);
  const file = Math.min(widestFile, Math.max(spareAfterIssues, guaranteedFileWidth));
  const issue = available - file;
  if (issue >= MIN_COLUMN_WIDTH) return { file, issue };
  return { file: Math.max(available, MIN_COLUMN_WIDTH), issue: 0 };
}

function formatRow({ rank, score, location, issue }: TableRow, widths: ColumnWidths): string {
  const file = truncateStart(location, widths.file).padEnd(widths.file);
  const issueCell = widths.issue ? truncateEnd(issue, widths.issue) : '';
  return `  ${rank}  ${score}  ${file}  ${issueCell}`.trimEnd();
}

/** A pipe has no width, and some terminals report 0. Full paths are more useful than truncated ones. */
const terminalWidth = () => process.stdout.columns || Number.POSITIVE_INFINITY;

function formatTable(files: FileReport[], scale: number): string {
  const cells = files.map((file) => ({
    file,
    score: formatScore(file.score),
    location: locate(file),
    issue: worstIssue(file),
  }));
  const rankWidth = String(files.length).length;
  const scoreWidth = longest(['Score', ...cells.map(({ score }) => score)]);
  const available = terminalWidth() - rankWidth - scoreWidth - ROW_PADDING_WIDTH;
  const widths = columnWidths(
    cells.map(({ location }) => location),
    cells.map(({ issue }) => issue),
    available,
  );

  const headerRow = {
    rank: '#'.padStart(rankWidth),
    score: 'Score'.padStart(scoreWidth),
    location: 'File',
    issue: 'Worst issue',
  };
  const rows = cells.map(({ file, score, location, issue }, index) => {
    const rank = String(index + 1).padStart(rankWidth);
    const coloredScore = colorByRatio(score.padStart(scoreWidth), file.score / scale);
    return formatRow({ rank, score: coloredScore, location, issue }, widths);
  });
  return [pc.dim(formatRow(headerRow, widths)), ...rows].join('\n');
}

function formatHeader({ root, provider, model, presets }: AuditReport): string {
  const engine = model ? `${provider}/${model}` : 'AST only';
  return ` ${pc.bold('jevlint')}  ${[root, engine, presets.join(', ')].join(SEPARATOR)}`;
}

function formatSummary({ score, scale, files, skipped }: AuditReport): string {
  const threshold = scale / 2;
  const belowThreshold = files.filter((file) => file.score < threshold).length;
  const parts = [
    `Repository score ${colorByRatio(formatScore(score), score / scale)}/${scale}`,
    plural(files.length, 'file'),
    `${belowThreshold} below ${formatScore(threshold)}`,
  ];
  const pinned = files.filter((file) => file.pin).length;
  if (pinned > 0) parts.push(`${pinned} pinned`);
  if (skipped.length > 0) parts.push(`${skipped.length} skipped`);
  return ` ${parts.join(SEPARATOR)}`;
}

function formatEmpty({ skipped }: AuditReport): string {
  if (skipped.length === 0) {
    return ' No files to audit.\n Next: jevlint config show   # check include and exclude';
  }
  const reason = `Skipped ${plural(skipped.length, 'file')}: no AST support and no model ran.`;
  return ` ${reason}\n Next: jevlint auth list`;
}

/** The hint gets pasted into a shell, and the path comes from the repository. */
const shellQuoted = (path: string) =>
  /^[\w./-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;

function formatNext(report: AuditReport, shown: number, presets: string[] = []): string {
  const top = Math.min(NEXT_PROMPT_TOP, report.files.length);
  // Only known presets get this far, and their names are limited to shell-safe characters.
  const flag = presets.length > 0 ? ` --preset ${presets.join(',')}` : '';
  const worst = shellQuoted(report.files[0]?.path ?? '');
  const hints = [
    ` Next: jevlint explain ${worst}${flag}`,
    `       jevlint prompt --top ${top} --copy${flag}`,
    `       jevlint quickfix ${worst} --agent claude${flag}`,
  ];
  const hidden = report.files.length - shown;
  if (hidden > 0) hints.unshift(` ${hidden} more. Show them with --top ${report.files.length}`, '');
  return hints.join('\n');
}

/** Renders the ranked audit table with its header and next-step hints. */
export function formatReport(
  untrusted: AuditReport,
  opts: { top: number; presets?: string[] },
): string {
  const report = withoutControlCharacters(untrusted);
  const header = formatHeader(report);
  if (report.files.length === 0) return `${header}\n\n${formatEmpty(report)}`;
  const shown = report.files.slice(0, opts.top);
  return [
    [header, formatSummary(report), ...formatUsage(report.usage)].join('\n'),
    formatTable(shown, report.scale),
    formatNext(report, shown.length, opts.presets),
  ].join('\n\n');
}

function formatSection(title: string, lines: string[]): string[] {
  return lines.length > 0 ? ['', ` ${pc.bold(title)}`, ...lines] : [];
}

function formatFindingLines(file: FileReport): string[] {
  const findings = worstFindings(file);
  const width = longest(findings.map(({ line }) => String(line)));
  return findings.map(
    (finding) => `  line ${String(finding.line).padStart(width)}  ${describeFinding(finding)}`,
  );
}

function formatAnswerLines(file: FileReport): string[] {
  return worstAnswers(file).map(({ compliance, title, id }) => {
    const value = colorByRatio(compliance.toFixed(2), compliance);
    return `  ${value}  ${title} ${pc.dim(`(${id})`)}`;
  });
}

function formatPinLines({ pin, model }: FileReport): string[] {
  const questionPins = model?.answers.filter((answer) => answer.pin) ?? [];
  const questions = questionPins.map(
    ({ id, compliance, pin }) =>
      `  ${compliance.toFixed(2)}  ${id}: ${pin?.reason} (line ${pin?.line})`,
  );
  return pin ? [`  whole file: ${pin.reason} (line ${pin.line})`, ...questions] : questions;
}

function formatEngineScores({ ast, model }: FileReport): string[] {
  const scores: string[] = [];
  if (ast) scores.push(`AST ${ast.approximate ? '~' : ''}${ast.score.toFixed(2)}`);
  if (model) scores.push(`Model ${model.score.toFixed(2)}`);
  return scores;
}

function formatFileFacts(file: FileReport): string {
  const language = file.language ?? 'unknown language';
  const facts = [language, plural(file.lines, 'line'), plural(file.commits, 'commit')];
  return ` ${[pc.bold(file.path), ...facts].join(SEPARATOR)}`;
}

function formatFileScores(file: FileReport, scale: number): string {
  const score = colorByRatio(formatScore(file.score), file.score / scale);
  return ` ${[`Score ${score}/${scale}`, ...formatEngineScores(file)].join(SEPARATOR)}`;
}

/** Renders every finding and question score for one file. */
export function formatExplain(untrusted: FileReport, report: AuditReport): string {
  const file = withoutControlCharacters(untrusted);
  const details = [
    ...formatSection('AST findings, worst first', formatFindingLines(file)),
    ...formatSection('Questions, worst first', formatAnswerLines(file)),
    ...formatSection('Pinned', formatPinLines(file)),
    ...formatSection(
      'Warnings',
      file.warnings.map((warning) => `  ${warning}`),
    ),
  ];
  const body = details.length > 0 ? details : ['', ' No findings.'];
  return [formatFileFacts(file), formatFileScores(file, report.scale), ...body].join('\n');
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  return usd < 0.0001 ? 'under $0.0001' : `$${usd.toFixed(4)}`;
}

/** Summarises what a run spent, as a line for a report, or nothing when no model ran. */
export function formatUsage(usage: AuditReport['usage']): string[] {
  const { inputTokens, estimatedCostUsd, cacheHits, modelCalls } = usage;
  if (modelCalls === 0 && cacheHits === 0) return [];
  const cost = estimatedCostUsd === null ? '' : `, about ${formatCost(estimatedCostUsd)}`;
  const tokens = inputTokens.toLocaleString('en-US');
  return [
    ` ${plural(modelCalls, 'model call')}, ${tokens} input tokens${cost}. ${cacheHits} cached, at no cost.`,
  ];
}

function formatChangedFile(file: ChangedFile, scale: number): string[] {
  const after = colorByRatio(formatScore(file.after), file.after / scale);
  const scores = file.before === null ? `new, ${after}` : `${formatScore(file.before)} -> ${after}`;
  return [
    ` ${file.path}  ${scores}`,
    ...file.findings.map((finding) => `   Line ${finding.line}: ${describeFinding(finding)}`),
    ...file.answers.map(({ title }) => `   ${title}`),
    ...file.warnings.map((warning) => `   ${warning}`),
  ];
}

function formatIntent({ intent, warnings = [] }: ChangeReview): string[] {
  if (!intent) return [];
  const weak = intent.filter(({ compliance }) => compliance < WEAK_COMPLIANCE);
  const summary = intent.length > 0 && weak.length === 0 ? [' Intent: no weak answers.'] : [];
  return [
    ...summary,
    ...weak.flatMap(({ compliance, title, id, fix }) => [
      ` Intent ${colorByRatio(compliance.toFixed(2), compliance)}  ${title} ${pc.dim(`(${id})`)}`,
      `   Fix: ${fix}`,
    ]),
    ...warnings.map((warning) => ` Intent: ${warning}`),
  ];
}

/** Renders one change: each file's score before and after, and what the change made worse. */
export function formatReview(untrusted: ChangeReview): string {
  const review = withoutControlCharacters(untrusted);
  const files = review.files.flatMap((file) => formatChangedFile(file, review.scale));
  const skipped = review.skipped.length > 0 ? [` Not scored: ${review.skipped.join(', ')}`] : [];
  return [
    pc.bold(review.title),
    ...(files.length > 0 ? files : [' No auditable files changed.']),
    ...skipped,
    ...formatIntent(review),
    ...formatUsage(review.usage),
  ].join('\n');
}

function formatFixture({ passed, compliance, question, file, recorded, moved }: FixtureResult) {
  const result = passed ? pc.green('pass') : pc.red('FAIL');
  const shift = moved ? `  moved from ${recorded?.toFixed(2)}` : '';
  return ` ${result}  ${compliance.toFixed(2)}  ${question}/${file}${shift}`;
}

/** Renders fixture results as a table, with what moved when the run compared against a record. */
export function formatFixtures(untrusted: FixtureReport): string {
  const { results, usage } = withoutControlCharacters(untrusted);
  const passed = results.filter((result) => result.passed).length;
  const moved = results.filter((result) => result.moved).length;
  return [
    ...results.map(formatFixture),
    '',
    ` ${passed} of ${plural(results.length, 'fixture')} passed.`,
    ...(moved > 0 ? [` ${plural(moved, 'fixture')} moved.`] : []),
    ...formatUsage(usage),
  ].join('\n');
}

/** Renders a dry run. A null provider means the audit stays on this machine. */
export function formatPlan(
  untrusted: Pick<AuditPlan, 'files' | 'skipped' | 'estimatedTokens' | 'estimatedCostUsd'>,
  provider: string | null,
): string {
  const plan = withoutControlCharacters(untrusted);
  const files = plural(plan.files.length, 'file');
  const tokens = plan.estimatedTokens.toLocaleString('en-US');
  const cost =
    plan.estimatedCostUsd === null ? '' : ` (about ${formatCost(plan.estimatedCostUsd)})`;
  const skipped =
    plan.skipped > 0
      ? ` ${plural(plan.skipped, 'file')} pinned, blank or cached, and not counted.`
      : '';
  const summary = provider
    ? ` ${files}, about ${tokens} tokens${cost}, would be sent to ${provider}.${skipped}`
    : ` ${files} would be analysed locally, and nothing would be sent.`;
  const list = plan.files.map((path) => `  ${path}\n`).join('');
  return list ? `${list}\n${summary}` : summary;
}
