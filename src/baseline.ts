/** Records what a repository already has wrong, so a gate can judge only what is new. */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ifExists, parseWith, readRegularFile, UserError, writeFileAtomic } from './config.ts';
import { assertInRepo } from './presets.ts';
import { worseAnswers, worseFindings } from './review.ts';
import type { AuditReport, FileReport } from './types.ts';

/** Where a baseline lives, relative to the root. */
export const BASELINE_PATH = join('.jevlint', 'baseline.json');

// A list rather than a table keyed by path, so that no path can collide with an object's own keys.
const baselineSchema = z.strictObject({
  files: z.array(
    z.strictObject({
      path: z.string(),
      findings: z.array(
        z.strictObject({
          rule: z.string(),
          symbol: z.string().optional(),
          value: z.number().optional(),
        }),
      ),
      answers: z.array(z.strictObject({ id: z.string(), compliance: z.number() })),
    }),
  ),
});

/** The findings and weak answers a repository had when its baseline was taken. */
export type Baseline = z.infer<typeof baselineSchema>;

/** Sorts by serialized text, which starts with each item's first key. Locale plays no part. */
const stableOrder = <T>(items: T[]): T[] =>
  items.toSorted((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));

function baselineEntry({ path, ast, model }: FileReport): Baseline['files'][number] {
  const findings = (ast?.findings ?? []).map(({ rule, symbol, value }) => ({
    rule,
    symbol,
    value,
  }));
  const answers = worseAnswers(model?.answers ?? [], []);
  return {
    path,
    findings: stableOrder(findings),
    answers: stableOrder(answers.map(({ id, compliance }) => ({ id, compliance }))),
  };
}

/** Builds a baseline from an audit. Stable, so that an unchanged repository rewrites the same file. */
export function toBaseline(report: AuditReport): Baseline {
  const files = report.files
    .map(baselineEntry)
    .filter(({ findings, answers }) => findings.length > 0 || answers.length > 0);
  return { files: stableOrder(files) };
}

/** Writes a baseline under `root`. */
export async function writeBaseline(root: string, baseline: Baseline): Promise<void> {
  const dir = join(root, '.jevlint');
  // Checked first as well, so that a linked `.jevlint` gets no directory outside the repository.
  await ifExists(assertInRepo(dir, root));
  await mkdir(dir, { recursive: true }).catch((error: Error) => {
    // A dangling link gets here too, as `assertInRepo` cannot resolve it.
    throw new UserError(`Could not create ${dir}: ${error.message}`);
  });
  await assertInRepo(dir, root);
  await writeFileAtomic(join(root, BASELINE_PATH), `${JSON.stringify(baseline, null, 2)}\n`);
}

function parseBaseline(text: string, file: string): Baseline {
  try {
    return parseWith(baselineSchema, JSON.parse(text), file);
  } catch (error) {
    if (error instanceof UserError) throw error;
    // JSON.parse quotes the text it choked on, which has no place in a CI log.
    throw new UserError(`${file}: invalid JSON`);
  }
}

/** Reads the baseline under `root`, which is a repository file and so is not trusted. */
export async function readBaseline(root: string): Promise<Baseline> {
  const file = join(root, BASELINE_PATH);
  const read = assertInRepo(file, root).then(() => readRegularFile(file));
  const text = await ifExists(read).catch((error: Error) => {
    if (error instanceof UserError) throw error;
    throw new UserError(`Could not read ${file}: ${error.message}`);
  });
  if (text === undefined) {
    throw new UserError(`No baseline at ${BASELINE_PATH}. Run: jevlint baseline`);
  }
  return parseBaseline(text, file);
}

/**
 * Keeps the report's shape and totals, with `files` narrowed to what is new or worse than the
 * baseline. A pinned file is settled, as everywhere else: `--ignore-pins` gates on it anyway.
 */
export function newIssues(report: AuditReport, baseline: Baseline): AuditReport {
  const known = new Map(baseline.files.map((file) => [file.path, file]));
  const files = report.files
    .filter(({ pin }) => !pin)
    .map((file) => {
      const before = known.get(file.path);
      const { ast, model } = file;
      return {
        ...file,
        ast: ast && { ...ast, findings: worseFindings(ast.findings, before?.findings ?? []) },
        model: model && { ...model, answers: worseAnswers(model.answers, before?.answers ?? []) },
      };
    })
    .filter(({ ast, model }) => ast?.findings.length || model?.answers.length);
  return { ...report, files };
}
