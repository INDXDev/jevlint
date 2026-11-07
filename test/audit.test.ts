import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Experimental_DecisionMockModelV4 as MockModel } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeAst } from '../src/ast/analyze.ts';
import { audit, planAudit } from '../src/audit.ts';
import { type Config, UserError } from '../src/config.ts';
import { createDecisionModel, type ResolvedModel } from '../src/decision/providers.ts';
import { discoverFiles } from '../src/files.ts';
import { commitCounts } from '../src/git.ts';
import { loadPresets } from '../src/presets.ts';
import type { Preset, ProviderName, Question } from '../src/types.ts';

vi.mock('../src/ast/analyze.ts', async (original) => {
  const actual = await original<typeof import('../src/ast/analyze.ts')>();
  return { ...actual, analyzeAst: vi.fn(actual.analyzeAst) };
});
vi.mock('../src/decision/providers.ts', () => ({ createDecisionModel: vi.fn() }));
vi.mock('../src/files.ts', async (original) => {
  const { discoverFiles } = await original<typeof import('../src/files.ts')>();
  return { discoverFiles: vi.fn(discoverFiles) };
});
vi.mock('../src/git.ts', () => ({ commitCounts: vi.fn() }));
vi.mock('../src/presets.ts', async (original) => ({
  ...(await original<typeof import('../src/presets.ts')>()),
  loadPresets: vi.fn(),
}));

const preset: Preset = {
  name: 'p',
  description: '',
  used_by: 'audit',
  includes: [],
  source: 'test',
  questions: [
    { id: 'q', title: 'T', instructions: 'I', weight: 1, fix: 'F', type: 'boolean', good: true },
  ],
  patterns: [
    { id: 'preset-log', language: 'typescript', pattern: 'console.log($$$)', message: 'No logs' },
  ],
  rules: [],
};

const answer = (probability: number) => async () => ({
  answers: { 'p.q': { type: 'boolean' as const, probability } },
  usage: { inputTokens: 10 },
  warnings: [],
});

let root: string;
let config: Config;

function useModel(doDecide: MockModel['doDecide']) {
  const model = new MockModel({ doDecide });
  const resolved = { model, provider: 'typesafe', modelId: 'm' } as unknown as ResolvedModel;
  vi.mocked(createDecisionModel).mockResolvedValue(resolved);
}

async function write(files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(root, path), content);
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jevlint-audit-'));
  const cache = join(root, '.cache-dir');
  await mkdir(cache);
  config = {
    root,
    sources: [],
    presets: ['p'],
    include: ['**/*'],
    exclude: ['.cache-dir/**'],
    concurrency: 2,
    max_file_chars: 1000,
    warn_file_count: 1000,
    max_rule_matches: 20,
    provider: { name: 'typesafe' },
    scoring: { scale: 100, precision: 1, ast_weight: 1, model_weight: 1, fail_under: 0 },
    priority: { churn: 1, size: 0, churn_days: 90 },
    ast: {
      max_cognitive_complexity: 15,
      max_nesting: 4,
      max_function_lines: 50,
      max_params: 2,
      max_file_lines: 100,
    },
    architecture: {
      max_fan_out: 12,
      max_hub_links: 5,
      max_directory_files: 20,
      max_class_methods: 20,
      max_class_lines: 300,
      max_inheritance_depth: 3,
    },
    weights: {},
    patterns: [],
    rules: [],
    spec: {
      dir: '.jevlint/spec',
      docs: ['README.md', 'docs/**/*.md', 'docs/**/*.html'],
      threshold: 0,
    },
    agents: {},
    cache: { dir: cache },
  };
  vi.mocked(loadPresets).mockResolvedValue([preset]);
  vi.mocked(commitCounts).mockResolvedValue(new Map());
  vi.mocked(createDecisionModel).mockResolvedValue(null);
});

afterEach(() => rm(root, { recursive: true, force: true }));

