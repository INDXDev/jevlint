/** Loads and validates the architecture SSOT. See docs/architecture-reference.md. */
import { readdir } from 'node:fs/promises';
import { join, posix, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  type Config,
  ifExists,
  isTable,
  parseWith,
  readRegularFile,
  UserError,
} from '../config.ts';
import { isOutsideRoot } from '../files.ts';
import { assertInRepo } from '../presets.ts';
import { checklistSchema, idSchema, readYaml } from '../spec/load.ts';
import type {
  ArchitectureChapter,
  ArchitectureComponent,
  ArchitectureFlow,
  ArchitectureIndex,
  ArchitectureRule,
  ArchitectureSsot,
  ArchitectureView,
} from '../types.ts';

/** The most components or flows one SSOT may have. */
const MAX_FILES = 255;

/** What `list` warns above: a few thousand tokens in all, as docs/architecture-reference.md says. */
export const BUDGET = {
  components: 25,
  summarySentences: 3,
  keyFiles: 5,
  tokens: 6000,
  /** Words in one chapter, and in all of them. */
  chapterWords: 1500,
  documentWords: 9000,
} as const;

const LANGUAGES = ['javascript', 'typescript', 'tsx', 'python', 'go', 'rust'] as const;

const text = z.string().min(1);
// Folded YAML ends in a line break, which the terminal would print as `?`.
const prose = z
  .string()
  .min(1)
  .transform((value) => value.trim().replace(/\s*\n\s*/g, ' '));
const ids = z.array(idSchema);
// Externals ids are written like `ai_sdk`, so they allow `_`.
const externalId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Use only lowercase letters, digits, - and _');
const glob = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith('/') && !path.split('/').includes('..'), {
    message: 'must be a root-relative path or glob, with no ..',
  });
const commit = z.string().regex(/^[0-9a-f]{7,40}$/, 'must be a commit hash');

const ruleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id: idSchema, kind: z.literal('layers') }),
  z.strictObject({ id: idSchema, kind: z.literal('no-cycles') }),
  z.strictObject({
    id: idSchema,
    kind: z.literal('only'),
    externals: z.array(externalId).min(1),
    components: ids.min(1).optional(),
  }),
  z
    .strictObject({
      id: idSchema,
      kind: z.literal('forbid'),
      from: ids.min(1).optional(),
      packages: z.array(text).optional(),
      components: ids.optional(),
    })
    .refine((rule) => (rule.packages?.length ?? 0) + (rule.components?.length ?? 0) > 0, {
      message: 'forbid needs packages or components',
    }),
  z.strictObject({
    id: idSchema,
    kind: z.literal('forbid-call'),
    pattern: text,
    language: z.enum(LANGUAGES).optional(),
    from: ids.min(1).optional(),
    except: ids.optional(),
  }),
]);

const uniqueIds = <T extends { id: string }>(schema: z.ZodType<T[]>) =>
  schema.superRefine((items, context) => {
    const seen = new Set<string>();
    items.forEach(({ id }, index) => {
      if (seen.has(id)) {
        context.addIssue({ code: 'custom', message: `duplicate id ${id}`, path: [index, 'id'] });
      }
      seen.add(id);
    });
  });

const indexSchema = z.strictObject({
  version: z.literal(1),
  name: text,
  compiled_at: commit.optional(),
  description: prose,
  layers: z.array(idSchema).default([]),
  ignore: z.array(glob).default([]),
  externals: uniqueIds(
    z.array(
      z.strictObject({
        id: externalId,
        title: text,
        packages: z.array(text).min(1),
        summary: prose.optional(),
      }),
    ),
  ).default([]),
  rules: uniqueIds(z.array(ruleSchema)).default([]),
  checklist: checklistSchema.default([]),
});

