/**
 * Reads the repository, or one of its commits, into resolved outlines and architecture facts.
 * Shared by every `jevlint architecture` verb. Outlines are cached by content hash.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, posix, relative } from 'node:path';
import { parse, type SgNode } from '@ast-grep/napi';
import pLimit from 'p-limit';
import { LANGUAGES, languageOf } from '../ast/languages.ts';
import { cacheKey, readCache, writeCache } from '../cache.ts';
import { type Config, UserError } from '../config.ts';
import { discoverFiles, excludedPaths } from '../files.ts';
import { commitCounts, fileAt, filesAt, headCommit, recentCommitFiles } from '../git.ts';
import type { ArchitectureFacts, FactModule, Language } from '../types.ts';
import type { CallMatch, CallSearch } from './conformance.ts';
import { entryKind } from './entrypoints.ts';
import { extractModule, type ModuleOutline } from './extract.ts';
import { buildFacts } from './facts.ts';
import { packageOf, type ResolveContext, resolveImport } from './resolve.ts';
import type { ResolvedOutline } from './structure.ts';
import {
  atCommit,
  goModuleOf,
  type ManifestSource,
  manifestEntries,
  tsconfigAliases,
  workingTree,
  workspacePackages,
} from './workspace.ts';

/** Bumped whenever an outline's shape changes, so stale cache entries are never read. */
const OUTLINE_VERSION = 2;
/** Co-change reads no more commits than this, so a long history stays cheap. */
const MAX_CO_CHANGE_COMMITS = 300;

/** Narrows what is collected, and where from. */
export interface CollectOptions {
  paths?: string[];
  /** Read the files of this commit from git instead of the working tree. A full hash. */
  commit?: string;
  noCache?: boolean;
  /** Keep each file's source in the result, for rules that match code. */
  keepSources?: boolean;
  /** Skip churn and co-change, which only the facts' readers want. */
  skipHistory?: boolean;
}

/** One file read and outlined. */
interface Read {
  outline: ModuleOutline;
  entry: string | null;
  source?: string;
}

