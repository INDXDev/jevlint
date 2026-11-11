/**
 * `jevlint architecture drift`: finds where the SSOT no longer describes the code, from the AST,
 * then asks the model about stale summaries and documents. See docs/architecture-reference.md#drift.
 */
import { join } from 'node:path';
import { type Config, readRegularFile, UserError } from '../config.ts';
import { decideFile } from '../decision/decide.ts';
import { discoverDocs } from '../files.ts';
import { changedSince, resolveCommit } from '../git.ts';
import { activeQuestions, loadPresets } from '../presets.ts';
import { ask, eachPath, type SpecRun, startRun, usageOf, verdicts } from '../spec/run.ts';
import type {
  ArchitectureDriftReport,
  ArchitectureSsot,
  DriftItem,
  DriftVerdict,
  SpecDocResult,
} from '../types.ts';
import { collect, existsIn, filesOfCommit } from './collect.ts';
import { assign, componentsTouching, mapEdges, staticDrift } from './conformance.ts';
import {
  componentOutline,
  DRIFT_PRESET,
  documentItems,
  documentRequest,
  documentState,
  ROUTE,
  routeQuestion,
  UNCOVERED,
} from './questions.ts';

/** Narrows and observes a drift run. */
export interface ArchitectureDriftOptions {
  /** AST only: no stale summaries and no documents. */
  static?: boolean;
  /** Documents to compare with the SSOT. An empty list means `spec.docs`. */
  docs?: string[];
  /** The base to compare with, instead of `compiled_at`. */
  since?: string;
  noCache?: boolean;
  onProgress?: (done: number, total: number, path: string) => void;
}

/** Files added and removed since `base`, and the files that changed, from git. */
async function sinceBase(config: Config, base: string, current: string[]) {
  const before = await filesOfCommit(config, base);
  const known = new Set(before);
  const now = new Set(current);
  const added = current.filter((path) => !known.has(path));
  const changed = [...new Set([...(await changedSince(config.root, base)), ...added])];
  return { added, removed: before.filter((path) => !now.has(path)), changed };
}

/** The base of a drift run: `--since`, else `compiled_at`, as a full hash, or null. */
async function baseOf(
  config: Config,
  ssot: ArchitectureSsot,
  since: string | undefined,
  warnings: string[],
) {
  const named = since ?? ssot.index.compiled_at;
  if (named === undefined) return null;
  try {
    return await resolveCommit(config.root, named);
  } catch (error) {
    if (since !== undefined || !(error instanceof UserError)) throw error;
    warnings.push(
      `compiled_at ${named} is not a commit in this repository, so nothing counts as new.`,
    );
    return null;
  }
}

async function staleSummaries(
  run: SpecRun,
  ssot: ArchitectureSsot,
  collected: Awaited<ReturnType<typeof collect>>,
  components: string[],
  warnings: string[],
): Promise<DriftItem[]> {
  const questions = activeQuestions(await loadPresets([DRIFT_PRESET], run.config.root), {});
  const edges = mapEdges(ssot, collected.modules);
  const { componentOf } = assign(ssot);
  const asked = ssot.components.filter(({ id }) => components.includes(id));
  const results = await Promise.all(
    asked.map(async (component): Promise<DriftItem[]> => {
      const modules = collected.modules.filter(({ path }) => componentOf(path) === component.id);
      try {
        const decision = await decideFile({
          resolved: run.resolved,
          questions,
          source: componentOutline(component, modules, edges),
          config: run.config,
          noCache: run.noCache,
        });
        if (decision.cached) run.cacheHits++;
        else {
          run.modelCalls++;
          run.inputTokens += decision.inputTokens;
        }
        const fits = Object.values(decision.answers)[0]?.value ?? 1;
        if (fits >= 0.5) return [];
        return [
          {
            kind: 'stale-summary',
            component: component.id,
            path: `${ssot.dir}/components/${component.id}.yaml`,
            message: `the summary may no longer fit the code (${fits.toFixed(2)})`,
          },
        ];
      } catch (error) {
        if (error instanceof UserError) throw error;
        warnings.push(`${component.id}: Provider error: ${(error as Error).message}`);
        return [];
      }
    }),
  );
  return results.flat();
}

