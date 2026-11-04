import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APICallError } from 'ai';
import { Experimental_DecisionMockModelV4 as MockModel } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audit, planAudit } from '../src/audit.ts';
import { type Config, loadConfig, UserError } from '../src/config.ts';
import { createDecisionModel, type ResolvedModel } from '../src/decision/providers.ts';
import type { AstRule } from '../src/types.ts';

vi.mock('../src/decision/providers.ts', () => ({ createDecisionModel: vi.fn() }));

const rule: AstRule = {
  id: 'hides-failure',
  language: 'typescript',
  pattern: 'try { $$$ } catch ($E) { $$$ }',
  question: 'Does this swallow a failure?',
  message: 'This catch hides a failure',
  fix: 'Rethrow it.',
  threshold: 0.8,
};

const tryBlock = (body = 'a()') => `try { ${body}; } catch (e) { log(e); }\n`;

const answer = (probability: number) => async () => ({
  answers: { [rule.id]: { type: 'boolean' as const, probability } },
  usage: { inputTokens: 7 },
  warnings: [],
});

let root: string;
let config: Config;

function useModel(doDecide: MockModel['doDecide'], modelId = 'm') {
  const spy = vi.fn(doDecide);
  const model = new MockModel({ doDecide: spy });
  const resolved = { model, provider: 'typesafe', modelId } as unknown as ResolvedModel;
  vi.mocked(createDecisionModel).mockResolvedValue(resolved);
  return spy;
}

const states = (spy: ReturnType<typeof useModel>) =>
  spy.mock.calls.map(
    ([options]) => (options as unknown as { state: { text: string }[] }).state[0]?.text,
  );

