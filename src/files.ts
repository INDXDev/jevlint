/** File discovery: which files under the root jevlint may read. */
import { access, open, readFile, realpath } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { glob } from 'tinyglobby';
import { type Config, findUp, UserError } from './config.ts';

const BINARY_SNIFF_BYTES = 8192;

// An allowlist, because tool dotfiles (`.node-version`, `.nvmrc`, ...) and data formats are endless
// and code principles say nothing useful about them. A file needs one of these to be audited.
// shortcut: extensionless scripts, Dockerfiles and Makefiles are skipped; match them by name or shebang if wanted.
const SOURCE_EXTENSIONS = new Set(
  `js mjs cjs jsx ts mts cts tsx vue svelte astro py pyi go rs rb php java kt kts scala groovy
  swift m mm c h cc cpp cxx hh hpp hxx cs fs vb dart lua pl pm r jl ex exs erl hs clj cljs ml mli
  zig nim sql sh bash zsh fish ps1 sol cob cbl f90 f95 pas adb ads tcl rkt scm lisp elm purs nix hx
  cr gd sv vhd vhdl hrl fsx`
    .split(/\s+/)
    .map((extension) => `.${extension}`),
);

// `node_modules` is excluded by PRUNED_DIRS.
const ALWAYS_EXCLUDED = [
  ...['.env*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', '*credentials*', '*secret*'],
  ...['dist', 'build', 'vendor', 'target', 'coverage', '*.min.*'],
  // Bad on purpose, for `jevlint test`, so they must not count against the repository.
  '/.jevlint/fixtures/',
];

const PRUNED_DIRS = ['**/.git/**', '**/node_modules/**'];

interface IgnoreRules {
  /** Root-relative directory the rules apply to, `.` for the root. */
  dir: string;
  matcher: Ignore;
  /** For a `.gitignore` above the root: the root's path relative to that file. */
  prefix?: string;
}

// followSymbolicLinks: false also drops symlinks to files. `isAuditable` covers what it misses.
const walk = (patterns: string[], root: string) =>
  glob(patterns, { cwd: root, dot: true, followSymbolicLinks: false, ignore: PRUNED_DIRS });

/** True when a result of `path.relative` leads out of the directory it is relative to. */
export const isOutsideRoot = (relativePath: string) =>
  relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);

async function toRootRelative(root: string, path: string): Promise<string> {
  const absolute = resolve(root, path);
  const relativePath = relative(root, absolute);
  if (isOutsideRoot(relativePath)) throw new UserError(`Path is outside the root: ${path}`);
  await access(absolute).catch(() => {
    throw new UserError(`Path not found: ${path}`);
  });
  return relativePath.split(sep).join('/');
}

/** With `jevlint.toml` in a subdirectory, the `.gitignore` files above it still apply. */
async function ignoreRulesAbove(root: string): Promise<IgnoreRules[]> {
  const gitRoot = await findUp(root, '.git');
  const rules: IgnoreRules[] = [];
  if (!gitRoot || gitRoot === root) return rules;
  for (let dir = root; dir !== gitRoot; ) {
    dir = dirname(dir);
    const text = await readFile(join(dir, '.gitignore'), 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    const prefix = relative(dir, root).split(sep).join('/');
    rules.push({ dir: '.', prefix, matcher: ignore().add(text) });
  }
  return rules;
}

// shortcut: a nested .gitignore cannot re-include what a parent ignores; use `git check-ignore` if that matters.
async function loadIgnoreRules(config: Config): Promise<IgnoreRules[]> {
  const gitignores = await walk(['**/.gitignore'], config.root);
  const rules = await Promise.all(
    gitignores.map(async (file) => ({
      dir: posix.dirname(file),
      matcher: ignore().add(await readFile(join(config.root, file), 'utf8')),
    })),
  );
  return [
    ...(await ignoreRulesAbove(config.root)),
    ...rules,
    { dir: '.', matcher: ignore().add(config.exclude) },
  ];
}

function matchesRules({ dir, matcher, prefix }: IgnoreRules, file: string): boolean {
  if (prefix) return matcher.ignores(`${prefix}/${file}`);
  if (dir === '.') return matcher.ignores(file);
  return file.startsWith(`${dir}/`) && matcher.ignores(posix.relative(dir, file));
}

const isUnder = (file: string, target: string) =>
  target === '' || file === target || file.startsWith(`${target}/`);

async function isBinary(file: string): Promise<boolean> {
  const handle = await open(file);
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

async function isAuditable(realRoot: string, file: string): Promise<boolean> {
  const path = join(realRoot, file);
  try {
    // `walk` starts at a pattern's static prefix, so `link/*` crosses a symlinked directory.
    return (await realpath(path)) === path && !(await isBinary(path));
  } catch {
    // audit() warns about a file it cannot read, which beats ending the whole run here.
    return true;
  }
}

/** Picks out the root-relative paths that discovery would refuse, whatever their extension. */
export async function excludedPaths(config: Config, paths: string[]): Promise<string[]> {
  const rules = await loadIgnoreRules(config);
  const alwaysExcluded = ignore().add(ALWAYS_EXCLUDED);
  return paths.filter(
    (file) =>
      // A crafted tree can hold a path such as `../x`, which the matchers throw on.
      !ignore.isPathValid(file) ||
      alwaysExcluded.ignores(file) ||
      rules.some((rule) => matchesRules(rule, file)),
  );
}

/**
 * Lists auditable files as sorted, root-relative posix paths. `paths` (files or directories,
 * relative to the root or absolute) narrows the result but never bypasses an exclusion.
 */
export async function discoverFiles(config: Config, paths?: string[]): Promise<string[]> {
  const { root } = config;
  const targets = paths && (await Promise.all(paths.map((path) => toRootRelative(root, path))));
  const rules = await loadIgnoreRules(config);
  // Kept apart from `rules` so a `!.env` in a repository's ignore lists cannot re-include secrets.
  const alwaysExcluded = ignore().add(ALWAYS_EXCLUDED);

  const candidates = (await walk(config.include, root))
    // A repository's `include` is untrusted and may point above the root.
    .filter((file) => !file.startsWith('../'))
    .filter((file) => SOURCE_EXTENSIONS.has(extname(file).toLowerCase()))
    .filter((file) => !alwaysExcluded.ignores(file))
    .filter((file) => !rules.some((rule) => matchesRules(rule, file)))
    .filter((file) => !targets || targets.some((target) => isUnder(file, target)));

  const realRoot = await realpath(root);
  const files: string[] = [];
  // Sequential so that a large repository cannot exhaust file descriptors.
  for (const file of candidates.sort()) {
    if (await isAuditable(realRoot, file)) files.push(file);
  }
  return files;
}