async function driftDocument(
  run: SpecRun,
  ssot: ArchitectureSsot,
  path: string,
): Promise<SpecDocResult> {
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
  const first = await ask(run, { [ROUTE]: routeQuestion(ssot) }, document, result.warnings);
  const route = first?.[ROUTE];
  if (!route?.choice) return result;
  const component = ssot.components.find(({ id }) => id === route.choice) ?? null;
  const items = documentItems(ssot, component);
  const second = await ask(
    run,
    documentRequest(items),
    documentState(items, path, document),
    result.warnings,
  );
  const base = { ...result, feature: route.choice, featureConfidence: route.value };
  if (!second) return base;
  return {
    ...base,
    items: verdicts<DriftVerdict>(second, items, run.config.spec.threshold),
    uncovered: second[UNCOVERED]?.value ?? null,
  };
}

function documentDrift(docs: SpecDocResult[]): DriftItem[] {
  return docs.flatMap((doc): DriftItem[] => {
    const contradictions = doc.items
      .filter(({ verdict }) => verdict === 'contradicts')
      .map(
        (item): DriftItem => ({
          kind: 'document',
          component: doc.feature === 'global' ? null : doc.feature,
          path: doc.path,
          target: item.id,
          message: `contradicts ${item.id}: ${item.text}`,
        }),
      );
    const uncovered: DriftItem[] =
      (doc.uncovered ?? 0) >= 0.5
        ? [
            {
              kind: 'document',
              component: null,
              path: doc.path,
              message: 'states a structural fact the SSOT leaves out',
            },
          ]
        : [];
    return [...contradictions, ...uncovered];
  });
}

/** Compares the code, and optionally documents, with the SSOT. */
export async function driftArchitecture(
  config: Config,
  ssot: ArchitectureSsot,
  options: ArchitectureDriftOptions = {},
): Promise<ArchitectureDriftReport> {
  const warnings: string[] = [];
  const collected = await collect(config, { skipHistory: true, noCache: options.noCache });
  const base = await baseOf(config, ssot, options.since, warnings);
  const history = base
    ? await sinceBase(config, base, collected.paths)
    : { added: [], removed: [], changed: collected.paths };
  const items = staticDrift(ssot, {
    modules: collected.modules,
    exists: existsIn(config.root),
    added: new Set(history.added),
  });
  let docs: SpecDocResult[] = [];
  let run: SpecRun | null = null;
  if (!options.static) {
    run = await startRun(
      config,
      'architecture drift',
      options.noCache,
      'Run: jevlint auth set <provider name>, or pass --static',
    );
    const touched = componentsTouching(ssot, history.changed);
    items.push(...(await staleSummaries(run, ssot, collected, touched, warnings)));
    if (options.docs) {
      const paths = await discoverDocs(config, options.docs.length > 0 ? options.docs : undefined);
      const active = run;
      docs = await eachPath(active, paths, options.onProgress, (path) =>
        driftDocument(active, ssot, path),
      );
      items.push(...documentDrift(docs));
    }
  }
  return {
    root: config.root,
    dir: ssot.dir,
    provider: run?.resolved.provider ?? null,
    model: run?.resolved.modelId ?? null,
    compiledAt: ssot.index.compiled_at ?? null,
    head: collected.facts.commit,
    items,
    added: history.added,
    removed: history.removed,
    docs,
    usage: run
      ? usageOf(run)
      : { inputTokens: 0, estimatedCostUsd: null, cacheHits: 0, modelCalls: 0 },
    warnings: [...collected.warnings, ...warnings],
  };
}
