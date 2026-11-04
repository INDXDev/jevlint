import { experimental_decide as decide } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Config, UserError } from '../src/config.ts';
import { getApiKey } from '../src/credentials.ts';
import { createDecisionModel } from '../src/decision/providers.ts';

vi.mock('../src/credentials.ts', () => ({ getApiKey: vi.fn() }));

const config = (provider: Partial<Config['provider']>) => ({ provider }) as Config;

const JEV_ANSWERS = {
  'readable-code.naming': { type: 'score', score: 1, probabilities: { '0': 0, '1': 1 } },
  'readable-code.dead': { type: 'noul', noul: 0.25 },
};
const QUESTIONS = {
  'readable-code.naming': { type: 'score', instructions: 'Names?', criteria: ['bad', 'good'] },
  'readable-code.dead': { type: 'boolean', instructions: 'Dead code?' },
} as const;

async function requestThrough(provider: Partial<Config['provider']>) {
  const resolved = await createDecisionModel(config(provider));
  if (!resolved) throw new Error('expected a model');
  return decide({ model: resolved.model, state: 'code', questions: QUESTIONS, maxRetries: 0 });
}

function sentRequest(fake: ReturnType<typeof vi.fn>) {
  const [url, init] = fake.mock.calls[0] as [string, RequestInit];
  return { url, body: JSON.parse(init.body as string), headers: new Headers(init.headers) };
}

beforeEach(() => {
  vi.mocked(getApiKey).mockResolvedValue('secret');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('createDecisionModel', () => {
  it('returns null without a key', async () => {
    vi.mocked(getApiKey).mockResolvedValue(undefined);
    expect(await createDecisionModel(config({ name: 'typesafe' }))).toBeNull();
  });

  describe('without a key for the configured provider', () => {
    const keysFor = (...names: string[]) =>
      vi
        .mocked(getApiKey)
        .mockImplementation(async (name) => (names.includes(name) ? 'secret' : undefined));

    it('uses a provider that has one, with its own model and endpoint', async () => {
      keysFor('typesafe');
      const provider = { name: 'openai', model: 'gpt-6-luna', base_url: 'https://x.test' } as const;
      const resolved = await createDecisionModel(config(provider));
      expect(resolved).toMatchObject({ provider: 'typesafe', modelId: 'jev-latest' });
      expect(resolved?.endpoint).toBeUndefined();
    });

    it('prefers the configured provider when it has a key', async () => {
      keysFor('typesafe', 'openai');
      const resolved = await createDecisionModel(config({ name: 'openai' }));
      expect(resolved?.provider).toBe('openai');
    });

    it('skips providers that need more than a key', async () => {
      keysFor('cloudflare', 'microsoft', 'compatible');
      vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', '');
      expect(await createDecisionModel(config({ name: 'openai' }))).toBeNull();
    });

    it('uses cloudflare once its account is known', async () => {
      keysFor('cloudflare');
      vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'acct');
      const resolved = await createDecisionModel(config({ name: 'openai' }));
      expect(resolved?.provider).toBe('cloudflare');
    });
  });

  it.each([
    ['typesafe', 'jev-latest'],
    ['openai', 'gpt-6-luna'],
    ['gateway', 'typesafe-ai/jev'],
  ] as const)('defaults %s to %s', async (name, modelId) => {
    const resolved = await createDecisionModel(config({ name }));
    expect(resolved).toMatchObject({ provider: name, modelId });
    expect(resolved?.model.modelId).toBe(modelId);
  });

  it('honours a configured model', async () => {
    const resolved = await createDecisionModel(config({ name: 'typesafe', model: 'jev-1.14.0' }));
    expect(resolved?.modelId).toBe('jev-1.14.0');
  });

  it('identifies the endpoint, so two proxies do not share cached answers', async () => {
    const provider = { name: 'compatible', model: 'm', base_url: 'https://proxy.test/v1' } as const;
    const resolved = await createDecisionModel(config(provider));
    expect(resolved?.endpoint).toBe('https://proxy.test/v1');
  });

  it.each(['microsoft', 'compatible'] as const)(
    'requires model and base_url for %s',
    async (name) => {
      await expect(createDecisionModel(config({ name, base_url: 'https://x' }))).rejects.toThrow(
        /provider\.model/,
      );
      await expect(createDecisionModel(config({ name, model: 'm' }))).rejects.toThrow(UserError);
    },
  );

  it('requires an account id for cloudflare', async () => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', '');
    await expect(createDecisionModel(config({ name: 'cloudflare' }))).rejects.toThrow(/account_id/);
  });
});

describe('requests', () => {
  it('sends dotted question ids to a compatible endpoint', async () => {
    const fake = vi.fn(async () =>
      Response.json({ answers: JEV_ANSWERS, usage: { input_tokens: 5 } }),
    );
    vi.stubGlobal('fetch', fake);
    const result = await requestThrough({
      name: 'compatible',
      model: 'm',
      base_url: 'https://proxy.test/v1',
    });
    const { url, body } = sentRequest(fake);
    expect(url).toBe('https://proxy.test/v1/systemone');
    expect(Object.keys(body.questions)).toEqual(Object.keys(QUESTIONS));
    expect(result.answers['readable-code.dead'].probability).toBe(0.25);
  });

  it('routes cloudflare through the shim and unwraps its envelope', async () => {
    const fake = vi.fn(async () =>
      Response.json({
        result: { model: 'clef', answers: JEV_ANSWERS, usage: { input_tokens: 9 } },
        success: true,
        errors: [],
        messages: [],
      }),
    );
    vi.stubGlobal('fetch', fake);
    const result = await requestThrough({ name: 'cloudflare', account_id: 'acct/1' });
    const { url, body, headers } = sentRequest(fake);
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct%2F1/ai/run/@cf/cloudflare/clef',
    );
    expect(headers.get('authorization')).toBe('Bearer secret');
    expect(body).toMatchObject({ model: 'clef', state: 'code' });
    expect(result.answers['readable-code.naming'].score).toBe(1);
    expect(result.usage.inputTokens).toBe(9);
  });

  it('reads the cloudflare account from the environment', async () => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'env-acct');
    const fake = vi.fn(async () => Response.json({ result: { answers: JEV_ANSWERS } }));
    vi.stubGlobal('fetch', fake);
    await requestThrough({ name: 'cloudflare', model: 'clef-flash' });
    const { url, body } = sentRequest(fake);
    expect(url).toContain('/accounts/env-acct/');
    expect(body.model).toBe('clef-flash');
  });

  it('passes cloudflare failures through with their status', async () => {
    const fake = vi.fn(async () => Response.json({ success: false }, { status: 401 }));
    vi.stubGlobal('fetch', fake);
    await expect(requestThrough({ name: 'cloudflare', account_id: 'a' })).rejects.toMatchObject({
      statusCode: 401,
    });
  });
});
