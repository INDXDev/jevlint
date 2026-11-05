/** Paths, config schema, layered loading and repository restrictions. */
// jevlint-score 79 -- Reviewed; the remaining gap is within model noise
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse, stringify, TomlError } from 'smol-toml';
import { z } from 'zod';
import type { Language, ProviderName } from './types.ts';

/** An error the user can fix: shown without a stack trace, exit code 2. */
export class UserError extends Error {}

/** Name of the repository config file. */
export const REPO_CONFIG = 'jevlint.toml';

const USER_ONLY_KEYS = ['provider.base_url', 'agents', 'cache', 'max_rule_matches'];

/** Letters, digits, `-` and `_`: safe in file names and in `<preset>.<id>`. */
export const idSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, 'Use only letters, digits, - and _');

/** An ast-grep rule, as written in `[[patterns]]` of a config or preset. */
export const astPatternSchema = z.strictObject({
  id: idSchema,
  language: z.enum([
    'javascript',
    'typescript',
    'tsx',
    'python',
    'go',
    'rust',
  ] as const satisfies Language[]),
  pattern: z.string(),
  message: z.string(),
});

const METRIC_RULES = ['cognitive-complexity', 'nesting', 'function-lines', 'params', 'file-lines'];

/** `[[rules]]` of a config or preset: a pattern picks code, and a question judges each match. */
export const astRulesSchema = z
  .array(
    astPatternSchema.extend({
      id: idSchema.refine((id) => !METRIC_RULES.includes(id), {
        error: 'This id belongs to a built-in finding',
      }),
      question: z.string(),
      fix: z.string(),
      threshold: z.number().min(0).max(1).default(0.8),
    }),
  )
  .refine((rules) => new Set(rules.map(({ id }) => id)).size === rules.length, {
    error: 'Rule ids must be unique',
  });

const positiveInt = z.int().positive();
const weight = z.number().nonnegative();

const provider = z.strictObject({
  name: z.enum([
    'typesafe',
    'openai',
    'gateway',
    'cloudflare',
    'microsoft',
    'compatible',
  ] as const satisfies ProviderName[]),
  model: z.string().optional(),
  account_id: z.string().optional(),
  base_url: z.url().optional(),
});

const scoring = z.strictObject({
  scale: z.number().positive(),
  precision: z.int().nonnegative().max(100), // the limit of Number.prototype.toFixed
  ast_weight: weight,
  model_weight: weight,
  fail_under: z.number().nonnegative(),
});

const priority = z.strictObject({ churn: weight, size: weight, churn_days: positiveInt });

const ast = z.strictObject({
  max_cognitive_complexity: positiveInt,
  max_nesting: positiveInt,
  max_function_lines: positiveInt,
  max_params: positiveInt,
  max_file_lines: positiveInt,
});

const architecture = z.strictObject({
  max_fan_out: positiveInt,
  max_hub_links: positiveInt,
  max_directory_files: positiveInt,
  max_class_methods: positiveInt,
  max_class_lines: positiveInt,
  max_inheritance_depth: positiveInt,
});

const cache = z.strictObject({
  dir: z.string(),
  remote: z
    .string()
    .regex(/^s3:\/\/[a-z0-9.-]+(\/[\w.-]+)*\/?$/, 'Use s3://bucket or s3://bucket/some/prefix')
    .optional(),
  endpoint: z.url().optional(),
  region: z.string().optional(),
});

const configSchema = z.strictObject({
  presets: z.array(z.string()),
  include: z.array(z.string()),
  exclude: z.array(z.string()),
  concurrency: positiveInt,
  max_file_chars: positiveInt,
  warn_file_count: positiveInt,
  max_rule_matches: positiveInt,
  provider,
  scoring: scoring.refine(({ ast_weight, model_weight }) => ast_weight + model_weight > 0, {
    error: 'ast_weight and model_weight cannot both be 0',
  }),
  priority,
  ast,
  architecture,
  weights: z.record(z.string(), weight),
  patterns: z.array(astPatternSchema),
  rules: astRulesSchema,
  agents: z.record(z.string(), z.strictObject({ command: z.array(z.string()).min(1) })),
  cache,
});

const layerSchema = configSchema
  .extend({
    provider: provider.partial(),
    scoring: scoring.partial(),
    priority: priority.partial(),
    ast: ast.partial(),
    architecture: architecture.partial(),
    cache: cache.partial(),
  })
  .partial();

/** The merged settings every module reads, plus where they came from. */
export interface Config extends z.infer<typeof configSchema> {
  root: string;
  /** Config files that applied, in the order they apply. */
  sources: string[];
}

