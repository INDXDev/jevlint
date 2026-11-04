/** Inline `jevlint-score` comments: scores a team has accepted, so nobody keeps chasing them. */
import type { Pin } from './types.ts';

const DIRECTIVE_LINE = /^\s*(?:\/\/+|#+|--|\/\*+)\s*jevlint-score\b(.*)$/;
const DIRECTIVE_BODY = /^\s+(?:([\w.-]+)\s+)?(\d+(?:\.\d+)?)\s+--\s+(\S.*)$/;
const USAGE = 'Use: jevlint-score [question] <value> -- <reason>';

/** What a file's comments say, plus its code without them. */
export interface Directives {
  filePin: Pin | null;
  questionPins: Record<string, Pin>;
  /** The source without directive lines, because a comment must not move its own score. */
  code: string;
  warnings: string[];
}

function parseBody(body: string, line: number, scale: number) {
  const match = DIRECTIVE_BODY.exec(body.replace(/\*\/$/, '').trimEnd());
  if (!match) return { warning: `Line ${line}: ignored a jevlint-score comment. ${USAGE}` };
  const [, questionId, rawValue, reason] = match;
  const value = Number(rawValue);
  if (value > scale) {
    return {
      warning: `Line ${line}: ignored a jevlint-score of ${value}, above the scale of ${scale}.`,
    };
  }
  return { questionId, pin: { value: value / scale, reason: reason as string, line } };
}

/** Reads whole-line comments. Values use the configured scale, and pins store 0 to 1. */
export function parseDirectives(source: string, scale: number): Directives {
  // No prototype, so that a `__proto__` id is a key like any other.
  const questionPins: Directives['questionPins'] = Object.create(null);
  const directives: Directives = { filePin: null, questionPins, code: '', warnings: [] };
  const codeLines = source.split(/(?<=\n)/).filter((text, index) => {
    // Trimmed here because `\s*$` in a pattern takes quadratic time on a repository's long lines.
    const body = DIRECTIVE_LINE.exec(text.trimEnd())?.[1];
    if (body === undefined) return true;
    const { warning, questionId, pin } = parseBody(body, index + 1, scale);
    if (warning) directives.warnings.push(warning);
    else if (questionId) directives.questionPins[questionId] = pin as Pin;
    else directives.filePin = pin as Pin;
    return false;
  });
  return { ...directives, code: codeLines.join('') };
}
