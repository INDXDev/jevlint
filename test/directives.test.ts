import { describe, expect, it } from 'vitest';
import { parseDirectives } from '../src/directives.ts';

describe('parseDirectives', () => {
  it.each([
    ['// jevlint-score 80 -- Generated shape\n'],
    ['# jevlint-score 80 -- Generated shape\n'],
    ['  /* jevlint-score 80 -- Generated shape */\n'],
    ['-- jevlint-score 80 -- Generated shape\n'],
  ])('reads a whole-file pin from %s', (comment) => {
    const { filePin } = parseDirectives(`a\n${comment}b\n`, 100);
    expect(filePin).toEqual({ value: 0.8, reason: 'Generated shape', line: 2 });
  });

  it('reads a question pin on the configured scale', () => {
    const source = '// jevlint-score readable-code.naming 0.9 -- Domain terms\n';
    expect(parseDirectives(source, 1).questionPins).toEqual({
      'readable-code.naming': { value: 0.9, reason: 'Domain terms', line: 1 },
    });
  });

  it('removes directive lines so they cannot change what the model sees', () => {
    const code = 'const a = 1;\nconst b = 2;\n';
    const pinned = 'const a = 1;\n// jevlint-score 80 -- Reason\nconst b = 2;\n';
    expect(parseDirectives(pinned, 100).code).toBe(code);
  });

  it.each([
    ['// jevlint-score 80\n', 'Use:'],
    ['// jevlint-score -- no value\n', 'Use:'],
    ['// jevlint-score 101 -- Too high\n', 'above the scale'],
  ])('warns about %s and pins nothing', (source, warning) => {
    const { filePin, questionPins, warnings, code } = parseDirectives(source, 100);
    expect(filePin).toBeNull();
    expect(questionPins).toEqual({});
    expect(warnings[0]).toContain(warning);
    expect(code).toBe('');
  });

  it('ignores the text when it is not a whole-line comment', () => {
    const source = 'const a = "// jevlint-score 80 -- Reason";\n';
    expect(parseDirectives(source, 100)).toMatchObject({ filePin: null, code: source });
  });
});

describe('parseDirectives on hostile input', () => {
  it.each([
    ['the comment', `// jevlint-score${' '.repeat(50_000)}x\n`],
    ['the reason', `// jevlint-score 1 -- a${' '.repeat(50_000)}x\n`],
  ])('stays linear on a long run of spaces in %s', (_, source) => {
    const started = performance.now();
    parseDirectives(source, 100);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('keeps the existing line endings and closers working', () => {
    expect(parseDirectives('/* jevlint-score 80 -- Why  */  \r\n', 100).filePin?.reason).toBe(
      'Why',
    );
  });

  it('does not read a line that a lone carriage return continues', () => {
    expect(parseDirectives('// jevlint-score 80 -- Why\rcode()\n', 100).filePin).toBeNull();
  });

  it('keeps `__proto__` as an ordinary, reportable question id', () => {
    const { questionPins } = parseDirectives('// jevlint-score __proto__ 1 -- Why\n', 100);
    expect(Object.keys(questionPins)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(questionPins)).toBeNull();
  });
});