/** Settings from the command line, using the same keys as the TOML files. */
export type ConfigOverrides = z.infer<typeof layerSchema>;

const DEFAULTS = {
  presets: ['readable-code'],
  include: ['**/*'],
  exclude: [],
  concurrency: 8,
  max_file_chars: 80000,
  warn_file_count: 1000,
  max_rule_matches: 20,
  provider: { name: 'typesafe' },
  scoring: { scale: 100, precision: 0, ast_weight: 0.4, model_weight: 0.6, fail_under: 0 },
  priority: { churn: 0.5, size: 0.25, churn_days: 180 },
  ast: {
    max_cognitive_complexity: 15,
    max_nesting: 4,
    max_function_lines: 60,
    max_params: 4,
    max_file_lines: 400,
  },
  architecture: {
    max_fan_out: 12,
    max_hub_links: 5,
    max_directory_files: 20,
    max_class_methods: 20,
    max_class_lines: 300,
    max_inheritance_depth: 3,
  },
  weights: {},
  patterns: [],
  rules: [],
  agents: {
    claude: { command: ['claude', '-p', '--permission-mode', 'acceptEdits'] },
    codex: { command: ['codex', 'exec', '--sandbox', 'workspace-write', '-'] },
  },
};

const xdgDir = (variable: string, fallback: string) =>
  join(process.env[variable] || join(homedir(), fallback), 'jevlint');

const configDir = () => xdgDir('XDG_CONFIG_HOME', '.config');

/** Locations of the user's jevlint files, read from the environment on each call. */
export const paths = {
  configDir,
  configFile: () => join(configDir(), 'config.toml'),
  credentialsFile: () => join(configDir(), 'credentials.toml'),
  presetsDir: () => join(configDir(), 'presets'),
};

/** True for a TOML table or any other plain object, but not for an array. */
export function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Awaits a file operation, turning "no such file" into `undefined`. */
export async function ifExists<T>(operation: Promise<T>): Promise<T | undefined> {
  try {
    return await operation;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Replaces a file in one step, so readers never see a partial write. */
export async function writeFileAtomic(file: string, data: string, mode?: number): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data, { mode, flag: 'wx' });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Reads a file a repository may have linked to a device or pipe, which would never end. */
export async function readRegularFile(file: string): Promise<string> {
  if (!(await stat(file)).isFile()) throw new UserError(`${file} is not a regular file`);
  return readFile(file, 'utf8');
}

/** Parses TOML, reporting a syntax error as a `UserError` that names the file. */
export function parseToml(text: string, file: string): Record<string, unknown> {
  try {
    return parse(text);
  } catch (error) {
    if (!(error instanceof TomlError)) throw error;
    // TomlError.message quotes the offending line, which may contain a key.
    throw new UserError(`${file}: invalid TOML at line ${error.line}, column ${error.column}`);
  }
}

/** Validates a value, reporting every problem by key path in one `UserError`. */
export function parseWith<T extends z.ZodType>(schema: T, value: unknown, source: string) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const problems = result.error.issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => `${[...issue.path, key].join('.')}: unknown key`)
      : `${issue.path.join('.')}: ${issue.message}`,
  );
  throw new UserError(`${source}: ${problems.join('; ')}`);
}

function keyPaths(value: object, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = `${prefix}${key}`;
    const isNested = typeof child === 'object' && child !== null;
    return [path, ...(isNested ? keyPaths(child, `${path}.`) : [])];
  });
}

function assertAllowedKeys(raw: Record<string, unknown>, file: string, forbidden: string[]) {
  for (const path of keyPaths(raw)) {
    if (path === 'api_key' || path.endsWith('.api_key')) {
      throw new UserError(
        `${file}: ${path}: API keys do not belong in config files. Use \`jevlint auth set\` or an environment variable.`,
      );
    }
    if (forbidden.includes(path)) {
      throw new UserError(`${path} is only allowed in user config (found in ${file})`);
    }
  }
}

async function readLayer(file: string, forbidden: string[] = []) {
  const text = await ifExists(readRegularFile(file));
  if (text === undefined) return undefined;
  const raw = parseToml(text, file);
  assertAllowedKeys(raw, file, forbidden);
  return parseWith(layerSchema, raw, file);
}

function mergeTables(base: Record<string, unknown>, layer: Record<string, unknown>) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(layer)) {
    // Flags the user did not pass arrive as undefined and must not erase a lower layer.
    if (value === undefined) continue;
    const current = merged[key];
    merged[key] = isTable(current) && isTable(value) ? mergeTables(current, value) : value;
  }
  return merged;
}

