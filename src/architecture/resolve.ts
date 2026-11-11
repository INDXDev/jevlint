/**
 * Turns import specifiers into repository paths, and names the package of anything outside the
 * repository. Pure: the caller reads tsconfig and workspace manifests.
 */
import { builtinModules } from 'node:module';
import { dirname, join, normalize } from 'node:path/posix';
import type { Language, PathAlias, WorkspacePackage } from '../types.ts';

export type { PathAlias, WorkspacePackage };

/** What resolving needs to know about the repository. */
export interface ResolveContext {
  /** Every file in the graph, relative to the root. */
  files: Set<string>;
  /** The Go module path from `go.mod`. */
  goModule?: string;
  /** TypeScript `paths` aliases, most specific first. */
  aliases?: PathAlias[];
  packages?: WorkspacePackage[];
}

const ECMASCRIPT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** TypeScript imports name the compiled file, so `./a.js` can mean `./a.ts`. */
function fileCandidates(path: string): string[] {
  const stem = path.replace(/\.[cm]?jsx?$/, '');
  return [
    path,
    ...ECMASCRIPT_EXTENSIONS.flatMap((extension) => [
      `${stem}${extension}`,
      join(path, `index${extension}`),
    ]),
  ];
}

/** What `*` stands for when `specifier` matches `pattern`, or undefined when it does not. */
function wildcardMatch(pattern: string, specifier: string): string | undefined {
  const star = pattern.indexOf('*');
  if (star === -1) return pattern === specifier ? '' : undefined;
  const [prefix, suffix] = [pattern.slice(0, star), pattern.slice(star + 1)];
  const fits =
    specifier.length >= prefix.length + suffix.length &&
    specifier.startsWith(prefix) &&
    specifier.endsWith(suffix);
  return fits ? specifier.slice(prefix.length, specifier.length - suffix.length) : undefined;
}

// A target may climb out of the root, which no repository file can be.
const insideRoot = (path: string) => (path.startsWith('../') || path === '..' ? [] : [path]);

function aliasCandidates(specifier: string, aliases: PathAlias[]): string[] {
  return aliases.flatMap(({ pattern, targets }) => {
    const matched = wildcardMatch(pattern, specifier);
    if (matched === undefined) return [];
    return targets.flatMap((target) =>
      insideRoot(normalize(target.replace('*', matched))).flatMap(fileCandidates),
    );
  });
}

function packageCandidates(specifier: string, packages: WorkspacePackage[]): string[] {
  return packages.flatMap(({ name, dir, entries }) => {
    if (specifier === name) {
      return [...entries, join(dir, 'src', 'index'), join(dir, 'index')].flatMap(fileCandidates);
    }
    if (!specifier.startsWith(`${name}/`)) return [];
    const subpath = specifier.slice(name.length + 1);
    return [join(dir, subpath), join(dir, 'src', subpath)].flatMap(fileCandidates);
  });
}

function ecmascriptCandidates(specifier: string, from: string, context: ResolveContext): string[] {
  if (specifier.startsWith('.')) return fileCandidates(join(dirname(from), specifier));
  return [
    ...aliasCandidates(specifier, context.aliases ?? []),
    ...packageCandidates(specifier, context.packages ?? []),
  ];
}

/** Each path with one fewer trailing segment, because the tail may name a symbol, not a file. */
function shrinking(segments: string[]): string[][] {
  return segments.map((_, index) => segments.slice(0, segments.length - index));
}

function pythonCandidates(specifier: string, from: string): string[] {
  const dots = specifier.match(/^\.*/)?.[0].length ?? 0;
  const segments = specifier.slice(dots).split('.').filter(Boolean);
  const parents = '../'.repeat(Math.max(0, dots - 1));
  const bases = dots > 0 ? [join(dirname(from), parents)] : ['.', 'src'];
  return bases.flatMap((base) => [
    ...shrinking(segments).flatMap((path) => {
      const module = join(base, ...path);
      return [`${module}.py`, `${module}/__init__.py`];
    }),
    ...(dots > 0 ? [join(base, '__init__.py')] : []),
  ]);
}

