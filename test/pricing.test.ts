import { describe, expect, it } from 'vitest';
import { estimateCostUsd } from '../src/decision/pricing.ts';

describe('estimateCostUsd', () => {
  it.each([
    ['typesafe', 'jev-latest', 0.042],
    ['typesafe', 'jev-1.14.0', 0.042],
    ['openai', 'gpt-6-luna', 0.1],
    ['gateway', 'typesafe-ai/jev', 0.042],
    ['cloudflare', 'clef', 0.24],
    // cloudflareFetch calls clef whatever the model id says.
    ['cloudflare', 'clef-flash', 0.24],
  ] as const)('prices %s %s per million input tokens', (provider, modelId, price) => {
    expect(estimateCostUsd(1_000_000, { provider, modelId })).toBeCloseTo(price);
  });

  it.each([
    ['compatible', 'jev-latest'],
    ['microsoft', 'jev'],
    ['openai', 'another-model'],
    ['gateway', 'other/model'],
  ] as const)('does not guess a price for %s %s', (provider, modelId) => {
    expect(estimateCostUsd(1000, { provider, modelId })).toBeNull();
  });
});
