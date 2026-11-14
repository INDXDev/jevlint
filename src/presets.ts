/** Loads and validates presets from the repository, the user and the built-in set. */
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
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
import type { Preset, PresetUse, Question } from './types.ts';

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
  used_by: z
    .enum(['audit', 'architecture', 'intent', 'acceptance'] as const satisfies PresetUse[])
    .default('audit'),
  includes: z.array(idSchema).default([]),
  questions: z
    .array(questionSchema)
    .refine((questions) => new Set(questions.map(({ id }) => id)).size === questions.length, {
      error: 'Question ids must be unique',
    }),
  patterns: z.array(astPatternSchema).default([]),
  rules: astRulesSchema.default([]),
});

/** Where a preset was found, in order of preference. */
export type PresetOrigin = 'repo' | 'user' | 'built-in';

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

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        substitution,
      );
    }
    previous = current;
  }
  return previous[b.length] as number;
}

/** The known name a typo most likely meant: within two edits, or one that starts with it. */
export function closestName(name: string, names: Iterable<string>): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const candidate of names) {
    const prefix = name.length >= 3 && candidate.startsWith(name);
    const distance = prefix ? 1 : editDistance(name, candidate);
    if (distance <= 2 && (!best || distance < best.distance)) best = { name: candidate, distance };
  }
  return best?.name;
}

function unknownPreset(name: string, names: Iterable<string>): UserError {
  const suggestion = closestName(name, names);
  const hint = suggestion ? `Did you mean "${suggestion}"?` : 'Run: jevlint preset list';
  return new UserError(`Unknown preset "${name}". ${hint}`);
}

/**
 * Resolves preset names, preferring repository, then user, then built-in. A preset's `includes`
 * join the result as presets of their own, so their question ids and scores stay theirs.
 */
export async function loadPresets(names: string[], root: string): Promise<Preset[]> {
  const found = await discoverPresets(root);
  const loaded = new Map<string, Preset>();
  const load = (name: string) => {
    // Also what stops presets that include each other, which a repository can plant.
    if (loaded.has(name)) return;
    const entry = found.get(name);
    if (!entry) {
      const suggestion = closestName(name, found.keys());
      const hint = suggestion
        ? `Did you mean "${suggestion}"?`
        : `Available: ${[...found.keys()].sort().join(', ')}`;
      throw new UserError(`Unknown preset "${name}". ${hint}`);
    }
    loaded.set(name, entry.preset);
    entry.preset.includes.forEach(load);
  };
  names.forEach(load);
  return [...loaded.values()];
}

/** Lists the presets that can be used from `root`, sorted by name. */
export async function listPresets(
  root: string,
): Promise<
  { name: string; description: string; used_by: PresetUse; origin: PresetOrigin; path: string }[]
> {
  const found = await discoverPresets(root);
  return [...found.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, { preset, origin, path }]) => ({
      name,
      description: preset.description,
      used_by: preset.used_by,
      origin,
      path,
    }));
}

/** The presets a person can pick for audits, with `full` first as it covers the rest. */
export function auditChoices<T extends { name: string; used_by: PresetUse }>(presets: T[]): T[] {
  return presets
    .filter(({ used_by }) => used_by === 'audit')
    .sort((a, b) => Number(b.name === 'full') - Number(a.name === 'full'));
}

/** `audit` arguments sorted into presets and paths. */
export interface PresetArgs {
  presets: string[];
  paths: string[];
  /** Existing paths that also name a preset, and so stay paths. */
  shadowed: string[];
  /** Arguments that are neither, mapped to the preset they most likely meant. */
  typos: Record<string, string>;
}

/**
 * Splits `audit` arguments into preset names and paths, so `jevlint audit security` picks a preset.
 * An existing path always stays a path.
 */
export async function presetsInArgs(
  args: string[],
  { root, cwd }: { root: string; cwd: string },
): Promise<PresetArgs> {
  const names = new Set((await discoverPresets(root)).keys());
  const isPath = (arg: string) => existsSync(resolve(cwd, arg)) || existsSync(resolve(root, arg));
  const result: PresetArgs = { presets: [], paths: [], shadowed: [], typos: {} };
  for (const arg of args) {
    if (isPath(arg)) {
      result.paths.push(arg);
      if (names.has(arg)) result.shadowed.push(arg);
    } else if (names.has(arg)) result.presets.push(arg);
    else {
      result.paths.push(arg);
      const suggestion = closestName(arg, names);
      if (suggestion !== undefined) result.typos[arg] = suggestion;
    }
  }
  return result;
}

