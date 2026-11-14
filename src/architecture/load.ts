/** Loads and validates the architecture SSOT. See docs/architecture-reference.md. */
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  type Config,
  ifExists,
  isTable,
  parseWith,
  readRegularFile,
  UserError,
  writeFileAtomic,
} from '../config.ts';
import { isOutsideRoot } from '../files.ts';
import { fileAt, filesAt } from '../git.ts';
import { assertInRepo } from '../presets.ts';
import { checklistSchema, idSchema, readYaml } from '../spec/load.ts';
import type {
  ArchitectureChapter,
  ArchitectureComponent,
  ArchitectureDecision,
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
  tokens: 8000,
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
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date as YYYY-MM-DD')
  .refine(
    (date) => {
      const parsed = new Date(`${date}T00:00:00Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(date);
    },
    { message: 'must be a real date' },
  );

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
  compiled_on: isoDate.optional(),
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

/** The most decision records one SSOT may have. They are never deleted, so the cap is generous. */
const MAX_DECISIONS = MAX_FILES;
/** A decision record's file name: its number, which sets the order, then its id. */
const DECISION_FILE = /^(\d+)-([a-z0-9][a-z0-9-]*)\.md$/;
/**
 * How `enforced_by` names a rule or checklist item, as `check` does: a rule of `index.yaml` by its
 * id, `global.<id>` for an item of `index.yaml`, and `<component>.<id>` for a component's own.
 */
const enforcerId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)?$/, 'must be a rule or checklist id');

const decisionSchema = (fileId: string) =>
  z.strictObject({
    id: idSchema.refine(
      (id) => id === fileId,
      `must equal the file name without its number and .md (${fileId})`,
    ),
    title: shortText(100),
    date: isoDate,
    status: z.enum(['proposed', 'accepted', 'deprecated', 'superseded']),
    supersedes: ids.default([]),
    superseded_by: idSchema.nullable().default(null),
    components: ids.default([]),
    enforced_by: z.array(enforcerId).default([]),
    unenforceable: prose.optional(),
    evidence: z.array(z.string().min(1)).default([]),
  });

/** Where a chapter places a diagram: `<!-- jevlint:diagram overview -->`. */
export const DIAGRAM_DIRECTIVE = /<!--\s*jevlint:diagram\s+([a-z0-9_:-]+)\s*-->/g;
/** Diagram names every SSOT has, besides its views and `flow:<id>`. */
export const BUILT_IN_DIAGRAMS = ['map', 'layers', 'components', 'decisions'];

/** Splits a Markdown file into its YAML frontmatter and its body. */
function parseFrontmatter(raw: string, file: string): { front: unknown; body: string } {
  const match = raw.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new UserError(`${file}: must start with --- frontmatter holding a title`);
  try {
    return {
      front: parseYaml(match[1] as string, { maxAliasCount: 10 }) ?? {},
      body: (match[2] as string).trim(),
    };
  } catch {
    throw new UserError(`${file}: invalid YAML in the frontmatter`);
  }
}

/**
 * The status and body of a decision record as some commit held it, or null when it does not
 * parse. Lenient, as an old version need not fit today's schema.
 */
export function recordVersion(raw: string): { status: unknown; body: string } | null {
  try {
    const { front, body } = parseFrontmatter(raw, 'record');
    return isTable(front) ? { status: front.status, body } : null;
  } catch {
    return null;
  }
}

/** Splits a chapter into its YAML frontmatter and its Markdown body. */
function parseChapter(raw: string, file: string, id: string): ArchitectureChapter {
  const { front, body } = parseFrontmatter(raw, file);
  const { title, evidence } = parseWith(chapterSchema, front, file);
  return { id, title, evidence, body };
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

async function readDecisions(root: string, dir: string): Promise<ArchitectureDecision[]> {
  const decisionsDir = join(root, dir, 'decisions');
  const names = ((await ifExists(readdir(decisionsDir))) ?? []).filter((name) =>
    name.endsWith('.md'),
  );
  if (names.length === 0) return [];
  if (names.length > MAX_DECISIONS) {
    throw new UserError(`${dir}/decisions: ${names.length} records, more than ${MAX_DECISIONS}`);
  }
  await assertInRepo(decisionsDir, root);
  const decisions: ArchitectureDecision[] = [];
  // By number, so that 10- follows 9- whether or not the numbers are padded.
  const order = (name: string) => Number(name.match(DECISION_FILE)?.[1] ?? Number.NaN);
  names.sort((a, b) => order(a) - order(b) || (a < b ? -1 : a > b ? 1 : 0));
  for (const name of names) {
    const file = posix.join(dir, 'decisions', name);
    const fileId = name.match(DECISION_FILE)?.[2];
    if (!fileId) {
      throw new UserError(`${file}: name decision records <number>-<id>.md, such as 0001-${name}`);
    }
    await assertInRepo(join(decisionsDir, name), root);
    const raw = await readRegularFile(join(decisionsDir, name));
    if (Buffer.byteLength(raw) > MAX_CHAPTER_BYTES) {
      throw new UserError(`${file}: larger than ${MAX_CHAPTER_BYTES} bytes`);
    }
    const { front, body } = parseFrontmatter(raw, file);
    const record = parseWith(decisionSchema(fileId), front, file);
    decisions.push({ ...record, file: name.slice(0, -'.md'.length), body });
  }
  return decisions;
}

/** The accepted decisions each rule or checklist id enforces: `enforced_by`, reversed. */
export function decisionsByEnforcer(ssot: ArchitectureSsot): Map<string, string[]> {
  const byEnforcer = new Map<string, string[]>();
  for (const { id, status, enforced_by } of ssot.decisions ?? []) {
    if (status !== 'accepted') continue;
    for (const enforcer of enforced_by)
      byEnforcer.set(enforcer, [...(byEnforcer.get(enforcer) ?? []), id]);
  }
  return byEnforcer;
}

/**
 * The order a document shows decisions in: accepted then proposed ones in file order, and the
 * superseded and deprecated ones apart, by date.
 */
export function orderDecisions(decisions: ArchitectureDecision[] = []): {
  live: ArchitectureDecision[];
  past: ArchitectureDecision[];
} {
  const byDate = (a: ArchitectureDecision, b: ArchitectureDecision) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  return {
    live: [
      ...decisions.filter(({ status }) => status === 'accepted'),
      ...decisions.filter(({ status }) => status === 'proposed'),
    ],
    past: decisions
      .filter(({ status }) => status === 'superseded' || status === 'deprecated')
      .sort(byDate),
  };
}

/** Decisions that supersede each other in a loop, each loop once, as `a → b → a`. */
function supersedeCycles(decisions: ArchitectureDecision[]): string[] {
  const replaces = new Map(decisions.map(({ id, supersedes }) => [id, supersedes]));
  const done = new Set<string>();
  const cycles: string[] = [];
  const visit = (id: string, path: string[]) => {
    const start = path.indexOf(id);
    if (start >= 0) return void cycles.push([...path.slice(start), id].join(' → '));
    if (done.has(id)) return;
    // A record that supersedes itself has its own message.
    for (const next of replaces.get(id) ?? []) if (next !== id) visit(next, [...path, id]);
    done.add(id);
  };
  for (const { id } of decisions) visit(id, []);
  return cycles;
}

/**
 * Checks the record graph: unique ids, components and enforcing ids that exist, and `supersedes`
 * and `superseded_by` that name real records, agree with each other and form no loop.
 */
function checkDecisions(ssot: ArchitectureSsot, need: Need): string[] {
  const decisions = ssot.decisions ?? [];
  const problems: string[] = [];
  const byId = new Map<string, ArchitectureDecision>();
  for (const decision of decisions) {
    const where = posix.join(ssot.dir, 'decisions', `${decision.file}.md`);
    const other = byId.get(decision.id);
    if (other) problems.push(`${where}: duplicate id ${decision.id}, also in ${other.file}.md`);
    else byId.set(decision.id, decision);
  }
  const ids = new Set(byId.keys());
  const componentIds = new Set(ssot.components.map(({ id }) => id));
  const enforcers = new Set([
    ...ssot.index.rules.map(({ id }) => id),
    ...ssot.index.checklist.map(({ id }) => `global.${id}`),
    ...ssot.components.flatMap(({ id, rules, checklist }) =>
      [...rules, ...checklist].map((item) => `${id}.${item.id}`),
    ),
  ]);
  for (const decision of decisions) {
    const { id, status, supersedes, superseded_by } = decision;
    const where = posix.join(ssot.dir, 'decisions', `${decision.file}.md`);
    need(where, 'component', componentIds, decision.components);
    need(where, 'rule or checklist item', enforcers, decision.enforced_by);
    need(where, 'decision', ids, [...supersedes, ...(superseded_by ? [superseded_by] : [])]);
    if (supersedes.includes(id) || superseded_by === id) {
      problems.push(`${where}: a decision cannot supersede itself`);
    }
    if (status === 'superseded' && superseded_by === null) {
      problems.push(`${where}: status is superseded, so superseded_by must name its successor`);
    }
    if (status !== 'superseded' && superseded_by !== null) {
      problems.push(`${where}: superseded_by is set, so status must be superseded`);
    }
    if (decision.unenforceable !== undefined && decision.enforced_by.length > 0) {
      problems.push(`${where}: give enforced_by or unenforceable, not both`);
    }
    for (const old of supersedes) {
      const replaced = byId.get(old);
      if (replaced && old !== id && replaced.superseded_by !== id) {
        problems.push(
          `${where}: supersedes ${old}, but ${old} has superseded_by: ${replaced.superseded_by ?? 'null'}`,
        );
      }
    }
    const successor = superseded_by ? byId.get(superseded_by) : undefined;
    if (successor && superseded_by !== id && !successor.supersedes.includes(id)) {
      problems.push(
        `${where}: superseded_by ${superseded_by}, but ${superseded_by} does not list ${id} in supersedes`,
      );
    }
  }
  for (const cycle of supersedeCycles([...byId.values()])) {
    problems.push(`${posix.join(ssot.dir, 'decisions')}: decisions supersede each other: ${cycle}`);
  }
  return problems;
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
  problems.push(...checkDecisions(ssot, need));
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
  const decisions = await readDecisions(root, dir);
  const ssot: ArchitectureSsot = {
    dir,
    index,
    components,
    flows,
    views,
    chapters,
    // Absent rather than empty, so an SSOT without records loads and prints exactly as before.
    ...(decisions.length > 0 ? { decisions } : {}),
  };
  const problems = crossCheck(ssot);
  if (problems.length > 0) throw new UserError(problems.join('\n'));
  return ssot;
}

/** More files than every directory of the SSOT may hold together, so a commit is refused early. */
const MAX_SNAPSHOT_FILES = 6 * MAX_FILES;

/**
 * Reads the SSOT as it was at a commit, with the same checks as `loadArchitecture`. Its files are
 * copied from git into a private directory, which is deleted afterwards, so nothing is checked out
 * and the working tree stays as it is. Null when the commit has no `index.yaml`.
 */
export async function loadArchitectureAt(
  config: Config,
  commit: string,
): Promise<ArchitectureSsot | null> {
  const dir = ssotDir(config);
  const files = (await filesAt(config.root, commit)).filter((path) => path.startsWith(`${dir}/`));
  if (files.length > MAX_SNAPSHOT_FILES) {
    throw new UserError(`${dir}: ${files.length} files at ${commit}, more than an SSOT can have`);
  }
  const snapshot = await mkdtemp(join(tmpdir(), 'jevlint-ssot-'));
  try {
    for (const path of files) {
      // A crafted tree can hold these names, which would write outside the directory.
      if (path.split('/').some((part) => part === '..' || part.toLowerCase() === '.git')) continue;
      const text = await fileAt(config.root, commit, path);
      if (text === undefined) continue;
      await mkdir(dirname(join(snapshot, path)), { recursive: true });
      await writeFileAtomic(join(snapshot, path), text);
    }
    // Root-relative, as an absolute `architecture.dir` would point back into the working tree.
    const architecture = { ...config.architecture, dir };
    return await loadArchitecture({ ...config, root: snapshot, architecture });
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
}

/** Root-relative paths of the SSOT's files: `index.yaml`, then components, flows, views and so on. */
export function architectureFiles(ssot: ArchitectureSsot): string[] {
  return [
    posix.join(ssot.dir, 'index.yaml'),
    ...ssot.components.map(({ id }) => posix.join(ssot.dir, 'components', `${id}.yaml`)),
    ...ssot.flows.map(({ id }) => posix.join(ssot.dir, 'flows', `${id}.yaml`)),
    ...ssot.views.map(({ id }) => posix.join(ssot.dir, 'views', `${id}.yaml`)),
    ...ssot.chapters.map(({ id }) => posix.join(ssot.dir, 'chapters', `${id}.md`)),
    ...(ssot.decisions ?? []).map(({ file }) => posix.join(ssot.dir, 'decisions', `${file}.md`)),
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
  // Decisions are prose kept for good, as chapters are, so they do not count against the budget.
  const tokens = tokensOf({
    ...ssot,
    dir: undefined,
    chapters: undefined,
    views: undefined,
    decisions: undefined,
  });
  if (tokens > BUDGET.tokens) {
    warnings.push(`About ${tokens} tokens in all, more than ${BUDGET.tokens}. Shorten summaries.`);
  }
  return warnings;
}