const componentSchema = (fileId: string) =>
  z.strictObject({
    id: idSchema
      .refine((id) => id === fileId, `must equal the file name without .yaml (${fileId})`)
      .refine((id) => id !== 'global', 'global is reserved'),
    title: prose,
    summary: prose,
    layer: idSchema.optional(),
    paths: z.array(glob).min(1),
    key_files: z.array(z.strictObject({ path: glob, role: prose })).default([]),
    interface: z.array(text).default([]),
    depends_on: ids.optional(),
    uses: z.array(externalId).default([]),
    rules: uniqueIds(z.array(ruleSchema)).default([]),
    checklist: checklistSchema.default([]),
    status: z.enum(['current', 'target']).default('current'),
  });

const flowSchema = (fileId: string) =>
  z.strictObject({
    id: idSchema.refine(
      (id) => id === fileId,
      `must equal the file name without .yaml (${fileId})`,
    ),
    title: text,
    trigger: text.optional(),
    steps: z
      .array(
        z.strictObject({
          from: idSchema,
          to: idSchema,
          verb: text,
          returns: text.optional(),
          optional: z.boolean().optional(),
        }),
      )
      .min(1),
  });

/** The most nodes and edges a view may have, as GitDiagram allows, so a diagram stays readable. */
export const VIEW_LIMITS = { nodes: 34, edges: 48, groups: 8, entities: 20, fields: 12 } as const;
const MAX_CHAPTERS = 30;
const MAX_CHAPTER_BYTES = 60_000;

const nodeId = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*$/, 'Use lowercase letters, digits, - and _, starting with a letter');
const shortText = (max: number) =>
  prose.pipe(z.string().max(max, `Keep it under ${max} characters`));

const viewNodeSchema = z
  .strictObject({
    id: nodeId,
    label: shortText(60),
    kind: z
      .enum(['actor', 'component', 'store', 'queue', 'external', 'document'])
      .default('component'),
    path: glob.optional(),
    component: idSchema.optional(),
    packages: z.array(text).min(1).optional(),
    group: nodeId.optional(),
    description: prose.optional(),
  })
  .refine((node) => !(node.path && node.component), {
    message: 'give a node a path or a component, not both',
  });

const graphViewSchema = (fileId: string) =>
  z.strictObject({
    id: nodeId.refine((id) => id === fileId, `must equal the file name without .yaml (${fileId})`),
    kind: z.literal('graph'),
    title: shortText(80),
    description: prose.optional(),
    groups: uniqueIds(
      z.array(z.strictObject({ id: nodeId, label: shortText(60) })).max(VIEW_LIMITS.groups),
    ).default([]),
    nodes: uniqueIds(z.array(viewNodeSchema).min(1).max(VIEW_LIMITS.nodes)),
    edges: z
      .array(
        z.strictObject({
          from: nodeId,
          to: nodeId,
          verb: shortText(40),
          style: z.enum(['solid', 'dashed']).default('solid'),
        }),
      )
      .max(VIEW_LIMITS.edges)
      .default([]),
  });

const dataViewSchema = (fileId: string) =>
  z.strictObject({
    id: nodeId.refine((id) => id === fileId, `must equal the file name without .yaml (${fileId})`),
    kind: z.literal('data'),
    title: shortText(80),
    description: prose.optional(),
    entities: uniqueIds(
      z
        .array(
          z.strictObject({
            id: nodeId,
            name: text,
            path: glob,
            description: prose.optional(),
            fields: z
              .array(z.strictObject({ name: text, type: text, note: prose.optional() }))
              .max(VIEW_LIMITS.fields)
              .default([]),
          }),
        )
        .min(1)
        .max(VIEW_LIMITS.entities),
    ),
    relations: z
      .array(
        z.strictObject({
          from: nodeId,
          to: nodeId,
          cardinality: z.enum(['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many']),
          label: shortText(40),
        }),
      )
      .default([]),
  });

/** A view is a graph unless it says `kind: data`, and its id is its file name unless it says. */
const viewSchema = (fileId: string) =>
  z.preprocess(
    (value) => (isTable(value) ? { id: fileId, ...value, kind: value.kind ?? 'graph' } : value),
    z.discriminatedUnion('kind', [graphViewSchema(fileId), dataViewSchema(fileId)]),
  );

