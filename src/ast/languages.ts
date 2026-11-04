/** Per-language parsers and node-kind tables that drive the AST walker. */
import { extname } from 'node:path';
import go from '@ast-grep/lang-go';
import python from '@ast-grep/lang-python';
import rust from '@ast-grep/lang-rust';
import { Lang, registerDynamicLanguage } from '@ast-grep/napi';
import type { Language } from '../types.ts';

registerDynamicLanguage({ python, go, rust });

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
  return EXTENSIONS[extname(path)] ?? null;
}
