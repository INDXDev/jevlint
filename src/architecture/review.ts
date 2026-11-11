/** Runs the architecture review: extract, build graphs, ask the model per perspective, score. */
import { posix } from 'node:path';
import pLimit from 'p-limit';
import { type Config, UserError } from '../config.ts';
import { decideFile } from '../decision/decide.ts';
import { estimateCostUsd } from '../decision/pricing.ts';
import { createDecisionModel, type ResolvedModel } from '../decision/providers.ts';
import { activeQuestions, loadPresets } from '../presets.ts';
import { astScoreFrom, fileScore, modelResult, repoScore, scaleScore } from '../scoring.ts';
import type {
  ArchitectureReport,
  ArchitectureSsot,
  ArchitectureUnit,
  FactModule,
  ModelResult,
  Perspective,
  Question,
} from '../types.ts';
import { collect } from './collect.ts';
import { assign, mapEdges } from './conformance.ts';
import { loadArchitecture } from './load.ts';
import { type Subject, subjectsOf } from './outline.ts';
import { componentOutline, designState } from './questions.ts';
import { buildStructure } from './structure.ts';

/** The preset whose questions are asked of each kind of unit. */
const PRESETS: Record<Perspective, string> = {
  codebase: 'architecture-codebase',
  directory: 'architecture-directory',
  class: 'architecture-class',
  component: 'architecture-component',
  design: 'architecture-design',
};

/** Every perspective, broadest first. */
export const PERSPECTIVES = Object.keys(PRESETS) as Perspective[];

/** The perspectives that review the SSOT, which need one. */
export const SSOT_PERSPECTIVES: Perspective[] = ['component', 'design'];

/** Narrows and observes a review. */
export interface ReviewOptions {
  paths?: string[];
  astOnly?: boolean;
  noCache?: boolean;
  /** Reviews only these. Defaults to all of them, leaving out the SSOT's when there is none. */
  perspectives?: Perspective[];
  /** The SSOT to review. Undefined loads it, and null reviews only the structure. */
  ssot?: ArchitectureSsot | null;
  onProgress?: (done: number, total: number, path: string) => void;
}

interface Run {
  config: Config;
  resolved: ResolvedModel | null;
  questions: Map<Perspective, Question[]>;
  noCache?: boolean;
}

async function askModel(
  { perspective, outline }: Subject,
  { config, resolved, questions, noCache }: Run,
): Promise<{ model: ModelResult | null; warnings: string[] }> {
  const asked = questions.get(perspective) ?? [];
  if (!resolved || asked.length === 0 || outline === null) return { model: null, warnings: [] };
  try {
    const decision = await decideFile({
      resolved,
      questions: asked,
      source: outline,
      config,
      noCache,
    });
    const warnings = decision.truncated
      ? [`Outline truncated: the model saw only the first ${config.max_file_chars} characters.`]
      : [];
    return { model: modelResult(asked, decision), warnings };
  } catch (error) {
    if (error instanceof UserError) throw error;
    return { model: null, warnings: [`Provider error: ${(error as Error).message}`] };
  }
}

async function scoreSubject(subject: Subject, run: Run): Promise<ArchitectureUnit> {
  const { outline, findings, ...identity } = subject;
  const ast = { score: astScoreFrom(findings), findings };
  const opinion = await askModel(subject, run);
  const score = fileScore(ast.score, opinion.model?.score ?? null, run.config.scoring) ?? ast.score;
  return { ...identity, score, ast, ...opinion };
}

async function scoreSubjects(
  subjects: Subject[],
  run: Run,
  onProgress: ReviewOptions['onProgress'],
): Promise<ArchitectureUnit[]> {
  const limit = pLimit(run.config.concurrency);
  let done = 0;
  const scoreOne = async (subject: Subject) => {
    const unit = await scoreSubject(subject, run);
    onProgress?.(++done, subjects.length, subject.name);
    return unit;
  };
  return Promise.all(subjects.map((subject) => limit(() => scoreOne(subject))));
}

