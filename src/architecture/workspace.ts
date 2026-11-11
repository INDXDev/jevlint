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

/** Where manifests are read from: the working tree, or one commit. */
export interface ManifestSource {
  /** A root-relative file's text, or undefined if there is none. */
  read: (path: string) => Promise<string | undefined>;
  /** Root-relative files that match any of the globs, outside `node_modules`, never through a link. */
  glob: (patterns: string[]) => Promise<string[]>;
}

/** Manifests in the working tree. A device or FIFO planted at a path is an error, never a hang. */
export function workingTree(root: string): ManifestSource {
  return {
    read: (path) => ifExists(readRegularFile(join(root, path))),
    glob: async (patterns) => {
      const found = await glob(patterns, {
        cwd: root,
        followSymbolicLinks: false,
        ignore: ['**/node_modules/**'],
        onlyFiles: true,
      });
      const inside = await Promise.all(
        // A manifest linked from outside the repository is not the repository's to describe.
        found.map((path) =>
          assertInRepo(join(root, path), root).then(
            () => true,
            () => false,
          ),
        ),
      );
      return found.filter((_, index) => inside[index]);
    },
  };
}

/** Manifests as one commit has them, read through `read` from the commit's `files`. */
export function atCommit(
  files: string[],
  read: (path: string) => Promise<string | undefined>,
): ManifestSource {
  return {
    read,
    glob: async (patterns) =>
      files.filter(
        (path) =>
          !path.split('/').includes('node_modules') &&
          patterns.some((pattern) => posix.matchesGlob(path, pattern)),
      ),
  };
}

const sourceOf = (from: string | ManifestSource) =>
  typeof from === 'string' ? workingTree(from) : from;

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
export async function goModuleOf(from: string | ManifestSource): Promise<string | undefined> {
  return (await sourceOf(from).read('go.mod'))?.match(/^module\s+(\S+)/m)?.[1];
}

/** The root `tsconfig.json`'s `paths`, made root-relative, most specific pattern first. */
export async function tsconfigAliases(from: string | ManifestSource): Promise<PathAlias[]> {
  const tsconfig = parseJson(await sourceOf(from).read('tsconfig.json'));
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

async function workspaceGlobs(source: ManifestSource): Promise<string[]> {
  const manifest = parseJson(await source.read('package.json'));
  const workspaces = manifest?.workspaces;
  const fromPackage = isTable(workspaces) ? strings(workspaces.packages) : strings(workspaces);
  let fromPnpm: string[] = [];
  try {
    const pnpm: unknown = parseYaml((await source.read('pnpm-workspace.yaml')) ?? '', {
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
export async function workspacePackages(
  from: string | ManifestSource,
): Promise<WorkspacePackage[]> {
  const source = sourceOf(from);
  const patterns = await workspaceGlobs(source);
  if (patterns.length === 0) return [];
  const manifests = await source.glob(
    patterns.map((pattern) => posix.join(pattern, 'package.json')),
  );
  const packages: WorkspacePackage[] = [];
  for (const path of manifests.filter(isInside).sort().slice(0, MAX_WORKSPACE_PACKAGES)) {
    const manifest = parseJson(await source.read(path));
    if (typeof manifest?.name !== 'string' || manifest.name === '') continue;
    const dir = posix.dirname(path);
    packages.push({ name: manifest.name, dir, entries: entriesOf(dir, manifest) });
  }
  return packages.sort((a, b) => b.name.length - a.name.length);
}

/** Files `package.json` names as `bin` or `main`, each with its kind. */
export async function manifestEntries(from: string | ManifestSource): Promise<Map<string, string>> {
  const manifest = parseJson(await sourceOf(from).read('package.json'));
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
