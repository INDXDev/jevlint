import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APICallError } from 'ai';
import { Experimental_DecisionMockModelV4 as MockModel } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Config, UserError } from '../src/config.ts';
import { decideFile } from '../src/decision/decide.ts';
import type { ResolvedModel } from '../src/decision/providers.ts';
import type { ProviderName, Question } from '../src/types.ts';

const base = { title: 'T', weight: 1, fix: 'F' };
const questions: Question[] = [
  { ...base, id: 'p.levels', type: 'score', instructions: 'Rate', levels: ['low', 'high'] },
  { ...base, id: 'p.flag', type: 'boolean', instructions: 'Is it?', good: true },
];

const answer = async () => ({
  answers: {
    'p.levels': { type: 'score' as const, score: 1 },
    'p.flag': { type: 'boolean' as const, probability: 0.25 },
  },
  usage: { inputTokens: 12 },
  warnings: [],
});

let dir: string;
let config: Config;

function resolvedWith(doDecide: MockModel['doDecide'], provider: ProviderName = 'typesafe') {
  const model = new MockModel({ doDecide });
  return { model, provider, modelId: 'm' } as unknown as ResolvedModel;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jevlint-decide-'));
  config = { max_file_chars: 100, cache: { dir } } as Config;
});

afterEach(() => rm(dir, { recursive: true }));

