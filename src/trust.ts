/**
 * Which repositories' `quickfix.after` commands the user approved. The record lives in the user's
 * config directory, keyed by project root, with a fingerprint of the commands, the repository's
 * history and the files those commands read to decide what they run.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  type Fixer,
  ifExists,
  isTable,
  paths,
  readRegularFile,
  UserError,
  writeFileAtomic,
} from './config.ts';
import { rootCommits } from './git.ts';

const JS_RUNNER = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.pnpmfile.cjs',
  'yarn.lock',
  '.yarnrc',
  '.yarnrc.yml',
  'bun.lock',
  'bun.lockb',
  'bunfig.toml',
  '.npmrc',
  'deno.json',
  'deno.jsonc',
  'deno.lock',
];
const PYTHON_RUNNER = [
  'pyproject.toml',
  'uv.lock',
  'poetry.lock',
  'pdm.lock',
  'requirements.txt',
  'setup.py',
  'setup.cfg',
  'tox.ini',
  'noxfile.py',
];
const CARGO = [
  'Cargo.toml',
  'Cargo.lock',
  '.cargo/config',
  '.cargo/config.toml',
  'rust-toolchain',
  'rust-toolchain.toml',
  'build.rs',
];
const MAKE = ['Makefile', 'makefile', 'GNUmakefile'];
const JS_CONFIG = (name: string) =>
  ['js', 'cjs', 'mjs', 'ts', 'cts', 'mts'].map((extension) => `${name}.${extension}`);
const RUBY = ['Gemfile', 'Gemfile.lock', 'Rakefile'];
const JVM = [
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'gradle/wrapper/gradle-wrapper.properties',
  'pom.xml',
  '.mvn/wrapper/maven-wrapper.properties',
];

/**
 * Files in the repository a program reads to decide what code it runs, by program name: scripts,
 * lockfiles, and config that can load code. A command's arguments are looked up here too, so
 * `pnpm eslint` covers both.
 */
const PROGRAM_FILES: Record<string, string[]> = {
  ...Object.fromEntries(
    ['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'node', 'deno', 'corepack'].map(
      (name) => [name, JS_RUNNER],
    ),
  ),
  ...Object.fromEntries(
    ['uv', 'uvx', 'poetry', 'pdm', 'hatch', 'pip', 'python', 'python3', 'tox', 'nox'].map(
      (name) => [name, PYTHON_RUNNER],
    ),
  ),
  cargo: CARGO,
  make: MAKE,
  gmake: MAKE,
  go: ['go.mod', 'go.sum', 'go.work'],
  bundle: RUBY,
  rake: RUBY,
  ruby: RUBY,
  gradle: JVM,
  gradlew: JVM,
  mvn: JVM,
  mvnw: JVM,
  just: ['justfile', 'Justfile', '.justfile'],
  composer: ['composer.json', 'composer.lock'],
  eslint: [...JS_CONFIG('eslint.config'), '.eslintrc.js', '.eslintrc.cjs'],
  prettier: [...JS_CONFIG('prettier.config'), ...JS_CONFIG('.prettierrc')],
  biome: ['biome.json', 'biome.jsonc'],
};

/** `pnpm`, `./node_modules/.bin/eslint` and `eslint.cmd` all name their program the same way. */
const programName = (argument: string) =>
  basename(argument)
    .toLowerCase()
    .replace(/\.(cmd|exe|bat|ps1)$/, '');

/** The root-relative path an argument names, when it names one inside the root. */
function insideRoot(root: string, argument: string): string | undefined {
  if (argument === '') return undefined;
  const path = relative(root, resolve(root, argument));
  if (path === '' || path.startsWith('..') || isAbsolute(path)) return undefined;
  return path;
}

/**
 * The repository files these commands read to decide what they run: every argument that names a
 * file in the root, as in `sh scripts/fix.sh` or `--config=x.js`, and each program's own files.
 */
export function referencedFiles(root: string, fixers: Fixer[]): string[] {
  const found = new Set<string>();
  for (const argument of fixers.flatMap(({ command }) => command)) {
    const value = argument.startsWith('-') ? argument.split('=').slice(1).join('=') : argument;
    const path = insideRoot(root, value);
    if (path !== undefined) found.add(path);
    for (const file of PROGRAM_FILES[programName(argument)] ?? []) found.add(file);
  }
  return [...found].sort();
}

/** A regular file's hash, or null when there is none at the path. */
async function contentHash(file: string): Promise<string | null> {
  const info = await ifExists(stat(file));
  if (info === undefined || !info.isFile()) return null;
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

/**
 * Fingerprints everything that changes what the commands run or what reaches the agent: the
 * commands, the repository's root commits, and the content of the files they read. Installed
 * tools, such as `node_modules`, are not covered.
 */
export async function fixersFingerprint(root: string, fixers: Fixer[]): Promise<string> {
  const commands = fixers.map(({ command, files, retry }) => ({
    command,
    files: files ?? null,
    retry: retry ?? false,
  }));
  const files = await Promise.all(
    referencedFiles(root, fixers).map(async (path) => [
      path,
      await contentHash(resolve(root, path)),
    ]),
  );
  const canonical = { commands, history: await rootCommits(root), files };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

async function readRecord(): Promise<Record<string, string>> {
  const file = paths.trustFile();
  const text = await ifExists(readRegularFile(file));
  if (text === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isTable(parsed)) throw new Error('not an object');
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    throw new UserError(`${file} is not valid JSON. Delete it to approve commands again.`);
  }
}

async function writeRecord(record: Record<string, string>): Promise<void> {
  const file = paths.trustFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`, 0o600);
}

/**
 * Whether the user approved these commands for this root as they are now: `approved`, `changed`
 * when the commands or a file they read changed since, or `none`.
 */
export async function approval(
  root: string,
  fixers: Fixer[],
): Promise<'approved' | 'changed' | 'none'> {
  const record = await readRecord();
  if (!Object.hasOwn(record, root)) return 'none';
  return record[root] === (await fixersFingerprint(root, fixers)) ? 'approved' : 'changed';
}

/** Records the user's approval of these commands, as they are now, for this project root. */
export async function trust(root: string, fixers: Fixer[]): Promise<void> {
  const fingerprint = await fixersFingerprint(root, fixers);
  await writeRecord({ ...(await readRecord()), [root]: fingerprint });
}

/** Forgets any approval for this project root. Returns whether there was one. */
export async function untrust(root: string): Promise<boolean> {
  const record = await readRecord();
  if (!Object.hasOwn(record, root)) return false;
  const { [root]: _, ...rest } = record;
  await writeRecord(rest);
  return true;
}
