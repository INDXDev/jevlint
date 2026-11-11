/** Proves that preset questions work on known files, and notices when a model moves them. */
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import pLimit from 'p-limit';
import { z } from 'zod';
import { ARCHITECTURE_PRESETS } from './architecture/questions.ts';
import type { AuditOptions } from './audit.ts';
import {
  type Config,
  ifExists,
  parseWith,
  readRegularFile,
  UserError,
  writeFileAtomic,
} from './config.ts';
import { decideFile } from './decision/decide.ts';
import { estimateCostUsd } from './decision/pricing.ts';
import { createDecisionModel, type ResolvedModel } from './decision/providers.ts';
import { parseDirectives } from './directives.ts';
import { activeQuestions, assertInRepo, loadPresets } from './presets.ts';
import { modelResult, WEAK_COMPLIANCE } from './scoring.ts';
import type { AuditReport, Question } from './types.ts';

const FIXTURE_NAME = /^(good|bad)-.+\.[^.]+$/;
/** Subtraction leaves stray last bits, which must not decide a move of exactly the limit. */
const DRIFT_PRECISION = 9;

/** How far a fixture's compliance may move before `--drift` reports it. */
export const DEFAULT_DRIFT_LIMIT = 0.1;

const fixturesDir = (root: string) => join(root, '.jevlint', 'fixtures');
const calibrationPath = (root: string) => join(root, '.jevlint', 'calibration.json');

const calibrationSchema = z.strictObject({
  provider: z.string(),
  model: z.string(),
  fixtures: z.array(
    z.strictObject({
      question: z.string(),
      file: z.string(),
      compliance: z.number().min(0).max(1),
    }),
  ),
});

type Calibration = z.infer<typeof calibrationSchema>;

/** What is known about a fixture before a model sees it. */
interface Fixture {
  /** Full id: `<preset>.<id>`. */
  question: string;
  /** File name in the question's directory. */
  file: string;
  expected: 'good' | 'bad';
}

interface LoadedFixture extends Fixture {
  source: string;
}

/** One fixture's outcome. */
export interface FixtureResult extends Fixture {
  /** 0 (worst) to 1 (best). */
  compliance: number;
  /** A good fixture passes at or above `WEAK_COMPLIANCE`, and a bad one below it. */
  passed: boolean;
  /** With `--drift`: the recorded compliance, or null for a fixture with no record. */
  recorded?: number | null;
  /** With `--drift`: whether it moved by the limit or more. */
  moved?: boolean;
}

/** Everything one `jevlint test` run found. */
export interface FixtureReport {
  provider: string;
  model: string;
  /** Sorted by question, then by file. */
  results: FixtureResult[];
  warnings: string[];
  usage: AuditReport['usage'];
}

/** Narrows a run, and says what to do with its results. */
export interface FixtureOptions {
  /** Tests only these questions. Defaults to every question with fixtures. */
  questionIds?: string[];
  /** Writes the results to `.jevlint/calibration.json`. */
  record?: boolean;
  /** Compares fresh answers with the record. */
  drift?: boolean;
  driftLimit?: number;
  onProgress?: AuditOptions['onProgress'];
}

interface Run {
  config: Config;
  resolved: ResolvedModel;
  noCache: boolean;
}

interface Asked {
  result: FixtureResult;
  cached: boolean;
  inputTokens: number;
  truncated: boolean;
}

const fixtureKey = ({ question, file }: Pick<Fixture, 'question' | 'file'>) =>
  `${question}/${file}`;

/** The repository is hostile: a link must not lead out of it, nor a dangling one end as a bug. */
async function readFixture(root: string, path: string): Promise<string> {
  try {
    await assertInRepo(path, root);
    return await readRegularFile(path);
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(`Could not read ${path}: ${(error as Error).message}`);
  }
}

