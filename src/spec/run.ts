/** What `spec check` and `spec drift` share: the model, the per-path loop, requests and usage. */
import pLimit from 'p-limit';
import { PROVIDER_ERROR } from '../audit.ts';
import { type Config, UserError } from '../config.ts';
import { type DecisionQuestion, decideState } from '../decision/decide.ts';
import { estimateCostUsd } from '../decision/pricing.ts';
import { createDecisionModel, type ResolvedModel } from '../decision/providers.ts';
import type { AuditReport, RawAnswer, SpecItemRef, SpecItemResult } from '../types.ts';

/** Narrows and observes a `spec check` or `spec drift` run. */
export interface SpecRunOptions {
  paths?: string[];
  noCache?: boolean;
  onProgress?: (done: number, total: number, path: string) => void;
}

/** One run's model and the usage its requests add up to. */
export interface SpecRun {
  config: Config;
  resolved: ResolvedModel;
  noCache?: boolean;
  inputTokens: number;
  cacheHits: number;
  modelCalls: number;
}

/** Starts a run, or stops with a hint when there is no model to ask. `command` names it. */
export async function startRun(
  config: Config,
  command: string,
  noCache?: boolean,
  hint = 'Run: jevlint auth set <provider name>',
): Promise<SpecRun> {
  const resolved = await createDecisionModel(config);
  if (!resolved) throw new UserError(`jevlint ${command} needs a decision model. ${hint}`);
  return { config, resolved, noCache, inputTokens: 0, cacheHits: 0, modelCalls: 0 };
}

/** Asks one request. A provider error becomes a warning and null; a bad key stops the run. */
export async function ask(
  run: SpecRun,
  request: Record<string, DecisionQuestion>,
  source: string,
  warnings: string[],
): Promise<Record<string, RawAnswer> | null> {
  const { config, resolved, noCache } = run;
  try {
    const decision = await decideState({ resolved, request, source, config, noCache });
    if (decision.cached) run.cacheHits++;
    else {
      run.modelCalls++;
      run.inputTokens += decision.inputTokens;
    }
    const truncated = `truncated: the model saw only the first ${config.max_file_chars} characters.`;
    if (decision.truncated && !warnings.includes(truncated)) warnings.push(truncated);
    return decision.answers;
  } catch (error) {
    if (error instanceof UserError) throw error;
    warnings.push(`${PROVIDER_ERROR} ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** The run's usage, as reports show it. */
export function usageOf(run: SpecRun): AuditReport['usage'] {
  const { inputTokens, cacheHits, modelCalls, resolved } = run;
  return {
    inputTokens,
    estimatedCostUsd: estimateCostUsd(inputTokens, resolved),
    cacheHits,
    modelCalls,
  };
}

/** Judges every path with bounded concurrency, in the order given. */
export function eachPath<T>(
  run: SpecRun,
  paths: string[],
  onProgress: SpecRunOptions['onProgress'],
  judge: (path: string) => Promise<T>,
): Promise<T[]> {
  const limit = pLimit(run.config.concurrency);
  let done = 0;
  return Promise.all(
    paths.map((path) =>
      limit(async () => {
        const result = await judge(path);
        onProgress?.(++done, paths.length, path);
        return result;
      }),
    ),
  );
}

// Only failures are held to the threshold: dropping an unsure `satisfies` would invent unimplemented items.
const FAILING = new Set(['violates', 'contradicts']);

/** The verdicts on items the model answered, without failures less confident than `threshold`. */
export function verdicts<V extends string>(
  answers: Record<string, RawAnswer>,
  items: SpecItemRef[],
  threshold: number,
): SpecItemResult<V>[] {
  return items.flatMap((item) => {
    const answer = answers[item.id];
    if (!answer?.choice) return [];
    if (FAILING.has(answer.choice) && answer.value < threshold) return [];
    return [{ ...item, verdict: answer.choice as V, confidence: answer.value }];
  });
}