describe('decideFile', () => {
  it('asks once for identical files in flight, and counts the tokens once', async () => {
    const doDecide = vi.fn<MockModel['doDecide']>(answer);
    const options = { resolved: resolvedWith(doDecide), questions, source: 'same', config };
    const [first, second] = await Promise.all([decideFile(options), decideFile(options)]);
    expect(doDecide).toHaveBeenCalledOnce();
    expect([first.cached, second.cached].sort()).toEqual([false, true]);
    expect(second.answers).toEqual(first.answers);
  });

  it('asks again after a failure, so one error does not stick', async () => {
    const doDecide = vi.fn<MockModel['doDecide']>(answer);
    doDecide.mockRejectedValueOnce(new Error('busy'));
    const options = { resolved: resolvedWith(doDecide), questions, source: 'retry', config };
    await expect(decideFile(options)).rejects.toThrow();
    expect((await decideFile(options)).cached).toBe(false);
  });

  it('returns raw values and translates question types', async () => {
    const doDecide = vi.fn<MockModel['doDecide']>(answer);
    const result = await decideFile({
      resolved: resolvedWith(doDecide),
      questions,
      source: 'code',
      config,
    });
    expect(result).toEqual({
      answers: { 'p.levels': { value: 1 }, 'p.flag': { value: 0.25 } },
      inputTokens: 12,
      cached: false,
      truncated: false,
    });
    expect(doDecide.mock.calls[0]?.[0]).toMatchObject({
      questions: {
        'p.levels': { type: 'score', instructions: 'Rate', criteria: ['low', 'high'] },
        'p.flag': { type: 'boolean', instructions: 'Is it?' },
      },
    });
  });

  it('truncates what it sends', async () => {
    const doDecide = vi.fn<MockModel['doDecide']>(answer);
    const source = 'x'.repeat(101);
    const result = await decideFile({
      resolved: resolvedWith(doDecide),
      questions,
      source,
      config,
    });
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(doDecide.mock.calls[0]?.[0].state)).toContain('x'.repeat(100));
    expect(JSON.stringify(doDecide.mock.calls[0]?.[0].state)).not.toContain('x'.repeat(101));
  });

  it('reuses a cached decision', async () => {
    const doDecide = vi.fn<MockModel['doDecide']>(answer);
    const options = { resolved: resolvedWith(doDecide), questions, source: 'code', config };
    const first = await decideFile(options);
    const second = await decideFile(options);
    expect(doDecide).toHaveBeenCalledOnce();
    expect(second).toEqual({ ...first, cached: true });
  });

  it('ignores changes past the truncation point when caching', async () => {
    const doDecide = vi.fn<MockModel['doDecide']>(answer);
    const resolved = resolvedWith(doDecide);
    await decideFile({ resolved, questions, source: `${'x'.repeat(100)}a`, config });
    const second = await decideFile({ resolved, questions, source: `${'x'.repeat(100)}b`, config });
    expect(second).toMatchObject({ cached: true, truncated: true });
  });

  it.each<[string, (o: Parameters<typeof decideFile>[0]) => Parameters<typeof decideFile>[0]]>([
    ['content', (o) => ({ ...o, source: 'other' })],
    ['model', (o) => ({ ...o, resolved: { ...o.resolved, modelId: 'other' } })],
    ['provider', (o) => ({ ...o, resolved: { ...o.resolved, provider: 'openai' } })],
    ['endpoint', (o) => ({ ...o, resolved: { ...o.resolved, endpoint: 'https://other.test' } })],
    [
      'instructions',
      (o) => ({ ...o, questions: o.questions.map((q) => ({ ...q, instructions: 'New' })) }),
    ],
    [
      'levels',
      (o) => ({
        ...o,
        questions: o.questions.map((q) =>
          q.type === 'score' ? { ...q, levels: ['low', 'mid'] } : q,
        ),
      }),
    ],
  ])('misses the cache when %s changes', async (_name, change) => {
    const doDecide = vi.fn<MockModel['doDecide']>(answer);
    const options = { resolved: resolvedWith(doDecide), questions, source: 'code', config };
    await decideFile(options);
    expect((await decideFile(change(options))).cached).toBe(false);
  });

  it.each([
    '[]',
    '5',
    '{}',
    '{"answers":{}}',
    '{"answers":{"p.levels":{"value":1}}}',
    '{"answers":{"p.levels":{"value":"1"},"p.flag":{"value":0.25}}}',
  ])('treats the valid JSON %s as a miss and repairs the entry', async (corrupt) => {
    const doDecide = vi.fn<MockModel['doDecide']>(answer);
    const options = { resolved: resolvedWith(doDecide), questions, source: 'code', config };
    await decideFile(options);
    const names = await readdir(join(dir, 'decisions'), { recursive: true });
    const entry = names.find((name) => name.endsWith('.json')) as string;
    await writeFile(join(dir, 'decisions', entry), corrupt);
    expect(await decideFile(options)).toMatchObject({
      cached: false,
      answers: { 'p.levels': { value: 1 }, 'p.flag': { value: 0.25 } },
    });
    expect((await decideFile(options)).cached).toBe(true);
    expect(doDecide).toHaveBeenCalledTimes(2);
  });

  it('keeps a paid answer when the cache cannot be written', async () => {
    await writeFile(join(dir, 'file'), '');
    const unwritable = { ...config, cache: { dir: join(dir, 'file', 'cache') } };
    const result = await decideFile({
      resolved: resolvedWith(answer),
      questions,
      source: 'code',
      config: unwritable,
    });
    expect(result).toMatchObject({ cached: false, inputTokens: 12 });
  });

  it('keeps the cache when only weights change', async () => {
    const options = { resolved: resolvedWith(answer), questions, source: 'code', config };
    await decideFile(options);
    const reweighted = questions.map((q) => ({ ...q, weight: 9 }));
    expect((await decideFile({ ...options, questions: reweighted })).cached).toBe(true);
  });

  it('neither reads nor writes with noCache', async () => {
    const doDecide = vi.fn<MockModel['doDecide']>(answer);
    const options = { resolved: resolvedWith(doDecide), questions, source: 'code', config };
    await decideFile({ ...options, noCache: true });
    expect((await decideFile(options)).cached).toBe(false);
    await decideFile({ ...options, noCache: true });
    expect(doDecide).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403])('turns HTTP %i into a UserError', async (statusCode) => {
    const failure = Object.assign(new Error('nope'), { statusCode });
    const resolved = resolvedWith(() => Promise.reject(failure));
    const run = decideFile({ resolved, questions, source: 'code', config });
    await expect(run).rejects.toThrow(UserError);
    await expect(run).rejects.toThrow(/auth set typesafe/);
  });

  it('sees a 401 that follows a retried failure', async () => {
    const busy = new APICallError({
      message: 'busy',
      url: 'https://x',
      requestBodyValues: {},
      statusCode: 503,
      responseHeaders: { 'retry-after-ms': '1' },
    });
    const denied = new APICallError({
      message: 'nope',
      url: 'https://x',
      requestBodyValues: {},
      statusCode: 401,
    });
    const doDecide = vi.fn<MockModel['doDecide']>();
    doDecide.mockRejectedValueOnce(busy).mockRejectedValueOnce(denied);
    const run = decideFile({ resolved: resolvedWith(doDecide), questions, source: 'code', config });
    await expect(run).rejects.toThrow(UserError);
  });

  it('leaves other failures for the caller', async () => {
    const resolved = resolvedWith(() => Promise.reject(new Error('boom')));
    const run = decideFile({ resolved, questions, source: 'code', config });
    await expect(run).rejects.not.toBeInstanceOf(UserError);
  });

  it('enforces the cloudflare question limit', async () => {
    const many = Array.from({ length: 65 }, (_, i) => ({ ...questions[1], id: `p.${i}` }));
    const resolved = resolvedWith(answer, 'cloudflare');
    await expect(
      decideFile({ resolved, questions: many as Question[], source: 'code', config }),
    ).rejects.toThrow(UserError);
  });
});