/** Validates a preset file and copies it into place, returning the new path. */
export async function installPreset(
  file: string,
  options: { repo: boolean; root: string },
): Promise<string> {
  const toml = await ifExists(readFile(file, 'utf8'));
  if (toml === undefined) throw new UserError(`Preset file not found: ${file}`);
  parsePreset(toml, file);
  return writePresetFile(toml, options);
}

/** A starting point for `preset new`, valid as written so the user edits rather than repairs it. */
function scaffold(name: string): string {
  return `name = "${name}"
description = "What this preset checks, in one line"
source = "Where these principles come from"

# Add one [[questions]] block per principle. See docs/presets.md#writing-a-preset

[[questions]]
id = "example"
type = "score"
title = "A short statement of the good state"
instructions = "The question the model answers about each file."
levels = [
  "The worst case",
  "Partly there",
  "The best case, or the question does not apply",
]
weight = 1
fix = "Advice for a coding agent that fixes a low score."
`;
}

/** Points an existing preset's TOML at a new name, keeping its comments and layout. */
function renamed(toml: string, name: string, source: string): string {
  const pattern = /^name\s*=\s*(["']).*?\1[ \t]*$/m;
  if (!pattern.test(toml)) throw new UserError(`${source}: no top-level name line to rename`);
  return toml.replace(pattern, `name = "${name}"`);
}

const editableDir = (options: { repo: boolean; root: string }) =>
  options.repo ? repoPresetsDir(options.root) : paths.presetsDir();

async function writePresetFile(
  toml: string,
  options: { repo: boolean; root: string },
): Promise<string> {
  const { name } = parsePreset(toml);
  const dir = editableDir(options);
  // Checked first as well, so that a linked `.jevlint` gets no directory outside the repository.
  if (options.repo) await ifExists(assertInRepo(dirname(dir), options.root));
  await mkdir(dir, { recursive: true });
  if (options.repo) await assertInRepo(dir, options.root);
  const destination = join(dir, `${name}.toml`);
  // Presets are found by declared name, so the file of this name can hold a different preset.
  // Not followed, because a link planted here may lead out of the repository.
  const isFile = (await ifExists(lstat(destination)))?.isFile();
  const held = isFile ? parsePreset(await readFile(destination, 'utf8'), destination).name : name;
  if (held !== name) {
    throw new UserError(`${destination} holds the preset "${held}". Move that file first.`);
  }
  // Atomic, so a symlink planted at the destination is replaced rather than written through.
  await writeFileAtomic(destination, toml);
  return destination;
}

/**
 * Creates a user or repository preset, blank or copied from `from`, and returns its path.
 * Refuses a name that already names a user or repository preset.
 */
export async function createPreset(
  name: string,
  options: { repo: boolean; root: string; from?: string },
): Promise<string> {
  const valid = idSchema.safeParse(name);
  if (!valid.success)
    throw new UserError(`Invalid preset name "${name}": ${valid.error.issues[0]?.message}`);
  const found = await discoverPresets(options.root);
  const existing = found.get(name);
  if (existing && existing.origin !== 'built-in') {
    throw new UserError(
      `A ${existing.origin} preset named "${name}" exists. Run: jevlint preset edit ${name}`,
    );
  }
  if (options.from === undefined) return writePresetFile(scaffold(name), options);
  const base = found.get(options.from);
  if (!base) throw unknownPreset(options.from, found.keys());
  const toml = await readFile(base.path, 'utf8');
  return writePresetFile(renamed(toml, name, base.path), options);
}

/**
 * Returns the file to edit for a preset. A built-in is first copied to the user's presets, or the
 * repository's with `repo`, where it then takes precedence; `copied` says so.
 */
export async function editablePreset(
  name: string,
  options: { repo: boolean; root: string },
): Promise<{ path: string; copied: boolean }> {
  const found = await discoverPresets(options.root);
  const entry = found.get(name);
  if (!entry) throw unknownPreset(name, found.keys());
  if (entry.origin !== 'built-in') return { path: entry.path, copied: false };
  const toml = await readFile(entry.path, 'utf8');
  return { path: await writePresetFile(toml, options), copied: true };
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
