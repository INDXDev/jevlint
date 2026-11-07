import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Experimental_DecisionMockModelV4 as MockModel } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Config, loadConfig, UserError } from '../src/config.ts';
import { createDecisionModel, type ResolvedModel } from '../src/decision/providers.ts';
import { driftSpec } from '../src/spec/drift.ts';
import type { Spec } from '../src/types.ts';

vi.mock('../src/decision/providers.ts', async (original) => ({
  ...(await original<typeof import('../src/decision/providers.ts')>()),
  createDecisionModel: vi.fn(),
}));

const feature = (id: string, items: string[]) => ({
  id,
  title: id.toUpperCase(),
  summary: `The ${id} feature.`,
  checklist: items.map((item) => ({ id: item, text: `${item} holds.` })),
});
const spec: Spec = {
  dir: '.jevlint/spec',
  index: {
    version: 1,
    name: 'Shop',
    description: 'An online shop.',
    checklist: [{ id: 'no-secrets', text: 'no-secrets holds.' }],
  },
  features: [feature('admin', ['audit-log']), feature('login', ['lockout', 'hashing'])],
};

let root: string;
let config: Config;
let requests: { state: string; questions: string[] }[];

/** A complete distribution over the options, as the SDK requires, with `choice` at 0.8. */
function distribution(question: unknown, choice: string): Record<string, number> {
  const options = Object.keys((question as { criteria: Record<string, string> }).criteria);
  const rest = 0.2 / (options.length - 1);
  return Object.fromEntries(options.map((option) => [option, option === choice ? 0.8 : rest]));
}

/** Routes by a word in the document; items take `verdicts[<doc>:<full id>]`, else absent. */
function useModel(
  route: Record<string, string>,
  verdicts: Record<string, string>,
  uncovered: Record<string, number> = {},
) {
  const doDecide: MockModel['doDecide'] = async ({ state, questions }) => {
    const text = JSON.stringify(state);
    requests.push({ state: text, questions: Object.keys(questions) });
    if (text.includes('boom')) throw new Error('provider down');
    const doc = Object.keys(route).find((name) => text.includes(name)) ?? '';
    const answers = Object.entries(questions).map(([id, question]) => {
      if (question.type === 'boolean') {
        return [id, { type: 'boolean', probability: uncovered[doc] ?? 0.1 }];
      }
      const choice =
        id === 'route' ? (route[doc] ?? 'global') : (verdicts[`${doc}:${id}`] ?? 'absent');
      return [id, { type: 'choice', choice, probabilities: distribution(question, choice) }];
    });
    return {
      answers: Object.fromEntries(answers),
      usage: { inputTokens: 3 },
      warnings: [],
    } as never;
  };
  const resolved = { model: new MockModel({ doDecide }), provider: 'typesafe', modelId: 'm' };
  vi.mocked(createDecisionModel).mockResolvedValue(resolved as unknown as ResolvedModel);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jevlint-spec-drift-'));
  const cache = await mkdtemp(join(tmpdir(), 'jevlint-spec-drift-cache-'));
  vi.stubEnv('XDG_CONFIG_HOME', cache);
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'jevlint.toml'), '');
  await writeFile(join(root, 'README.md'), '# readme\n');
  await writeFile(join(root, 'docs/auth.md'), '# auth\nLocks after five tries.\n');
  config = { ...(await loadConfig({ cwd: root })), cache: { dir: cache } };
  requests = [];
});

afterEach(() => rm(root, { recursive: true, force: true }));

describe('driftSpec', () => {
  it('routes, compares, and aggregates the four findings', async () => {
    useModel(
      { auth: 'login', readme: 'global' },
      { 'auth:login.lockout': 'contradicts', 'readme:global.no-secrets': 'agrees' },
      { auth: 0.7 },
    );
    const report = await driftSpec(config, spec);
    expect(report.docs.map(({ path, feature }) => [path, feature])).toEqual([
      ['README.md', 'global'],
      ['docs/auth.md', 'login'],
    ]);
    const compare = requests.find(({ state }) => state.includes('===== Checklist: the LOGIN'));
    expect(compare?.questions).toEqual(['login.lockout', 'login.hashing', 'uncovered']);
    const state = compare?.state ?? '';
    expect(state).toContain('- login.lockout: lockout holds.');
    expect(state.indexOf('- login.lockout: lockout holds.')).toBeLessThan(
      state.indexOf('===== Document: docs/auth.md ====='),
    );
    expect(report.docs[1]).toMatchObject({
      featureConfidence: 0.8,
      uncovered: 0.7,
      items: [
        { id: 'login.lockout', verdict: 'contradicts', confidence: 0.8 },
        { id: 'login.hashing', verdict: 'absent' },
      ],
    });
    expect(report).toMatchObject({
      complete: true,
      contradictions: 1,
      uncovered: ['docs/auth.md'],
      unbacked: [
        { id: 'admin.audit-log', text: 'audit-log holds.' },
        { id: 'login.hashing', text: 'hashing holds.' },
      ],
      undocumented: ['admin'],
      usage: { inputTokens: 12, modelCalls: 4, cacheHits: 0 },
    });
  });

  it('skips unbacked and undocumented for a narrowed run', async () => {
    useModel({ auth: 'login' }, {});
    const report = await driftSpec(config, spec, { paths: ['docs/auth.md'] });
    expect(report).toMatchObject({ complete: false, unbacked: [], undocumented: [] });
    expect(report.docs.map(({ path }) => path)).toEqual(['docs/auth.md']);
  });

  it('turns a provider error into a warning on that document', async () => {
    await writeFile(join(root, 'README.md'), 'boom\n');
    useModel({ auth: 'login' }, {});
    const report = await driftSpec(config, spec);
    expect(report.docs[0]).toMatchObject({
      path: 'README.md',
      feature: null,
      uncovered: null,
      warnings: ['Provider error: provider down'],
    });
  });

  it('needs a decision model', async () => {
    vi.mocked(createDecisionModel).mockResolvedValue(null);
    await expect(driftSpec(config, spec)).rejects.toThrow(
      new UserError(
        'jevlint spec drift needs a decision model. Run: jevlint auth set <provider name>',
      ),
    );
  });
});
