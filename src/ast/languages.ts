/** Per-language parsers and node-kind tables that drive the AST walker. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserError } from '../config.ts';
import type { Language } from '../types.ts';

type GrammarName = 'python' | 'go' | 'rust';

const GRAMMARS: Record<GrammarName, { extensions: string[]; languageSymbol: string }> = {
  python: { extensions: ['py'], languageSymbol: 'tree_sitter_python' },
  go: { extensions: ['go'], languageSymbol: 'tree_sitter_go' },
  rust: { extensions: ['rs'], languageSymbol: 'tree_sitter_rust' },
};

const PLATFORMS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'macOS',
  linux: 'Linux',
  win32: 'Windows',
};
const ARCHES: Partial<Record<string, string>> = { x64: 'X64', arm64: 'ARM64' };

/**
 * The build copies each grammar's prebuilt parsers next to the bundle, so an install has no
 * `@ast-grep/lang-*` package, whose install script pnpm would warn about. From source, they are
 * devDependencies.
 */
function prebuildsDir(grammar: GrammarName): string {
  const bundled = fileURLToPath(new URL(`./parsers/${grammar}/prebuilds/`, import.meta.url));
  if (existsSync(bundled)) return bundled;
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve(`@ast-grep/lang-${grammar}/package.json`)), 'prebuilds');
}

function parserPath(grammar: GrammarName): string | undefined {
  const platform = PLATFORMS[process.platform];
  const arch = ARCHES[process.arch];
  if (!platform || !arch) return undefined;
  const path = join(prebuildsDir(grammar), `prebuild-${platform}-${arch}`, 'parser.so');
  return existsSync(path) ? path : undefined;
}

/** Grammars with a parser for this platform. Files in the others get the lexical fallback. */
const registered = new Set<GrammarName>();
const available = Object.entries(GRAMMARS).flatMap(([name, grammar]) => {
  const libraryPath = parserPath(name as GrammarName);
  if (libraryPath === undefined) return [];
  registered.add(name as GrammarName);
  return [[name, { ...grammar, libraryPath, expandoChar: 'µ' }] as const];
});

type AstGrep = typeof import('@ast-grep/napi');
let astGrep: AstGrep | undefined;
/** Kept once loading fails, so each later parse fails alike without rerunning napi's loader. */
let loadFailure: UserError | undefined;

const firstLine = (text: string) => text.split('\n', 1)[0] ?? text;

/** The reasons napi-rs keeps in `cause`, one for each binary it tried. */
function loadReasons(error: Error): string[] {
  const reasons: string[] = [];
  for (let cause = error.cause; cause instanceof Error; cause = cause.cause) {
    reasons.push(firstLine(cause.message));
  }
  return reasons;
}

/**
 * Whether ast-grep's Windows binary sits beside it on Linux. Windows npm installs only that one,
 * and WSL then runs its shim from the Windows PATH.
 */
function hasOnlyWindowsBinary(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const napi = createRequire(import.meta.url).resolve('@ast-grep/napi/package.json');
    const scope = dirname(dirname(napi));
    return ['x64', 'arm64', 'ia32'].some((arch) =>
      existsSync(join(scope, `napi-win32-${arch}-msvc`)),
    );
  } catch {
    return false;
  }
}

/**
 * Says why ast-grep did not load. napi-rs keeps the real reasons in `cause`, which is never
 * printed, and its hint about npm lockfiles misleads when another system's npm installed jevlint.
 */
function parserFailure(error: unknown): UserError {
  const platform = `${process.platform}-${process.arch}`;
  if (!(error instanceof Error) || !error.message.includes('Cannot find native binding')) {
    const reason = error instanceof Error ? error.message : String(error);
    return new UserError(`jevlint's parser could not load: ${firstLine(reason)}`, { cause: error });
  }
  // napi-rs reports a binary it did not find as a missing module. Any other reason means one was
  // there and failed to load, which reinstalling the same files will not fix.
  const reasons = loadReasons(error).filter((reason) => !reason.startsWith('Cannot find module '));
  if (reasons.length > 0) {
    return new UserError(`jevlint's parser could not load on ${platform}: ${reasons.join('; ')}`, {
      cause: error,
    });
  }
  const fix = hasOnlyWindowsBinary()
    ? 'It holds only the Windows binary, so it was probably installed by Windows npm and is being run from WSL. Install it inside WSL: npm install -g @indxjp/jevlint'
    : 'Reinstall jevlint on this machine the way you installed it, such as npm install -g @indxjp/jevlint. In a project, remove node_modules and the lockfile first.';
  return new UserError(`jevlint's parser has no binary for ${platform}. ${fix}`, { cause: error });
}

/**
 * ast-grep honours only the first registerDynamicLanguage call in a process, so a program that
 * registered its own languages before jevlint's first parse leaves Python, Go and Rust unparsed.
 */
