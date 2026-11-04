/** Reads what a source file imports and declares from its AST. */
import { parse, type SgNode } from '@ast-grep/napi';
import { countLines } from '../ast/analyze.ts';
import { LANGUAGES, type LanguageSpec } from '../ast/languages.ts';
import type { Language } from '../types.ts';

/** One class, or the parts of one that a single file declares. */
export interface ClassOutline {
  name: string;
  line: number;
  lines: number;
  methods: string[];
  /** Names it inherits from or implements. */
  bases: string[];
  /** Every name it mentions, among which later steps look for other classes. */
  references: string[];
}

/** What a file imports and declares, before any import is resolved. */
export interface ModuleOutline {
  path: string;
  language: Language;
  lines: number;
  /** Import specifiers as written, in the language's own syntax. */
  imports: string[];
  symbols: string[];
  classes: ClassOutline[];
}

const kindOf = (node: SgNode) => node.kind() as string;
const unquote = (node: SgNode) => node.text().replace(/^['"`]|['"`]$/g, '');
const findKinds = (root: SgNode, kinds: string[]) =>
  root.findAll({ rule: { any: kinds.map((kind) => ({ kind })) } });

/** The `from` of an import or re-export, and of TypeScript's `import x = require()`. */
function staticSpecifier(node: SgNode): SgNode | null | undefined {
  const isRequireClause = (child: SgNode) => child.kind() === 'import_require_clause';
  return node.field('source') ?? node.children().find(isRequireClause)?.field('source');
}

/** The string passed to `require()` or `import()`. */
function calledSpecifier(node: SgNode): SgNode | undefined {
  if (!/^(require|import)$/.test(node.field('function')?.text() ?? '')) return undefined;
  const callArguments = node.field('arguments')?.children();
  return callArguments?.find((argument) => argument.kind() === 'string');
}

function ecmascriptImports(root: SgNode): string[] {
  const candidates = findKinds(root, ['import_statement', 'export_statement', 'call_expression']);
  return candidates.flatMap((node) => {
    const specifier = staticSpecifier(node) ?? calledSpecifier(node);
    return specifier ? [unquote(specifier)] : [];
  });
}

const importedName = (node: SgNode) => node.text().split(/\s+as\s+/)[0] as string;
const isImportedName = (node: SgNode) => /^(dotted_name|aliased_import)$/.test(kindOf(node));

/** `from a import b` yields `a.b`, because `b` may be a module; resolving falls back to `a`. */
function pythonImports(root: SgNode): string[] {
  return findKinds(root, ['import_statement', 'import_from_statement']).flatMap((node) => {
    const from = node.field('module_name');
    const names = node
      .children()
      .filter((child) => isImportedName(child) && child.id() !== from?.id())
      .map(importedName);
    if (!from) return names;
    const moduleName = from.text();
    const prefix = moduleName.endsWith('.') ? moduleName : `${moduleName}.`;
    return names.length > 0 ? names.map((name) => `${prefix}${name}`) : [moduleName];
  });
}

const goImports = (root: SgNode) =>
  findKinds(root, ['import_spec']).flatMap((node) => {
    const path = node.field('path');
    return path ? [unquote(path)] : [];
  });

/** shortcut: expands one level of `{a, b}`, so nested groups resolve only to their prefix. */
function expandUse(argument: string): string[] {
  const group = argument.match(/^(.*?)\{(.*)\}$/s);
  const paths = group
    ? (group[2] as string).split(',').map((item) => `${group[1]}${item.trim()}`)
    : [argument];
  return paths.map((path) => path.replace(/\s+as\s+\w+$/, ''));
}

function rustImports(root: SgNode): string[] {
  return findKinds(root, ['use_declaration', 'mod_item']).flatMap((node) => {
    const argument = node.field('argument');
    if (argument) return expandUse(argument.text());
    const name = node.field('name');
    return name && !node.field('body') ? [`self::${name.text()}`] : [];
  });
}

const IMPORT_READERS: Record<Language, (root: SgNode) => string[]> = {
  javascript: ecmascriptImports,
  typescript: ecmascriptImports,
  tsx: ecmascriptImports,
  python: pythonImports,
  go: goImports,
  rust: rustImports,
};

/** Identifiers, dotted namespaces, and `declare module "foo"`. */
const TOP_LEVEL_NAME = /^[\p{L}\p{N}_$#.]+$|^(["'])[\w@./-]+\1$/u;

/** The names a statement declares, looking through wrappers such as `export` and `const x = ...`. */
function declaredNames(node: SgNode): SgNode[] {
  const declaration = node.field('declaration') ?? node;
  const ownName = declaration.field('name');
  if (ownName) return [ownName];
  return declaration.children().flatMap((child) => child.field('name') ?? []);
}

function topLevelSymbols(root: SgNode): string[] {
  return (
    root
      .children()
      .filter((node) => !/import|use_declaration|package/.test(kindOf(node)))
      .flatMap(declaredNames)
      .map((name) => name.text())
      // A destructuring pattern can hold literals, and an outline must not carry file contents.
      .filter((name) => TOP_LEVEL_NAME.test(name))
  );
}

/** The class a name refers to: `Foo<T>`, `crate::Foo` and Go's `(s *Foo)` all give `Foo`. */
const baseName = (text: string) =>
  text
    .replace(/[<[].*$/s, '')
    .match(/[\p{L}\p{N}_$]+/gu)
    ?.at(-1);

function methodNames(node: SgNode, spec: LanguageSpec): string[] {
  const isMethod = (member: SgNode) => spec.functions.includes(kindOf(member));
  const members = isMethod(node) ? [node] : (node.field('body')?.children() ?? []);
  return members
    .map((member) => member.field('definition') ?? member)
    .filter(isMethod)
    .flatMap((method) => method.field('name')?.text() ?? []);
}

const IDENTIFIER = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

function identifiersIn(
  node: SgNode | null | undefined,
  keep: (name: SgNode) => boolean = () => true,
): string[] {
  if (!node) return [];
  const names = new Set<string>();
  // Leaves only: reading the text of every node costs the square of the nesting depth.
  const stack = [node];
  for (let current = stack.pop(); current; current = stack.pop()) {
    const children = current.children();
    for (const child of children.toReversed()) stack.push(child);
    const isNamedLeaf = children.length === 0 && current.isNamed();
    // Grammars name identifier kinds differently, so match on the text instead.
    if (isNamedLeaf && IDENTIFIER.test(current.text()) && keep(current)) names.add(current.text());
  }
  return [...names];
}

function disqualifiesParent(ancestor: SgNode, name: SgNode): boolean {
  if (kindOf(ancestor) !== 'subscript') {
    return /^(type_arguments|keyword_argument)$/.test(kindOf(ancestor));
  }
  const subscriptedEnd = ancestor.field('value')?.range().end.index ?? 0;
  return subscriptedEnd <= name.range().start.index;
}

/**
 * `Repo<User>` and `Base[User]` inherit from the first name alone, and `metaclass=Meta` is not a
 * parent.
 */
const isParent = (name: SgNode) =>
  !name.ancestors().some((ancestor) => disqualifiesParent(ancestor, name));

const heritageOf = (node: SgNode) =>
  node.field('superclasses') ??
  node.field('trait') ??
  node.children().find((child) => child.kind() === 'class_heritage');

function classFragment(node: SgNode, spec: LanguageSpec): ClassOutline | null {
  const nameField = spec.classes[kindOf(node)] as string;
  const name = baseName(node.field(nameField)?.text() ?? '');
  if (!name) return null;
  const { start, end } = node.range();
  return {
    name,
    line: start.line + 1,
    lines: end.line - start.line + 1,
    methods: methodNames(node, spec),
    bases: identifiersIn(heritageOf(node), isParent),
    references: identifiersIn(node).filter((reference) => reference !== name),
  };
}

const union = (first: string[], second: string[]) => [...new Set([...first, ...second])];

function mergeFragment(known: ClassOutline, fragment: ClassOutline): ClassOutline {
  return {
    ...known,
    lines: known.lines + fragment.lines,
    methods: [...known.methods, ...fragment.methods],
    bases: union(known.bases, fragment.bases),
    references: union(known.references, fragment.references),
  };
}

/** Rust impl blocks and Go methods each declare part of a class, so one file's parts merge. */
function mergeFragments(fragments: ClassOutline[]): ClassOutline[] {
  const merged = new Map<string, ClassOutline>();
  for (const fragment of fragments) {
    const known = merged.get(fragment.name);
    merged.set(fragment.name, known ? mergeFragment(known, fragment) : fragment);
  }
  return [...merged.values()];
}

/** Outlines one file. */
export function extractModule(path: string, source: string, language: Language): ModuleOutline {
  const spec = LANGUAGES[language];
  const root = parse(spec.parser, source).root();
  const fragments = findKinds(root, Object.keys(spec.classes)).flatMap(
    (node) => classFragment(node, spec) ?? [],
  );
  return {
    path,
    language,
    lines: countLines(source),
    imports: [...new Set(IMPORT_READERS[language](root))],
    symbols: topLevelSymbols(root),
    classes: mergeFragments(fragments),
  };
}
