/** Language-independent AST metrics and pattern matching. */
import { parse, type SgNode } from '@ast-grep/napi';
import { type Config, UserError } from '../config.ts';
import { astScoreFrom } from '../scoring.ts';
import type { AstFinding, AstPattern, AstResult, Language } from '../types.ts';
import { LANGUAGES, type LanguageSpec } from './languages.ts';

/** The configured maximum for each metric. */
export type Limits = Config['ast'];

interface Flow {
  complexity: number;
  nesting: number;
}

function kindOf(node: SgNode): string {
  return node.kind() as string;
}

/** Counts lines the way an editor does: a trailing newline does not start a new line. */
export function countLines(source: string): number {
  if (source === '') return 0;
  return source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
}

/** Measures one file and scores it against the configured limits. */
export function analyzeAst(
  source: string,
  language: Language,
  limits: Limits,
  patterns: AstPattern[],
): AstResult {
  const spec = LANGUAGES[language];
  const root = parse(spec.parser, source).root();
  const fileLength = countLines(source);
  const functions = root.findAll({ rule: { any: spec.functions.map((kind) => ({ kind })) } });
  const ownPatterns = patterns.filter((pattern) => pattern.language === language);
  const findings = [
    ...overLimit([['file-lines', 'file length', fileLength, limits.max_file_lines]], { line: 1 }),
    ...functions.flatMap((fn) => findingsForFunction(fn, spec, limits)),
    ...ownPatterns.flatMap((pattern) => patternFindings(root, pattern)),
  ];
  return { score: astScoreFrom(findings), findings };
}

function findingsForFunction(fn: SgNode, spec: LanguageSpec, limits: Limits): AstFinding[] {
  const { start, end } = fn.range();
  const measures = {
    ...measureFlow(fn, spec),
    length: end.line - start.line + 1,
    params: paramCount(fn, spec),
  };
  return functionFindings(measures, limits, start.line + 1, symbolOf(fn));
}

/** Turns one function's measures into findings, however they were taken. */
export function functionFindings(
  { complexity, nesting, length, params }: Flow & { length: number; params: number },
  limits: Limits,
  line: number,
  symbol: string | undefined,
): AstFinding[] {
  return overLimit(
    [
      ['cognitive-complexity', 'cognitive complexity', complexity, limits.max_cognitive_complexity],
      ['nesting', 'nesting depth', nesting, limits.max_nesting],
      ['function-lines', 'length', length, limits.max_function_lines],
      ['params', 'parameters', params, limits.max_params],
    ],
    { line, symbol },
  );
}

type Measure = [rule: string, label: string, value: number, limit: number];

/** Turns every measure above its limit into a finding at the given place. */
export function overLimit(
  measures: Measure[],
  at: Pick<AstFinding, 'line' | 'symbol'>,
): AstFinding[] {
  return measures
    .filter(([, , value, limit]) => value > limit)
    .map(([rule, label, value, limit]) => ({
      rule,
      message: `${label} ${value} (max ${limit})`,
      value,
      limit,
      ...at,
    }));
}

function findMatches(root: SgNode, { id, pattern }: AstPattern): SgNode[] {
  try {
    return root.findAll(pattern);
  } catch (error) {
    throw new UserError(`Invalid AST pattern "${id}": ${(error as Error).message}`);
  }
}

function patternFindings(root: SgNode, pattern: AstPattern): AstFinding[] {
  const { id: rule, message } = pattern;
  return findMatches(root, pattern).map((match) => ({
    rule,
    message,
    line: match.range().start.line + 1,
  }));
}

/** Lists what each pattern for this language matches, with 1-indexed lines. */
export function patternMatches<T extends AstPattern>(
  source: string,
  language: Language,
  patterns: T[],
): { pattern: T; matches: { line: number; text: string }[] }[] {
  const own = patterns.filter((pattern) => pattern.language === language);
  if (own.length === 0) return [];
  const root = parse(LANGUAGES[language].parser, source).root();
  return own.map((pattern) => ({
    pattern,
    matches: findMatches(root, pattern).map((match) => ({
      line: match.range().start.line + 1,
      text: match.text(),
    })),
  }));
}

