import { describe, expect, it } from 'vitest';
import { analyzeAst, countLines } from '../src/ast/analyze.ts';
import { languageOf } from '../src/ast/languages.ts';
import { UserError } from '../src/config.ts';
import type { AstPattern, Language } from '../src/types.ts';

const NO_LIMITS = {
  max_cognitive_complexity: 0,
  max_nesting: 0,
  max_function_lines: 0,
  max_params: 0,
  max_file_lines: 1000,
};
const LOOSE = {
  max_cognitive_complexity: 100,
  max_nesting: 100,
  max_function_lines: 100,
  max_params: 100,
  max_file_lines: 100,
};

/** Every metric above zero, keyed `rule:symbol`. */
function metrics(source: string, language: Language): Record<string, number | undefined> {
  const { findings } = analyzeAst(source, language, NO_LIMITS, []);
  return Object.fromEntries(findings.map((f) => [`${f.rule}:${f.symbol}`, f.value]));
}

const ecmascript = `function f(a, b) {
  if (a && b && c) {
    for (const x of y) {
      if (x) {}
    }
  } else if (a && b || c) {
    g();
  } else {
    h();
  }
}
`;

// Each fixture has the same shape: the expected values below hold for all six languages.
const FIXTURES: [Language, string, number][] = [
  ['javascript', ecmascript, 11],
  ['typescript', ecmascript.replace('a, b', 'a: number, b: string'), 11],
  ['tsx', ecmascript, 11],
  [
    'python',
    `def f(a, b):
    if a and b and c:
        for x in y:
            if x:
                pass
    elif a and b or c:
        g()
    else:
        h()
`,
    9,
  ],
  [
    'go',
    `package m

func f(a bool, b bool) {
	if a && b && c {
		for _, x := range y {
			if x {
			}
		}
	} else if a && b || c {
		g()
	} else {
		h()
	}
}
`,
    12,
  ],
  [
    'rust',
    `fn f(a: bool, b: bool) {
    if a && b && c {
        for x in y {
            if x {}
        }
    } else if a && b || c {
        g();
    } else {
        h();
    }
}
`,
    11,
  ],
];

