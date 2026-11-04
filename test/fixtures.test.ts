import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Experimental_DecisionMockModelV4 as MockModel } from 'ai/test';
import { runCommand } from 'citty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testCommand } from '../src/commands/test.ts';
import { type Config, loadConfig, UserError } from '../src/config.ts';
import { createDecisionModel, type ResolvedModel } from '../src/decision/providers.ts';
import { discoverFiles } from '../src/files.ts';
import { testFixtures } from '../src/fixtures.ts';

vi.mock('../src/decision/providers.ts', async (original) => ({
  ...(await original<typeof import('../src/decision/providers.ts')>()),
  createDecisionModel: vi.fn(),
}));

const PRESET = `name = "house"
description = "d"
source = "s"

[[questions]]
id = "levels"
type = "boolean"
title = "T"
instructions = "Is it good?"
good = true
fix = "F"

[[questions]]
id = "rubric"
type = "score"
title = "T"
instructions = "Rate it"
levels = ["bad", "fair", "good"]
fix = "F"

[[questions]]
id = "global-state"
type = "boolean"
title = "No global state"
instructions = "Does it use global state?"
good = false
fix = "F"
`;

const LEVELS_DIR = '.jevlint/fixtures/house.levels';
const BOOLEAN_DIR = '.jevlint/fixtures/house.global-state';

let root: string;
let scratch: string;
let config: Config;
/** How good the mock model finds a state, from 0 to 10. */
let level: (state: string) => number;
let asked: { state: string; questions: string[] }[];

const write = async (files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
};

function useModel(modelId = 'm') {
  const model = new MockModel({
    doDecide: async ({ state, questions }) => {
      const text = JSON.stringify(state);
      asked.push({ state: text, questions: Object.keys(questions) });
      const answers = Object.entries(questions).map(([id, question]) => [
        id,
        question.type === 'score'
          ? { type: 'score', score: level(text) > 5 ? 2 : 0 }
          : {
              type: 'boolean',
              probability: id.endsWith('levels') ? level(text) / 10 : 1 - level(text) / 10,
            },
      ]);
      return {
        answers: Object.fromEntries(answers),
        usage: { inputTokens: 5 },
        warnings: [],
      } as never;
    },
  });
  vi.mocked(createDecisionModel).mockResolvedValue({
    model,
    provider: 'typesafe',
    modelId,
  } as unknown as ResolvedModel);
}

const byWords = (state: string) => (state.includes('tidy') ? 9 : 2);

const record = async () =>
  JSON.parse(await readFile(join(root, '.jevlint/calibration.json'), 'utf8'));

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'jevlint-fixtures-')));
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'jevlint-fixtures-out-')));
  vi.stubEnv('XDG_CONFIG_HOME', scratch);
  await write({
    'jevlint.toml': 'presets = ["house"]\n',
    '.jevlint/presets/house.toml': PRESET,
    [`${LEVELS_DIR}/good-one.ts`]: 'const tidy = 1;\n',
    [`${LEVELS_DIR}/bad-one.ts`]: 'var x;\n',
  });
  config = await loadConfig({ cwd: root });
  config = { ...config, cache: { dir: join(scratch, 'cache') } };
  level = byWords;
  asked = [];
  useModel();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