const write = (path: string, content: string) => writeFile(join(root, path), content);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jevlint-rules-'));
  vi.stubEnv('XDG_CONFIG_HOME', root);
  vi.mocked(createDecisionModel).mockReset();
  config = await loadConfig({
    cwd: root,
    overrides: {
      presets: [],
      exclude: ['cache/**'],
      rules: [rule],
      cache: { dir: join(root, 'cache') },
    },
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('judging matches', () => {
  it('reports a hit as a finding at the match line, and lowers the AST score', async () => {
    await write('a.ts', `const a = 1;\n\n${tryBlock()}`);
    useModel(answer(0.9));
    const { files, usage } = await audit(config);
    expect(files[0]?.ast?.findings).toEqual([
      {
        rule: rule.id,
        message: rule.message,
        line: 3,
        probability: 0.9,
        fix: rule.fix,
      },
    ]);
    expect(files[0]?.ast?.score).toBeCloseTo(0.95);
    expect(files[0]?.score).toBe(95);
    expect(usage).toMatchObject({ inputTokens: 7, cacheHits: 0, modelCalls: 1 });
  });

  it('sends only the match, as a boolean question', async () => {
    await write('a.ts', `const secret = 1;\n${tryBlock()}`);
    const spy = useModel(answer(0));
    await audit(config);
    expect(states(spy)).toEqual([tryBlock().trimEnd()]);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      questions: { [rule.id]: { type: 'boolean', instructions: rule.question } },
    });
  });

  it('reports at the threshold but not below it', async () => {
    await write('a.ts', tryBlock());
    useModel(answer(0.8));
    expect((await audit(config, { noCache: true })).files[0]?.ast?.findings).toHaveLength(1);
    useModel(answer(0.79));
    const { files } = await audit(config, { noCache: true });
    expect(files[0]?.ast).toEqual({ score: 1, findings: [] });
  });

  it('adds to findings the AST already has', async () => {
    await write('a.ts', `function f(a, b, c, d, e) {}\n${tryBlock()}`);
    useModel(answer(1));
    const { files } = await audit(config);
    expect(files[0]?.ast?.findings.map((finding) => finding.rule)).toEqual(['params', rule.id]);
    expect(files[0]?.ast?.score).toBeCloseTo((4 / 5) * 0.95);
  });

  it('ignores rules for another language and files with no grammar', async () => {
    await write('a.py', 'try:\n    a()\nexcept E:\n    pass\n');
    await write('b.rb', 'def f\nend\n');
    const spy = useModel(answer(1));
    await audit(config);
    expect(spy).not.toHaveBeenCalled();
  });

  it('names the rule when its pattern is invalid', async () => {
    await write('a.ts', 'a();\n');
    useModel(answer(1));
    const bad = { ...config, rules: [{ ...rule, pattern: '' }] };
    const run = audit(bad);
    await expect(run).rejects.toBeInstanceOf(UserError);
    await expect(run).rejects.toThrow(`Invalid AST pattern "${rule.id}"`);
  });

  it('never has more calls in flight than concurrency', async () => {
    const blocks = ['a', 'b', 'c', 'd'].map(tryBlock).join('');
    await write('a.ts', blocks);
    await write('b.ts', blocks.replaceAll('(e)', '(err)'));
    let running = 0;
    let peak = 0;
    useModel(async () => {
      peak = Math.max(peak, ++running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      return answer(0)();
    });
    await audit({ ...config, concurrency: 1 });
    expect(peak).toBe(1);
  });
});

describe('the cache', () => {
  it('answers a second run from the cache, and counts the hit', async () => {
    await write('a.ts', tryBlock());
    const spy = useModel(answer(0.9));
    await audit(config);
    const { files, usage } = await audit(config);
    expect(spy).toHaveBeenCalledOnce();
    expect(files[0]?.ast?.findings).toHaveLength(1);
    expect(usage).toMatchObject({ inputTokens: 0, cacheHits: 1, modelCalls: 0 });
  });

  it('applies a new threshold, message or fix to the cached answer at no cost', async () => {
    await write('a.ts', tryBlock());
    const spy = useModel(answer(0.5));
    await audit(config);
    const tuned = { ...rule, threshold: 0.4, message: 'New', fix: 'Other' };
    const { files } = await audit({ ...config, rules: [tuned] });
    expect(spy).toHaveBeenCalledOnce();
    expect(files[0]?.ast?.findings[0]).toMatchObject({ message: 'New', fix: 'Other' });
  });

  it('asks again for a new question, new content or a new model', async () => {
    await write('a.ts', tryBlock());
    const spy = useModel(answer(0));
    await audit(config);
    await audit({ ...config, rules: [{ ...rule, question: 'Another?' }] });
    expect(spy).toHaveBeenCalledTimes(2);
    await write('a.ts', tryBlock('b()'));
    await audit(config);
    expect(spy).toHaveBeenCalledTimes(3);
    const other = useModel(answer(0), 'other-model');
    await audit(config);
    expect(other).toHaveBeenCalledOnce();
  });

  it('counts identical matches in a file as one call', async () => {
    await write('a.ts', tryBlock() + tryBlock());
    const spy = useModel(answer(0.9));
    const { files, usage } = await audit(config);
    expect(spy).toHaveBeenCalledOnce();
    expect(files[0]?.ast?.findings.map(({ line }) => line)).toEqual([1, 2]);
    expect(usage).toMatchObject({ cacheHits: 1, modelCalls: 1 });
  });
});

describe('when rules do not run', () => {
  it('does nothing with --ast-only, even with an invalid pattern', async () => {
    await write('a.ts', tryBlock());
    const spy = useModel(answer(1));
    const bad = { ...config, rules: [{ ...rule, pattern: '' }] };
    const { files } = await audit(bad, { astOnly: true });
    expect(spy).not.toHaveBeenCalled();
    expect(files[0]).toMatchObject({ warnings: [], ast: { findings: [] } });
  });

  it('does nothing with no model', async () => {
    await write('a.ts', tryBlock());
    vi.mocked(createDecisionModel).mockResolvedValue(null);
    const { files } = await audit(config);
    expect(files[0]).toMatchObject({ warnings: [], ast: { findings: [] } });
  });

  it('skips a pinned file, unless pins are ignored', async () => {
    await write('a.ts', `// jevlint-score 90 -- Accepted\n${tryBlock()}`);
    const spy = useModel(answer(1));
    expect((await audit(config)).files[0]?.score).toBe(90);
    expect(spy).not.toHaveBeenCalled();
    const { files } = await audit(config, { ignorePins: true });
    expect(files[0]?.ast?.findings[0]?.line).toBe(2);
  });
});

describe('pin comments', () => {
  const pin = '// jevlint-score readable-code.naming 90 -- Accepted\n';
  const pinned = `${pin}${pin}try {\n  ${pin}  a();\n} catch (e) {\n  log(e);\n}\n`;
  const clean = 'try {\n  a();\n} catch (e) {\n  log(e);\n}\n';

  it('keep the line numbers of the file on disk', async () => {
    await write('a.ts', pinned);
    useModel(answer(1));
    expect((await audit(config)).files[0]?.ast?.findings[0]?.line).toBe(3);
  });

  it('never reach the model, and leave the cached answer valid', async () => {
    await write('a.ts', clean);
    const spy = useModel(answer(1));
    await audit(config);
    await write('a.ts', pinned);
    const { usage } = await audit(config);
    expect(states(spy)).toEqual([clean.trimEnd()]);
    expect(usage).toMatchObject({ cacheHits: 1, modelCalls: 0 });
  });

  it('send nothing when a match is only a pin', async () => {
    await write('a.ts', pin);
    const spy = useModel(answer(1));
    await audit({ ...config, rules: [{ ...rule, pattern: pin.trimEnd() }] });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('provider failures', () => {
  const failing = (statusCode?: number) =>
    new APICallError({
      message: 'busy',
      url: 'https://example.test',
      requestBodyValues: {},
      statusCode,
      isRetryable: false,
    });

  it('become one file warning, and other matches still count', async () => {
    await write('a.ts', ['a', 'b', 'c'].map(tryBlock).join(''));
    const spy = useModel(answer(0.9));
    spy.mockRejectedValueOnce(failing(500)).mockRejectedValueOnce(failing(500));
    const { files } = await audit(config);
    const errors = files[0]?.warnings.filter((text) => text.startsWith('Provider error:'));
    expect(errors).toHaveLength(1);
    expect(files[0]?.ast?.findings.map(({ line }) => line)).toEqual([3]);
    expect(files[0]?.ruleUsage).toEqual({ inputTokens: 7, cacheHits: 0, modelCalls: 1 });
  });

  it('leave the file scored by the AST', async () => {
    await write('a.ts', tryBlock());
    useModel(async () => {
      throw failing(500);
    });
    const { files } = await audit(config);
    expect(files[0]).toMatchObject({ score: 100, ruleUsage: undefined });
    expect(files[0]?.warnings[0]).toContain('Provider error:');
  });

  it('end the run on a rejected key', async () => {
    await write('a.ts', tryBlock());
    useModel(async () => {
      throw failing(401);
    });
    await expect(audit(config)).rejects.toBeInstanceOf(UserError);
  });
});

describe('max_rule_matches', () => {
  const blocks = ['a', 'b', 'c'].map(tryBlock).join('');

  it('judges only the first matches of each rule, and says so', async () => {
    await write('a.ts', blocks);
    const spy = useModel(answer(1));
    const { files } = await audit({ ...config, max_rule_matches: 2 });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(files[0]?.ast?.findings.map(({ line }) => line)).toEqual([1, 2]);
    expect(files[0]?.warnings).toEqual([
      `Rule ${rule.id}: judged the first 2 of 3 matches and skipped the rest.`,
    ]);
  });

  it('stays silent at the limit', async () => {
    await write('a.ts', blocks);
    useModel(answer(0));
    expect((await audit({ ...config, max_rule_matches: 3 })).files[0]?.warnings).toEqual([]);
  });
});

it('warns when a match is longer than max_file_chars', async () => {
  await write('a.ts', tryBlock('a'.repeat(100)));
  const spy = useModel(answer(0));
  const { files } = await audit({ ...config, max_file_chars: 20 });
  expect(states(spy)[0]).toHaveLength(20);
  expect(files[0]?.warnings[0]).toContain('first 20 characters of a match');
});

describe('dry run', () => {
  const target = { provider: 'typesafe', modelId: 'm' } as const;
  const text = tryBlock().trimEnd();
  const questionChars = JSON.stringify({
    [rule.id]: { type: 'boolean', instructions: rule.question },
  }).length;

  it('counts each match as a request of its own', async () => {
    await write('a.ts', `${tryBlock()}${tryBlock('b()')}`);
    const plan = await planAudit(config, { target });
    const chars = text.length + tryBlock('b()').trimEnd().length;
    expect(plan).toMatchObject({
      files: ['a.ts'],
      skipped: 0,
      chars,
      estimatedTokens: Math.ceil((chars + 2 * questionChars) / 4),
    });
  });

  it('respects max_rule_matches', async () => {
    await write('a.ts', `${tryBlock()}${tryBlock('b()')}`);
    const plan = await planAudit({ ...config, max_rule_matches: 1 }, { target });
    expect(plan.chars).toBe(text.length);
  });

  it('counts nothing for a file with no match', async () => {
    await write('a.ts', 'a();\n');
    expect(await planAudit(config, { target })).toMatchObject({ files: [], skipped: 1, chars: 0 });
  });

  it('leaves out answers already cached, unless the cache is off', async () => {
    await write('a.ts', tryBlock());
    useModel(answer(0.9));
    await audit(config);
    expect(await planAudit(config, { target })).toMatchObject({ files: [], chars: 0 });
    const fresh = await planAudit(config, { target, noCache: true });
    expect(fresh.chars).toBe(text.length);
  });

  it('leaves out pinned files', async () => {
    await write('a.ts', `// jevlint-score 90 -- Accepted\n${tryBlock()}`);
    expect(await planAudit(config, { target })).toMatchObject({ files: [], skipped: 1 });
  });

  it('counts no rule with --ast-only, which has no target', async () => {
    await write('a.ts', tryBlock());
    expect(await planAudit(config)).toMatchObject({ estimatedTokens: 0, chars: tryBlock().length });
  });
});