async function loadQuestionFixtures(config: Config, question: string): Promise<LoadedFixture[]> {
  const dir = join(fixturesDir(config.root), question);
  await assertInRepo(dir, config.root);
  const fixtures: LoadedFixture[] = [];
  for (const file of (await readdir(dir).catch(() => [])).sort()) {
    const expected = file.match(FIXTURE_NAME)?.[1] as Fixture['expected'] | undefined;
    if (!expected) continue;
    const path = join(dir, file);
    const text = await readFixture(config.root, path);
    // Audit sends a file without its pins, so a fixture is asked about the same way.
    const { code } = parseDirectives(text, config.scoring.scale);
    if (code.trim() === '') throw new UserError(`Fixture ${path} is empty.`);
    fixtures.push({ question, file, expected, source: code });
  }
  return fixtures;
}

async function loadFixtures(config: Config, active: Question[], selected: Question[]) {
  const dir = fixturesDir(config.root);
  await ifExists(assertInRepo(dir, config.root));
  const entries = ((await ifExists(readdir(dir))) ?? []).sort();
  const known = new Set(active.map(({ id }) => id));
  const wanted = new Set(selected.map(({ id }) => id));
  const fixtures: LoadedFixture[] = [];
  for (const entry of entries.filter((name) => wanted.has(name))) {
    fixtures.push(...(await loadQuestionFixtures(config, entry)));
  }
  const warnings = entries
    .filter((name) => !known.has(name))
    .map((name) => `.jevlint/fixtures/${name} matches no active question, so it was ignored.`);
  return { fixtures, warnings };
}

function selectQuestions(active: Question[], ids: string[]): Question[] {
  const unknown = ids.find((id) => !active.some((question) => question.id === id));
  if (unknown !== undefined) {
    throw new UserError(`Unknown question "${unknown}". Name an active one, as <preset>.<id>.`);
  }
  return ids.length > 0 ? active.filter(({ id }) => ids.includes(id)) : active;
}

function assertFixturesFor(ids: string[], fixtures: Fixture[]): void {
  const bare = ids.find((id) => !fixtures.some(({ question }) => question === id));
  if (bare !== undefined) throw new UserError(`No fixtures for ${bare}.`);
  if (fixtures.length === 0) {
    throw new UserError(
      'No fixtures to test. Add .jevlint/fixtures/<preset>.<question>/good-*.<ext> and bad-*.<ext>.',
    );
  }
}

/** The record comes from the repository, so it gets the same distrust as a preset. */
async function readCalibration(root: string): Promise<Calibration> {
  const path = calibrationPath(root);
  await ifExists(assertInRepo(path, root));
  const text = await ifExists(readRegularFile(path));
  if (text === undefined) {
    throw new UserError('No calibration record to compare with. Run: jevlint test --record');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new UserError(`${path} is not valid JSON.`);
  }
  return parseWith(calibrationSchema, raw, path);
}

async function writeCalibration(root: string, report: FixtureReport): Promise<void> {
  const path = calibrationPath(root);
  // A fixture was read, so `.jevlint` exists, but its `fixtures` may be a link back in from outside.
  await assertInRepo(dirname(path), root);
  const { provider, model, results } = report;
  const fixtures = results.map(({ question, file, compliance }) => ({
    question,
    file,
    compliance,
  }));
  const calibration: Calibration = { provider, model, fixtures };
  // Atomic, so a symlink planted at the destination is replaced rather than written through.
  await writeFileAtomic(path, `${JSON.stringify(calibration, null, 2)}\n`);
}

function compareWithRecord(
  results: FixtureResult[],
  calibration: Calibration,
  limit: number,
): FixtureResult[] {
  const record = new Map(calibration.fixtures.map((entry) => [fixtureKey(entry), entry]));
  return results.map((result) => {
    const recorded = record.get(fixtureKey(result))?.compliance ?? null;
    if (recorded === null) return { ...result, recorded, moved: false };
    const distance = Math.abs(result.compliance - recorded);
    return { ...result, recorded, moved: Number(distance.toFixed(DRIFT_PRECISION)) >= limit };
  });
}

function driftWarnings(
  results: FixtureResult[],
  { provider, model }: Calibration,
  resolved: ResolvedModel,
): string[] {
  const sameModel = provider === resolved.provider && model === resolved.modelId;
  const used = `${resolved.provider} ${resolved.modelId}`;
  const unrecorded = results
    .filter(({ recorded }) => recorded === null)
    .map((result) => `${fixtureKey(result)} has no record. Run: jevlint test --record`);
  return [
    ...(sameModel ? [] : [`The record is from ${provider} ${model}, but this run used ${used}.`]),
    ...unrecorded,
  ];
}

