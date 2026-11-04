import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Experimental_DecisionMockModelV4 as MockModel } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Config, loadConfig } from '../src/config.ts';
import { createDecisionModel, type ResolvedModel } from '../src/decision/providers.ts';
import { judgeIntent } from '../src/intent.ts';
import { loadPresets } from '../src/presets.ts';
import { formatReview } from '../src/report.ts';
import { reviewChange } from '../src/review.ts';
import type { Change, ChangeReview } from '../src/types.ts';

vi.mock('../src/decision/providers.ts', async (original) => ({
  ...(await original<typeof import('../src/decision/providers.ts')>()),
  createDecisionModel: vi.fn(),
}));

const MATCHES = 'change-intent.message-matches-diff';
const UNMENTIONED = 'change-intent.no-unmentioned-changes';
const INSTRUCTIONS = 'change-intent.follows-instructions';

let dir: string;
let scratch: string;
let config: Config;
let requests: { state: string; questions: string[] }[];
let doDecide: MockModel['doDecide'];

const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();

function commit(files: Record<string, string>, message = 'change'): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git('add', '.');
  git('commit', '-m', message);
  return git('rev-parse', 'HEAD');
}

/** Every score is the best level, and every boolean is a sure yes unless a test says otherwise. */
const answering =
  (probability: number): MockModel['doDecide'] =>
  async ({ state, questions }) => {
    requests.push({ state: JSON.stringify(state), questions: Object.keys(questions) });
    const answers = Object.entries(questions).map(([id, question]) => [
      id,
      question.type === 'score'
        ? { type: 'score', score: (question.criteria as string[]).length - 1 }
        : { type: 'boolean', probability },
    ]);
    return {
      answers: Object.fromEntries(answers),
      usage: { inputTokens: 7 },
      warnings: [],
    } as never;
  };

