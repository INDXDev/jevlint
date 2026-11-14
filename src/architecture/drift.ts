/**
 * `jevlint architecture drift`: finds where the SSOT no longer describes the code, from the AST,
 * then asks the model about stale summaries and documents. See docs/architecture-reference.md#drift.
 */
import { join, posix } from 'node:path';
import { type Config, readRegularFile, UserError } from '../config.ts';
import { decisionRequest } from '../decision/decide.ts';
import { discoverDocs } from '../files.ts';
import { changedSince, fileAt, fileHistory, isShallow, resolveCommit } from '../git.ts';
import { activeQuestions, loadPresets } from '../presets.ts';
import { ask, eachPath, type SpecRun, startRun, usageOf, verdicts } from '../spec/run.ts';
import type {
  ArchitectureComponent,
  ArchitectureDecision,
  ArchitectureDriftReport,
  ArchitectureSsot,
  DriftItem,
  DriftVerdict,
  SpecDocResult,
} from '../types.ts';
import { collect, existsIn, filesOfCommit, lineCountIn } from './collect.ts';
import { assign, componentsTouching, mapEdges, staticDrift } from './conformance.ts';
import { recordVersion } from './load.ts';
import {
  componentOutline,
  DECISION_PRESET,
  DRIFT_PRESET,
  documentItems,
  documentRequest,
  documentState,
  ROUTE,
  routeQuestion,
  STILL_HOLDS,
  stillHoldsState,
  UNCOVERED,
} from './questions.ts';
import { isTypoLevel, documentDrift as ssotDocumentDrift } from './views.ts';

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
  const request = decisionRequest(questions);
  const results = await eachPath(
    run,
    asked.map(({ id }) => id),
    undefined,
    async (id): Promise<DriftItem[]> => {
      const component = asked.find((c) => c.id === id) as ArchitectureComponent;
      const modules = collected.modules.filter(({ path }) => componentOf(path) === id);
      const own: string[] = [];
      const answers = await ask(run, request, componentOutline(component, modules, edges), own);
      // A warning keeps its leading PROVIDER_ERROR, so the command still notices the failure.
      for (const warning of own) {
        const tagged = `${warning} (${id})`;
        if (!warnings.includes(tagged)) warnings.push(tagged);
      }
      const fits = answers ? (Object.values(answers)[0]?.value ?? 1) : 1;
      if (fits >= 0.5) return [];
      return [
        {
          kind: 'stale-summary',
          component: id,
          path: `${ssot.dir}/components/${id}.yaml`,
          message: `the summary may no longer fit the code (${fits.toFixed(2)})`,
        },
      ];
    },
  );
  return results.flat();
}

/**
 * Accepted records whose body changed since the commit that first held them as accepted, by more
 * than typo fixes. A record accepted only in the working tree has nothing to compare with, and in a
 * shallow clone the accepting commit may be missing, so neither counts as an edit.
 */
async function editedDecisions(
  config: Config,
  ssot: ArchitectureSsot,
  warnings: string[],
): Promise<DriftItem[]> {
  const accepted = (ssot.decisions ?? []).filter(({ status }) => status === 'accepted');
  if (accepted.length === 0) return [];
  if (await isShallow(config.root)) {
    warnings.push(
      'This is a shallow clone, so accepted decision records were not compared with the commit that accepted them.',
    );
    return [];
  }
  const items: DriftItem[] = [];
  for (const decision of accepted) {
    const path = posix.join(ssot.dir, 'decisions', `${decision.file}.md`);
    for (const commit of await fileHistory(config.root, path)) {
      const raw = await fileAt(config.root, commit, path);
      const version = raw === undefined ? null : recordVersion(raw);
      if (version?.status !== 'accepted') continue;
      if (!isTypoLevel(version.body, decision.body)) {
        items.push({
          kind: 'edited-decision',
          component: decision.components[0] ?? null,
          path,
          target: decision.id,
          message: `the body of "${decision.title}" changed since commit ${commit.slice(0, 7)} accepted it; write a new record that supersedes it instead`,
        });
      }
      break;
    }
  }
  return items;
}

/**
 * Asks of each stale decision whether the code still follows it, from the outlines of the
 * components it names. One that holds is dropped; a decision about no component stays as it is.
 */
async function confirmStaleDecisions(
  run: SpecRun,
  ssot: ArchitectureSsot,
  collected: Awaited<ReturnType<typeof collect>>,
  items: DriftItem[],
  warnings: string[],
): Promise<DriftItem[]> {
  const questions = activeQuestions(await loadPresets([DECISION_PRESET], run.config.root), {});
  const question = questions.filter(({ id }) => id === STILL_HOLDS);
  if (question.length === 0) return items;
  const request = decisionRequest(question);
  const edges = mapEdges(ssot, collected.modules);
  const { componentOf } = assign(ssot);
  const byId = new Map((ssot.decisions ?? []).map((decision) => [decision.id, decision]));
  const keys = items.map((_, index) => String(index));
  const checked = await eachPath(run, keys, undefined, async (key): Promise<DriftItem[]> => {
    const item = items[Number(key)] as DriftItem;
    const decision = byId.get(item.target ?? '') as ArchitectureDecision | undefined;
    if (item.kind !== 'stale-decision' || !decision) return [item];
    const components = ssot.components.filter(({ id }) => decision.components.includes(id));
    if (components.length === 0) return [item];
    const outlines = components.map((component) =>
      componentOutline(
        component,
        collected.modules.filter(({ path }) => componentOf(path) === component.id),
        edges,
      ),
    );
    const own: string[] = [];
    const answers = await ask(run, request, stillHoldsState(decision, outlines), own);
    for (const warning of own) {
      const tagged = `${warning} (${decision.id})`;
      if (!warnings.includes(tagged)) warnings.push(tagged);
    }
    const holds = answers?.[STILL_HOLDS]?.value;
    if (holds === undefined) return [item];
    if (holds >= 0.5) return [];
    return [
      {
        ...item,
        message: `${item.message} The model doubts it still holds (${holds.toFixed(2)}).`,
      },
    ];
  });
  return checked.flat();
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
  // With no base, nothing is known to have changed, so no chapter is stale for that reason.
  const changed = new Set(base ? history.changed : []);
  const lookup = {
    modules: collected.modules,
    exists: existsIn(config.root),
    lineCount: lineCountIn(config.root),
  };
  items.push(...ssotDocumentDrift(ssot, lookup, changed));
  items.push(...(await editedDecisions(config, ssot, warnings)));
  let docs: SpecDocResult[] = [];
  let run: SpecRun | null = null;
  if (!options.static) {
    run = await startRun(
      config,
      'architecture drift',
      options.noCache,
      'Run: jevlint auth set <provider name>, or pass --static',
    );
    const confirmed = await confirmStaleDecisions(run, ssot, collected, items, warnings);
    items.splice(0, items.length, ...confirmed);
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
