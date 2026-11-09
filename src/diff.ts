/** Turns file contents before and after an edit into git-style diffs, plain or coloured. */
import { diffWordsWithSpace, formatPatch, type StructuredPatch, structuredPatch } from 'diff';
import pc from 'picocolors';
import { withoutEscapes } from './report.ts';
import type { FileDiff } from './types.ts';

/** One file's content before and after an edit. Null means the file did not exist. */
export interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
}

type Colors = ReturnType<typeof pc.createColors>;

const CONTEXT_LINES = 3;
const FILE_MODE = '100644';
// A diff of a huge or hostile file must not hang the command, so it falls back to a full rewrite.
const DIFF_TIMEOUT_MS = 5_000;
// Below this share of unchanged text, word highlights are noise, so the lines stay whole.
const MIN_SHARED_RATIO = 0.4;
const MAX_WORD_DIFF_CHARS = 1_000;

const isBinary = (text: string | null) => text?.includes('\0') ?? false;

function statusOf({ before, after }: FileChange): FileDiff['status'] {
  if (before === null) return 'added';
  return after === null ? 'deleted' : 'modified';
}

function linesOf(text: string): string[] {
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

/** Repository text, safe to print: no escape sequences, and no carriage return at the end. */
const shown = (line: string) => withoutEscapes(line.replace(/\r$/, ''));

function sharedRatio(parts: ReturnType<typeof diffWordsWithSpace>, longest: number): number {
  const shared = parts.filter((part) => !part.added && !part.removed);
  return shared.reduce((sum, part) => sum + part.value.length, 0) / Math.max(longest, 1);
}

/** Colours a removed line and the added line that replaced it, inverting the words that changed. */
function wordPair(removed: string, added: string, c: Colors): [string, string] | undefined {
  const [before, after] = [removed.slice(1), added.slice(1)];
  if (Math.max(before.length, after.length) > MAX_WORD_DIFF_CHARS) return undefined;
  const parts = diffWordsWithSpace(before, after);
  if (sharedRatio(parts, Math.max(before.length, after.length)) < MIN_SHARED_RATIO)
    return undefined;
  const side = (keep: 'removed' | 'added', skip: 'removed' | 'added') =>
    parts
      .filter((part) => !part[skip])
      .map((part) => (part[keep] ? c.inverse(part.value) : part.value))
      .join('');
  return [c.red(`-${side('removed', 'added')}`), c.green(`+${side('added', 'removed')}`)];
}

function colorLine(line: string, c: Colors): string {
  if (line.startsWith('+')) return c.green(line);
  if (line.startsWith('-')) return c.red(line);
  return line.startsWith('\\') ? c.dim(line) : line;
}

const runOf = (lines: string[], from: number, sign: string) => {
  let end = from;
  while (lines[end]?.startsWith(sign)) end++;
  return end;
};

/** Colours a hunk's lines. A run of removed lines followed by as many added ones is paired by word. */
function colorBody(lines: string[], c: Colors): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;
    const removedEnd = line.startsWith('-') ? runOf(lines, index, '-') : index;
    const addedEnd = runOf(lines, removedEnd, '+');
    if (removedEnd === index || addedEnd - removedEnd !== removedEnd - index) {
      out.push(colorLine(line, c));
      index++;
      continue;
    }
    const removed = lines.slice(index, removedEnd);
    const added = lines.slice(removedEnd, addedEnd);
    const pairs = removed.map((text, i) => wordPair(text, added[i] as string, c));
    out.push(...removed.map((text, i) => pairs[i]?.[0] ?? colorLine(text, c)));
    out.push(...added.map((text, i) => pairs[i]?.[1] ?? colorLine(text, c)));
    index = addedEnd;
  }
  return out;
}

/** Colours one file's patch: bold headers, cyan hunk ranges, red and green lines. */
function colorPatch(patch: string, c: Colors): string {
  const lines = linesOf(patch).map(shown);
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'));
  const headerEnd = firstHunk === -1 ? lines.length : firstHunk;
  const out = lines.slice(0, headerEnd).map((line) => c.bold(line));
  let body: string[] = [];
  const flush = () => {
    out.push(...colorBody(body, c));
    body = [];
  };
  for (const line of lines.slice(headerEnd)) {
    if (!line.startsWith('@@')) {
      body.push(line);
      continue;
    }
    flush();
    // Git puts the context after the second @@ in the default colour.
    const [, range = line, context = ''] = /^(@@ .*? @@)(.*)$/.exec(line) ?? [];
    out.push(`${c.cyan(range)}${context}`);
  }
  flush();
  return out.join('\n');
}

/** Renders diffs as one patch. Plain text is what `git apply` takes; colour is for a terminal. */
export function formatDiffs(diffs: FileDiff[], color: boolean): string {
  const c = pc.createColors(color);
  if (!color) return diffs.map(({ patch }) => linesOf(patch).map(shown).join('\n')).join('\n');
  return diffs.map(({ patch }) => colorPatch(patch, c)).join('\n');
}

/** Summarises diffs the way `git diff --stat` does, one line per file and a total. */
export function formatDiffStat(diffs: FileDiff[], color: boolean): string {
  const c = pc.createColors(color);
  const width = Math.max(...diffs.map(({ path }) => shown(path).length));
  const rows = diffs.map(({ path, status, additions, deletions }) => {
    const note = status === 'modified' ? '' : ` (${status === 'added' ? 'new' : 'deleted'})`;
    const counts = `${c.green(`+${additions}`)} ${c.red(`-${deletions}`)}`;
    return ` ${shown(path).padEnd(width)} | ${counts}${note}`;
  });
  const sum = (key: 'additions' | 'deletions') => diffs.reduce((total, d) => total + d[key], 0);
  const files = diffs.length === 1 ? '1 file' : `${diffs.length} files`;
  const total = ` ${files} changed, ${sum('additions')} insertions(+), ${sum('deletions')} deletions(-)`;
  return [...rows, total].join('\n');
}