describe('testFixtures', () => {
  it('asks each fixture only its one question, and passes good high and bad low', async () => {
    await write({ [`${BOOLEAN_DIR}/good-a.py`]: 'tidy = 1\n' });
    const report = await testFixtures(config);
    expect(report.results.map(({ question, file, passed }) => [question, file, passed])).toEqual([
      ['house.global-state', 'good-a.py', true],
      ['house.levels', 'bad-one.ts', true],
      ['house.levels', 'good-one.ts', true],
    ]);
    expect(asked.map(({ questions }) => questions).sort()).toEqual([
      ['house.global-state'],
      ['house.levels'],
      ['house.levels'],
    ]);
    expect(report.results[2]?.compliance).toBeCloseTo(0.9);
    expect(report.usage).toMatchObject({ modelCalls: 3, inputTokens: 15, cacheHits: 0 });
  });

  it('fails a good fixture below 0.7 and a bad one at 0.7, using the audit conversion', async () => {
    level = () => 7;
    const atLine = await testFixtures(config);
    expect(atLine.results.map(({ file, passed }) => [file, passed])).toEqual([
      ['bad-one.ts', false],
      ['good-one.ts', true],
    ]);
    level = () => 6;
    await write({ [`${LEVELS_DIR}/good-one.ts`]: 'const tidy = 2;\n' });
    const below = await testFixtures(config);
    expect(below.results.find(({ file }) => file === 'good-one.ts')?.passed).toBe(false);
  });

  it('reads a score question on its rubric', async () => {
    await write({
      '.jevlint/fixtures/house.rubric/good-a.ts': 'const tidy = 1;\n',
      '.jevlint/fixtures/house.rubric/bad-a.ts': 'var x;\n',
    });
    const { results } = await testFixtures(config, { questionIds: ['house.rubric'] });
    expect(results.map(({ compliance, passed }) => [compliance, passed])).toEqual([
      [0, true],
      [1, true],
    ]);
  });

  it('answers from the cache on a plain run, and strips pins as audit does', async () => {
    await write({
      [`${LEVELS_DIR}/good-one.ts`]: '// jevlint-score 100 -- accepted\nconst tidy = 1;\n',
    });
    await testFixtures(config);
    expect(asked.map(({ state }) => state).join()).not.toContain('jevlint-score');
    const again = await testFixtures(config);
    expect(asked).toHaveLength(2);
    expect(again.usage).toMatchObject({ modelCalls: 0, cacheHits: 2 });
  });

  it('warns about a directory for no active question, and does not ask about it', async () => {
    await write({ '.jevlint/fixtures/house.gone/good-a.ts': 'const tidy = 1;\n' });
    const { results, warnings } = await testFixtures(config);
    expect(results).toHaveLength(2);
    expect(warnings.join()).toContain('house.gone');
  });

  it('leaves out a question weighted 0', async () => {
    const weights = { 'house.levels': 0 };
    await write({ [`${BOOLEAN_DIR}/good-a.ts`]: 'const tidy = 1;\n' });
    const { results, warnings } = await testFixtures({ ...config, weights });
    expect(results.map(({ question }) => question)).toEqual(['house.global-state']);
    expect(warnings.join()).toContain('house.levels');
  });

  it('narrows to named questions, and refuses one that is unknown or has no fixtures', async () => {
    await write({ [`${BOOLEAN_DIR}/good-a.ts`]: 'const tidy = 1;\n' });
    const { results } = await testFixtures(config, { questionIds: ['house.global-state'] });
    expect(results).toHaveLength(1);
    await expect(testFixtures(config, { questionIds: ['house.nope'] })).rejects.toThrow(
      'Unknown question',
    );
    await rm(join(root, BOOLEAN_DIR), { recursive: true });
    await expect(testFixtures(config, { questionIds: ['house.global-state'] })).rejects.toThrow(
      'No fixtures for house.global-state',
    );
  });

  it('refuses a run with no fixtures, or no key, as nothing can be tested', async () => {
    vi.mocked(createDecisionModel).mockResolvedValue(null);
    await expect(testFixtures(config)).rejects.toThrow('fixtures need a model');
    await rm(join(root, '.jevlint/fixtures'), { recursive: true });
    await expect(testFixtures(config)).rejects.toThrow('No fixtures to test');
  });

  it('stops with a user error when a provider call fails, and records nothing', async () => {
    level = () => {
      throw new Error('busy');
    };
    await expect(testFixtures(config, { record: true })).rejects.toThrow(UserError);
    await expect(record()).rejects.toThrow('ENOENT');
  });

  it('warns when a fixture is truncated', async () => {
    const { warnings } = await testFixtures({ ...config, max_file_chars: 3 });
    expect(warnings.join()).toContain('truncated');
  });
});

