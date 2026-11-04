/** Runs the architecture review: extract, build graphs, ask the model per perspective, score. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pLimit from 'p-limit';
import { languageOf } from '../ast/languages.ts';
import { type Config, ifExists, readRegularFile, UserError } from '../config.ts';
import { decideFile } from '../decision/decide.ts';
import { estimateCostUsd } from '../decision/pricing.ts';
import { createDecisionModel, type ResolvedModel } from '../decision/providers.ts';
import { discoverFiles } from '../files.ts';
import { activeQuestions, loadPresets } from '../presets.ts';
import { astScoreFrom, fileScore, modelResult, repoScore, scaleScore } from '../scoring.ts';
import type {
  ArchitectureReport,
  ArchitectureUnit,
  ModelResult,
  Perspective,
  Question,
} from '../types.ts';
import { extractModule, type ModuleOutline } from './extract.ts';
import { type Subject, subjectsOf } from './outline.ts';
import { resolveImport } from './resolve.ts';
import { buildStructure } from './structure.ts';

/** The preset whose questions are asked of each kind of unit. */
const PRESETS: Record<Perspective, string> = {
  codebase: 'architecture-codebase',
  directory: 'architecture-directory',
  class: 'architecture-class',
};

/** Every perspective, broadest first. */
export const PERSPECTIVES = Object.keys(PRESETS) as Perspective[];

/** Narrows and observes a review. */
export interface ReviewOptions {
  paths?: string[];
  astOnly?: boolean;
  noCache?: boolean;
  /** Reviews only these. Defaults to all of them. */
  perspectives?: Perspective[];
  onProgress?: (done: number, total: number, path: string) => void;
}

async function readOutlines(config: Config, paths: string[]) {
  const warnings: string[] = [];
  const limit = pLimit(config.concurrency);
  const outlines = paths.flatMap((path) => {
    const language = languageOf(path);
    if (!language) return [];
    return limit(async () => {
      const source = await readFile(join(config.root, path), 'utf8').catch((error: Error) => {
        warnings.push(`Could not read ${path}: ${error.message}`);
        return null;
      });
      return source === null ? [] : [extractModule(path, source, language)];
    });
  });
  return { outlines: (await Promise.all(outlines)).flat(), warnings };
}

async function goModuleOf(root: string): Promise<string | undefined> {
  const goMod = await ifExists(readRegularFile(join(root, 'go.mod')));
  return goMod?.match(/^module\s+(\S+)/m)?.[1];
}

function resolveAll(outlines: ModuleOutline[], goModule?: string): ModuleOutline[] {
  const files = new Set(outlines.map(({ path }) => path));
  return outlines.map((outline) => {
    const { path, language, imports } = outline;
    const resolved = imports.flatMap(
      (specifier) => resolveImport(specifier, path, language, { files, goModule }) ?? [],
    );
    return { ...outline, imports: [...new Set(resolved)] };
  });
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
  const { noCache, onProgress, perspectives = PERSPECTIVES } = options;
  const [paths, resolved, goModule, questions] = await Promise.all([
    discoverFiles(config, options.paths),
    options.astOnly ? null : createDecisionModel(config),
    goModuleOf(config.root),
    loadQuestions(config, perspectives),
  ]);
  const { outlines, warnings } = await readOutlines(config, paths);
  const structure = buildStructure(resolveAll(outlines, goModule), config.architecture);
  const subjects = subjectsOf(structure).filter(({ perspective }) =>
    perspectives.includes(perspective),
  );
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
