import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Experimental_DecisionMockModelV4 as MockModel } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Config, loadConfig, UserError } from '../src/config.ts';
import { createDecisionModel, type ResolvedModel } from '../src/decision/providers.ts';
import { checkSpec } from '../src/spec/check.ts';
import type { Spec } from '../src/types.ts';

vi.mock('../src/decision/providers.ts', async (original) => ({
  ...(await original<typeof import('../src/decision/providers.ts')>()),
  createDecisionModel: vi.fn(),
}));

const spec: Spec = {
  dir: '.jevlint/spec',
  index: {
    version: 1,
    name: 'Shop',
    description: 'An online shop.',
    checklist: [{ id: 'no-secrets', text: 'Logs hold no secrets.' }],
    accept_uncovered: [],
  },
  features: [
    {
      id: 'login',
      title: 'Login',
      summary: 'Signs customers in.',
      checklist: [
        { id: 'lockout', text: 'Failures lock the account.' },
        { id: 'hashing', text: 'Passwords are hashed.' },
      ],
    },
  ],
};

const CONFIDENCE: Record<string, number> = { satisfies: 0.9, violates: 0.8, login: 0.6 };

/** A complete distribution over the options, as the SDK requires, with `choice` most likely. */
function distribution(question: unknown, choice: string): Record<string, number> {
  const options = Object.keys((question as { criteria: Record<string, string> }).criteria);
  const p = CONFIDENCE[choice] ?? 0.5;
  const rest = (1 - p) / (options.length - 1);
  return Object.fromEntries(options.map((option) => [option, option === choice ? p : rest]));
}

let root: string;
let config: Config;
let requests: { state: string; questions: string[] }[];

/** Routes by file name, and picks each item's verdict from `verdicts`, else not-applicable. */
function useModel(route: Record<string, string>, verdicts: Record<string, string>) {
  const doDecide: MockModel['doDecide'] = async ({ state, questions }) => {
    const text = JSON.stringify(state);
    requests.push({ state: text, questions: Object.keys(questions) });
    if (text.includes('boom')) throw new Error('provider down');
    const file = Object.keys(route).find((name) => text.includes(name)) ?? '';
    const answers = Object.entries(questions).map(([id, question]) => {
      const choice =
        id === 'route'
          ? (route[file] ?? 'global')
          : (verdicts[`${file}:${id}`] ?? 'not-applicable');
      return [id, { type: 'choice', choice, probabilities: distribution(question, choice) }];
    });
    return {
      answers: Object.fromEntries(answers),
      usage: { inputTokens: 5 },
      warnings: [],
    } as never;
  };
  const resolved = { model: new MockModel({ doDecide }), provider: 'typesafe', modelId: 'm' };
  vi.mocked(createDecisionModel).mockResolvedValue(resolved as unknown as ResolvedModel);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jevlint-spec-check-'));
  const cache = await mkdtemp(join(tmpdir(), 'jevlint-spec-check-cache-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/auth.ts'), 'export const auth = 1; // auth\n');
  await writeFile(
    join(root, 'src/util.ts'),
    'export const util = 1; // util\n// jevlint-score 100: fine\n',
  );
  vi.stubEnv('XDG_CONFIG_HOME', cache);
  await writeFile(join(root, 'jevlint.toml'), '');
  config = { ...(await loadConfig({ cwd: root })), cache: { dir: cache } };
  requests = [];
});

afterEach(() => rm(root, { recursive: true, force: true }));

describe('checkSpec', () => {
  it('asks feature items only of files routed to that feature', async () => {
    useModel(
      { auth: 'login', util: 'global' },
      {
        'auth:global.no-secrets': 'satisfies',
        'auth:login.lockout': 'violates',
        'auth:login.hashing': 'satisfies',
        'util:global.no-secrets': 'satisfies',
      },
    );
    const report = await checkSpec(config, spec);
    expect(requests.map(({ questions }) => questions).toSorted()).toEqual([
      ['login.lockout', 'login.hashing'],
      ['route', 'global.no-secrets'],
      ['route', 'global.no-secrets'],
    ]);
    expect(requests.some(({ state }) => state.includes('jevlint-score'))).toBe(false);
    const [auth, util] = report.files;
    expect(auth).toMatchObject({ path: 'src/auth.ts', feature: 'login', featureConfidence: 0.6 });
    expect(auth?.score).toBe(67);
    expect(auth?.items.map(({ id, verdict, confidence }) => [id, verdict, confidence])).toEqual([
      ['global.no-secrets', 'satisfies', 0.9],
      ['login.lockout', 'violates', 0.8],
      ['login.hashing', 'satisfies', 0.9],
    ]);
    expect(util).toMatchObject({ path: 'src/util.ts', feature: 'global', score: 100 });
    expect(report).toMatchObject({
      complete: true,
      violations: 1,
      unimplemented: [{ id: 'login.lockout', text: 'Failures lock the account.' }],
      provider: 'typesafe',
      model: 'm',
      usage: { inputTokens: 15, cacheHits: 0, modelCalls: 3 },
    });
  });

  it('drops violations less confident than spec.threshold', async () => {
    useModel(
      { auth: 'login' },
      { 'auth:login.lockout': 'violates', 'auth:login.hashing': 'satisfies' },
    );
    const strict = { ...config, spec: { ...config.spec, threshold: 0.85 } };
    const report = await checkSpec(strict, spec, { paths: ['src/auth.ts'] });
    expect(report.violations).toBe(0);
    expect(report.files[0]?.items.map(({ id }) => id)).toEqual([
      'global.no-secrets',
      'login.hashing',
    ]);
    expect(report.files[0]?.score).toBe(100);
  });

  it('leaves unimplemented empty for a narrowed run, and scores no applicable item as null', async () => {
    useModel({ util: 'global' }, {});
    const report = await checkSpec(config, spec, { paths: ['src/util.ts'] });
    expect(report.complete).toBe(false);
    expect(report.unimplemented).toEqual([]);
    expect(report.files).toEqual([expect.objectContaining({ path: 'src/util.ts', score: null })]);
  });

  it('turns a provider error into a warning on that file', async () => {
    await writeFile(join(root, 'src/auth.ts'), 'boom\n');
    useModel({ util: 'global' }, {});
    const report = await checkSpec(config, spec);
    expect(report.files.find(({ path }) => path === 'src/auth.ts')).toMatchObject({
      feature: null,
      score: null,
      warnings: ['Provider error: provider down'],
    });
  });

  it('needs a decision model', async () => {
    vi.mocked(createDecisionModel).mockResolvedValue(null);
    const run = checkSpec(config, spec);
    await expect(run).rejects.toBeInstanceOf(UserError);
    await expect(run).rejects.toThrow(
      'jevlint spec check needs a decision model. Run: jevlint auth set <provider name>',
    );
  });
});
