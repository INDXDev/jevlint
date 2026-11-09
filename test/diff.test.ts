import { describe, expect, it } from 'vitest';
import { diffFiles } from '../src/diff.ts';

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
