/**
 * Approximate metrics for languages without a grammar, read from keywords and indentation.
 * It errs towards silence: code it cannot place in a function is not measured at all.
 */
import { astScoreFrom } from '../scoring.ts';
import type { AstResult } from '../types.ts';
import { countLines, functionFindings, type Limits, overLimit } from './analyze.ts';

// Longer lines are generated, and the cap bounds what the regexes below can cost on hostile input.
const MAX_LINE_CHARS = 1000;
const MAX_SIGNATURE_LINES = 20;
const TAB_WIDTH = 4;
const DEFAULT_INDENT_UNIT = 4;

/**
 * Comments and strings in the syntaxes most languages share. A quote must close on its own line, as
 * `'` is also an apostrophe. Unrolled, because `(?:a|b)*` overflows the stack on a long string.
 */
const NOISE =
  /\/\*[\s\S]*?(?:\*\/|$)|"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|\/\/.*|#.*|(?<!\S)-- .*|"[^"\\\n]*(?:\\.[^"\\\n]*)*"|'[^'\\\n]*(?:\\.[^'\\\n]*)*'|`[^`\\\n]*(?:\\.[^`\\\n]*)*`/g;

const KEYWORD_FUNCTION =
  /(?<![\w$.-])(?:def|defp|defn|fn|func|fun|function|sub|subroutine|proc|procedure|method)\s+([\p{L}_$][\p{L}\p{N}_$.:!?]*)/iu;
const ASSIGNED_FUNCTION =
  /([\p{L}_$][\p{L}\p{N}_$.]*)\s*(?:=|<-|:=?)\s*(?:function|fun|fn|proc|lambda)\b/iu;
