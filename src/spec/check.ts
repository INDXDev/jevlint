/** `jevlint spec check`: judges code files against the spec. See docs/spec-reference.md#check. */
import { join } from 'node:path';
import { type Config, readRegularFile } from '../config.ts';
import { parseDirectives } from '../directives.ts';
import { discoverFiles } from '../files.ts';
import { scaleScore } from '../scoring.ts';
import type { CheckVerdict, Spec, SpecCheckReport, SpecFileResult, SpecItemRef } from '../types.ts';
import { checkRequest, itemRefs, ROUTE, routeQuestion } from './questions.ts';
import {
  ask,
  eachPath,
  type SpecRun,
  type SpecRunOptions,
  startRun,
  usageOf,
  verdicts,
} from './run.ts';

export type { SpecRunOptions } from './run.ts';

function scoreOf(items: SpecFileResult['items'], config: Config): number | null {
  const satisfied = items.filter(({ verdict }) => verdict === 'satisfies').length;
  const judged = satisfied + items.filter(({ verdict }) => verdict === 'violates').length;
  return judged === 0 ? null : scaleScore(satisfied / judged, config.scoring);
}

async function checkFile(run: SpecRun, spec: Spec, path: string): Promise<SpecFileResult> {
  const { config } = run;
  const result: SpecFileResult = {
    path,
    feature: null,
    featureConfidence: null,
    score: null,
    items: [],
    warnings: [],
  };
  let raw: string;
  try {
    raw = await readRegularFile(join(config.root, path));
  } catch (error) {
    return { ...result, warnings: [`Could not read file: ${(error as Error).message}`] };
  }
  const source = parseDirectives(raw, config.scoring.scale).code;
  const project = itemRefs(null, spec.index.checklist);
  const request = { [ROUTE]: routeQuestion(spec, 'file'), ...checkRequest(null, project) };
  const first = await ask(run, request, source, result.warnings);
  if (!first) return result;
  const items = verdicts<CheckVerdict>(first, project, config.spec.threshold);
  result.feature = first[ROUTE]?.choice ?? null;
  result.featureConfidence = first[ROUTE]?.value ?? null;
  const feature = spec.features.find(({ id }) => id === result.feature);
  if (feature) {
    const own = itemRefs(feature, feature.checklist);
    const second = await ask(run, checkRequest(feature, own), source, result.warnings);
    if (second) items.push(...verdicts<CheckVerdict>(second, own, config.spec.threshold));
  }
  return { ...result, items, score: scoreOf(items, config) };
}

function allItems(spec: Spec): SpecItemRef[] {
  return [
    ...itemRefs(null, spec.index.checklist),
    ...spec.features.flatMap((feature) => itemRefs(feature, feature.checklist)),
  ];
}

function byViolationsThenScore(a: SpecFileResult, b: SpecFileResult): number {
  const violations = (file: SpecFileResult) =>
    file.items.filter(({ verdict }) => verdict === 'violates').length;
  return (
    violations(b) - violations(a) ||
    (a.score ?? Infinity) - (b.score ?? Infinity) ||
    a.path.localeCompare(b.path)
  );
}

/** Judges every code file, or only `options.paths`, against the spec. */
export async function checkSpec(
  config: Config,
  spec: Spec,
  options: SpecRunOptions = {},
): Promise<SpecCheckReport> {
  const run = await startRun(config, 'check', options.noCache);
  const paths = await discoverFiles(config, options.paths);
  const files = await eachPath(run, paths, options.onProgress, (path) =>
    checkFile(run, spec, path),
  );
  const results = files.flatMap(({ items }) => items);
  const satisfied = new Set(results.filter((r) => r.verdict === 'satisfies').map(({ id }) => id));
  const complete = !options.paths;
  return {
    root: config.root,
    specDir: spec.dir,
    provider: run.resolved.provider,
    model: run.resolved.modelId,
    scale: config.scoring.scale,
    complete,
    files: files.toSorted(byViolationsThenScore),
    violations: results.filter(({ verdict }) => verdict === 'violates').length,
    unimplemented: complete ? allItems(spec).filter(({ id }) => !satisfied.has(id)) : [],
    usage: usageOf(run),
    warnings: [],
  };
}
