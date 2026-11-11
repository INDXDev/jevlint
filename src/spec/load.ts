/** Loads and validates the spec in `spec.dir`. See docs/spec-reference.md. */
import { readdir } from 'node:fs/promises';
import { join, posix, relative, resolve, sep } from 'node:path';
import { parse, YAMLParseError } from 'yaml';
import { z } from 'zod';
import { type Config, ifExists, parseWith, readRegularFile, UserError } from '../config.ts';
import { isOutsideRoot } from '../files.ts';
import { assertInRepo } from '../presets.ts';
import type { Spec, SpecFeature, SpecIndex } from '../types.ts';

/** The scope of the project checklist, and the route answer for "no single feature". */
export const GLOBAL = 'global';

/** An item's full id: `<feature>.<id>`, or `global.<id>`. */
export const fullId = (scope: string, item: { id: string }) => `${scope}.${item.id}`;

// The most options one choice question takes, counting `global`.
const MAX_FEATURES = 255;
// Enough for honest reuse, too few for a billion-laughs expansion.
const MAX_ALIASES = 10;

/** An id: lowercase letters, digits and `-`. */
export const idSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    'Use only lowercase letters, digits and -, starting with a letter or digit',
  );

const itemSchema = z.strictObject({
  id: idSchema,
  text: z.string().min(1),
  source: z.string().optional(),
});

/** A checklist whose ids are unique. */
export const checklistSchema = z.array(itemSchema).superRefine((items, context) => {
  const seen = new Set<string>();
  items.forEach(({ id }, index) => {
    if (seen.has(id))
      context.addIssue({ code: 'custom', message: `duplicate id ${id}`, path: [index, 'id'] });
    seen.add(id);
  });
});

const acceptedSchema = z.array(
  z.strictObject({ path: z.string().min(1), reason: z.string().min(1) }),
);

const indexSchema = z.strictObject({
  version: z.literal(1),
  name: z.string().min(1),
  description: z.string().min(1),
  checklist: checklistSchema.default([]),
  accept_uncovered: acceptedSchema.default([]),
});

const featureSchema = (fileId: string) =>
  z.strictObject({
    id: idSchema
      .refine((id) => id === fileId, `must equal the file name without .yaml (${fileId})`)
      .refine((id) => id !== GLOBAL, `${GLOBAL} is reserved`),
    title: z.string().min(1),
    summary: z.string().min(1),
    checklist: checklistSchema.min(1),
  });

/** Reads one YAML mapping from the repository, with errors that never quote its text. */
export async function readYaml(root: string, path: string): Promise<unknown> {
  const name = relative(root, path).split(sep).join('/');
  await assertInRepo(path, root);
  let value: unknown;
  try {
    value = parse(await readRegularFile(path), { maxAliasCount: MAX_ALIASES });
  } catch (error) {
    // The parser's message quotes the source line, which is the repository's text.
    if (error instanceof YAMLParseError) {
      const [position] = error.linePos ?? [];
      throw new UserError(
        `${name}: invalid YAML at line ${position?.line}, column ${position?.col}`,
      );
    }
    if (error instanceof ReferenceError) throw new UserError(`${name}: too many YAML aliases`);
    throw error;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UserError(`${name}: must be a mapping of keys`);
  }
  return value;
}

/** Reads and validates the spec, or returns null when `index.yaml` does not exist yet. */
export async function loadSpec(config: Config): Promise<Spec | null> {
  const { root } = config;
  const absolute = resolve(root, config.spec.dir);
  const relativeDir = relative(root, absolute);
  // `spec.dir` may come from the repository's own config.
  if (isOutsideRoot(relativeDir)) {
    throw new UserError(`spec.dir is outside the root: ${config.spec.dir}`);
  }
  const dir = relativeDir.split(sep).join('/');
  const indexPath = join(absolute, 'index.yaml');
  const rawIndex = await ifExists(readYaml(root, indexPath));
  if (rawIndex === undefined) return null;
  const index: SpecIndex = parseWith(indexSchema, rawIndex, posix.join(dir, 'index.yaml'));

  const featuresDir = join(absolute, 'features');
  const names = ((await ifExists(readdir(featuresDir))) ?? []).filter((name) =>
    name.endsWith('.yaml'),
  );
  if (names.length === 0) {
    throw new UserError(
      `${dir}: the spec has no features. Add ${posix.join(dir, 'features', '<id>.yaml')}`,
    );
  }
  if (names.length > MAX_FEATURES) {
    throw new UserError(`${dir}: the spec has ${names.length} features, more than ${MAX_FEATURES}`);
  }
  await assertInRepo(featuresDir, root);
  const features: SpecFeature[] = [];
  for (const name of names.sort()) {
    const raw = await readYaml(root, join(featuresDir, name));
    const fileId = name.slice(0, -'.yaml'.length);
    features.push(parseWith(featureSchema(fileId), raw, posix.join(dir, 'features', name)));
  }
  features.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { dir, index, features };
}

/** Root-relative paths of the spec's files: `index.yaml`, then each feature. */
export function specFiles(spec: Spec): string[] {
  return [
    posix.join(spec.dir, 'index.yaml'),
    ...spec.features.map(({ id }) => posix.join(spec.dir, 'features', `${id}.yaml`)),
  ];
}