describe('audit', () => {
  it('returns full marks for an empty repository', async () => {
    expect(await audit(config)).toEqual({
      root,
      provider: null,
      model: null,
      presets: ['p'],
      scale: 100,
      score: 100,
      files: [],
      skipped: [],
      usage: { inputTokens: 0, estimatedCostUsd: null, cacheHits: 0, modelCalls: 0 },
    });
  });

  it('blends both engines on the configured scale', async () => {
    await write({ 'a.ts': 'function f(a, b, c, d) {}\n' });
    useModel(answer(1));
    const { files, score, provider, model, usage } = await audit(config);
    expect(files[0]).toMatchObject({ path: 'a.ts', language: 'typescript', lines: 1, score: 75 });
    expect(files[0]?.model?.presets).toEqual({ p: 1 });
    expect(score).toBe(75);
    expect({ provider, model }).toEqual({ provider: 'typesafe', model: 'm' });
    expect(usage).toEqual({
      inputTokens: 10,
      estimatedCostUsd: null,
      cacheHits: 0,
      modelCalls: 1,
    });
  });

  it('prices the tokens a run used', async () => {
    await write({ 'a.ts': 'const a = 1;\n' });
    useModel(answer(0.9));
    vi.mocked(createDecisionModel).mockResolvedValue({
      ...(await createDecisionModel(config)),
      modelId: 'jev-latest',
    } as ResolvedModel);
    const { usage } = await audit(config);
    expect(usage.estimatedCostUsd).toBeCloseTo((10 * 0.042) / 1_000_000, 12);
  });

  it('counts cached answers as hits, not usage', async () => {
    await write({ 'a.ts': 'const a = 1;\n' });
    useModel(answer(1));
    await audit(config);
    const { usage, files } = await audit(config);
    expect(usage).toEqual({ inputTokens: 0, estimatedCostUsd: null, cacheHits: 1, modelCalls: 0 });
    expect(files[0]?.model?.inputTokens).toBe(10);
  });

  it('does not create or call a model with astOnly', async () => {
    await write({ 'a.ts': 'const a = 1;\n', 'deploy.sh': 'hello\n' });
    const report = await audit(config, { astOnly: true });
    expect(createDecisionModel).not.toHaveBeenCalled();
    expect(report.files.map((f) => f.path)).toEqual(['a.ts']);
    expect(report.skipped).toEqual(['deploy.sh']);
  });

  it('estimates metrics for a language with no grammar', async () => {
    await write({
      'A.java': `class A {\n    int f(int a, int b, int c, int d, int e) {\n    }\n}\n`,
    });
    const { files, skipped } = await audit(config, { astOnly: true });
    expect(skipped).toEqual([]);
    expect(files[0]?.language).toBeNull();
    expect(files[0]?.ast).toMatchObject({
      approximate: true,
      findings: [{ rule: 'params', line: 2 }],
    });
  });

  it('scores unknown languages with the model alone', async () => {
    await write({ 'deploy.sh': 'hello\n' });
    useModel(answer(0.5));
    const { files } = await audit(config);
    expect(files[0]).toMatchObject({ language: null, ast: null, score: 50 });
  });

  it('does not ask about blank files', async () => {
    await write({ 'empty.ts': '' });
    const doDecide = vi.fn(answer(1));
    useModel(doDecide);
    const { files } = await audit(config);
    expect(doDecide).not.toHaveBeenCalled();
    expect(files[0]).toMatchObject({ lines: 0, score: 100 });
  });

  it('skips the model when no question is active', async () => {
    await write({ 'a.ts': 'const a = 1;\n' });
    const doDecide = vi.fn(answer(1));
    useModel(doDecide);
    await audit({ ...config, weights: { 'p.q': 0 } });
    expect(doDecide).not.toHaveBeenCalled();
  });

  it('applies patterns from presets and config', async () => {
    await write({ 'a.ts': 'console.log(1);\ndebugger;\n' });
    const own = { id: 'own', language: 'typescript', pattern: 'debugger', message: 'No' } as const;
    const { files } = await audit({ ...config, patterns: [own] }, { astOnly: true });
    expect(files[0]?.ast?.findings.map((f) => f.rule)).toEqual(['preset-log', 'own']);
  });

  it('sorts by priority, then path, and uses churn', async () => {
    await write({ 'a.ts': 'function f(a, b, c, d) {}\n', 'b.ts': 'function f(a, b, c, d) {}\n' });
    await write({ 'c.ts': 'const a = 1;\n' });
    vi.mocked(commitCounts).mockResolvedValue(new Map([['b.ts', 5]]));
    const { files } = await audit(config, { astOnly: true });
    expect(files.map((f) => f.path)).toEqual(['b.ts', 'a.ts', 'c.ts']);
    expect(files[0]?.commits).toBe(5);
    expect(files[0]?.priority).toBeCloseTo(1);
    expect(files[1]?.priority).toBeCloseTo(0.5);
  });

  it('keeps the AST score and warns when the provider fails', async () => {
    await write({ 'a.ts': 'const a = 1;\n', 'deploy.sh': 'hello\n' });
    useModel(() => Promise.reject(new Error('refused')));
    const { files, skipped, score } = await audit(config);
    const ts = files.find((f) => f.path === 'a.ts');
    expect(ts).toMatchObject({ model: null, score: 100 });
    expect(ts?.warnings[0]).toContain('refused');
    expect(files.find((f) => f.path === 'deploy.sh')?.warnings[0]).toContain('refused');
    expect(skipped).toEqual([]);
    expect(score).toBe(100);
  });

  it('aborts on an auth failure instead of retrying every file', async () => {
    await write({ 'a.ts': 'a\n', 'b.ts': 'b\n', 'c.ts': 'c\n', 'd.ts': 'd\n', 'e.ts': 'e\n' });
    const failure = Object.assign(new Error('nope'), { statusCode: 401 });
    const doDecide = vi.fn(() => Promise.reject(failure));
    useModel(doDecide);
    await expect(audit(config)).rejects.toThrow(UserError);
    expect(doDecide.mock.calls.length).toBeLessThanOrEqual(config.concurrency);
  });

  it('keeps auditing when one file cannot be analysed', async () => {
    await write({ 'a.ts': 'a\n', 'b.ts': 'b\n' });
    vi.mocked(analyzeAst).mockImplementationOnce(() => {
      throw new RangeError('Maximum call stack size exceeded');
    });
    useModel(answer(0.5));
    const { files } = await audit(config);
    expect(files).toHaveLength(2);
    const failed = files.find((file) => file.ast === null);
    expect(failed?.warnings[0]).toContain('AST analysis failed');
    expect(failed).toMatchObject({ score: 50, model: { score: 0.5 } });
  });

  it('still stops on an AST failure the user can fix', async () => {
    await write({ 'a.ts': 'a\n' });
    vi.mocked(analyzeAst).mockImplementationOnce(() => {
      throw new UserError('Invalid AST pattern');
    });
    await expect(audit(config)).rejects.toThrow(UserError);
  });

  it('warns on truncation', async () => {
    await write({ 'a.ts': `// ${'x'.repeat(2000)}\n` });
    useModel(answer(1));
    const { files } = await audit(config);
    expect(files[0]?.warnings).toEqual([
      'File truncated: the model saw only the first 1000 characters.',
    ]);
    expect(files[0]?.model?.truncated).toBe(true);
  });

  it('survives a file it cannot read', async () => {
    await write({ 'a.ts': 'const a = 1;\n' });
    vi.mocked(discoverFiles).mockResolvedValueOnce(['a.ts', 'gone.ts']);
    const { files, skipped, score } = await audit(config, { astOnly: true });
    const unread = files.find((f) => f.path === 'gone.ts');
    expect(unread).toMatchObject({ ast: null, model: null, priority: 0 });
    expect(unread?.warnings[0]).toContain('Could not read file');
    expect(skipped).toEqual([]);
    expect(score).toBe(100);
  });

  it('reports progress for every file', async () => {
    await write({ 'a.ts': 'a\n', 'b.ts': 'b\n' });
    const onProgress = vi.fn();
    await audit(config, { astOnly: true, onProgress });
    expect(onProgress.mock.calls.map(([done, total]) => [done, total])).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it('limits the run to the given paths', async () => {
    await write({ 'a.ts': 'a\n', 'b.ts': 'b\n' });
    const { files } = await audit(config, { astOnly: true, paths: ['a.ts'] });
    expect(files.map((f) => f.path)).toEqual(['a.ts']);
  });
});

describe('audit with semantic rules', () => {
  const rule = {
    id: 'r',
    language: 'typescript',
    pattern: 'console.log($$$)',
    question: 'Bad?',
    message: 'Bad log',
    fix: 'Drop it.',
    threshold: 0.5,
  } as const;
  const both: MockModel['doDecide'] = async ({ questions }) => ({
    answers: Object.fromEntries(
      Object.keys(questions).map((id) => [id, { type: 'boolean' as const, probability: 1 }]),
    ),
    usage: { inputTokens: 10 },
    warnings: [],
  });

  it('blends the hit into the AST score and adds its call to the usage', async () => {
    await write({ 'a.ts': 'console.log(1);\n' });
    vi.mocked(loadPresets).mockResolvedValue([{ ...preset, patterns: [], rules: [rule] }]);
    useModel(both);
    const { files, usage } = await audit(config);
    expect(files[0]?.ast?.score).toBeCloseTo(0.95);
    expect(files[0]?.score).toBe(97.5);
    expect(usage).toMatchObject({ inputTokens: 20, modelCalls: 2, cacheHits: 0 });
    const again = await audit(config);
    expect(again.usage).toMatchObject({ inputTokens: 0, modelCalls: 0, cacheHits: 2 });
  });

  it('runs rules from the config as well as from presets', async () => {
    await write({ 'a.ts': 'console.log(1);\n' });
    vi.mocked(loadPresets).mockResolvedValue([{ ...preset, patterns: [] }]);
    useModel(both);
    const { files } = await audit({ ...config, rules: [rule] });
    expect(files[0]?.ast?.findings.map((finding) => finding.rule)).toEqual(['r']);
  });

  it('adds what rules send to the dry run', async () => {
    await write({ 'a.ts': 'console.log(1);\n' });
    const target = { provider: 'typesafe', modelId: 'jev-latest' } as const;
    const plain = await planAudit(config, { target });
    const ruled = await planAudit({ ...config, rules: [rule] }, { target });
    expect(ruled.files).toEqual(['a.ts']);
    expect(ruled.chars).toBe(plain.chars + 'console.log(1)'.length);
    expect(ruled.estimatedTokens).toBeGreaterThan(plain.estimatedTokens);
  });
});

describe('planAudit', () => {
  const target = { provider: 'typesafe', modelId: 'jev-latest' } as const;

  it('estimates each request as a capped file plus every question', async () => {
    await write({ 'a.ts': 'x'.repeat(10), 'b.sh': 'y'.repeat(5000) });
    const plan = await planAudit(config, { target });
    const questionChars = JSON.stringify({ 'p.q': { type: 'boolean', instructions: 'I' } }).length;
    const estimatedTokens = Math.ceil((1010 + 2 * questionChars) / 4);
    expect(plan).toEqual({
      files: ['a.ts', 'b.sh'],
      skipped: 0,
      chars: 1010,
      estimatedTokens,
      estimatedCostUsd: (estimatedTokens * 0.042) / 1_000_000,
    });
    expect(createDecisionModel).not.toHaveBeenCalled();
  });

  it('sends nothing, so costs nothing, with no target', async () => {
    await write({ 'a.ts': 'a\n' });
    expect(await planAudit(config)).toMatchObject({
      files: ['a.ts'],
      estimatedTokens: 0,
      estimatedCostUsd: null,
    });
  });

  it('has no cost for a model whose price is unknown', async () => {
    await write({ 'a.ts': 'a\n' });
    const plan = await planAudit(config, { target: { provider: 'compatible', modelId: 'x' } });
    expect(plan.estimatedCostUsd).toBeNull();
    expect(plan.estimatedTokens).toBeGreaterThan(0);
  });

  it('does not count blank or pinned files', async () => {
    await write({
      'a.ts': 'a\n',
      'blank.ts': ' \n',
      'empty.ts': '',
      'pinned.ts': '// jevlint-score 90 -- Reviewed\nconst a = 1;\n',
    });
    const plan = await planAudit(config, { target });
    expect(plan).toMatchObject({ files: ['a.ts'], skipped: 3 });
  });

  it('counts a file once per request when its questions need several', async () => {
    await write({ 'a.ts': 'a'.repeat(400) });
    const many = Array.from({ length: 65 }, (_, i) => ({ ...preset.questions[0], id: `q${i}` }));
    vi.mocked(loadPresets).mockResolvedValue([{ ...preset, questions: many as Question[] }]);
    const tokens = async (provider: ProviderName) =>
      (await planAudit(config, { target: { provider, modelId: 'm' } })).estimatedTokens;
    expect((await tokens('cloudflare')) - (await tokens('typesafe'))).toBe(100);
  });

  it('does not count cached files, unless the cache is off', async () => {
    await write({ 'a.ts': 'a\n', 'b.ts': 'b\n' });
    useModel(answer(0.9));
    await audit(config, { paths: ['a.ts'] });
    const used = { provider: 'typesafe', modelId: 'm' } as const;
    const plan = await planAudit(config, { target: used });
    expect(plan).toMatchObject({ files: ['b.ts'], skipped: 1 });
    const fresh = await planAudit(config, { target: used, noCache: true });
    expect(fresh).toMatchObject({ files: ['a.ts', 'b.ts'], skipped: 0 });
  });

  it('sends nothing with no questions', async () => {
    await write({ 'a.ts': 'a\n' });
    vi.mocked(loadPresets).mockResolvedValue([{ ...preset, questions: [] }]);
    expect(await planAudit(config, { target })).toMatchObject({ files: [], estimatedTokens: 0 });
  });
});

describe('jevlint-score comments', () => {
  const code = 'const a = 1;\n';
  const auditOne = async (options = {}) => (await audit(config, options)).files[0];

  it('pins a whole file without calling the model', async () => {
    const doDecide = vi.fn(answer(0.1));
    useModel(doDecide);
    await write({ 'a.ts': `// jevlint-score 80 -- Accepted\n${code}` });
    const file = await auditOne();
    expect(file).toMatchObject({
      score: 80,
      priority: 0,
      model: null,
      pin: { reason: 'Accepted' },
    });
    expect(doDecide).not.toHaveBeenCalled();
  });

  it('ranks a pinned file after unpinned ones, however low its score', async () => {
    useModel(answer(0.9));
    await write({ 'a.ts': `// jevlint-score 5 -- Accepted debt\n${code}`, 'b.ts': code });
    const { files } = await audit(config);
    expect(files.map((file) => file.path)).toEqual(['b.ts', 'a.ts']);
  });

  it('keeps a question pin out of the model request and its cache key', async () => {
    const doDecide = vi.fn(answer(0.2));
    useModel(doDecide);
    await write({ 'a.ts': code });
    await audit(config);
    await write({ 'a.ts': `// jevlint-score p.q 90 -- Domain terms\n${code}` });
    const file = await auditOne();
    expect(doDecide).toHaveBeenCalledTimes(1);
    expect(file?.model).toMatchObject({ cached: true, score: 0.9 });
    expect(file?.model?.answers[0]?.pin?.reason).toBe('Domain terms');
  });

  it('scores the real code with ignorePins', async () => {
    useModel(answer(0.5));
    await write({ 'a.ts': `// jevlint-score 80 -- Accepted\n${code}` });
    const file = await auditOne({ ignorePins: true });
    expect(file?.pin).toBeUndefined();
    expect(file?.model?.score).toBe(0.5);
  });

  it('warns about a pin for a question that is not active', async () => {
    useModel(answer(0.5));
    await write({ 'a.ts': `// jevlint-score nope.q 90 -- Reason\n${code}` });
    expect((await auditOne())?.warnings[0]).toContain('unknown question nope.q');
  });

  it('leaves pinned files out of the dry run, because nothing is sent', async () => {
    await write({ 'a.ts': `// jevlint-score 80 -- Accepted\n${code}`, 'b.ts': code });
    expect((await planAudit(config)).files).toEqual(['b.ts']);
    expect((await planAudit(config, { ignorePins: true })).files).toEqual(['a.ts', 'b.ts']);
  });
});
