import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeAst } from '../src/ast/analyze.ts';
import { analyzeGeneric } from '../src/ast/generic.ts';
import { languageOf } from '../src/ast/languages.ts';
import type { Language } from '../src/types.ts';

const NO_LIMITS = {
  max_cognitive_complexity: 0,
  max_nesting: 0,
  max_function_lines: 0,
  max_params: 0,
  max_file_lines: 100_000,
};
const DEFAULTS = {
  max_cognitive_complexity: 15,
  max_nesting: 4,
  max_function_lines: 60,
  max_params: 4,
  max_file_lines: 400,
};

/** Every metric above zero, keyed `rule:symbol`. */
function metrics(source: string): Record<string, number | undefined> {
  const findings = analyzeGeneric(source, NO_LIMITS)?.findings ?? [];
  return Object.fromEntries(findings.map((f) => [`${f.rule}:${f.symbol}`, f.value]));
}

// None of these has a grammar. Each is one loop around one `if` with one logical operator.
const SAME_SHAPE: [string, string, number][] = [
  [
    'java',
    `public class A {
    // if for while, in a comment
    public static int total(List<Item> items, int limit) throws IOException {
        String s = "if for while";
        for (Item i : items) {
            if (i.ok() && limit > 0) {
                count++;
            }
        }
        return count;
    }
}
`,
    9,
  ],
  [
    'ruby',
    `class A
  def total(items, limit)
    for x in items
      if x.ok && limit > 0
        puts x
      end
    end
  end
end
`,
    7,
  ],
  [
    'c',
    `#include <stdio.h>
static int total(const char *items, int limit)
{
    for (int i = 0; i < limit; i++) {
        if (items[i] && limit > 0) {
            n++;
        }
    }
    return n;
}
`,
    9,
  ],
  [
    'lua',
    `local function total(items, limit)
  for _, i in ipairs(items) do
    if i.ok and limit > 0 then
      n = n + 1
    end
  end
  return n
end
`,
    8,
  ],
  [
    'elixir',
    `defmodule A do
  def total(items, limit) do
    for i <- items do
      if i.ok and limit > 0 do
        i
      end
    end
  end
end
`,
    7,
  ],
];

describe('analyzeGeneric', () => {
  it.each(SAME_SHAPE)('measures %s', (_, source, length) => {
    expect(metrics(source)).toEqual({
      'cognitive-complexity:total': 4,
      'nesting:total': 2,
      'function-lines:total': length,
      'params:total': 2,
    });
  });

  it('marks its result as approximate', () => {
    expect(analyzeGeneric('def f(a):\n    return a\n', DEFAULTS)).toEqual({
      score: 1,
      findings: [],
      approximate: true,
    });
  });

  it('gives no result for a file with no function, which is no evidence of quality', () => {
    expect(analyzeGeneric('hello, if this is for nothing\n', DEFAULTS)).toBeNull();
  });

  it('still reports a long file with no function', () => {
    const { findings } = analyzeGeneric('x\n'.repeat(500), DEFAULTS) ?? { findings: [] };
    expect(findings.map((f) => f.rule)).toEqual(['file-lines']);
  });

  it('ignores keywords in comments and strings, and the closer of a block', () => {
    const source = `def f
  # if for while
  x = "if for while"
  y = 'if'
  /* if
     while */
end
`;
    expect(metrics(source)['cognitive-complexity:f']).toBeUndefined();
    expect(
      metrics('SUBROUTINE f(a)\n  IF (a) THEN\n    b\n  END IF\nEND SUBROUTINE\n'),
    ).toMatchObject({
      'cognitive-complexity:f': 1,
    });
  });

  it('counts else-if as one continuation and a run of one operator once', () => {
    const source = `function f()
  if a && b && c || d then
    x
  else if e then
    y
  else
    z
  end
end
`;
    // if 1, the && run 1, the || run 1, else-if 1, else 1.
    expect(metrics(source)['cognitive-complexity:f']).toBe(5);
  });

  it('adds nothing for case labels, do loops or ternaries', () => {
    const source = `int f(int a) {
    do {
        a = a > 0 ? a - 1 : a;
    } while (a);
    switch (a) {
        case 1:
            return 1;
    }
    return 0;
}
`;
    // switch 1, and nothing else.
    expect(metrics(source)['cognitive-complexity:f']).toBe(1);
  });

  it('measures nested functions on their own', () => {
    const source = `def outer(a)
  if a
    b
  end
  def inner(c, d)
    for e in c
      if e
        d
      end
    end
  end
end
`;
    expect(metrics(source)).toMatchObject({
      'cognitive-complexity:outer': 1,
      'cognitive-complexity:inner': 3,
      'params:outer': 1,
      'params:inner': 2,
    });
  });

  it('reads parameters over several lines, across generics, and without the receiver', () => {
    expect(metrics('def f(\n  self,\n  a,\n  b\n)\n  x\nend\n')['params:f']).toBe(2);
    expect(metrics('fun f(a: Map<K, V>, b: Int) {\n    x\n}\n')['params:f']).toBe(2);
    expect(metrics('procedure F(a: Integer; b: Integer);\nbegin\n  x;\nend;\n')).toMatchObject({
      'params:F': 2,
      'function-lines:F': 4,
    });
  });

  it('names assigned functions', () => {
    expect(metrics('total <- function(a, b) {\n  a\n}\n')['params:total']).toBe(2);
  });

  it('does not take calls or control flow for declarations', () => {
    const source = `describe("x", () => {
  it("y", () => {
    if (a) {
    }
  });
});
if (a) {
}
while (b) {
}
`;
    expect(analyzeGeneric(source, NO_LIMITS)).toBeNull();
  });

  it('survives hostile input', () => {
    const hostile = [
      `"${'a'.repeat(5_000_000)}"`,
      '/* '.repeat(500_000),
      'func('.repeat(500_000),
      'fn a((((((\n'.repeat(1000),
      Array.from({ length: 3000 }, (_, depth) => `${' '.repeat(depth)}fn a(x) {`).join('\n'),
    ];
    for (const source of hostile) expect(() => analyzeGeneric(source, DEFAULTS)).not.toThrow();
  });

  // Keeps the fallback honest: the same files, measured by the real grammars.
  it.each([
    'examples/messy-shop/src/checkout.ts',
    'examples/messy-shop/src/pricing.py',
    'examples/messy-shop/src/refunds.py',
    'examples/messy-shop/src/shipping.rs',
    'src/scoring.ts',
  ])('stays close to the grammar on %s', (path) => {
    const source = readFileSync(path, 'utf8');
    const exact = analyzeAst(source, languageOf(path) as Language, DEFAULTS, []);
    expect(analyzeGeneric(source, DEFAULTS)?.score).toBeCloseTo(exact.score, 1);
  });
});
