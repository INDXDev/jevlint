/** Turns import specifiers into repository paths. Anything outside the repository gives null. */
import { dirname, join } from 'node:path/posix';
import type { Language } from '../types.ts';

/** What resolving needs to know about the repository. */
export interface ResolveContext {
  /** Every file in the graph, relative to the root. */
  files: Set<string>;
  /** The Go module path from `go.mod`. */
  goModule?: string;
}

const ECMASCRIPT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** TypeScript imports name the compiled file, so `./a.js` can mean `./a.ts`. */
function ecmascriptCandidates(specifier: string, from: string): string[] {
  // shortcut: tsconfig `paths` aliases and workspace packages stay unresolved; read tsconfig if asked.
  if (!specifier.startsWith('.')) return [];
  const path = join(dirname(from), specifier);
  const stem = path.replace(/\.[cm]?jsx?$/, '');
  return [
    path,
    ...ECMASCRIPT_EXTENSIONS.flatMap((extension) => [
      `${stem}${extension}`,
      join(path, `index${extension}`),
    ]),
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
  return ecmascriptCandidates(specifier, from);
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
