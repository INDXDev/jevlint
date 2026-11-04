/** Runs the pipeline over a repository and assembles the report. */
// jevlint-score 77 -- Reviewed; the remaining gap is within model noise
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pLimit from 'p-limit';
import { analyzeAst, countLines } from './ast/analyze.ts';
import { analyzeGeneric } from './ast/generic.ts';
import { languageOf } from './ast/languages.ts';
import { type Config, UserError } from './config.ts';
import {
  decideFile,
  decisionRequest,
  isDecisionCached,
  PROVIDER_ERROR,
} from './decision/decide.ts';
import { estimateCostUsd } from './decision/pricing.ts';
import { createDecisionModel, type ModelTarget, type ResolvedModel } from './decision/providers.ts';
import { type Directives, parseDirectives } from './directives.ts';
import { discoverFiles } from './files.ts';
import { commitCounts } from './git.ts';
import { activeQuestions, loadPresets } from './presets.ts';
import { judgeRules, plannedRuleChars } from './rules.ts';
import { fileScore, modelResult, rank, repoScore, scaleScore } from './scoring.ts';
import type {
  AstPattern,
  AstResult,
  AstRule,
  AuditReport,
  FileReport,
  Language,
  ModelResult,
  Question,
} from './types.ts';

const CHARS_PER_TOKEN = 4;

export { PROVIDER_ERROR };

/** Narrows and observes a run. */
export interface AuditOptions {
  paths?: string[];
  astOnly?: boolean;
  noCache?: boolean;
  /** Scores files as if no `jevlint-score` comment existed. */
  ignorePins?: boolean;
  /** Where repository presets live, when `config.root` is a snapshot that has none. */
  presetsRoot?: string;
  onProgress?: (done: number, total: number, path: string) => void;
}

