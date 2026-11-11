/** `jevlint spec drift`: compares documents with the spec. See docs/spec-reference.md#drift. */
import { join } from 'node:path';
import { type Config, readRegularFile } from '../config.ts';
import { discoverDocs } from '../files.ts';
import type { DriftVerdict, Spec, SpecDocResult, SpecDriftReport, SpecFeature } from '../types.ts';
import { GLOBAL } from './load.ts';
import {
  driftRequest,
  driftState,
  itemRefs,
  ROUTE,
  routeQuestion,
  UNCOVERED,
} from './questions.ts';
import {
  ask,
  eachPath,
  type SpecRun,
  type SpecRunOptions,
  startRun,
  usageOf,
  verdicts,
} from './run.ts';

/** Every checklist with the id documents are routed to it by: `global` first, then each feature. */
function checklists(spec: Spec): { route: string; feature: SpecFeature | null }[] {
  return [
    { route: GLOBAL, feature: null },
    ...spec.features.map((feature) => ({ route: feature.id, feature })),
  ];
}

async function driftDoc(run: SpecRun, spec: Spec, path: string): Promise<SpecDocResult> {
  const result: SpecDocResult = {
    path,
    feature: null,
    featureConfidence: null,
    items: [],
    uncovered: null,
    warnings: [],
  };
  let document: string;
  try {
    document = await readRegularFile(join(run.config.root, path));
  } catch (error) {
    return { ...result, warnings: [`Could not read file: ${(error as Error).message}`] };
  }
  const first = await ask(
    run,
    { [ROUTE]: routeQuestion(spec, 'document') },
    document,
    result.warnings,
  );
  const route = first?.[ROUTE];
  if (!route?.choice) return result;
  result.feature = route.choice;
  result.featureConfidence = route.value;
  const feature = spec.features.find(({ id }) => id === route.choice) ?? null;
  const items = itemRefs(feature, feature?.checklist ?? spec.index.checklist);
  const others = checklists(spec)
    .filter((list) => list.route !== route.choice)
    .flatMap((list) => itemRefs(list.feature, list.feature?.checklist ?? spec.index.checklist));
  const state = driftState(feature, items, others, path, document);
  const second = await ask(run, driftRequest(items), state, result.warnings);
  if (!second) return result;
  return {
    ...result,
    items: verdicts<DriftVerdict>(second, items, run.config.spec.threshold),
    uncovered: second[UNCOVERED]?.value ?? null,
  };
}

/** Items no document routed to their checklist mentions, and features no document is routed to. */
function gaps(spec: Spec, docs: SpecDocResult[]) {
  const unbacked = checklists(spec).flatMap(({ route, feature }) => {
    const routed = docs.filter((doc) => doc.feature === route);
    const backed = (id: string) =>
      routed.some((doc) => doc.items.some((item) => item.id === id && item.verdict !== 'absent'));
    return itemRefs(feature, feature?.checklist ?? spec.index.checklist).filter(
      ({ id }) => !backed(id),
    );
  });
  const routes = new Set(docs.map(({ feature }) => feature));
  const undocumented = spec.features.map(({ id }) => id).filter((id) => !routes.has(id));
  return { unbacked, undocumented };
}

/** Compares every document, or only `options.paths`, with the spec. */
export async function driftSpec(
  config: Config,
  spec: Spec,
  options: SpecRunOptions = {},
): Promise<SpecDriftReport> {
  const run = await startRun(config, 'spec drift', options.noCache);
  const paths = await discoverDocs(config, options.paths);
  const accepted = new Map(spec.index.accept_uncovered.map(({ path, reason }) => [path, reason]));
  const docs = (
    await eachPath(run, paths, options.onProgress, (path) => driftDoc(run, spec, path))
  ).map((doc) => {
    const reason = accepted.get(doc.path);
    return reason === undefined ? doc : { ...doc, uncoveredAccepted: reason };
  });
  const complete = !options.paths;
  // Only a full run sees every document, so only it can tell an entry is stale.
  const stale = complete
    ? [...accepted.keys()].filter((path) => !docs.some((doc) => doc.path === path))
    : [];
  const { unbacked, undocumented } = complete
    ? gaps(spec, docs)
    : { unbacked: [], undocumented: [] };
  return {
    root: config.root,
    specDir: spec.dir,
    provider: run.resolved.provider,
    model: run.resolved.modelId,
    complete,
    docs,
    contradictions: docs.flatMap(({ items }) => items).filter((i) => i.verdict === 'contradicts')
      .length,
    uncovered: docs
      .filter((doc) => (doc.uncovered ?? 0) >= 0.5 && doc.uncoveredAccepted === undefined)
      .map(({ path }) => path),
    unbacked,
    undocumented,
    usage: usageOf(run),
    warnings: stale.map((path) => `accept_uncovered names ${path}, which is not a document`),
  };
}
