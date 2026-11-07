/** Answers one file's questions through the cache or the provider. */
import { experimental_decide as decide, RetryError } from 'ai';
import { cacheKey } from '../cache.ts';
import { type Config, UserError } from '../config.ts';
import { readThrough, writeThrough } from '../remote-cache.ts';
import type { Question, RawAnswer } from '../types.ts';
import type { ModelTarget, ResolvedModel } from './providers.ts';

/** Starts a file's warning when its provider call failed. */
export const PROVIDER_ERROR = 'Provider error:';

const MAX_RETRIES = 3;
// Covers all the retries of one file, so that a stalled provider costs a warning, not the whole run.
const REQUEST_TIMEOUT_MS = 5 * 60_000;
const CLOUDFLARE_MAX_QUESTIONS = 64;

// The SDK prints provider warnings to the console, and core modules must stay silent.
globalThis.AI_SDK_LOG_WARNINGS = false;

type DecisionQuestion = ReturnType<typeof toDecisionQuestion>;

interface Answers {
  answers: Record<string, RawAnswer>;
  inputTokens: number;
}

interface CallDetails {
  cached: boolean;
  truncated: boolean;
}

/** The inputs of one file's decision. */
export interface DecideFileOptions {
  resolved: ResolvedModel;
  questions: Question[];
  source: string;
  config: Config;
  noCache?: boolean;
}

function toDecisionQuestion(question: Question) {
  const { instructions } = question;
  return question.type === 'score'
    ? { type: 'score' as const, instructions, criteria: question.levels }
    : { type: 'boolean' as const, instructions };
}

/** The questions as the provider receives them, keyed by id. */
export function decisionRequest(questions: Question[]): Record<string, DecisionQuestion> {
  return Object.fromEntries(questions.map((q) => [q.id, toDecisionQuestion(q)]));
}

function decisionKey(
  { provider, modelId, endpoint }: ModelTarget,
  request: Record<string, DecisionQuestion>,
  content: string,
): string {
  return cacheKey({ provider, modelId, endpoint, questions: request, content });
}

/** How many requests one file's questions take, each of which bills the file again. */
export function requestsPerFile(
  { provider }: Pick<ModelTarget, 'provider'>,
  questions: number,
): number {
  return provider === 'cloudflare'
    ? Math.max(1, Math.ceil(questions / CLOUDFLARE_MAX_QUESTIONS))
    : 1;
}

/** A bad key fails every file the same way, so it stops the run instead of warning per file. */
function translateError(error: unknown, { provider }: ResolvedModel): unknown {
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  const status = (cause as { statusCode?: number } | null)?.statusCode;
  if (status !== 401 && status !== 403) return error;
  return new UserError(
    `${provider} rejected the API key (HTTP ${status}). Update it with \`jevlint auth set ${provider}\`.`,
  );
}

/** Entries are plain JSON on disk, so one without every answer must count as a miss. */
function isComplete(hit: Answers | undefined, questions: Question[]): hit is Answers {
  return (
    Boolean(hit?.answers) && questions.every(({ id }) => Number.isFinite(hit?.answers[id]?.value))
  );
}

async function askOnce(
  resolved: ResolvedModel,
  questions: Record<string, DecisionQuestion>,
  content: string,
): Promise<Answers> {
  const { answers, usage } = await decide({
    model: resolved.model,
    state: content,
    questions,
    maxRetries: MAX_RETRIES,
    abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch((error) => {
    throw translateError(error, resolved);
  });
  const values = Object.entries(answers).map(([id, answer]) => [
    id,
    { value: answer.type === 'score' ? answer.score : answer.probability },
  ]);
  return { answers: Object.fromEntries(values), inputTokens: usage.inputTokens ?? 0 };
}

async function ask(
  resolved: ResolvedModel,
  questions: Record<string, DecisionQuestion>,
  content: string,
): Promise<Answers> {
  const entries = Object.entries(questions);
  const requests = requestsPerFile(resolved, entries.length);
  const size = Math.ceil(entries.length / requests);
  const batches = Array.from({ length: requests }, (_, index) =>
    Object.fromEntries(entries.slice(index * size, (index + 1) * size)),
  );
  const parts = await Promise.all(batches.map((batch) => askOnce(resolved, batch, content)));
  return {
    answers: Object.assign({}, ...parts.map(({ answers }) => answers)),
    inputTokens: parts.reduce((sum, { inputTokens }) => sum + inputTokens, 0),
  };
}

/** Says whether `decideFile` would answer from the cache, with no provider call. */
export async function isDecisionCached(
  target: ModelTarget,
  questions: Question[],
  source: string,
  config: Config,
): Promise<boolean> {
  const content = source.slice(0, config.max_file_chars);
  const key = decisionKey(target, decisionRequest(questions), content);
  return isComplete(await readThrough<Answers>(config.cache, key), questions);
}

/** Identical files audited together share one lookup, as the cache would have them do in turn. */
const inFlight = new Map<string, Promise<Answers & { cached: boolean }>>();

async function cachedOrAsked(
  key: string,
  request: Record<string, DecisionQuestion>,
  { resolved, questions, source, config, noCache }: DecideFileOptions,
): Promise<Answers & { cached: boolean }> {
  const hit = noCache ? undefined : await readThrough<Answers>(config.cache, key);
  if (isComplete(hit, questions)) return { ...hit, cached: true };
  const fresh = await ask(resolved, request, source.slice(0, config.max_file_chars));
  if (!noCache) await writeThrough(config.cache, key, fresh);
  return { ...fresh, cached: false };
}

/** Returns raw answers for one file. Scoring happens later, so tuning weights stays free. */
export async function decideFile(options: DecideFileOptions): Promise<Answers & CallDetails> {
  const { resolved, questions, source, config } = options;
  const content = source.slice(0, config.max_file_chars);
  const truncated = content.length < source.length;
  const request = decisionRequest(questions);
  const key = decisionKey(resolved, request, content);
  const running = inFlight.get(key);
  if (running) return { ...(await running), cached: true, truncated };
  const lookup = cachedOrAsked(key, request, options).finally(() => inFlight.delete(key));
  inFlight.set(key, lookup);
  return { ...(await lookup), truncated };
}