describe('analyzeAst metrics', () => {
  it.each(FIXTURES)('measures %s', (language, source, lines) => {
    expect(metrics(source, language)).toEqual({
      'cognitive-complexity:f': 11,
      'nesting:f': 3,
      'function-lines:f': lines,
      'params:f': 2,
    });
  });

  const LOGICAL: [Language, string, string][] = [
    ['javascript', 'function f() { return a && b && c }', 'function f() { return a && b || c }'],
    ['typescript', 'function f() { return a && b && c }', 'function f() { return a && b || c }'],
    ['tsx', 'function f() { return a && b && c }', 'function f() { return a && b || c }'],
    ['python', 'def f():\n    return a and b and c', 'def f():\n    return a and b or c'],
    [
      'go',
      'package m\nfunc f() bool { return a && b && c }',
      'package m\nfunc f() bool { return a && b || c }',
    ],
    ['rust', 'fn f() -> bool { a && b && c }', 'fn f() -> bool { a && b || c }'],
  ];

  it.each(LOGICAL)('counts logical runs in %s', (language, sequence, mixed) => {
    expect(metrics(sequence, language)['cognitive-complexity:f']).toBe(1);
    expect(metrics(mixed, language)['cognitive-complexity:f']).toBe(2);
  });

  it('counts `??` as a logical operator', () => {
    expect(metrics('function f() { return a ?? b }', 'typescript')).toMatchObject({
      'cognitive-complexity:f': 1,
    });
  });

  it('does not nest `else if`', () => {
    const source = `function f() {
      if (a) {} else if (b) {} else if (c) { if (d) {} }
    }`;
    expect(metrics(source, 'javascript')).toMatchObject({
      'cognitive-complexity:f': 5,
      'nesting:f': 2,
    });
  });

  it.each([
    ['javascript', 'function f() { if (a) {} else for (;;) {} }', 4],
    ['javascript', 'function f() { if (a) {} else switch (a) {} }', 4],
    ['python', 'def f():\n    return 1 if a else 2 if b else 3\n', 3],
  ] as [Language, string, number][])(
    'counts what follows a plain else in %s: %s',
    (language, source, complexity) => {
      expect(metrics(source, language)['cognitive-complexity:f']).toBe(complexity);
    },
  );

  it('survives expressions deeper than the call stack', () => {
    const source = `function f() { return ${Array(20_000).fill('1').join(' + ')}; }`;
    expect(metrics(source, 'javascript')).toEqual({ 'function-lines:f': 1 });
  }, 30_000);

  it('nests the contents of try blocks but keeps catch at the same level', () => {
    const source = 'function f() { try { if (a) {} } catch (e) { if (b) {} } }';
    expect(metrics(source, 'javascript')).toMatchObject({
      'cognitive-complexity:f': 5,
      'nesting:f': 2,
    });
  });

  it('measures nested functions on their own', () => {
    const source = `function outer() {
      function inner() { if (a) { if (b) {} } }
    }`;
    const result = metrics(source, 'javascript');
    expect(result['cognitive-complexity:inner']).toBe(3);
    expect(result['cognitive-complexity:outer']).toBeUndefined();
    expect(result['function-lines:outer']).toBe(3);
  });

  it.each([
    ['javascript', 'x => x', 1],
    ['javascript', '(a, /* note */ b = 1, ...c) => a', 3],
    ['python', 'def f(a, /, b, *, c):\n    pass', 3],
    ['go', 'package m\nfunc f(a, b int, c ...string) {}', 3],
    ['go', 'package m\nvar v = func(int, string) {}', 2],
    ['go', 'package m\nfunc (r R) f(a int) {}', 1],
    ['rust', 'fn f() { let g = |x, y| x; }', 2],
    ['rust', 'fn f(#[cfg(x)] a: i32, b: i32) {}', 2],
  ] as [Language, string, number][])('counts parameters in %s: %s', (language, source, count) => {
    const { findings } = analyzeAst(source, language, { ...LOOSE, max_params: 0 }, []);
    expect(findings.map((f) => f.value)).toEqual([count]);
  });

  it.each([
    ['typescript', 'const g = (x) => x;', 'g'],
    ['typescript', 'class K { m() {} }', 'm'],
    ['typescript', 'const o = { k: () => 1 };', 'k'],
    ['typescript', 'class K { p = () => 1; }', 'p'],
    ['typescript', 'x.y = function () {};', 'x.y'],
    ['typescript', 'run(() => 1);', undefined],
    ['javascript', 'class K { p = () => 1; }', 'p'],
    ['javascript', 'x(function () {}.bind(y));', undefined],
    ['go', 'package m\nfunc f() { g := func() {}\n_ = g }', 'g'],
    ['go', 'package m\nvar g = func() {}', 'g'],
    ['python', 'g = lambda: 1', 'g'],
    ['go', 'package m\nfunc (r R) m() {}', 'm'],
    ['rust', 'fn f() { let g = || 1; }', 'g'],
  ] as [Language, string, string | undefined][])('names %s: %s', (language, source, symbol) => {
    const { findings } = analyzeAst(source, language, { ...LOOSE, max_function_lines: 0 }, []);
    expect(findings.at(-1)?.symbol).toBe(symbol);
  });

  it('reports 1-indexed lines and readable messages', () => {
    const { findings } = analyzeAst('\n\nfunction f(a) {}', 'javascript', NO_LIMITS, []);
    expect(findings).toContainEqual({
      rule: 'params',
      message: 'parameters 1 (max 0)',
      line: 3,
      symbol: 'f',
      value: 1,
      limit: 0,
    });
  });

  it('parses JSX as javascript', () => {
    const source = 'const C = (p) => <div>{p.a && <b />}</div>;';
    expect(metrics(source, 'javascript')['cognitive-complexity:C']).toBe(1);
  });
});