/** `int main(`, `public Foo(`, or a bare `name(`: a declaration only if a block follows. */
const C_STYLE_FUNCTION = /^\s*((?:[\p{L}\p{N}_$<>[\],:*&?]+\s+)*)[*&]*([\p{L}_$][\w$:~]*)\s*\(/u;
const NOT_A_FUNCTION = new Set(
  `if for foreach while until switch match catch return new else elif do try with when using lock
  synchronized`.split(/\s+/),
);

/** What closes a block at the indent of its header, so it belongs to the function. */
const CLOSER = /^\s*(?:[)\]}]|end\b)/i;
/** What opens a block at the indent of its header, as in Allman braces and Pascal. */
const OPENER = /^\s*(?:\{|begin\b)/i;

// `case` and `match` are left out: labels would overcount, and `match` is a common variable name.
const FLOW =
  /(?<![\w$.:-]|end\s)(else\s+if|elif|elsif|elseif|else|catch|except|rescue|if|unless|for|foreach|while|until|switch)(?![\w$-])|&&(?!=)|\|\|(?!=)|(?<![\w$.:-])(?:and|or)(?![\w$-])/gi;
const CONTINUATION = /^(?:else|elif|elsif|elseif|catch|except|rescue)/i;

const RECEIVER = /^&?(?:mut\s+)?\$?(?:self|this|cls)\b/;

interface Line {
  text: string;
  indent: number;
}

interface Signature {
  params: number;
  /** The line its parameter list closes on. */
  end: number;
}

interface Declaration {
  symbol: string | undefined;
  /** Where to look for its parameters. */
  after: number;
}

interface OpenFunction extends Signature {
  symbol: string | undefined;
  line: number;
  indent: number;
  complexity: number;
  nesting: number;
}

const blankOut = (match: string) => match.replace(/[^\n]/g, ' ');

function indentOf(text: string): number {
  let width = 0;
  for (const char of text) {
    if (char === ' ') width += 1;
    else if (char === '\t') width += TAB_WIDTH;
    else break;
  }
  return width;
}

/** Each line of code, or null where nothing can be read: blank, comment, or generated. */
function readLines(source: string): (Line | null)[] {
  return source
    .replace(NOISE, blankOut)
    .split('\n')
    .map((text) =>
      text.trim() === '' || text.length > MAX_LINE_CHARS ? null : { text, indent: indentOf(text) },
    );
}

/** The most common step between indented lines; a tie goes to the smaller. */
function indentUnit(lines: (Line | null)[]): number {
  const counts = new Map<number, number>();
  let previous = 0;
  for (const line of lines) {
    if (!line) continue;
    const step = line.indent - previous;
    if (step > 0) counts.set(step, (counts.get(step) ?? 0) + 1);
    previous = line.indent;
  }
  const commonestFirst = [...counts].sort(
    ([stepA, countA], [stepB, countB]) => countB - countA || stepA - stepB,
  );
  const [unit] = commonestFirst[0] ?? [DEFAULT_INDENT_UNIT];
  return unit;
}

/** Every character from an opening parenthesis on, with the line it is on. */
function* signatureChars(lines: (Line | null)[], at: number, openParen: number) {
  const stop = Math.min(at + MAX_SIGNATURE_LINES, lines.length);
  for (let index = at; index < stop; index += 1) {
    const text = lines[index]?.text.slice(index === at ? openParen : 0) ?? '';
    for (const char of text) yield { char, index };
  }
}

function countParams(parts: string[]): number {
  const params = parts.map((text) => text.replace(/^\(/, '').trim());
  return params.filter((text) => text !== '' && !RECEIVER.test(text)).length;
}

function signatureAt(lines: (Line | null)[], at: number, openParen: number): Signature {
  const parts: string[] = [];
  let part = '';
  let depth = 0;
  for (const { char, index } of signatureChars(lines, at, openParen)) {
    if ('([{<'.includes(char)) depth += 1;
    if (')]}>'.includes(char)) depth -= 1;
    if (depth <= 0) return { params: countParams([...parts, part]), end: index };
    // Pascal separates parameters with `;`.
    if ((char === ',' || char === ';') && depth === 1) {
      parts.push(part);
      part = '';
    } else {
      part += char;
    }
  }
  return { params: 0, end: at };
}

const nextCode = (lines: (Line | null)[], at: number) => lines.slice(at + 1, at + 3).find(Boolean);

function cStyleDeclaration(lines: (Line | null)[], at: number, text: string): Declaration | null {
  const cStyle = text.match(C_STYLE_FUNCTION);
  if (!cStyle) return null;
  const [match, prefix, name] = cStyle as unknown as [string, string, string];
  const firstWord = prefix.trim().split(/\s+/)[0] as string;
  if (NOT_A_FUNCTION.has(name) || NOT_A_FUNCTION.has(firstWord)) return null;
  // `describe(..., () => {` is a call that takes a closure.
  if (prefix === '' && /=>|->/.test(text)) return null;
  const opensBlock = text.trimEnd().endsWith('{');
  const blockFollows = prefix !== '' && /^\s*\{/.test(nextCode(lines, at)?.text ?? '');
  // shortcut: a C-style signature split over lines is missed; read on to its `)` if that matters.
  return opensBlock || blockFollows ? { symbol: name, after: match.length - 1 } : null;
}

/** Returns the function a line declares, if any. */
function declaredAt(lines: (Line | null)[], at: number): Declaration | null {
  const text = lines[at]?.text ?? '';
  const named = text.match(KEYWORD_FUNCTION) ?? text.match(ASSIGNED_FUNCTION);
  if (named) return { symbol: named[1], after: (named.index ?? 0) + named[0].length };
  return cStyleDeclaration(lines, at, text);
}

function measureLine(line: Line, fn: OpenFunction, unit: number): void {
  const depth = Math.max(0, Math.round((line.indent - fn.indent) / unit) - 1);
  let operator: string | undefined;
  for (const [token, keyword] of line.text.matchAll(FLOW)) {
    if (!keyword) {
      if (token.toLowerCase() !== operator) fn.complexity += 1;
      operator = token.toLowerCase();
    } else if (CONTINUATION.test(keyword)) {
      fn.complexity += 1;
    } else {
      fn.complexity += 1 + depth;
      fn.nesting = Math.max(fn.nesting, depth + 1);
    }
  }
}

function openFunction(
  lines: (Line | null)[],
  index: number,
  line: Line,
  { symbol, after }: Declaration,
): OpenFunction {
  const signature = line.text.includes('(')
    ? signatureAt(lines, index, line.text.indexOf('(', after - 1))
    : { params: 0, end: index };
  return { ...signature, symbol, line: index + 1, indent: line.indent, complexity: 0, nesting: 0 };
}

const endsAt = (line: Line, index: number, fn: OpenFunction) =>
  index > fn.end && line.indent <= fn.indent && !OPENER.test(line.text);

/** Measures every function in one pass, so a hostile file costs no more than its length. */
function measureFunctions(lines: (Line | null)[], limits: Limits) {
  const unit = indentUnit(lines);
  const findings: ReturnType<typeof functionFindings> = [];
  const openFunctions: OpenFunction[] = [];
  let lastCode = 0;

  const report = (fn: OpenFunction, end: number) => {
    const { complexity, nesting, params, line, symbol } = fn;
    const length = end - line + 2;
    findings.push(
      ...functionFindings({ complexity, nesting, length, params }, limits, line, symbol),
    );
  };

  lines.forEach((line, index) => {
    if (!line) return;
    for (let fn = openFunctions.at(-1); fn && endsAt(line, index, fn); fn = openFunctions.at(-1)) {
      openFunctions.pop();
      const isClosingLine = CLOSER.test(line.text) && line.indent === fn.indent;
      report(fn, isClosingLine ? index : lastCode);
    }
    lastCode = index;
    const declared = declaredAt(lines, index);
    if (declared) {
      openFunctions.push(openFunction(lines, index, line, declared));
      return;
    }
    const owner = openFunctions.at(-1);
    if (owner && index > owner.end) measureLine(line, owner, unit);
  });
  for (const fn of openFunctions.toReversed()) report(fn, lastCode);
  return findings;
}

/**
 * Measures a file in a language with no grammar. Returns null when it finds no function and the
 * file is within its length limit: that is no evidence of good code, so it must not score 1.
 */
export function analyzeGeneric(source: string, limits: Limits): AstResult | null {
  const lines = readLines(source);
  const fileLines = overLimit(
    [['file-lines', 'file length', countLines(source), limits.max_file_lines]],
    { line: 1 },
  );
  const hasFunction = lines.some((_, index) => declaredAt(lines, index) !== null);
  if (!hasFunction && fileLines.length === 0) return null;
  const findings = [...fileLines, ...measureFunctions(lines, limits)];
  return { score: astScoreFrom(findings), findings, approximate: true };
}
