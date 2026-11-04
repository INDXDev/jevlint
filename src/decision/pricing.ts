/** Rough USD costs of model calls, from input tokens. Decision models do not bill output. */
import type { ProviderName } from '../types.ts';
import type { ModelTarget } from './providers.ts';

const TOKENS_PER_PRICE = 1_000_000;

// USD per million input tokens, checked 2026-11-05, by model id prefix. Update with docs/providers.md.
// `cloudflareFetch` always calls clef, so every Cloudflare model id costs what clef costs.
// microsoft and compatible are absent: their price depends on the endpoint.
const INPUT_PRICES: Partial<Record<ProviderName, Record<string, number>>> = {
  typesafe: { jev: 0.042 },
  openai: { 'gpt-6-luna': 0.1 },
  gateway: { 'typesafe-ai/jev': 0.042 },
  cloudflare: { clef: 0.24 },
};

/** Estimates what input tokens cost, or null when the model's price is unknown. */
export function estimateCostUsd(
  inputTokens: number,
  { provider, modelId }: Pick<ModelTarget, 'provider' | 'modelId'>,
): number | null {
  const prices = Object.entries(INPUT_PRICES[provider] ?? {});
  const price = prices.find(([prefix]) => modelId.startsWith(prefix))?.[1];
  return price === undefined ? null : (inputTokens * price) / TOKENS_PER_PRICE;
}
