import { describe, expect, it } from 'vitest';
import { diffFiles } from '../src/diff.ts';
import { type DiffView, formatDiffStat, formatDiffs } from '../src/diff-view.ts';

const INVERSE = '\u001b[7m';
const unified: DiffView = { color: true, layout: 'unified', width: 120 };
const split: DiffView = { color: true, layout: 'split', width: 100 };
const plainText = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠]/u;
const columns = (line: string) =>
  [...line].reduce((sum, char) => sum + (WIDE.test(char) ? 2 : 1), 0);

describe('formatDiffs', () => {
  const diffs = diffFiles([
    { path: 'a.ts', before: 'const total = sum(a, b);\n', after: 'const total = add(a, b);\n' },
  ]);

  it('prints the plain patch without colour', () => {
    const plain = { ...unified, color: false };
    expect(formatDiffs(diffs, plain)).toBe((diffs[0]?.patch ?? '').trimEnd());
  });

  it('highlights the words that changed on a replaced line', () => {
    const shown = formatDiffs(diffs, unified);
    expect(shown).toContain(`${INVERSE}sum`);
    expect(shown).toContain(`${INVERSE}add`);
    expect(shown).toContain('\u001b[36m@@ -1,1 +1,1 @@');
  });

  it('keeps whole lines when they share too little to pair', () => {
    const rewritten = diffFiles([{ path: 'a.ts', before: 'alpha();\n', after: 'return 42;\n' }]);
    expect(formatDiffs(rewritten, unified)).not.toContain(INVERSE);
  });

  it('prints removed lines before added ones, as git does', () => {
    const block = diffFiles([{ path: 'a.ts', before: 'a\nb\nkeep\n', after: 'x\nkeep\n' }]);
    expect(plainText(formatDiffs(block, unified))).toContain('-a\n-b\n+x\n keep');
  });

  it('writes an empty range as git does', () => {
    const added = diffFiles([{ path: 'n.ts', before: null, after: 'one\n' }]);
    expect(plainText(formatDiffs(added, unified))).toContain('@@ -0,0 +1,1 @@');
    expect(plainText(formatDiffs(added, split))).toContain('@@ -0,0 +1,1 @@');
  });

  it('keeps escape sequences from the repository out of the terminal', () => {
    const hostile = diffFiles([{ path: 'a\u001b[2J.ts', before: 'x\n', after: 'y\u001b[2J\r\n' }]);
    for (const view of [unified, { ...unified, color: false }, split]) {
      const shown = formatDiffs(hostile, view);
      expect(shown).toContain('y?[2J');
      expect(shown).not.toContain('\u001b[2J');
      expect(shown).not.toContain('\r');
    }
    // jsdiff quotes an unusual path as git does, so the escape arrives as text.
    expect(formatDiffs(hostile, unified)).toContain('"a/a\\033[2J.ts"');
    expect(hostile[0]?.patch).toContain('\u001b[2J');
  });
});

describe('formatDiffs side by side', () => {
  const diffs = diffFiles([
    {
      path: 'src/a.ts',
      before: 'a\nb\nc\nkeep\n',
      after: `x\nkeep\n\tconst s = "${'長い'.repeat(40)}";\n`,
    },
  ]);
  const lines = plainText(formatDiffs(diffs, split)).split('\n');

  it('titles each file and numbers both panels', () => {
    expect(lines[0]).toMatch(/^━━━ src\/a\.ts {2}modified {2}\+2 -3 ━+$/);
    expect(lines[1]).toContain('@@ -1,4 +1,3 @@');
    expect(lines[2]).toMatch(/^1 - a +│ 1 \+ x/);
    expect(lines[3]).toMatch(/^2 - b +│ +$/);
    expect(lines[5]).toMatch(/^4 {3}keep +│ 2 {3}keep/);
  });

  it('keeps every row the same width, cutting long and wide lines with an ellipsis', () => {
    const rows = lines.filter((line) => line.includes('│'));
    expect(new Set(rows.map(columns)).size).toBe(1);
    expect(rows.at(-1)).toContain('…');
    expect(rows.at(-1)).not.toContain('\t');
  });

  it('highlights changed words in both panels', () => {
    const pair = diffFiles([
      { path: 'a.ts', before: 'return sum(a);\n', after: 'return add(a);\n' },
    ]);
    const shown = formatDiffs(pair, split);
    expect(shown).toContain(`${INVERSE}sum`);
    expect(shown).toContain(`${INVERSE}add`);
  });

  it('notes a binary file instead of panels', () => {
    const binary = diffFiles([{ path: 'a.bin', before: 'a\0', after: 'b\0' }]);
    expect(plainText(formatDiffs(binary, split))).toContain(
      'Binary files a/a.bin and b/a.bin differ',
    );
  });
});

describe('formatDiffStat', () => {
  const diffs = diffFiles([
    { path: 'a.ts', before: 'a\nb\n', after: 'a\nc\n' },
    { path: 'src/new.ts', before: null, after: 'x\ny\n' },
  ]);

  it('lists each file and a total, like git diff --stat', () => {
    expect(formatDiffStat(diffs, false)).toBe(
      [
        ' a.ts       | +1 -1',
        ' src/new.ts | +2 -0  (new)',
        ' 2 files changed, 3 insertions(+), 1 deletions(-)',
      ].join('\n'),
    );
  });

  it('adds each score change that is known', () => {
    const scores = new Map([
      ['a.ts', { before: 51, after: 68 }],
      ['src/new.ts', { before: null, after: 95 }],
    ]);
    const [first, second] = formatDiffStat(diffs, false, scores).split('\n');
    expect(first).toBe(' a.ts       | +1 -1  score 51 -> 68 (+17)');
    expect(second).toBe(' src/new.ts | +2 -0  score 95  (new)');
    const worse = formatDiffStat(diffs, false, new Map([['a.ts', { before: 70, after: 65.5 }]]));
    expect(worse).toContain('score 70 -> 65.5 (-4.5)');
  });
});