interface Run {
  config: Config;
  options: AuditOptions;
  resolved: ResolvedModel | null;
  questions: Question[];
  patterns: AstPattern[];
  rules: AstRule[];
  commits: Map<string, number>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readSource(config: Config, path: string): Promise<string> {
  return readFile(join(config.root, path), 'utf8');
}

function readDirectives(source: string, { scoring }: Config, ignorePins?: boolean): Directives {
  const directives = parseDirectives(source, scoring.scale);
  return ignorePins ? { ...directives, filePin: null, questionPins: {} } : directives;
}

function unknownPinWarnings({ questionPins }: Directives, questions: Question[]): string[] {
  const active = new Set(questions.map((question) => question.id));
  return Object.entries(questionPins)
    .filter(([id]) => !active.has(id))
    .map(([id, { line }]) => `Line ${line}: ignored a jevlint-score for unknown question ${id}.`);
}

/** One file must not end the run: generated code can overflow the stack of the AST walk. */
function analyzeSource(
  source: string,
  language: Language | null,
  { config, patterns }: Run,
): { ast: AstResult | null; warnings: string[] } {
  try {
    const ast = language
      ? analyzeAst(source, language, config.ast, patterns)
      : analyzeGeneric(source, config.ast);
    return { ast, warnings: [] };
  } catch (error) {
    if (error instanceof UserError) throw error;
    return { ast: null, warnings: [`AST analysis failed: ${errorMessage(error)}`] };
  }
}

async function reviewWithModel(
  { code, questionPins }: Directives,
  { config, options, resolved, questions }: Run,
): Promise<{ model: ModelResult | null; warnings: string[] }> {
  if (!resolved || questions.length === 0 || code.trim() === '') {
    return { model: null, warnings: [] };
  }
  try {
    const { noCache } = options;
    const decision = await decideFile({ resolved, questions, source: code, config, noCache });
    const warnings = decision.truncated
      ? [`File truncated: the model saw only the first ${config.max_file_chars} characters.`]
      : [];
    return { model: modelResult(questions, decision, questionPins), warnings };
  } catch (error) {
    if (error instanceof UserError) throw error;
    return { model: null, warnings: [`${PROVIDER_ERROR} ${errorMessage(error)}`] };
  }
}

/** Builds a file's report with its score still from 0 to 1. */
async function auditFile(path: string, run: Run): Promise<FileReport> {
  const { config } = run;
  const language = languageOf(path);
  // An unscored file stays neutral: full score, so no priority, and no weight in the repo score.
  const file: FileReport = {
    path,
    language,
    lines: 0,
    score: 1,
    priority: 0,
    commits: run.commits.get(path) ?? 0,
    ast: null,
    model: null,
    warnings: [],
  };
  let source: string;
  try {
    source = await readSource(config, path);
  } catch (error) {
    return { ...file, warnings: [`Could not read file: ${errorMessage(error)}`] };
  }
  const { ast, warnings: astWarnings } = analyzeSource(source, language, run);
  const directives = readDirectives(source, config, run.options.ignorePins);
  const lines = countLines(source);
  const directiveWarnings = [
    ...astWarnings,
    ...directives.warnings,
    ...unknownPinWarnings(directives, run.questions),
  ];
  const { filePin: pin } = directives;
  if (pin) return { ...file, lines, score: pin.value, pin, ast, warnings: directiveWarnings };

  const { model, warnings } = await reviewWithModel(directives, run);
  const judged = await judgeRules(ast, source, language, run);
  const astScore = judged.ast?.score ?? null;
  const score = fileScore(astScore, model?.score ?? null, config.scoring) ?? file.score;
  return {
    ...file,
    lines,
    score,
    ast: judged.ast,
    model,
    ruleUsage: judged.usage,
    warnings: [...directiveWarnings, ...warnings, ...judged.warnings],
  };
}

async function auditFiles(paths: string[], run: Run): Promise<FileReport[]> {
  const limit = pLimit(run.config.concurrency);
  let done = 0;
  const auditOne = async (path: string) => {
    try {
      const file = await auditFile(path, run);
      run.options.onProgress?.(++done, paths.length, path);
      return file;
    } catch (error) {
      // The run is over, so queued files must not spend more provider calls.
      limit.clearQueue();
      throw error;
    }
  };
  return Promise.all(paths.map((path) => limit(() => auditOne(path))));
}

function usageOf(files: FileReport[], resolved: ResolvedModel | null): AuditReport['usage'] {
  const models = files.flatMap((file) => file.model ?? []);
  const fresh = models.filter((model) => !model.cached);
  const rules = files.flatMap((file) => file.ruleUsage ?? []);
  const inputTokens = [...fresh, ...rules].reduce((sum, used) => sum + used.inputTokens, 0);
  return {
    inputTokens,
    estimatedCostUsd: resolved && estimateCostUsd(inputTokens, resolved),
    cacheHits: rules.reduce((sum, used) => sum + used.cacheHits, models.length - fresh.length),
    modelCalls: rules.reduce((sum, used) => sum + used.modelCalls, fresh.length),
  };
}

function isSkipped({ ast, model, pin, warnings }: FileReport): boolean {
  return !ast && !model && !pin && warnings.length === 0;
}

/** Audits the repository, or only `options.paths`, and ranks what to refactor first. */
export async function audit(config: Config, options: AuditOptions = {}): Promise<AuditReport> {
  const presets = await loadPresets(config.presets, options.presetsRoot ?? config.root);
  const [paths, resolved, commits] = await Promise.all([
    discoverFiles(config, options.paths),
    options.astOnly ? null : createDecisionModel(config),
    commitCounts(config.root, config.priority.churn_days),
  ]);
  const questions = activeQuestions(presets, config.weights);
  const patterns = [...presets.flatMap((preset) => preset.patterns), ...config.patterns];
  const rules = [...presets.flatMap((preset) => preset.rules), ...config.rules];
  const audited = await auditFiles(paths, {
    config,
    options,
    resolved,
    questions,
    patterns,
    rules,
    commits,
  });
  const files = rank(
    audited.filter((file) => !isSkipped(file)),
    config.priority,
  );
  return {
    root: config.root,
    provider: resolved?.provider ?? null,
    model: resolved?.modelId ?? null,
    presets: config.presets,
    scale: config.scoring.scale,
    score: scaleScore(repoScore(files), config.scoring),
    files: files.map((file) => ({ ...file, score: scaleScore(file.score, config.scoring) })),
    skipped: audited.filter(isSkipped).map((file) => file.path),
    usage: usageOf(files, resolved),
  };
}

/** What a dry run would send. Tokens and cost are 0 and null with no `target`, as nothing leaves. */
export interface AuditPlan {
  files: string[];
  /** Files found that send nothing: pinned, blank or already cached. */
  skipped: number;
  chars: number;
  estimatedTokens: number;
  estimatedCostUsd: number | null;
}

/** Estimates what a run would send, reaching no provider. A file's request carries every question, and a rule match's its own. */
export async function planAudit(
  config: Config,
  {
    paths,
    ignorePins,
    noCache,
    target = null,
  }: Pick<AuditOptions, 'paths' | 'ignorePins' | 'noCache'> & { target?: ModelTarget | null } = {},
): Promise<AuditPlan> {
  const limit = pLimit(config.concurrency);
  const presets = await loadPresets(config.presets, config.root);
  const questions = activeQuestions(presets, config.weights);
  const rules = [...presets.flatMap((preset) => preset.rules), ...config.rules];
  const fileQuestionChars = JSON.stringify(decisionRequest(questions)).length;
  const sentChars = async (path: string) => {
    const source = await readSource(config, path).catch(() => '');
    const { code, filePin } = readDirectives(source, config, ignorePins);
    const asks = !target || questions.length > 0;
    const worthSending = asks && !filePin && code.trim() !== '';
    const cached =
      worthSending &&
      target &&
      !noCache &&
      (await isDecisionCached(target, questions, code, config));
    const sendsFile = worthSending && !cached;
    // With no target the run stays local, and rules need a model.
    const ruled =
      target && !filePin
        ? await plannedRuleChars(source, languageOf(path), rules, target, config, noCache)
        : { chars: 0, questionChars: 0 };
    return {
      path,
      chars: (sendsFile ? Math.min(code.length, config.max_file_chars) : 0) + ruled.chars,
      questionChars: (sendsFile ? fileQuestionChars : 0) + ruled.questionChars,
      sends: sendsFile || ruled.chars > 0,
    };
  };
  const discovered = await discoverFiles(config, paths);
  const sent = (await Promise.all(discovered.map((path) => limit(() => sentChars(path))))).filter(
    ({ sends }) => sends,
  );
  const chars = sent.reduce((sum, file) => sum + file.chars, 0);
  const files = sent.map(({ path }) => path);
  const questionChars = sent.reduce((sum, file) => sum + file.questionChars, 0);
  const estimatedTokens = target ? Math.ceil((chars + questionChars) / CHARS_PER_TOKEN) : 0;
  return {
    files,
    skipped: discovered.length - files.length,
    chars,
    estimatedTokens,
    estimatedCostUsd: target && estimateCostUsd(estimatedTokens, target),
  };
}