/** shortcut: a package maps to its first file, so read Go graphs at directory level. */
function goCandidates(specifier: string, { files, goModule }: ResolveContext): string[] {
  if (!goModule || (specifier !== goModule && !specifier.startsWith(`${goModule}/`))) return [];
  const directory = specifier.slice(goModule.length + 1) || '.';
  return [...files]
    .filter((file) => dirname(file) === directory && /(?<!_test)\.go$/.test(file))
    .sort();
}

/** Where a file's child modules live: `a/b.rs` keeps them in `a/b/`, `a/mod.rs` in `a/`. */
function rustModuleDir(from: string): string {
  return /(^|\/)(mod|lib|main)\.rs$/.test(from) ? dirname(from) : from.replace(/\.rs$/, '');
}

function rustCandidates(specifier: string, from: string): string[] {
  const [first, ...rest] = specifier.split('::');
  const crateRoot = from.match(/^(?:.*?\/)?src(?=\/)/)?.[0] ?? '.';
  let base = rustModuleDir(from);
  let segments = rest;
  if (first === 'crate') base = crateRoot;
  else if (first === 'super') base = dirname(base);
  else if (first !== 'self') return [];
  while (segments[0] === 'super') {
    base = dirname(base);
    segments = segments.slice(1);
  }
  return shrinking(segments).flatMap((path) => {
    const module = join(base, ...path);
    return [`${module}.rs`, `${module}/mod.rs`];
  });
}

function candidates(
  specifier: string,
  from: string,
  language: Language,
  context: ResolveContext,
): string[] {
  if (language === 'python') return pythonCandidates(specifier, from);
  if (language === 'go') return goCandidates(specifier, context);
  if (language === 'rust') return rustCandidates(specifier, from);
  return ecmascriptCandidates(specifier, from, context);
}

/** Returns the repository file an import points to, or null. */
export function resolveImport(
  specifier: string,
  from: string,
  language: Language,
  context: ResolveContext,
): string | null {
  const found = candidates(specifier, from, language, context).find((path) =>
    context.files.has(path),
  );
  return found && found !== from ? found : null;
}

const NODE_BUILTINS = new Set(builtinModules.filter((name) => !name.startsWith('_')));

function ecmascriptPackage(specifier: string): string | null {
  if (/^[./#]/.test(specifier) || specifier === '') return null;
  const [first = '', second] = specifier.split('/');
  if (specifier.startsWith('node:')) return first;
  if (NODE_BUILTINS.has(first)) return `node:${first}`;
  // Bundler schemes such as `virtual:` name no package.
  if (first.includes(':')) return null;
  return first.startsWith('@') && second ? `${first}/${second}` : first;
}

function goPackage(specifier: string, goModule: string | undefined): string | null {
  if (goModule && (specifier === goModule || specifier.startsWith(`${goModule}/`))) return null;
  const segments = specifier.split('/');
  // The standard library's paths have no domain.
  if (!segments[0]?.includes('.')) return `go:${segments[0]}`;
  return segments.slice(0, 3).join('/');
}

function rustPackage(specifier: string): string | null {
  const [first = ''] = specifier.split('::');
  if (/^(crate|self|super)$/.test(first) || first === '') return null;
  return /^(std|core|alloc)$/.test(first) ? `rust:${first}` : first;
}

/**
 * The package an unresolved import names, such as `@ai-sdk/openai` for `@ai-sdk/openai/x` and
 * `node:fs` for `fs/promises`. Null when it names no package, as a relative path does.
 */
export function packageOf(
  specifier: string,
  language: Language,
  { goModule }: Pick<ResolveContext, 'goModule'> = {},
): string | null {
  if (language === 'python') {
    if (specifier.startsWith('.')) return null;
    return specifier.split('.')[0] || null;
  }
  if (language === 'go') return goPackage(specifier, goModule);
  if (language === 'rust') return rustPackage(specifier);
  return ecmascriptPackage(specifier);
}