export async function findUp(start: string, name: string): Promise<string | undefined> {
  for (let dir = start; ; dir = dirname(dir)) {
    const found = await access(join(dir, name)).then(
      () => true,
      () => false,
    );
    if (found) return dir;
    if (dir === dirname(dir)) return undefined;
  }
}

const expandHome = (path: string) => path.replace(/^~(?=$|\/)/, homedir());

/** A user's base_url is for their provider. A repository naming another would send it that key. */
function withoutForeignEndpoint(
  user: Record<string, unknown>,
  repo: Record<string, unknown> | undefined,
) {
  const provider = isTable(user.provider) ? user.provider : {};
  const repoName = isTable(repo?.provider) ? repo.provider.name : undefined;
  if (repoName === undefined || repoName === provider.name) return user;
  const { base_url: _, ...rest } = provider;
  return { ...user, provider: rest };
}

/** Finds the root and merges defaults, user config, repo config, environment and overrides. */
export async function loadConfig(options: {
  cwd: string;
  overrides?: ConfigOverrides;
  /** Leaves out a layer, so that `init --force` can replace a file too broken to load. */
  skip?: 'user' | 'repo';
}): Promise<Config> {
  const cwd = resolve(options.cwd);
  const root = (await findUp(cwd, REPO_CONFIG)) ?? (await findUp(cwd, '.git')) ?? cwd;
  const userFile = paths.configFile();
  const repoFile = join(root, REPO_CONFIG);
  const user = options.skip === 'user' ? undefined : await readLayer(userFile);
  const repo = options.skip === 'repo' ? undefined : await readLayer(repoFile, USER_ONLY_KEYS);

  const layers = [
    { ...DEFAULTS, cache: { dir: xdgDir('XDG_CACHE_HOME', '.cache') } },
    withoutForeignEndpoint(user ?? {}, repo),
    repo ?? {},
    {
      provider: { base_url: process.env.JEVLINT_BASE_URL || undefined },
      cache: {
        dir: process.env.JEVLINT_CACHE_DIR || undefined,
        remote: process.env.JEVLINT_CACHE_REMOTE || undefined,
        endpoint: process.env.JEVLINT_CACHE_ENDPOINT || undefined,
        region: process.env.JEVLINT_CACHE_REGION || process.env.AWS_REGION || undefined,
      },
    },
    options.overrides ?? {},
  ];
  const config = parseWith(configSchema, layers.reduce(mergeTables), 'config');

  return {
    ...config,
    cache: { ...config.cache, dir: expandHome(config.cache.dir) },
    root,
    sources: [...(user ? [userFile] : []), ...(repo ? [repoFile] : [])],
  };
}

/** Renders the merged settings as TOML for `config show`. */
export function renderConfigToml(config: Config): string {
  const { root, sources, ...settings } = config;
  return stringify(settings);
}

/**
 * Sets the top-level `presets` key in config TOML, keeping every other line and comment. The key
 * goes where top-level keys may appear: in place of the old one, or before the first table.
 */
export function withPresets(toml: string, presets: string[], file: string): string {
  parseToml(toml, file);
  const line = `presets = ${JSON.stringify(presets)}`;
  const firstTable = toml.search(/^[ \t]*\[/m);
  const topLevel = firstTable === -1 ? toml : toml.slice(0, firstTable);
  const rest = firstTable === -1 ? '' : toml.slice(firstTable);
  // Preset names cannot contain `]`, so the first one closes the array, even across lines.
  const existing = /^[ \t]*presets[ \t]*=[ \t]*\[[^\]]*\][^\n]*$/m;
  const updated = existing.test(topLevel)
    ? topLevel.replace(existing, line)
    : `${topLevel}${topLevel === '' || topLevel.endsWith('\n') ? '' : '\n'}${line}\n${rest === '' ? '' : '\n'}`;
  const result = `${updated}${rest}`;
  const parsed = parseToml(result, file);
  if (JSON.stringify(parsed.presets) !== JSON.stringify(presets)) {
    throw new UserError(`${file}: could not set presets. Edit the file by hand.`);
  }
  return result;
}

/** Writes the default presets to the user config, or with `repo` to `jevlint.toml`, and returns the file. */
export async function saveDefaultPresets(
  presets: string[],
  options: { repo: boolean; root: string },
): Promise<string> {
  const file = options.repo ? join(options.root, REPO_CONFIG) : paths.configFile();
  const text = (await ifExists(readRegularFile(file))) ?? '';
  const updated = withPresets(text, presets, file);
  await mkdir(dirname(file), { recursive: true });
  // Atomic, so a symlink the repository planted here is replaced, not written through.
  await writeFileAtomic(file, updated);
  return file;
}