describe('a hostile fixtures directory', () => {
  const OUTSIDE = 'links outside the repository';

  it('refuses a fixture linked outside the repository', async () => {
    await writeFile(join(scratch, 'private.ts'), 'const tidy = 1;\n');
    await symlink(join(scratch, 'private.ts'), join(root, LEVELS_DIR, 'good-link.ts'));
    await expect(testFixtures(config)).rejects.toThrow(OUTSIDE);
    expect(asked).toEqual([]);
  });

  it('refuses a question directory linked outside the repository', async () => {
    await mkdir(join(scratch, 'q'));
    await symlink(join(scratch, 'q'), join(root, BOOLEAN_DIR));
    await expect(testFixtures(config)).rejects.toThrow(OUTSIDE);
  });

  it('refuses fixtures linked outside the repository', async () => {
    await rm(join(root, '.jevlint/fixtures'), { recursive: true });
    await symlink(scratch, join(root, '.jevlint/fixtures'));
    await expect(testFixtures(config)).rejects.toThrow(OUTSIDE);
  });

  it('allows a link that stays inside', async () => {
    await write({ 'src/a.ts': 'const tidy = 1;\n' });
    await symlink(join(root, 'src/a.ts'), join(root, LEVELS_DIR, 'good-link.ts'));
    expect((await testFixtures(config)).results).toHaveLength(3);
  });

  it('turns a dangling link into a user error, not a bug report', async () => {
    await symlink(join(scratch, 'missing.ts'), join(root, LEVELS_DIR, 'good-gone.ts'));
    await expect(testFixtures(config)).rejects.toThrow(UserError);
  });

  it('refuses a fixture that is not a regular file', async () => {
    await mkdir(join(root, LEVELS_DIR, 'good-dir.ts'));
    await expect(testFixtures(config)).rejects.toThrow('not a regular file');
  });

  it('keeps fixtures out of file discovery', async () => {
    await write({ 'src/a.ts': 'const a = 1;\n' });
    expect(await discoverFiles(config)).toEqual(['src/a.ts']);
  });
});

describe('--record', () => {
  it('writes provider, model and sorted compliance, the same each time', async () => {
    await testFixtures(config, { record: true });
    const first = await readFile(join(root, '.jevlint/calibration.json'), 'utf8');
    expect(JSON.parse(first)).toEqual({
      provider: 'typesafe',
      model: 'm',
      fixtures: [
        { question: 'house.levels', file: 'bad-one.ts', compliance: 0.2 },
        { question: 'house.levels', file: 'good-one.ts', compliance: 0.9 },
      ],
    });
    await testFixtures(config, { record: true });
    expect(await readFile(join(root, '.jevlint/calibration.json'), 'utf8')).toBe(first);
  });

  it('asks afresh, as a cached answer may be from an older model', async () => {
    await testFixtures(config);
    await testFixtures(config, { record: true });
    expect(asked).toHaveLength(4);
  });

  it('replaces a planted symlink rather than writing through it', async () => {
    const target = join(scratch, 'target.json');
    await writeFile(target, 'untouched');
    await symlink(target, join(root, '.jevlint/calibration.json'));
    await testFixtures(config, { record: true });
    expect(await readFile(target, 'utf8')).toBe('untouched');
    expect((await record()).model).toBe('m');
  });

  it('refuses a linked .jevlint that leads outside, with fixtures linked back in', async () => {
    await write({ 'kept/readable-code.naming/good-a.ts': 'const tidy = 1;\n' });
    await rm(join(root, '.jevlint'), { recursive: true });
    await mkdir(join(scratch, 'dot'));
    await symlink(join(root, 'kept'), join(scratch, 'dot', 'fixtures'));
    await symlink(join(scratch, 'dot'), join(root, '.jevlint'));
    const builtIn = { ...config, presets: ['readable-code'] };
    await expect(testFixtures(builtIn, { record: true })).rejects.toThrow('links outside');
    await expect(readFile(join(scratch, 'dot', 'calibration.json'))).rejects.toThrow('ENOENT');
  });
});

