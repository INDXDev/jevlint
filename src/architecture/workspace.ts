/**
 * Reads what import resolution needs from the repository's manifests: `go.mod`, the `paths` of
 * `tsconfig.json`, and pnpm, npm and bun workspaces. Every file read is the repository's, so
 * each is parsed defensively and anything that points outside the root is dropped.
 */
import { join, posix } from 'node:path';
import { glob } from 'tinyglobby';
import { parse as parseYaml } from 'yaml';
import { ifExists, isTable, readRegularFile } from '../config.ts';
import { assertInRepo } from '../presets.ts';
import type { PathAlias, WorkspacePackage } from '../types.ts';

const MAX_WORKSPACE_PACKAGES = 500;
const MAX_ALIASES = 10;

/** A missing file is undefined. A device or FIFO planted at the path is an error, never a hang. */
function readText(root: string, path: string): Promise<string | undefined> {
  return ifExists(readRegularFile(join(root, path)));
}

/**
 * Removes comments and trailing commas, which tsconfig allows, while leaving strings alone.
 */
export function stripJsonComments(text: string): string {
  let result = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string;
    if (char === '"') {
      const end = endOfString(text, index);
      result += text.slice(index, end);
      index = end - 1;
    } else if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index++;
      result += '\n';
    } else if (char === '/' && text[index + 1] === '*') {
      index = text.indexOf('*/', index + 2);
      if (index === -1) break;
      index++;
    } else result += char;
  }
  return result.replace(/,(\s*[}\]])/g, '$1');
}

function endOfString(text: string, start: number): number {
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') index++;
    else if (text[index] === '"') return index + 1;
  }
  return text.length;
}

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(stripJsonComments(text));
    return isTable(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const isInside = (path: string) =>
  !path.startsWith('../') && path !== '..' && !posix.isAbsolute(path);

/** The Go module path from `go.mod`. */
export async function goModuleOf(root: string): Promise<string | undefined> {
  return (await readText(root, 'go.mod'))?.match(/^module\s+(\S+)/m)?.[1];
}

/** The root `tsconfig.json`'s `paths`, made root-relative, most specific pattern first. */
export async function tsconfigAliases(root: string): Promise<PathAlias[]> {
  const tsconfig = parseJson(await readText(root, 'tsconfig.json'));
  const options = isTable(tsconfig?.compilerOptions) ? tsconfig.compilerOptions : {};
  const baseUrl = typeof options.baseUrl === 'string' ? options.baseUrl : '.';
  const paths = isTable(options.paths) ? options.paths : {};
  return Object.entries(paths)
    .filter(([pattern]) => pattern.split('*').length <= 2)
    .map(([pattern, targets]) => ({
      pattern,
      targets: strings(targets)
        .slice(0, MAX_ALIASES)
        .filter((target) => target.split('*').length <= 2)
        .map((target) => posix.normalize(posix.join(baseUrl, target)))
        .filter(isInside),
    }))
    .filter(({ targets }) => targets.length > 0)
    .sort((a, b) => b.pattern.length - a.pattern.length);
}

async function workspaceGlobs(root: string): Promise<string[]> {
  const manifest = parseJson(await readText(root, 'package.json'));
  const workspaces = manifest?.workspaces;
  const fromPackage = isTable(workspaces) ? strings(workspaces.packages) : strings(workspaces);
  let fromPnpm: string[] = [];
  try {
    const pnpm: unknown = parseYaml((await readText(root, 'pnpm-workspace.yaml')) ?? '', {
      maxAliasCount: 10,
    });
    fromPnpm = isTable(pnpm) ? strings(pnpm.packages) : [];
  } catch {
    fromPnpm = [];
  }
  return [...fromPackage, ...fromPnpm].filter(
    (pattern) => !pattern.startsWith('!') && isInside(posix.normalize(pattern)),
  );
}

function exportEntries(exports: unknown): string[] {
  if (typeof exports === 'string') return [exports];
  if (!isTable(exports)) return [];
  const main = exports['.'] ?? exports;
  if (typeof main === 'string') return [main];
  if (!isTable(main)) return [];
  return Object.values(main).flatMap((value) =>
    typeof value === 'string' ? [value] : isTable(value) ? exportEntries(value) : [],
  );
}

function entriesOf(dir: string, manifest: Record<string, unknown>): string[] {
  const named = [
    ...exportEntries(manifest.exports),
    ...['source', 'module', 'main', 'types'].flatMap((key) =>
      typeof manifest[key] === 'string' ? [manifest[key] as string] : [],
    ),
  ];
  return [...new Set(named.map((entry) => posix.normalize(posix.join(dir, entry))))].filter(
    isInside,
  );
}

/** Every workspace package with a name, from `package.json` and `pnpm-workspace.yaml`. */
export async function workspacePackages(root: string): Promise<WorkspacePackage[]> {
  const patterns = await workspaceGlobs(root);
  if (patterns.length === 0) return [];
  const manifests = await glob(
    patterns.map((pattern) => posix.join(pattern, 'package.json')),
    { cwd: root, followSymbolicLinks: false, ignore: ['**/node_modules/**'], onlyFiles: true },
  );
  const packages: WorkspacePackage[] = [];
  for (const path of manifests.filter(isInside).sort().slice(0, MAX_WORKSPACE_PACKAGES)) {
    // A manifest linked from outside the repository is not the repository's to describe.
    const inside = await assertInRepo(join(root, path), root).then(
      () => true,
      () => false,
    );
    if (!inside) continue;
    const manifest = parseJson(await readText(root, path));
    if (typeof manifest?.name !== 'string' || manifest.name === '') continue;
    const dir = posix.dirname(path);
    packages.push({ name: manifest.name, dir, entries: entriesOf(dir, manifest) });
  }
  return packages.sort((a, b) => b.name.length - a.name.length);
}

/** Files `package.json` names as `bin` or `main`, each with its kind. */
export async function manifestEntries(root: string): Promise<Map<string, string>> {
  const manifest = parseJson(await readText(root, 'package.json'));
  const entries = new Map<string, string>();
  if (!manifest) return entries;
  const bins =
    typeof manifest.bin === 'string'
      ? [manifest.bin]
      : isTable(manifest.bin)
        ? Object.values(manifest.bin).filter((bin): bin is string => typeof bin === 'string')
        : [];
  for (const bin of bins) entries.set(posix.normalize(bin), 'package-bin');
  if (typeof manifest.main === 'string') {
    const main = posix.normalize(manifest.main);
    if (!entries.has(main)) entries.set(main, 'package-main');
  }
  return entries;
}