/** Anonymous functions take the name of whatever they are assigned to. */
function symbolOf(fn: SgNode): string | undefined {
  const parent = fn.parent();
  // Go wraps the values of an assignment in a list.
  const owner = parent?.kind() === 'expression_list' ? parent.parent() : parent;
  const name =
    fn.field('name') ??
    owner?.field('name') ??
    owner?.field('left') ??
    owner?.field('pattern') ??
    owner?.field('key') ??
    (owner?.kind() === 'field_definition' ? owner.field('property') : null);
  return name?.text();
}

/** Receivers are supplied by the language, so callers never have to think about them. */
const isReceiver = (param: SgNode, { receiver }: LanguageSpec) =>
  kindOf(param) === 'self_parameter' || receiver?.test(param.text());

const NOT_A_PARAMETER = /comment|separator|attribute/;

function paramCount(fn: SgNode, spec: LanguageSpec): number {
  const list = fn.field('parameters');
  // A bare arrow function parameter, as in `x => x`, has no list around it.
  if (!list) return fn.field('parameter') ? 1 : 0;
  return list
    .children()
    .filter((node) => node.isNamed() && !NOT_A_PARAMETER.test(kindOf(node)))
    .filter((node) => !isReceiver(node, spec))
    .reduce((total, node) => total + countNames(node, spec), 0);
}

function countNames(param: SgNode, spec: LanguageSpec): number {
  if (kindOf(param) !== spec.paramGroup) return 1;
  // Go allows unnamed parameters, as in `func(int, string)`.
  return param.children().filter((node) => node.kind() === 'identifier').length || 1;
}

function measureFlow(fn: SgNode, spec: LanguageSpec): Flow {
  const flow = { complexity: 0, nesting: 0 };
  // An explicit stack, because a long `a + b + c` nests deeper than the call stack allows.
  const pending = [{ node: fn, depth: 0 }];
  for (let next = pending.pop(); next; next = pending.pop()) {
    const { node, depth } = next;
    for (const child of node.children()) {
      // Nested functions are measured on their own.
      if (spec.functions.includes(kindOf(child))) continue;
      if (addsOnePoint(child, node, spec)) flow.complexity += 1;
      pending.push({ node: child, depth: depth + enterNesting(child, depth, spec, flow) });
    }
  }
  return flow;
}

/** Whether a node costs one point however deep it sits. */
function addsOnePoint(node: SgNode, parent: SgNode, spec: LanguageSpec): boolean {
  return spec.continuations.includes(kindOf(node)) || startsLogicalRun(node, parent, spec);
}

/** Records a branch or block in the flow, and returns the nesting it adds for its children. */
function enterNesting(node: SgNode, depth: number, spec: LanguageSpec, flow: Flow): number {
  const kind = kindOf(node);
  const branches = spec.branches.includes(kind) || spec.loops.includes(kind);
  if (!branches && !spec.blocks.includes(kind)) return 0;
  // The `else` before an `else if` already counted it, and the chain stays at one level.
  if (kind.startsWith('if_') && node.prev()?.kind() === 'else') return 0;
  if (branches) flow.complexity += 1 + depth;
  flow.nesting = Math.max(flow.nesting, depth + 1);
  return 1;
}

/**
 * `a && b && c` parses as nested nodes, so only the outermost of a run counts.
 * The walker passes `parent` because `node.parent()` costs time proportional to the node's depth.
 */
function startsLogicalRun(node: SgNode, parent: SgNode, spec: LanguageSpec): boolean {
  const operator = logicalOperator(node, spec);
  return operator !== undefined && logicalOperator(parent, spec) !== operator;
}

function logicalOperator(node: SgNode, { logical }: LanguageSpec): string | undefined {
  if (kindOf(node) !== logical.kind) return undefined;
  const operator = node.field('operator')?.text();
  return operator && logical.operators.includes(operator) ? operator : undefined;
}