const chapterSchema = z.strictObject({
  title: shortText(100),
  evidence: z.array(z.string().min(1)).default([]),
});

/** Where a chapter places a diagram: `<!-- jevlint:diagram overview -->`. */
export const DIAGRAM_DIRECTIVE = /<!--\s*jevlint:diagram\s+([a-z0-9_:-]+)\s*-->/g;
/** Diagram names every SSOT has, besides its views and `flow:<id>`. */
export const BUILT_IN_DIAGRAMS = ['map', 'layers', 'components'];

/** Splits a chapter into its YAML frontmatter and its Markdown body. */
function parseChapter(raw: string, file: string, id: string): ArchitectureChapter {
  const match = raw.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new UserError(`${file}: must start with --- frontmatter holding a title`);
  let front: unknown;
  try {
    front = parseYaml(match[1] as string, { maxAliasCount: 10 });
  } catch {
    throw new UserError(`${file}: invalid YAML in the frontmatter`);
  }
  const { title, evidence } = parseWith(chapterSchema, front ?? {}, file);
  return { id, title, evidence, body: (match[2] as string).trim() };
}

async function readChapters(root: string, dir: string): Promise<ArchitectureChapter[]> {
  const chaptersDir = join(root, dir, 'chapters');
  const names = ((await ifExists(readdir(chaptersDir))) ?? []).filter((name) =>
    name.endsWith('.md'),
  );
  if (names.length === 0) return [];
  if (names.length > MAX_CHAPTERS) {
    throw new UserError(`${dir}/chapters: ${names.length} chapters, more than ${MAX_CHAPTERS}`);
  }
  await assertInRepo(chaptersDir, root);
  const chapters: ArchitectureChapter[] = [];
  for (const name of names.sort()) {
    const file = posix.join(dir, 'chapters', name);
    const id = name.slice(0, -'.md'.length);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new UserError(`${file}: name chapters with lowercase letters, digits and -`);
    }
    await assertInRepo(join(chaptersDir, name), root);
    const raw = await readRegularFile(join(chaptersDir, name));
    if (Buffer.byteLength(raw) > MAX_CHAPTER_BYTES) {
      throw new UserError(`${file}: larger than ${MAX_CHAPTER_BYTES} bytes`);
    }
    chapters.push(parseChapter(raw, file, id));
  }
  return chapters;
}

function checkViews(ssot: ArchitectureSsot, need: Need): void {
  const componentIds = new Set(ssot.components.map(({ id }) => id));
  for (const view of ssot.views) {
    const where = posix.join(ssot.dir, 'views', `${view.id}.yaml`);
    if (view.kind === 'data') {
      const entities = new Set(view.entities.map(({ id }) => id));
      need(
        where,
        'entity',
        entities,
        view.relations.flatMap(({ from, to }) => [from, to]),
      );
      continue;
    }
    const nodes = new Set(view.nodes.map(({ id }) => id));
    const groups = new Set(view.groups.map(({ id }) => id));
    need(
      where,
      'group',
      groups,
      view.nodes.flatMap(({ group }) => group ?? []),
    );
    need(
      where,
      'component',
      componentIds,
      view.nodes.flatMap(({ component }) => component ?? []),
    );
    need(
      where,
      'node',
      nodes,
      view.edges.flatMap(({ from, to }) => [from, to]),
    );
  }
}

function checkChapters(ssot: ArchitectureSsot, need: Need): void {
  const diagrams = new Set([
    ...BUILT_IN_DIAGRAMS,
    ...ssot.views.map(({ id }) => id),
    ...ssot.flows.map(({ id }) => `flow:${id}`),
    ...ssot.components.map(({ id }) => `component:${id}`),
  ]);
  for (const chapter of ssot.chapters) {
    const named = [...chapter.body.matchAll(DIAGRAM_DIRECTIVE)].map((match) => match[1] as string);
    need(posix.join(ssot.dir, 'chapters', `${chapter.id}.md`), 'diagram', diagrams, named);
  }
}