describe('--drift', () => {
  beforeEach(() => testFixtures(config, { record: true }));

  it('reports nothing when answers hold, asking afresh', async () => {
    const { results, warnings } = await testFixtures(config, { drift: true });
    expect(results.map(({ moved }) => moved)).toEqual([false, false]);
    expect(results.map(({ recorded }) => recorded)).toEqual([0.2, 0.9]);
    expect(warnings).toEqual([]);
    expect(asked).toHaveLength(4);
  });

  it('flags a move of the limit or more, even where subtraction falls just short', async () => {
    level = (state) => (state.includes('tidy') ? 8 : 2);
    const { results } = await testFixtures(config, { drift: true });
    expect(results.map(({ file, moved }) => [file, moved])).toEqual([
      ['bad-one.ts', false],
      ['good-one.ts', true],
    ]);
  });

  it('takes the limit from the caller', async () => {
    level = (state) => (state.includes('tidy') ? 8 : 2);
    const { results } = await testFixtures(config, { drift: true, driftLimit: 0.2 });
    expect(results.some(({ moved }) => moved)).toBe(false);
  });

  it('warns when the recorded model differs', async () => {
    useModel('other');
    const { warnings } = await testFixtures(config, { drift: true });
    expect(warnings.join()).toContain(
      'The record is from typesafe m, but this run used typesafe other',
    );
  });

  it('warns about a fixture with no record, and does not call it moved', async () => {
    await write({ [`${LEVELS_DIR}/good-new.ts`]: 'const tidy = 3;\n' });
    const { results, warnings } = await testFixtures(config, { drift: true });
    const added = results.find(({ file }) => file === 'good-new.ts');
    expect(added).toMatchObject({ recorded: null, moved: false });
    expect(warnings.join()).toContain('good-new.ts has no record');
  });

  it('refuses a missing record before asking anything', async () => {
    await rm(join(root, '.jevlint/calibration.json'));
    asked = [];
    await expect(testFixtures(config, { drift: true })).rejects.toThrow('jevlint test --record');
    expect(asked).toEqual([]);
  });

  it.each([
    ['not JSON', '{'],
    ['an unknown key', '{"provider":"p","model":"m","fixtures":[],"extra":1}'],
    ['a wrong type', '{"provider":"p","model":"m","fixtures":"x"}'],
    [
      'compliance out of range',
      '{"provider":"p","model":"m","fixtures":[{"question":"q","file":"f","compliance":2}]}',
    ],
  ])('refuses a record with %s', async (_, text) => {
    await writeFile(join(root, '.jevlint/calibration.json'), text);
    await expect(testFixtures(config, { drift: true })).rejects.toThrow(UserError);
  });

  it('refuses a record linked outside the repository', async () => {
    const path = join(root, '.jevlint/calibration.json');
    await rm(path);
    await writeFile(join(scratch, 'record.json'), '{}');
    await symlink(join(scratch, 'record.json'), path);
    await expect(testFixtures(config, { drift: true })).rejects.toThrow('links outside');
  });
});

describe('the test command', () => {
  const run = async (...rawArgs: string[]) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    try {
      await runCommand(testCommand, { rawArgs });
      const exitCode = process.exitCode;
      return {
        exitCode,
        stdout: log.mock.calls.join('\n'),
        stderr: error.mock.calls.join('\n'),
      };
    } finally {
      process.exitCode = undefined;
      vi.restoreAllMocks();
    }
  };

  beforeEach(() => vi.stubEnv('XDG_CACHE_HOME', scratch));

  it('exits 0 when every fixture passes, prints a table and warns on stderr', async () => {
    await write({ '.jevlint/fixtures/house.gone/good-a.ts': 'const tidy = 1;\n' });
    const { exitCode, stdout, stderr } = await run();
    expect(exitCode).toBeUndefined();
    expect(stderr).toContain('Warning: .jevlint/fixtures/house.gone');
    expect(stdout).toContain('house.levels/good-one.ts');
    expect(stdout).toContain('2 of 2 fixtures passed');
  });

  it('exits 1 when a fixture fails, and prints only JSON on stdout', async () => {
    level = () => 1;
    const { exitCode, stdout } = await run('--json');
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout).results).toHaveLength(2);
  });

  it('exits 1 when a fixture moved, and says so on the warning stream for a new model', async () => {
    await run('--record');
    level = (state) => (state.includes('tidy') ? 7 : 2);
    useModel('other');
    const { exitCode, stdout, stderr } = await run('--drift');
    expect(exitCode).toBe(1);
    expect(stdout).toContain('moved from 0.90');
    expect(stdout).toContain('1 fixture moved');
    expect(stderr).toContain('The record is from');
  });

  it.each([
    [['--record', '--drift'], 'not both'],
    [['--record', 'house.levels'], 'no question ids'],
    [['--drift-limit', '0.2'], 'needs --drift'],
    [['--drift', '--drift-limit', 'x'], 'must be a number'],
  ])('refuses %j', async (args, message) => {
    await expect(run(...args)).rejects.toThrow(message);
  });
});