const lastState = () => requests.at(-1)?.state ?? '';
const change = (base: string | null, head: string, message = 'the message'): Change => ({
  title: 't',
  base,
  head,
  message,
});

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevlint-intent-')));
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'jevlint-intent-cache-')));
  vi.stubEnv('XDG_CONFIG_HOME', scratch);
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'jevlint.toml'), '');
  config = await loadConfig({ cwd: dir });
  config = { ...config, cache: { dir: scratch } };
  requests = [];
  doDecide = answering(0);
  vi.mocked(createDecisionModel).mockImplementation(
    async () =>
      ({
        model: new MockModel({ doDecide: (options) => doDecide(options) }),
        provider: 'typesafe',
        modelId: 'm',
      }) as unknown as ResolvedModel,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

describe('the change-intent preset', () => {
  it('asks what the command relies on', async () => {
    const [preset] = await loadPresets(['change-intent'], dir);
    const ids = preset?.questions.map(({ id }) => `change-intent.${id}`);
    expect(ids).toEqual([MATCHES, UNMENTIONED, INSTRUCTIONS]);
  });
});

describe('judgeIntent', () => {
  it('sends labelled sections, message before diff, and turns answers into compliance', async () => {
    const base = commit({ 'AGENTS.md': 'Use tabs.\n', 'a.ts': 'old\n' });
    const head = commit({ 'a.ts': 'new\n' });
    const result = await judgeIntent(config, change(base, head, 'Subject\n\nBody text'));

    const state = lastState();
    expect(state.indexOf('Subject\\n\\nBody text')).toBeGreaterThan(-1);
    expect(state.indexOf('===== Message')).toBeLessThan(state.indexOf('Repository instructions'));
    expect(state.indexOf('Use tabs.')).toBeLessThan(state.indexOf('===== Unified diff'));
    expect(state).toContain('+new');
    expect(result?.answers.map(({ id, compliance }) => [id, compliance])).toEqual([
      [MATCHES, 1],
      [UNMENTIONED, 1],
      [INSTRUCTIONS, 1],
    ]);
    expect(result?.usage).toMatchObject({ inputTokens: 7, modelCalls: 1, cacheHits: 0 });
    expect(result?.warnings).toEqual([]);
  });

  it('reads instructions from the base commit, not the head', async () => {
    const base = commit({ 'AGENTS.md': 'Base rule.\n', 'a.ts': 'old\n' });
    const head = commit({ 'AGENTS.md': 'Head rule.\n', 'a.ts': 'new\n' });
    await judgeIntent(config, change(base, head));
    const [, instructions] = lastState().split('===== Unified diff');
    expect(lastState().split('===== Unified diff')[0]).toContain('Base rule.');
    expect(lastState().split('===== Unified diff')[0]).not.toContain('Head rule.');
    // The diff still shows the attempt to change them.
    expect(instructions).toContain('+Head rule.');
  });

  it('falls back to CLAUDE.md, and AGENTS.md wins when both exist', async () => {
    const base = commit({ 'CLAUDE.md': 'Claude rule.\n', 'a.ts': 'old\n' });
    const head = commit({ 'a.ts': 'new\n' });
    await judgeIntent(config, change(base, head));
    expect(lastState()).toContain('Claude rule.');

    const both = commit({ 'AGENTS.md': 'Agents rule.\n' });
    const next = commit({ 'a.ts': 'newer\n' });
    await judgeIntent(config, change(both, next));
    expect(lastState()).toContain('Agents rule.');
    expect(lastState()).not.toContain('Claude rule.');
  });

  it('skips the instructions question with no instructions at the base', async () => {
    const base = commit({ 'a.ts': 'old\n' });
    const head = commit({ 'AGENTS.md': 'Late rule.\n', 'a.ts': 'new\n' });
    const result = await judgeIntent(config, change(base, head));
    expect(requests.at(-1)?.questions).toEqual([MATCHES, UNMENTIONED]);
    expect(lastState()).not.toContain('Repository instructions');
    expect(result?.answers).toHaveLength(2);
  });

  it('gives a root commit no instructions, whatever it adds', async () => {
    const root = commit({ 'AGENTS.md': 'Own rule.\n', 'a.ts': 'new\n' });
    await judgeIntent(config, change(null, root));
    expect(requests.at(-1)?.questions).toEqual([MATCHES, UNMENTIONED]);
    expect(lastState()).not.toContain('Repository instructions');
    expect(lastState()).toContain('+new');
  });

  it('keeps the message when truncation cuts the diff, and warns', async () => {
    const base = commit({ 'a.ts': 'old\n' });
    const head = commit({ 'a.ts': `${'x'.repeat(5000)}\nLAST LINE\n` });
    const result = await judgeIntent(
      { ...config, max_file_chars: 200 },
      change(base, head, 'Keep this message'),
    );
    expect(lastState()).toContain('Keep this message');
    expect(lastState()).not.toContain('LAST LINE');
    expect(result?.warnings.join()).toContain('first 200 characters');
  });

  it('does not send the diff of a file audit would never send', async () => {
    const base = commit({ '.env': 'TOKEN=removed\n', 'a.ts': 'old\n', 'skipped.ts': 'one\n' });
    commit({
      'prod.pem': 'TOKEN=added\n',
      'a.ts': 'new\n',
      'skipped.ts': 'two-excluded\n',
    });
    git('rm', '-q', '.env');
    const deleted = commit({ 'a.ts': 'newer\n' });
    const narrow = { ...config, exclude: ['skipped.ts'] };

    await judgeIntent(narrow, change(base, deleted));

    expect(lastState()).toContain('+newer');
    for (const secret of ['TOKEN=removed', 'TOKEN=added', 'two-excluded']) {
      expect(lastState()).not.toContain(secret);
    }
  });

  it('says so rather than asking, when only excluded files changed', async () => {
    const base = commit({ 'a.ts': 'old\n' });
    const head = commit({ '.env': 'TOKEN=x\n' });
    const result = await judgeIntent(config, change(base, head));
    expect(requests).toEqual([]);
    expect(result?.answers).toEqual([]);
    expect(result?.warnings.join()).toContain('no diff');
  });

  it('uses the cache, which instructions and message are part of', async () => {
    const base = commit({ 'a.ts': 'old\n' });
    const head = commit({ 'a.ts': 'new\n' });
    await judgeIntent(config, change(base, head));
    const again = await judgeIntent(config, change(base, head));
    expect(requests).toHaveLength(1);
    expect(again?.usage).toMatchObject({ inputTokens: 0, modelCalls: 0, cacheHits: 1 });
    await judgeIntent(config, change(base, head, 'another message'));
    expect(requests).toHaveLength(2);
    await judgeIntent(config, change(base, head), true);
    expect(requests).toHaveLength(3);
  });

  it('honours a question weighted 0', async () => {
    const base = commit({ 'a.ts': 'old\n' });
    const head = commit({ 'a.ts': 'new\n' });
    await judgeIntent({ ...config, weights: { [UNMENTIONED]: 0 } }, change(base, head));
    expect(requests.at(-1)?.questions).toEqual([MATCHES]);
  });

  it('returns null with no key, and a warning when the provider fails', async () => {
    const base = commit({ 'a.ts': 'old\n' });
    const head = commit({ 'a.ts': 'new\n' });
    doDecide = async () => {
      throw new Error('busy');
    };
    const failed = await judgeIntent(config, change(base, head));
    expect(failed?.answers).toEqual([]);
    expect(failed?.warnings.join()).toContain('Provider error');

    vi.mocked(createDecisionModel).mockResolvedValue(null);
    expect(await judgeIntent(config, change(base, head))).toBeNull();
  });
});

describe('reviewChange', () => {
  it('leaves intent and the message out by default, and spends nothing on it', async () => {
    const base = commit({ 'a.ts': 'export const a = 1;\n' });
    const head = commit({ 'a.ts': 'export const a = 2;\n' });
    const review = await reviewChange(config, change(base, head), { astOnly: true });
    expect(Object.keys(review).sort()).toEqual(
      ['base', 'files', 'head', 'model', 'provider', 'scale', 'skipped', 'title', 'usage'].sort(),
    );
    expect(requests).toEqual([]);
  });

  it('adds intent, and counts its usage in the review', async () => {
    const base = commit({ 'a.ts': 'export const a = 1;\n' });
    const head = commit({ 'a.ts': 'export const a = 2;\n' });
    const plain = await reviewChange(config, change(base, head), { noCache: true });
    const judged = await reviewChange(config, change(base, head), { noCache: true, intent: true });
    expect(judged.intent).toHaveLength(2);
    expect(judged.warnings).toEqual([]);
    expect(judged.usage.modelCalls).toBe(plain.usage.modelCalls + 1);
    expect(judged.usage.inputTokens).toBe(plain.usage.inputTokens + 7);
  });

  it('carries on without intent when there is no key', async () => {
    vi.mocked(createDecisionModel).mockResolvedValue(null);
    const base = commit({ 'a.ts': 'export const a = 1;\n' });
    const head = commit({ 'a.ts': 'export const a = 2;\n' });
    const review = await reviewChange(config, change(base, head), { intent: true });
    expect(review.intent).toBeUndefined();
    expect(review.files).toHaveLength(1);
  });
});

describe('formatReview', () => {
  const review = (overrides: Partial<ChangeReview>): ChangeReview => ({
    title: 'T',
    base: null,
    head: 'h',
    provider: 'typesafe',
    model: 'm',
    scale: 100,
    files: [],
    skipped: [],
    usage: { inputTokens: 0, estimatedCostUsd: null, cacheHits: 0, modelCalls: 0 },
    ...overrides,
  });
  const answer = (compliance: number) => ({
    id: MATCHES,
    title: 'The title',
    compliance,
    weight: 1,
    fix: 'The \u001b[31mfix',
  });

  it('shows weak answers with their fix, without control characters', () => {
    const text = formatReview(review({ intent: [answer(0.2)], warnings: ['truncated: x'] }));
    expect(text).toContain('The title');
    expect(text).toContain('Fix: The ?[31mfix');
    expect(text).toContain('Intent: truncated: x');
  });

  it('keeps strong answers to one line', () => {
    const text = formatReview(review({ intent: [answer(0.7)], warnings: [] }));
    expect(text).toContain('Intent: no weak answers.');
    expect(text).not.toContain('The title');
  });

  it('prints nothing about intent unless it was asked for', () => {
    expect(formatReview(review({}))).not.toContain('Intent');
  });
});
