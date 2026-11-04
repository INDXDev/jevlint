/** Reviews a change: audits its files on both sides and keeps what it made worse. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type AuditOptions, audit } from './audit.ts';
import { type Config, writeFileAtomic } from './config.ts';
import { changedFiles, fileAt } from './git.ts';
import { judgeIntent } from './intent.ts';
import { WEAK_COMPLIANCE } from './scoring.ts';
import type {
  AstFinding,
  AuditReport,
  Change,
  ChangedFile,
  ChangeReview,
  FileReport,
  ModelAnswer,
} from './types.ts';

// A crafted tree can hold these names. `.git` would make the snapshot a repository with its config,
// `..` would write outside it, and `.gitignore` would let a change hide its own files.
const UNSAFE_PATH = /(^|\/)(\.\.|\.git|\.gitignore)(\/|$)/i;

/**
 * Audits files as they were at a commit, leaving the working tree alone. The config stays the
 * caller's, so a change cannot rewrite the rules it is judged by.
 */
async function auditAt(
  config: Config,
  commit: string,
  paths: string[],
  options: AuditOptions,
): Promise<AuditReport> {
  const root = await mkdtemp(join(tmpdir(), 'jevlint-review-'));
  try {
    for (const path of paths) {
      // shortcut: a blob a partial clone lacks reads as absent, so such a file looks new; use a full clone.
      const source = await fileAt(config.root, commit, path);
      if (source === undefined) continue;
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFileAtomic(join(root, path), source);
    }
    return await audit({ ...config, root }, { ...options, presetsRoot: config.root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Matches by rule and symbol, not by line or message, so moved or improved findings drop out. */
export function worseFindings(
  after: AstFinding[],
  before: Pick<AstFinding, 'rule' | 'symbol' | 'value'>[],
): AstFinding[] {
  const unmatched = [...before];
  return after.filter((finding) => {
    const index = unmatched.findIndex(
      ({ rule, symbol, value = 0 }) =>
        rule === finding.rule && symbol === finding.symbol && value >= (finding.value ?? 0),
    );
    if (index === -1) return true;
    unmatched.splice(index, 1);
    return false;
  });
}

/** Keeps unpinned weak answers that dropped. With no earlier answer, every one of them counts. */
export function worseAnswers(
  after: ModelAnswer[],
  before: Pick<ModelAnswer, 'id' | 'compliance'>[],
): ModelAnswer[] {
  const compliance = new Map(before.map(({ id, compliance }) => [id, compliance]));
  return after.filter(
    ({ id, compliance: now, pin }) =>
      !pin && now < WEAK_COMPLIANCE && now < (compliance.get(id) ?? 1),
  );
}

function compareFile(after: FileReport, before: FileReport | undefined): ChangedFile {
  return {
    path: after.path,
    before: before?.score ?? null,
    after: after.score,
    findings: worseFindings(after.ast?.findings ?? [], before?.ast?.findings ?? []),
    answers: worseAnswers(after.model?.answers ?? [], before?.model?.answers ?? []),
    warnings: after.warnings,
  };
}

function addUsage(a: AuditReport['usage'], b: AuditReport['usage']): AuditReport['usage'] {
  const { estimatedCostUsd: costA } = a;
  const { estimatedCostUsd: costB } = b;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    estimatedCostUsd: costA === null || costB === null ? (costA ?? costB) : costA + costB,
    cacheHits: a.cacheHits + b.cacheHits,
    modelCalls: a.modelCalls + b.modelCalls,
  };
}

/** Narrows and observes a change's review. */
export interface ChangeReviewOptions extends AuditOptions {
  /** Also judges the change against its message and the repository's instructions. */
  intent?: boolean;
}

/** Compares a change's added and modified files between its two commits. */
export async function reviewChange(
  config: Config,
  change: Change,
  { intent, ...options }: ChangeReviewOptions = {},
): Promise<ChangeReview> {
  const paths = (await changedFiles(config.root, change)).filter((path) => !UNSAFE_PATH.test(path));
  const after = await auditAt(config, change.head, paths, options);
  const before = change.base ? await auditAt(config, change.base, paths, options) : null;
  const review = compareReports(change, after, before);
  if (!intent) return review;
  const judged = await judgeIntent(config, change, options.noCache);
  if (!judged) return review;
  return {
    ...review,
    usage: addUsage(review.usage, judged.usage),
    intent: judged.answers,
    warnings: judged.warnings,
  };
}

/** Compares a root-relative file on disk with HEAD. Null if it is excluded or cannot be scored. */
export async function reviewFile(
  config: Config,
  path: string,
  options: AuditOptions = {},
): Promise<ChangeReview | null> {
  if (UNSAFE_PATH.test(path)) return null;
  const after = await audit(config, { ...options, paths: [path] });
  if (after.files.length === 0) return null;
  const before = await auditAt(config, 'HEAD', [path], options);
  return compareReports({ title: `Edited ${path}`, base: 'HEAD', head: path }, after, before);
}

/** True when a review found anything the change made worse. */
export const madeWorse = ({ files }: ChangeReview) =>
  files.some(({ findings, answers }) => findings.length > 0 || answers.length > 0);

function compareReports(
  change: Change,
  after: AuditReport,
  before: AuditReport | null,
): ChangeReview {
  const beforeByPath = new Map(before?.files.map((file) => [file.path, file]));
  const { title, base, head } = change;
  return {
    title,
    base,
    head,
    provider: after.provider,
    model: after.model,
    scale: after.scale,
    files: after.files.map((file) => compareFile(file, beforeByPath.get(file.path))),
    skipped: after.skipped,
    usage: before ? addUsage(after.usage, before.usage) : after.usage,
  };
}