describe('analyzeAst scoring', () => {
  it('scores a clean file 1', () => {
    expect(analyzeAst('const a = 1;', 'javascript', LOOSE, [])).toEqual({ score: 1, findings: [] });
  });

  it('scores the worst metric', () => {
    const source = 'function f(a, b, c, d) {}\n';
    expect(analyzeAst(source, 'javascript', { ...LOOSE, max_params: 2 }, []).score).toBe(0.5);
  });

  it('flags long files', () => {
    const { findings, score } = analyzeAst(
      'a\nb\nc\nd\n',
      'javascript',
      { ...LOOSE, max_file_lines: 2 },
      [],
    );
    expect(findings).toMatchObject([{ rule: 'file-lines', line: 1, value: 4, limit: 2 }]);
    expect(score).toBe(0.5);
  });
});

describe('analyzeAst patterns', () => {
  const pattern = (language: Language, source: string): AstPattern => ({
    id: 'no-log',
    language,
    pattern: source,
    message: 'Remove logging',
  });

  it('reports matches in the file language and reduces the score', () => {
    const source = 'a();\nconsole.log(1);\nconsole.log(2);';
    const result = analyzeAst(source, 'typescript', LOOSE, [
      pattern('typescript', 'console.log($$$)'),
      pattern('python', 'console.log($$$)'),
    ]);
    expect(result.findings).toEqual([
      { rule: 'no-log', message: 'Remove logging', line: 2 },
      { rule: 'no-log', message: 'Remove logging', line: 3 },
    ]);
    expect(result.score).toBeCloseTo(0.95 ** 2);
  });

  it('matches in dynamically registered languages', () => {
    const { findings } = analyzeAst('print(1)', 'python', LOOSE, [pattern('python', 'print($$$)')]);
    expect(findings).toHaveLength(1);
  });

  it('turns an unusable pattern into a UserError', () => {
    expect(() => analyzeAst('a', 'typescript', LOOSE, [pattern('typescript', 'a; b')])).toThrow(
      UserError,
    );
  });
});

describe('languageOf', () => {
  it.each([
    ['a.js', 'javascript'],
    ['a.mjs', 'javascript'],
    ['a.cjs', 'javascript'],
    ['a.jsx', 'javascript'],
    ['a.ts', 'typescript'],
    ['a.mts', 'typescript'],
    ['a.cts', 'typescript'],
    ['src/a.tsx', 'tsx'],
    ['a.py', 'python'],
    ['a.go', 'go'],
    ['a.rs', 'rust'],
    ['a.md', null],
    ['Makefile', null],
  ])('maps %s', (path, language) => {
    expect(languageOf(path)).toBe(language);
  });
});

describe('countLines', () => {
  it.each([
    ['', 0],
    ['a', 1],
    ['a\n', 1],
    ['a\nb', 2],
    ['a\n\n', 2],
  ])('counts %j', (source, lines) => {
    expect(countLines(source)).toBe(lines);
  });
});

describe('receiver parameters', () => {
  const limits = {
    max_cognitive_complexity: 99,
    max_nesting: 99,
    max_function_lines: 999,
    max_params: 1,
    max_file_lines: 9999,
  };

  it.each([
    ['python', 'class A:\n    def f(self, a):\n        return a\n'],
    ['python', 'class A:\n    def f(self: "A", a):\n        return a\n'],
    ['rust', 'impl A { fn f(&self, a: i32) -> i32 { a } }\n'],
    ['rust', 'impl A { fn f(mut self: Box<Self>, a: i32) -> i32 { a } }\n'],
    ['typescript', 'function f(this: A, a: number) {}\n'],
  ] as const)('does not count the %s receiver in %j', (language, source) => {
    expect(analyzeAst(source, language, limits, []).findings).toEqual([]);
  });

  it.each([
    ['javascript', 'function f(self, a) {}\n'],
    ['typescript', 'function f(cls: A, a: number) {}\n'],
  ] as const)('counts a parameter that is only named like a receiver in %s', (language, source) => {
    expect(analyzeAst(source, language, limits, []).findings).toMatchObject([
      { rule: 'params', value: 2 },
    ]);
  });
});