function usageOf(
  units: ArchitectureUnit[],
  resolved: ResolvedModel | null,
): ArchitectureReport['usage'] {
  const models = units.flatMap(({ model }) => model ?? []);
  const fresh = models.filter(({ cached }) => !cached);
  const inputTokens = fresh.reduce((sum, unit) => sum + unit.inputTokens, 0);
  return {
    inputTokens,
    estimatedCostUsd: resolved && estimateCostUsd(inputTokens, resolved),
    cacheHits: models.length - fresh.length,
    modelCalls: fresh.length,
  };
}

/** One unit per SSOT component, and one for the design as a whole. Neither sends code. */
function ssotSubjects(ssot: ArchitectureSsot, modules: FactModule[]): Subject[] {
  const { componentOf } = assign(ssot);
  const edges = mapEdges(ssot, modules);
  const components = ssot.components.map((component): Subject => {
    const owned = modules.filter(({ path }) => componentOf(path) === component.id);
    return {
      perspective: 'component',
      name: component.id,
      path: posix.join(ssot.dir, 'components', `${component.id}.yaml`),
      line: 1,
      lines: owned.reduce((sum, { lines }) => sum + lines, 0),
      findings: [],
      outline: componentOutline(component, owned, edges),
    };
  });
  const design: Subject = {
    perspective: 'design',
    name: 'design',
    path: posix.join(ssot.dir, 'index.yaml'),
    line: 1,
    lines: modules.reduce((sum, { lines }) => sum + lines, 0),
    findings: [],
    outline: designState(ssot),
  };
  return [...components, design];
}

async function loadQuestions(config: Config, perspectives: Perspective[]) {
  const entries = perspectives.map(async (perspective) => {
    const presets = await loadPresets([PRESETS[perspective]], config.root);
    return [perspective, activeQuestions(presets, config.weights)] as const;
  });
  return new Map(await Promise.all(entries));
}

/** Maps the repository, or only `options.paths`, and ranks its units from worst to best. */
export async function reviewArchitecture(
  config: Config,
  options: ReviewOptions = {},
): Promise<ArchitectureReport> {
  const { noCache, onProgress } = options;
  const ssot = options.ssot === undefined ? await loadArchitecture(config) : options.ssot;
  const perspectives =
    options.perspectives ?? PERSPECTIVES.filter((p) => ssot || !SSOT_PERSPECTIVES.includes(p));
  const needsSsot = perspectives.find((perspective) => SSOT_PERSPECTIVES.includes(perspective));
  if (needsSsot && !ssot) {
    throw new UserError(
      `The ${needsSsot} perspective reviews the architecture SSOT, and there is none. Run: jevlint architecture compile`,
    );
  }
  const [collected, resolved, questions] = await Promise.all([
    collect(config, { paths: options.paths, skipHistory: true, noCache }),
    options.astOnly ? null : createDecisionModel(config),
    loadQuestions(config, perspectives),
  ]);
  const { warnings } = collected;
  const structure = buildStructure(collected.resolved, config.architecture);
  const subjects = [
    ...subjectsOf(structure),
    ...(ssot && structure.modules.length > 0 ? ssotSubjects(ssot, collected.modules) : []),
  ].filter(({ perspective }) => perspectives.includes(perspective));
  const scored = await scoreSubjects(
    subjects,
    { config, resolved, questions, noCache },
    onProgress,
  );
  const scaled = (units: ArchitectureUnit[]) => scaleScore(repoScore(units), config.scoring);
  const byPerspective = Map.groupBy(scored, ({ perspective }) => perspective);
  return {
    root: config.root,
    provider: resolved?.provider ?? null,
    model: resolved?.modelId ?? null,
    scale: config.scoring.scale,
    score: scaled(scored),
    perspectives: Object.fromEntries(
      [...byPerspective].map(([perspective, units]) => [perspective, scaled(units)]),
    ),
    units: scored
      .toSorted((a, b) => a.score - b.score || a.name.localeCompare(b.name))
      .map((unit) => ({ ...unit, score: scaleScore(unit.score, config.scoring) })),
    directories: structure.directories,
    modules: structure.modules,
    classes: structure.classes,
    edges: structure.edges,
    findings: structure.findings,
    warnings,
    usage: usageOf(scored, resolved),
  };
}
