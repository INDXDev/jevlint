/** Per-language parsers and node-kind tables that drive the AST walker. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lang, registerDynamicLanguage } from '@ast-grep/napi';
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
registerDynamicLanguage(Object.fromEntries(available));

/** The node kinds that give one language its metrics. */
export interface LanguageSpec {
  parser: Lang | 'python' | 'go' | 'rust';
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
  javascript: { ...ecmascript, parser: Lang.JavaScript },
  typescript: { ...typed, parser: Lang.TypeScript },
  tsx: { ...typed, parser: Lang.Tsx },
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