async function yamlFiles(root: string, dir: string): Promise<string[]> {
  const names = ((await ifExists(readdir(dir))) ?? []).filter((name) => name.endsWith('.yaml'));
  if (names.length > MAX_FILES) {
    throw new UserError(`${relative(root, dir)}: ${names.length} files, more than ${MAX_FILES}`);
  }
  if (names.length > 0) await assertInRepo(dir, root);
  return names.sort();
}

/** Where the SSOT lives, root-relative, refusing a directory outside the root. */
export function ssotDir(config: Config): string {
  const relativeDir = relative(config.root, resolve(config.root, config.architecture.dir));
  // `architecture.dir` may come from the repository's own config.
  if (isOutsideRoot(relativeDir) || relativeDir === '') {
    throw new UserError(`architecture.dir must be inside the root: ${config.architecture.dir}`);
  }
  return relativeDir.split(sep).join('/');
}

/** Every component, layer, external and flow id that a rule, step or field names must exist. */
type Need = (where: string, kind: string, known: Set<string>, names?: string[]) => void;

function crossCheck(ssot: ArchitectureSsot): string[] {
  const { index, components, flows } = ssot;
  const componentIds = new Set(components.map(({ id }) => id));
  const externalIds = new Set(index.externals.map(({ id }) => id));
  const layers = new Set(index.layers);
  const problems: string[] = [];
  const need: Need = (where, kind, known, names = []) => {
    for (const name of names) {
      if (!known.has(name)) problems.push(`${where}: no ${kind} ${name}`);
    }
  };
  const checkRule = (where: string, rule: ArchitectureRule) => {
    if (rule.kind === 'only') {
      need(where, 'external', externalIds, rule.externals);
      need(where, 'component', componentIds, rule.components);
    }
    if (rule.kind === 'forbid') {
      need(where, 'component', componentIds, rule.from);
      need(where, 'component', componentIds, rule.components);
    }
    if (rule.kind === 'forbid-call') {
      need(where, 'component', componentIds, rule.from);
      need(where, 'component', componentIds, rule.except);
    }
  };
  const indexFile = posix.join(ssot.dir, 'index.yaml');
  for (const rule of index.rules) checkRule(`${indexFile} rule ${rule.id}`, rule);
  if (index.rules.some(({ kind }) => kind === 'layers') && layers.size === 0) {
    problems.push(`${indexFile}: a layers rule needs layers`);
  }
  for (const component of components) {
    const where = posix.join(ssot.dir, 'components', `${component.id}.yaml`);
    if (component.layer !== undefined) need(where, 'layer', layers, [component.layer]);
    need(where, 'component', componentIds, component.depends_on);
    need(where, 'external', externalIds, component.uses);
    for (const rule of component.rules) checkRule(`${where} rule ${rule.id}`, rule);
  }
  checkViews(ssot, need);
  checkChapters(ssot, need);
  for (const flow of flows) {
    const where = posix.join(ssot.dir, 'flows', `${flow.id}.yaml`);
    need(
      where,
      'component',
      componentIds,
      flow.steps.flatMap(({ from, to }) => [from, to]),
    );
  }
  return problems;
}