/** Everything collected: outlines for the structure, modules and facts for the SSOT. */
export interface Collected {
  /** Root-relative paths of every file with a grammar. */
  paths: string[];
  resolved: ResolvedOutline[];
  modules: FactModule[];
  facts: ArchitectureFacts;
  /** Sources by path, when `keepSources` was set. */
  sources: Map<string, string>;
  /** Whether a root-relative file or directory exists in the tree collected, for `key_files`. */
  exists: (path: string) => boolean;
  warnings: string[];
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

async function outlineOf(config: Config, path: string, source: string, noCache?: boolean) {
  const language = languageOf(path);
  if (!language) return null;
  const key = cacheKey({
    kind: 'architecture-outline',
    OUTLINE_VERSION,
    path,
    language,
    sha: hash(source),
  });
  const cached = noCache ? undefined : await readCache<ModuleOutline>(config.cache.dir, key);
  if (cached?.path === path) return cached;
  const outline = extractModule(path, source, language);
  if (!noCache) await writeCache(config.cache.dir, key, outline).catch(() => {});
  return outline;
}

/** The files a commit holds that discovery would read, as `discoverFiles` lists the working tree. */
export async function filesOfCommit(
  config: Config,
  commit: string,
  paths?: string[],
): Promise<string[]> {
  const all = (await filesAt(config.root, commit)).filter((path) => languageOf(path) !== null);
  const included = all.filter((path) =>
    config.include.some((pattern) => posix.matchesGlob(path, pattern)),
  );
  const excluded = new Set(await excludedPaths(config, included));
  const targets = paths?.map((path) => posix.normalize(path).replace(/\/$/, ''));
  return included
    .filter((path) => !excluded.has(path))
    .filter((path) => !targets || targets.some((t) => path === t || path.startsWith(`${t}/`)))
    .sort();
}

/** `dist/cli.mjs` in package.json usually means `src/cli.ts`, so try the source too. */
function manifestTargets(manifest: Map<string, string>, files: Set<string>): Map<string, string> {
  const found = new Map<string, string>();
  for (const [entry, kind] of manifest) {
    const stem = entry.replace(/^\.\//, '').replace(/\.[cm]?[jt]sx?$/, '');
    const stems = [stem, stem.replace(/^(dist|lib|build|out)\//, 'src/')];
    const match = stems
      .flatMap((candidate) =>
        ['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs'].map((e) => `${candidate}${e}`),
      )
      .find((candidate) => files.has(candidate));
    if (match) found.set(match, kind);
  }
  return found;
}

async function readAll(
  config: Config,
  files: string[],
  options: CollectOptions,
  manifests: ManifestSource,
) {
  const warnings: string[] = [];
  const limit = pLimit(config.concurrency);
  const manifest = manifestTargets(await manifestEntries(manifests), new Set(files));
  const read = await Promise.all(
    files.map((path) =>
      limit(async (): Promise<Read | null> => {
        const source = options.commit
          ? await fileAt(config.root, options.commit, path)
          : await readFile(join(config.root, path), 'utf8').catch((error: Error) => {
              warnings.push(`Could not read ${path}: ${error.message}`);
              return undefined;
            });
        if (source === undefined) return null;
        const outline = await outlineOf(config, path, source, options.noCache);
        if (!outline) return null;
        const entry = entryKind(path, outline.language, source, manifest);
        return options.keepSources ? { outline, entry, source } : { outline, entry };
      }),
    ),
  );
  return { read: read.filter((item): item is Read => item !== null), warnings };
}

async function resolveContext(files: string[], manifests: ManifestSource): Promise<ResolveContext> {
  const [goModule, aliases, packages] = await Promise.all([
    goModuleOf(manifests),
    tsconfigAliases(manifests),
    workspacePackages(manifests),
  ]);
  return { files: new Set(files), goModule, aliases, packages };
}

/** Resolves each import to a repository file, or names its package, keeping its line. */
export function resolveModules(outlines: ModuleOutline[], context: ResolveContext) {
  const modules: FactModule[] = outlines.map((outline) => {
    const { path, language, lines, imports, symbols, types = [], comments = [] } = outline;
    const resolvedImports: FactModule['imports'] = [];
    const externals: FactModule['externals'] = [];
    const seen = new Set<string>();
    for (const { specifier, line, names } of imports) {
      const target = resolveImport(specifier, path, language, context);
      if (target !== null) {
        if (seen.has(target)) continue;
        seen.add(target);
        resolvedImports.push(names ? { path: target, line, names } : { path: target, line });
        continue;
      }
      const name = packageOf(specifier, language, context);
      if (name !== null && !externals.some((known) => known.package === name)) {
        externals.push({ package: name, line });
      }
    }
    return { path, language, lines, imports: resolvedImports, externals, symbols, types, comments };
  });
  const resolved: ResolvedOutline[] = outlines.map((outline, index) => ({
    ...outline,
    imports: (modules[index] as FactModule).imports.map(({ path }) => path),
  }));
  return { modules, resolved };
}

/** One commit's manifests, and whether a file or directory exists in it. */
async function treeAt(root: string, commit: string) {
  const files = await filesAt(root, commit);
  const known = new Set(files);
  const dirs = new Set(
    files.flatMap((path) => {
      const parts = path.split('/');
      return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join('/'));
    }),
  );
  const exists = (path: string) => {
    const normal = posix.normalize(path).replace(/\/$/, '');
    return known.has(normal) || dirs.has(normal);
  };
  return { manifests: atCommit(files, (path) => fileAt(root, commit, path)), exists };
}

/** Reads, outlines and resolves every file in scope, then builds the facts. */
export async function collect(config: Config, options: CollectOptions = {}): Promise<Collected> {
  const { root } = config;
  const files = options.commit
    ? await filesOfCommit(config, options.commit, options.paths)
    : await discoverFiles(config, options.paths);
  const grammarFiles = files.filter((path) => languageOf(path) !== null);
  // At a commit, manifests and `key_files` come from that commit too, or a change would cancel out.
  const tree = options.commit ? await treeAt(root, options.commit) : null;
  const manifests = tree ? tree.manifests : workingTree(root);
  const [{ read, warnings }, context, commit, churn, commits] = await Promise.all([
    readAll(config, grammarFiles, options, manifests),
    resolveContext(grammarFiles, manifests),
    options.commit ? Promise.resolve(options.commit) : headCommit(root),
    options.skipHistory
      ? new Map<string, number>()
      : commitCounts(root, config.priority.churn_days),
    options.skipHistory ? [] : recentCommitFiles(root, MAX_CO_CHANGE_COMMITS),
  ]);
  const { modules, resolved } = resolveModules(
    read.map(({ outline }) => outline),
    context,
  );
  const facts = buildFacts({
    root,
    commit,
    modules,
    entrypoints: read.flatMap(({ outline, entry }) =>
      entry ? [{ path: outline.path, kind: entry }] : [],
    ),
    churn,
    commits,
    warnings,
  });
  const sources = new Map(
    read.flatMap(({ outline, source }) => (source === undefined ? [] : [[outline.path, source]])),
  );
  const exists = tree ? tree.exists : existsIn(root);
  return { paths: grammarFiles, resolved, modules, facts, sources, exists, warnings };
}

/**
 * Runs each `forbid-call` search with ast-grep over the sources it covers. A rule with no
 * `language` skips the languages its pattern is not written in, and fails only if it fits none.
 */
export function matchCalls(searches: CallSearch[], sources: Map<string, string>): CallMatch[] {
  return searches.flatMap(({ ruleId, pattern, language: named, files }) => {
    const unreadable = new Set<Language>();
    const read = new Set<Language>();
    const matches = files.flatMap((path) => {
      const source = sources.get(path);
      const language = languageOf(path);
      if (source === undefined || !language || unreadable.has(language)) return [];
      let nodes: SgNode[];
      try {
        nodes = parse(LANGUAGES[language].parser, source).root().findAll(pattern);
      } catch {
        if (named) {
          throw new UserError(`Rule ${ruleId}: ast-grep cannot read the pattern for ${language}.`);
        }
        unreadable.add(language);
        return [];
      }
      read.add(language);
      return nodes.map((node) => ({
        ruleId,
        path,
        line: node.range().start.line + 1,
        text: node.text().split('\n')[0]?.slice(0, 80) ?? '',
      }));
    });
    if (read.size === 0 && unreadable.size > 0) {
      throw new UserError(
        `Rule ${ruleId}: ast-grep cannot read the pattern for ${[...unreadable].join(' or ')}.`,
      );
    }
    return matches;
  });
}

/** Whether a root-relative path exists, for `key_files`. */
export const existsIn = (root: string) => (path: string) => existsSync(join(root, path));

const MAX_COUNTED_BYTES = 5 * 1024 * 1024;

/**
 * Counts a root-relative file's lines, for checking cited line numbers. Only a regular file inside
 * the root is read, so a planted link to a device or outside the repository gives undefined.
 */
export function lineCountIn(root: string): (path: string) => number | undefined {
  const counts = new Map<string, number | undefined>();
  return (path) => {
    if (counts.has(path)) return counts.get(path);
    let count: number | undefined;
    try {
      const real = realpathSync(join(root, path));
      const inside = !relative(realpathSync(root), real).startsWith('..');
      const stats = statSync(real);
      if (inside && stats.isFile() && stats.size <= MAX_COUNTED_BYTES) {
        count = readFileSync(real, 'utf8').split('\n').length;
      }
    } catch {
      count = undefined;
    }
    counts.set(path, count);
    return count;
  };
}
