import { describe, expect, it } from 'vitest';
import { diffFiles, formatDiffStat, formatDiffs } from '../src/diff.ts';

const INVERSE = '\u001b[7m';

describe('diffFiles', () => {
  it('leaves out files whose content stayed the same', () => {
    expect(diffFiles([{ path: 'a.ts', before: 'x\n', after: 'x\n' }])).toEqual([]);
  });

  it('writes a git-style patch with counts', () => {
    const [diff] = diffFiles([{ path: 'a.ts', before: 'a\nb\nc\n', after: 'a\nB\nc\nd\n' }]);
    expect(diff).toMatchObject({ path: 'a.ts', status: 'modified', additions: 2, deletions: 1 });
    expect(diff?.patch).toBe(
      'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+d\n',
    );
  });

  it('marks new and deleted files as git does', () => {
    const [added, deleted] = diffFiles([
      { path: 'new.ts', before: null, after: 'one\n' },
      { path: 'old.ts', before: 'one\n', after: null },
    ]);
    expect(added?.status).toBe('added');
    expect(added?.patch).toContain('new file mode 100644\n--- /dev/null\n+++ b/new.ts');
    expect(deleted?.status).toBe('deleted');
    expect(deleted?.patch).toContain('deleted file mode 100644\n--- a/old.ts\n+++ /dev/null');
  });

  it('does not diff a binary file line by line', () => {
    const [diff] = diffFiles([{ path: 'a.bin', before: 'a\0', after: 'b\0' }]);
    expect(diff).toMatchObject({ additions: 0, deletions: 0 });
    expect(diff?.patch).toContain('Binary files a/a.bin and b/a.bin differ');
  });
});

describe('formatDiffs', () => {
  const diffs = diffFiles([
    { path: 'a.ts', before: 'const total = sum(a, b);\n', after: 'const total = add(a, b);\n' },
  ]);

  it('prints the plain patch without colour', () => {
    expect(formatDiffs(diffs, false)).toBe((diffs[0]?.patch ?? '').trimEnd());
  });

  it('highlights the words that changed on a replaced line', () => {
    const shown = formatDiffs(diffs, true);
    expect(shown).toContain(`${INVERSE}sum`);
    expect(shown).toContain(`${INVERSE}add`);
    expect(shown).toContain('\u001b[36m@@ -1,1 +1,1 @@');
  });

  it('keeps whole lines when they share too little to pair', () => {
    const rewritten = diffFiles([{ path: 'a.ts', before: 'alpha();\n', after: 'return 42;\n' }]);
    expect(formatDiffs(rewritten, true)).not.toContain(INVERSE);
  });

  it('keeps escape sequences from the repository out of the terminal', () => {
    const hostile = diffFiles([{ path: 'a\u001b[2J.ts', before: 'x\n', after: 'y\u001b[2J\r\n' }]);
    for (const color of [true, false]) {
      const shown = formatDiffs(hostile, color);
      // jsdiff quotes an unusual path as git does, so the escape arrives as text.
      expect(shown).toContain('"a/a\\033[2J.ts"');
      expect(shown).toContain('y?[2J');
      expect(shown).not.toContain('\u001b[2J');
      expect(shown).not.toContain('\r');
    }
    expect(hostile[0]?.patch).toContain('\u001b[2J');
  });
});

describe('formatDiffStat', () => {
  it('lists each file and a total, like git diff --stat', () => {
    const diffs = diffFiles([
      { path: 'a.ts', before: 'a\nb\n', after: 'a\nc\n' },
      { path: 'src/new.ts', before: null, after: 'x\ny\n' },
    ]);
    expect(formatDiffStat(diffs, false)).toBe(
      [
        ' a.ts       | +1 -1',
        ' src/new.ts | +2 -0 (new)',
        ' 2 files changed, 3 insertions(+), 1 deletions(-)',
      ].join('\n'),
    );
  });
});
