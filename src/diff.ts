/** Turns file contents before and after an edit into git-style diffs. */
import { formatPatch, type StructuredPatch, structuredPatch } from 'diff';
import type { FileDiff } from './types.ts';

/** One file's content before and after an edit. Null means the file did not exist. */
export interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
}

const CONTEXT_LINES = 3;
const FILE_MODE = '100644';
// A diff of a huge or hostile file must not hang the command, so it falls back to a full rewrite.
const DIFF_TIMEOUT_MS = 5_000;

const isBinary = (text: string | null) => text?.includes('\0') ?? false;

function statusOf({ before, after }: FileChange): FileDiff['status'] {
  if (before === null) return 'added';
  return after === null ? 'deleted' : 'modified';
}

/** Splits text into lines, without the empty one after a final newline. */
export function linesOf(text: string): string[] {
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

/** Replaces the whole file, for a diff that took too long to find. */
function rewriteHunks(before: string, after: string): StructuredPatch['hunks'] {
  const removed = linesOf(before);
  const added = linesOf(after);
  return [
    {
      oldStart: removed.length === 0 ? 0 : 1,
      oldLines: removed.length,
      newStart: added.length === 0 ? 0 : 1,
      newLines: added.length,
      lines: [...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)],
    },
  ];
}

function patchOf(change: FileChange, status: FileDiff['status']): StructuredPatch {
  const { path } = change;
  const before = change.before ?? '';
  const after = change.after ?? '';
  const oldName = status === 'added' ? '/dev/null' : `a/${path}`;
  const newName = status === 'deleted' ? '/dev/null' : `b/${path}`;
  const options = { context: CONTEXT_LINES, timeout: DIFF_TIMEOUT_MS };
  const patch = structuredPatch(oldName, newName, before, after, undefined, undefined, options) ?? {
    oldFileName: oldName,
    newFileName: newName,
    oldHeader: undefined,
    newHeader: undefined,
    hunks: rewriteHunks(before, after),
  };
  return {
    ...patch,
    isGit: true,
    isCreate: status === 'added',
    isDelete: status === 'deleted',
    ...(status === 'added' ? { newMode: FILE_MODE } : {}),
    ...(status === 'deleted' ? { oldMode: FILE_MODE } : {}),
  };
}

function binaryDiff(path: string, status: FileDiff['status']): FileDiff {
  const patch = `diff --git a/${path} b/${path}\nBinary files a/${path} and b/${path} differ\n`;
  return { path, status, additions: 0, deletions: 0, patch };
}

/** Diffs each change, leaving out files whose content stayed the same. */
export function diffFiles(changes: FileChange[]): FileDiff[] {
  return changes.flatMap((change): FileDiff[] => {
    if (change.before === change.after) return [];
    const status = statusOf(change);
    if (isBinary(change.before) || isBinary(change.after)) return [binaryDiff(change.path, status)];
    const patch = patchOf(change, status);
    const lines = patch.hunks.flatMap((hunk) => hunk.lines);
    return [
      {
        path: change.path,
        status,
        additions: lines.filter((line) => line.startsWith('+')).length,
        deletions: lines.filter((line) => line.startsWith('-')).length,
        patch: formatPatch(patch),
      },
    ];
  });
}
