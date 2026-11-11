/** Loads and validates the architecture SSOT. See docs/architecture-reference.md. */
import { readdir } from 'node:fs/promises';
import { join, posix, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { type Config, ifExists, parseWith, UserError } from '../config.ts';
import { isOutsideRoot } from '../files.ts';
import { assertInRepo } from '../presets.ts';
import { checklistSchema, idSchema, readYaml } from '../spec/load.ts';
import type {
  ArchitectureComponent,
  ArchitectureFlow,
  ArchitectureIndex,
  ArchitectureRule,
  ArchitectureSsot,
} from '../types.ts';

/** The most components or flows one SSOT may have. */
const MAX_FILES = 255;

/** What `list` warns above: a few thousand tokens in all, as docs/architecture-reference.md says. */
export const BUDGET = {
  components: 25,
  summarySentences: 3,
  keyFiles: 5,
  tokens: 6000,
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
    steps: z.array(z.strictObject({ from: idSchema, to: idSchema, verb: text })).min(1),
  });

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
function crossCheck(ssot: ArchitectureSsot): string[] {
  const { index, components, flows } = ssot;
  const componentIds = new Set(components.map(({ id }) => id));
  const externalIds = new Set(index.externals.map(({ id }) => id));
  const layers = new Set(index.layers);
  const problems: string[] = [];
  const need = (where: string, kind: string, known: Set<string>, names: string[] = []) => {
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
  const ssot = { dir, index, components, flows };
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
  const tokens = tokensOf({ ...ssot, dir: undefined });
  if (tokens > BUDGET.tokens) {
    warnings.push(`About ${tokens} tokens in all, more than ${BUDGET.tokens}. Shorten summaries.`);
  }
  return warnings;
}