/** Reads and validates the SSOT, or returns null when `index.yaml` does not exist yet. */
export async function loadArchitecture(config: Config): Promise<ArchitectureSsot | null> {
  const { root } = config;
  const dir = ssotDir(config);
  const absolute = join(root, dir);
  const rawIndex = await ifExists(readYaml(root, join(absolute, 'index.yaml')));
  if (rawIndex === undefined) return null;
  const index: ArchitectureIndex = parseWith(indexSchema, rawIndex, posix.join(dir, 'index.yaml'));
  const components: ArchitectureComponent[] = [];
  for (const name of await yamlFiles(root, join(absolute, 'components'))) {
    const raw = await readYaml(root, join(absolute, 'components', name));
    const file = posix.join(dir, 'components', name);
    components.push(parseWith(componentSchema(name.slice(0, -'.yaml'.length)), raw, file));
  }
  if (components.length === 0) {
    throw new UserError(
      `${dir}: the SSOT has no components. Add ${posix.join(dir, 'components', '<id>.yaml')}`,
    );
  }
  const flows: ArchitectureFlow[] = [];
  for (const name of await yamlFiles(root, join(absolute, 'flows'))) {
    const raw = await readYaml(root, join(absolute, 'flows', name));
    const file = posix.join(dir, 'flows', name);
    flows.push(parseWith(flowSchema(name.slice(0, -'.yaml'.length)), raw, file));
  }
  const views: ArchitectureView[] = [];
  for (const name of await yamlFiles(root, join(absolute, 'views'))) {
    const raw = await readYaml(root, join(absolute, 'views', name));
    const file = posix.join(dir, 'views', name);
    views.push(
      parseWith(viewSchema(name.slice(0, -'.yaml'.length)), raw, file) as ArchitectureView,
    );
  }
  const chapters = await readChapters(root, dir);
  const ssot = { dir, index, components, flows, views, chapters };
  const problems = crossCheck(ssot);
  if (problems.length > 0) throw new UserError(problems.join('\n'));
  return ssot;
}

/** Root-relative paths of the SSOT's files: `index.yaml`, each component, then each flow. */
export function architectureFiles(ssot: ArchitectureSsot): string[] {
  return [
    posix.join(ssot.dir, 'index.yaml'),
    ...ssot.components.map(({ id }) => posix.join(ssot.dir, 'components', `${id}.yaml`)),
    ...ssot.flows.map(({ id }) => posix.join(ssot.dir, 'flows', `${id}.yaml`)),
    ...ssot.views.map(({ id }) => posix.join(ssot.dir, 'views', `${id}.yaml`)),
    ...ssot.chapters.map(({ id }) => posix.join(ssot.dir, 'chapters', `${id}.md`)),
  ];
}

const sentences = (paragraph: string) =>
  paragraph
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9`"(])/)
    .filter(Boolean).length;

/** Roughly four characters a token, which is close enough for a budget. */
const tokensOf = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);

/** Where the SSOT is bigger than the budget, as warnings. */
export function budgetWarnings(ssot: ArchitectureSsot): string[] {
  const warnings: string[] = [];
  if (ssot.components.length > BUDGET.components) {
    warnings.push(
      `${ssot.components.length} components, more than ${BUDGET.components}. Merge the smaller ones.`,
    );
  }
  for (const { id, summary, key_files } of ssot.components) {
    if (sentences(summary) > BUDGET.summarySentences) {
      warnings.push(`${id}: the summary has more than ${BUDGET.summarySentences} sentences.`);
    }
    if (key_files.length > BUDGET.keyFiles) {
      warnings.push(`${id}: ${key_files.length} key files, more than ${BUDGET.keyFiles}.`);
    }
  }
  const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
  for (const { id, body } of ssot.chapters) {
    if (words(body) > BUDGET.chapterWords) {
      warnings.push(
        `chapter ${id}: ${words(body)} words, more than ${BUDGET.chapterWords}. Split it or cut it.`,
      );
    }
  }
  const total = ssot.chapters.reduce((sum, { body }) => sum + words(body), 0);
  if (total > BUDGET.documentWords) {
    warnings.push(`The chapters have ${total} words, more than ${BUDGET.documentWords}.`);
  }
  const tokens = tokensOf({ ...ssot, dir: undefined, chapters: undefined, views: undefined });
  if (tokens > BUDGET.tokens) {
    warnings.push(`About ${tokens} tokens in all, more than ${BUDGET.tokens}. Shorten summaries.`);
  }
  return warnings;
}
