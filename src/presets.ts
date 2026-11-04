/** Loads and validates presets from the repository, the user and the built-in set. */
import { mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  astPatternSchema,
  astRulesSchema,
  idSchema,
  ifExists,
  parseToml,
  parseWith,
  paths,
  UserError,
  writeFileAtomic,
} from './config.ts';
import type { Preset, Question } from './types.ts';

// One level below the package root from both src/ and dist/.
const BUILT_IN_DIR = fileURLToPath(new URL('../presets/', import.meta.url));

const questionBase = {
  id: idSchema,
  title: z.string(),
  instructions: z.string(),
  weight: z.number().nonnegative().default(1),
  fix: z.string(),
};

const questionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...questionBase,
    type: z.literal('score'),
    levels: z.array(z.string()).min(2).max(10),
  }),
  z.strictObject({ ...questionBase, type: z.literal('boolean'), good: z.boolean() }),
]);

const presetSchema = z.strictObject({
  name: idSchema,
  description: z.string(),
  source: z.string(),
  questions: z
    .array(questionSchema)
    .refine((questions) => new Set(questions.map(({ id }) => id)).size === questions.length, {
      error: 'Question ids must be unique',
    }),
  patterns: z.array(astPatternSchema).default([]),
  rules: astRulesSchema.default([]),
});

type PresetOrigin = 'repo' | 'user' | 'built-in';

const repoPresetsDir = (root: string) => join(root, '.jevlint', 'presets');

/** Parses and validates preset TOML. `source` names it in error messages. */
export function parsePreset(toml: string, source = 'preset'): Preset {
  return parseWith(presetSchema, parseToml(toml, source), source);
}

/** A repository is untrusted, so its symlinks must not lead jevlint outside the root. */
export async function assertInRepo(path: string, root: string): Promise<void> {
  const [real, realRoot] = await Promise.all([realpath(path), realpath(root)]);
  if (!real.startsWith(join(realRoot, sep))) {
    throw new UserError(`${path} links outside the repository`);
  }
}

/** Finds every preset by its declared name, so callers never build a path from a name. */
async function discoverPresets(root: string) {
  const dirs: [PresetOrigin, string][] = [
    ['repo', repoPresetsDir(root)],
    ['user', paths.presetsDir()],
    ['built-in', BUILT_IN_DIR],
  ];
  const found = new Map<string, { preset: Preset; origin: PresetOrigin; path: string }>();
  for (const [origin, dir] of dirs) {
    const fileNames = (await ifExists(readdir(dir))) ?? [];
    for (const fileName of fileNames.filter((name) => name.endsWith('.toml')).sort()) {
      const path = join(dir, fileName);
      if (origin === 'repo') await assertInRepo(path, root);
      const preset = parsePreset(await readFile(path, 'utf8'), path);
      if (!found.has(preset.name)) found.set(preset.name, { preset, origin, path });
    }
  }
  return found;
}

/** Resolves preset names, preferring repository, then user, then built-in. */
export async function loadPresets(names: string[], root: string): Promise<Preset[]> {
  const found = await discoverPresets(root);
  return [...new Set(names)].map((name) => {
    const entry = found.get(name);
    if (entry) return entry.preset;
    const available = [...found.keys()].sort().join(', ');
    throw new UserError(`Unknown preset "${name}". Available: ${available}`);
  });
}

/** Lists the presets that can be used from `root`, sorted by name. */
export async function listPresets(
  root: string,
): Promise<{ name: string; description: string; origin: PresetOrigin; path: string }[]> {
  const found = await discoverPresets(root);
  return [...found.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, { preset, origin, path }]) => ({
      name,
      description: preset.description,
      origin,
      path,
    }));
}

/** Validates a preset file and copies it into place, returning the new path. */
export async function installPreset(
  file: string,
  options: { repo: boolean; root: string },
): Promise<string> {
  const toml = await ifExists(readFile(file, 'utf8'));
  if (toml === undefined) throw new UserError(`Preset file not found: ${file}`);
  const { name } = parsePreset(toml, file);
  const dir = options.repo ? repoPresetsDir(options.root) : paths.presetsDir();
  // Checked first as well, so that a linked `.jevlint` gets no directory outside the repository.
  if (options.repo) await ifExists(assertInRepo(dirname(dir), options.root));
  await mkdir(dir, { recursive: true });
  if (options.repo) await assertInRepo(dir, options.root);
  const destination = join(dir, `${name}.toml`);
  // Atomic, so a symlink planted at the destination is replaced rather than written through.
  await writeFileAtomic(destination, toml);
  return destination;
}

/** Removes an installed preset, returning whether it existed. Built-ins cannot be removed. */
export async function removePreset(name: string, root: string): Promise<boolean> {
  const entry = (await discoverPresets(root)).get(name);
  if (!entry) return false;
  if (entry.origin === 'built-in') throw new UserError(`Cannot remove built-in preset "${name}"`);
  await rm(entry.path);
  return true;
}

/** Flattens presets into questions with full ids and final weights, dropping weight 0. */
export function activeQuestions(presets: Preset[], weights: Record<string, number>): Question[] {
  return presets
    .flatMap(({ name, questions }) =>
      questions.map((question) => {
        const id = `${name}.${question.id}`;
        return { ...question, id, weight: weights[id] ?? question.weight };
      }),
    )
    .filter((question) => question.weight > 0);
}