function checkRegistered(loaded: AstGrep): void {
  const missing = [...registered].filter((name) => {
    try {
      loaded.parse(name, '');
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length === 0) return;
  throw new UserError(
    `jevlint cannot parse ${missing.join(', ')}: this process registered other ast-grep languages first, and ast-grep accepts them only once.`,
  );
}

/** Loads ast-grep on first use, so commands that parse no code still run without its binary. */
function loadAstGrep(): AstGrep {
  if (astGrep) return astGrep;
  if (loadFailure) throw loadFailure;
  try {
    const loaded = createRequire(import.meta.url)('@ast-grep/napi') as AstGrep;
    loaded.registerDynamicLanguage(Object.fromEntries(available));
    checkRegistered(loaded);
    // Kept only now, so a failed registration cannot leave Python, Go and Rust unregistered.
    astGrep = loaded;
    return loaded;
  } catch (error) {
    loadFailure = error instanceof UserError ? error : parserFailure(error);
    throw loadFailure;
  }
}

/** Parses source with ast-grep, loading it on the first call. */
export const parse: AstGrep['parse'] = (lang, source) => loadAstGrep().parse(lang, source);

/** Whether an error is ast-grep failing to load, which no single file or rule caused. */
export const isParserFailure = (error: unknown): boolean =>
  loadFailure !== undefined && error === loadFailure;

/** The node kinds that give one language its metrics. */
export interface LanguageSpec {
  parser: 'JavaScript' | 'TypeScript' | 'Tsx' | GrammarName;
  functions: string[];
  /** Add 1 plus the nesting depth, and nest what they contain. */
  branches: string[];
  /** Scored exactly like branches. */
  loops: string[];
  /** Add 1 without nesting, because they continue a statement already counted. */
  continuations: string[];
  /** Nest what they contain without adding complexity. */
  blocks: string[];
  logical: { kind: string; operators: string[] };
  /** A parameter node that can declare several names, as in Go's `a, b int`. */
  paramGroup?: string;
  /** Matches the text of a parameter that the language supplies rather than the caller. */
  receiver?: RegExp;
  /** Node kinds that declare a class or part of one, with the field that names the class. */
  classes: Record<string, string>;
}

const ecmascript: Omit<LanguageSpec, 'parser'> = {
  functions: [
    'function_declaration',
    'function_expression',
    'generator_function_declaration',
    'generator_function',
    'arrow_function',
    'method_definition',
  ],
  branches: ['if_statement', 'switch_statement', 'ternary_expression'],
  loops: ['for_statement', 'for_in_statement', 'while_statement', 'do_statement'],
  continuations: ['else_clause', 'catch_clause'],
  blocks: ['try_statement'],
  logical: { kind: 'binary_expression', operators: ['&&', '||', '??'] },
  classes: { class_declaration: 'name', class: 'name' },
};

const typed = {
  ...ecmascript,
  receiver: /^this\b/,
  classes: { ...ecmascript.classes, abstract_class_declaration: 'name' },
};

/** Every language with AST support. */
export const LANGUAGES: Record<Language, LanguageSpec> = {
  javascript: { ...ecmascript, parser: 'JavaScript' },
  typescript: { ...typed, parser: 'TypeScript' },
  tsx: { ...typed, parser: 'Tsx' },
  python: {
    parser: 'python',
    functions: ['function_definition', 'lambda'],
    branches: ['if_statement', 'match_statement', 'conditional_expression', 'if_clause'],
    loops: ['for_statement', 'while_statement', 'for_in_clause'],
    continuations: ['elif_clause', 'else_clause', 'except_clause'],
    blocks: ['try_statement', 'with_statement'],
    logical: { kind: 'boolean_operator', operators: ['and', 'or'] },
    receiver: /^(self|cls)\b/,
    classes: { class_definition: 'name' },
  },
  go: {
    parser: 'go',
    functions: ['function_declaration', 'method_declaration', 'func_literal'],
    branches: [
      'if_statement',
      'expression_switch_statement',
      'type_switch_statement',
      'select_statement',
    ],
    loops: ['for_statement'],
    // Go has no else clause node, only the keyword.
    continuations: ['else'],
    blocks: [],
    logical: { kind: 'binary_expression', operators: ['&&', '||'] },
    paramGroup: 'parameter_declaration',
    // Go declares methods outside the type, so each one is a fragment of its receiver's class.
    classes: { type_spec: 'name', method_declaration: 'receiver' },
  },
  rust: {
    parser: 'rust',
    functions: ['function_item', 'closure_expression'],
    branches: ['if_expression', 'match_expression'],
    loops: ['for_expression', 'while_expression', 'loop_expression'],
    continuations: ['else_clause'],
    blocks: [],
    logical: { kind: 'binary_expression', operators: ['&&', '||'] },
    receiver: /^(mut\s+)?self\b/,
    classes: { impl_item: 'type', trait_item: 'name' },
  },
};

const EXTENSIONS: Record<string, Language> = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
};

/** Returns the AST language for a path, or null when only the model can read it. */
export function languageOf(path: string): Language | null {
  const language = EXTENSIONS[extname(path)] ?? null;
  if (language === null || !Object.hasOwn(GRAMMARS, language)) return language;
  return registered.has(language as GrammarName) ? language : null;
}