async function askFixture(
  { source, ...fixture }: LoadedFixture,
  question: Question,
  { config, resolved, noCache }: Run,
): Promise<Asked> {
  try {
    const questions = [question];
    const decision = await decideFile({ resolved, questions, source, config, noCache });
    const { cached, inputTokens, truncated } = decision;
    const compliance = modelResult(questions, decision).answers[0]?.compliance as number;
    const passed = compliance >= WEAK_COMPLIANCE === (fixture.expected === 'good');
    return { result: { ...fixture, compliance, passed }, cached, inputTokens, truncated };
  } catch (error) {
    if (error instanceof UserError) throw error;
    // A failed request says nothing about the question, and a partial record would mislead.
    throw new UserError(`Provider error on ${fixtureKey(fixture)}: ${(error as Error).message}`);
  }
}

async function askAll(
  fixtures: LoadedFixture[],
  questions: Question[],
  run: Run,
  onProgress: FixtureOptions['onProgress'],
): Promise<Asked[]> {
  const limit = pLimit(run.config.concurrency);
  let done = 0;
  const askOne = async (fixture: LoadedFixture) => {
    const question = questions.find(({ id }) => id === fixture.question) as Question;
    try {
      const asked = await askFixture(fixture, question, run);
      onProgress?.(++done, fixtures.length, fixtureKey(fixture));
      return asked;
    } catch (error) {
      // The run is over, so queued fixtures must not spend more provider calls.
      limit.clearQueue();
      throw error;
    }
  };
  return Promise.all(fixtures.map((fixture) => limit(() => askOne(fixture))));
}

function usageOf(asked: Asked[], resolved: ResolvedModel): AuditReport['usage'] {
  const fresh = asked.filter(({ cached }) => !cached);
  const inputTokens = fresh.reduce((sum, { inputTokens }) => sum + inputTokens, 0);
  return {
    inputTokens,
    estimatedCostUsd: estimateCostUsd(inputTokens, resolved),
    cacheHits: asked.length - fresh.length,
    modelCalls: fresh.length,
  };
}

/** Asks each fixture's one question, then records the results or compares them with the record. */
export async function testFixtures(
  config: Config,
  options: FixtureOptions = {},
): Promise<FixtureReport> {
  const { questionIds = [], record, drift, driftLimit = DEFAULT_DRIFT_LIMIT, onProgress } = options;
  const { root } = config;
  // The architecture review asks its presets whatever `presets` says, so their questions are active.
  const names = [...new Set([...config.presets, ...ARCHITECTURE_PRESETS])];
  const active = activeQuestions(await loadPresets(names, root), config.weights);
  const selected = selectQuestions(active, questionIds);
  const { fixtures, warnings } = await loadFixtures(config, active, selected);
  assertFixturesFor(questionIds, fixtures);
  const calibration = drift ? await readCalibration(root) : null;
  const resolved = await createDecisionModel(config);
  if (!resolved) {
    const { name } = config.provider;
    throw new UserError(
      `No API key found for ${name}, and fixtures need a model. Run: jevlint auth set ${name}`,
    );
  }
  // A cached answer is from the model as it was then, and an id such as `jev-latest` can move.
  const noCache = Boolean(drift || record);
  const asked = await askAll(fixtures, selected, { config, resolved, noCache }, onProgress);
  const answered = asked.map(({ result }) => result);
  const results = calibration ? compareWithRecord(answered, calibration, driftLimit) : answered;
  const truncated = asked
    .filter(({ truncated }) => truncated)
    .map(
      ({ result }) =>
        `${fixtureKey(result)} was truncated: the model saw only the first ${config.max_file_chars} characters.`,
    );
  const report: FixtureReport = {
    provider: resolved.provider,
    model: resolved.modelId,
    results,
    warnings: [
      ...warnings,
      ...truncated,
      ...(calibration ? driftWarnings(results, calibration, resolved) : []),
    ],
    usage: usageOf(asked, resolved),
  };
  if (record) await writeCalibration(root, report);
  return report;
}
