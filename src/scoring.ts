/** Pure functions implementing the formulas in docs/scoring.md. */
// jevlint-score 77 -- Reviewed; the remaining gap is within model noise
import type { Config } from './config.ts';
import type {
  AcceptanceVerdict,
  AstFinding,
  FileReport,
  ModelAnswer,
  ModelResult,
  Pin,
  Question,
  RawAnswer,
} from './types.ts';

type Scoring = Config['scoring'];

const PATTERN_MATCH_PENALTY = 0.95;

/** Below this, a question's compliance is poor enough to act on. */
export const WEAK_COMPLIANCE = 0.7;

interface Weighted {
  value: number;
  weight: number;
}

/** Raw answers plus the request details that `modelResult` carries through. */
export type Decision = Pick<ModelResult, 'cached' | 'truncated' | 'inputTokens'> & {
  answers: Record<string, RawAnswer>;
};

/** With nothing to weigh there is nothing wrong, so the result is a perfect 1. */
function weightedMean(items: Weighted[]): number {
  const totalWeight = items.reduce((sum, { weight }) => sum + weight, 0);
  if (totalWeight === 0) return 1;
  const weightedSum = items.reduce((sum, { value, weight }) => sum + value * weight, 0);
  return weightedSum / totalWeight;
}

/** Converts a raw answer to a value from 0 (worst) to 1 (best). */
export function compliance(question: Question, raw: RawAnswer): number {
  if (question.type === 'score') {
    const highestLevel = question.levels.length - 1;
    return raw.value / highestLevel;
  }
  return question.good ? raw.value : 1 - raw.value;
}

/** A metric's score, as a list that is empty when the finding measured nothing. */
function metricScores({ value, limit }: AstFinding): number[] {
  if (value === undefined || limit === undefined) return [];
  return [Math.min(1, limit / value)];
}

/** Scores a file's findings: the worst metric, reduced by 5% for each pattern match. */
export function astScoreFrom(findings: AstFinding[]): number {
  const worstMetric = Math.min(1, ...findings.flatMap(metricScores));
  const patternMatches = findings.filter(({ value }) => value === undefined).length;
  return worstMetric * PATTERN_MATCH_PENALTY ** patternMatches;
}

function presetOf({ id }: ModelAnswer): string {
  return id.slice(0, id.lastIndexOf('.'));
}

function presetScores(answers: ModelAnswer[]): Record<string, number> {
  const presets = [...new Set(answers.map(presetOf))];
  const answersFor = (preset: string) => answers.filter((answer) => presetOf(answer) === preset);
  return Object.fromEntries(presets.map((preset) => [preset, meanCompliance(answersFor(preset))]));
}

function meanCompliance(answers: ModelAnswer[]): number {
  return weightedMean(answers.map(({ compliance, weight }) => ({ value: compliance, weight })));
}

function toModelAnswer(question: Question, raw: RawAnswer, pin?: Pin): ModelAnswer {
  const { id, title, weight, fix } = question;
  const answer = { id, title, compliance: compliance(question, raw), weight, fix };
  return pin ? { ...answer, compliance: pin.value, pin } : answer;
}

/** Turns one file's raw answers and pins into its model score and per-preset breakdown. */
export function modelResult(
  questions: Question[],
  decision: Decision,
  pins: Record<string, Pin> = {},
): ModelResult {
  const { answers: rawAnswers, ...requestDetails } = decision;
  const answers = questions.map((question) =>
    toModelAnswer(question, rawAnswers[question.id] as RawAnswer, pins[question.id]),
  );
  return {
    ...requestDetails,
    score: meanCompliance(answers),
    answers,
    presets: presetScores(answers),
  };
}

/** Blends the engines that ran, or returns null when neither did. */
export function fileScore(
  ast: number | null,
  model: number | null,
  scoring: Scoring,
): number | null {
  if (ast === null) return model;
  if (model === null) return ast;
  return weightedMean([
    { value: ast, weight: scoring.ast_weight },
    { value: model, weight: scoring.model_weight },
  ]);
}

/** Where `value` sits between 0 and `max` on a log scale, so one giant file cannot flatten the rest. */
function logShareOfMax(value: number, max: number): number {
  return max === 0 ? 0 : Math.log1p(value) / Math.log1p(max);
}

/**
 * Sets each file's priority from its 0 to 1 score and sorts highest first, then by path.
 * A pinned file gets no priority: its score is accepted, however low.
 */
export function rank(files: FileReport[], { churn, size }: Config['priority']): FileReport[] {
  // Not `Math.max(...)`: a large monorepo has more files than a call can take arguments.
  const maxCommits = files.reduce((max, file) => Math.max(max, file.commits), 0);
  const maxLines = files.reduce((max, file) => Math.max(max, file.lines), 0);
  const withPriority = (file: FileReport) => {
    const churnBoost = churn * logShareOfMax(file.commits, maxCommits);
    const sizeBoost = size * logShareOfMax(file.lines, maxLines);
    const mess = file.pin ? 0 : 1 - file.score;
    return { ...file, priority: mess * (1 + churnBoost + sizeBoost) };
  };
  return files.map(withPriority).sort(byPriorityThenPath);
}

function byPriorityThenPath(a: FileReport, b: FileReport): number {
  return b.priority - a.priority || a.path.localeCompare(b.path);
}

/** Line-weighted mean of the files that an engine scored or a comment pinned. */
export function repoScore(
  files: Pick<FileReport, 'ast' | 'model' | 'pin' | 'score' | 'lines'>[],
): number {
  const scoredFiles = files.filter((file) => file.ast || file.model || file.pin);
  return weightedMean(scoredFiles.map((file) => ({ value: file.score, weight: file.lines })));
}

const VERDICT_POINTS: Record<Exclude<AcceptanceVerdict, 'cannot-tell'>, number> = {
  met: 1,
  partly: 0.5,
  'not-met': 0,
};

/**
 * A change's acceptance score: the points of its verdicts over the criteria a diff can show, on the
 * configured scale. `cannot-tell` and unjudged criteria are left out. Null when none count.
 */
export function acceptanceScore(
  verdicts: (AcceptanceVerdict | null)[],
  scoring: Scoring,
): number | null {
  const counted = verdicts.filter(
    (verdict): verdict is keyof typeof VERDICT_POINTS =>
      verdict !== null && verdict !== 'cannot-tell',
  );
  if (counted.length === 0) return null;
  const points = counted.reduce((sum, verdict) => sum + VERDICT_POINTS[verdict], 0);
  return scaleScore(points / counted.length, scoring);
}

/** Converts a 0 to 1 score to the configured display scale. */
export function scaleScore(score: number, { scale, precision }: Scoring): number {
  return Number((score * scale).toFixed(precision));
}
