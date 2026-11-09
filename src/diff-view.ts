/** Draws diffs for a terminal: unified as git does, or side by side as delta does, plus a summary. */
import { diffWordsWithSpace, parsePatch } from 'diff';
import pc from 'picocolors';
import { linesOf } from './diff.ts';
import { formatScore, withoutEscapes } from './report.ts';
import type { FileDiff } from './types.ts';

type Colors = ReturnType<typeof pc.createColors>;
type Hunk = ReturnType<typeof parsePatch>[number]['hunks'][number];

/** How diffs are drawn. */
export interface DiffView {
  color: boolean;
  /** `split` puts the old lines on the left and the new ones on the right. */
  layout: 'unified' | 'split';
  /** Terminal columns, which `split` fills. */
  width: number;
}

/** Below this width, two panels leave too little of each line to read. */
export const SPLIT_MIN_WIDTH = 120;

// Below this share of unchanged text, word highlights are noise, so the lines stay whole.
const MIN_SHARED_RATIO = 0.4;
const MAX_WORD_DIFF_CHARS = 1_000;
const TAB = '    ';
const ELLIPSIS = '…';
// East Asian wide characters and emoji take two columns, so a panel must count them twice.
const WIDE_RANGES = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd],
];
// Zero-width space and joiner, and the variation selector that turns a character into emoji.
const ZERO_WIDTH = [0x200b, 0x200d, 0xfe0f];
const COMBINING_MARK = /\p{Mn}/u;

/** A run of a line's text, and whether it is a word that changed within the line. */
interface Segment {
  text: string;
  changed: boolean;
}

type Kind = 'context' | 'removed' | 'added';

/** One side of a line: its number in its file, its kind and its text. */
interface Side {
  number: number;
  kind: Kind;
  segments: Segment[];
}

/** Repository text, safe to print: no escape sequences, and no carriage return at the end. */
const shown = (line: string) => withoutEscapes(line.replace(/\r$/, ''));

const whole = (text: string): Segment[] => [{ text, changed: false }];

/** Splits a replaced line and its replacement into words, or undefined when they share too little. */
function wordSegments(before: string, after: string): [Segment[], Segment[]] | undefined {
  const longest = Math.max(before.length, after.length, 1);
  if (longest > MAX_WORD_DIFF_CHARS) return undefined;
  const parts = diffWordsWithSpace(before, after);
  const shared = parts.filter((part) => !part.added && !part.removed);
  if (shared.reduce((sum, part) => sum + part.value.length, 0) / longest < MIN_SHARED_RATIO) {
    return undefined;
  }
  const side = (skip: 'added' | 'removed') =>
    parts
      .filter((part) => !part[skip])
      .map((part) => ({ text: part.value, changed: Boolean(part.added || part.removed) }));
  return [side('added'), side('removed')];
}

function paintFor(kind: Kind, c: Colors): (text: string) => string {
  if (kind === 'removed') return c.red;
  return kind === 'added' ? c.green : (text) => text;
}

function paintSegments(segments: Segment[], kind: Kind, c: Colors): string {
  const text = segments.map((part) => (part.changed ? c.inverse(part.text) : part.text)).join('');
  return paintFor(kind, c)(text);
}

/**
 * Pairs each run of removed lines with the added lines after it, numbering both sides. Equal runs
 * are compared word by word, as git's diff-highlight does.
 */
function rowsOf(hunk: Hunk): [Side | undefined, Side | undefined][] {
  const rows: [Side | undefined, Side | undefined][] = [];
  let oldNumber = hunk.oldStart;
  let newNumber = hunk.newStart;
  const lines = hunk.lines.filter((line) => !line.startsWith('\\')).map(shown);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;
    if (line.startsWith(' ')) {
      const segments = whole(line.slice(1));
      rows.push([
        { number: oldNumber++, kind: 'context', segments },
        { number: newNumber++, kind: 'context', segments },
      ]);
      index++;
      continue;
    }
    const removed: string[] = [];
    const added: string[] = [];
    while (lines[index]?.startsWith('-')) removed.push((lines[index++] as string).slice(1));
    while (lines[index]?.startsWith('+')) added.push((lines[index++] as string).slice(1));
    for (let i = 0; i < Math.max(removed.length, added.length); i++) {
      const [before, after] = [removed[i], added[i]];
      const words =
        removed.length === added.length && before !== undefined && after !== undefined
          ? wordSegments(before, after)
          : undefined;
      rows.push([
        before === undefined
          ? undefined
          : { number: oldNumber++, kind: 'removed', segments: words?.[0] ?? whole(before) },
        after === undefined
          ? undefined
          : { number: newNumber++, kind: 'added', segments: words?.[1] ?? whole(after) },
      ]);
    }
  }
  return rows;
}

/** jsdiff stores an empty range as starting one line later than git writes it. */
const rangeOf = ({ oldStart, oldLines, newStart, newLines }: Hunk) =>
  `@@ -${oldLines === 0 ? oldStart - 1 : oldStart},${oldLines} +${newLines === 0 ? newStart - 1 : newStart},${newLines} @@`;

const SIGNS: Record<Kind, string> = { context: ' ', removed: '-', added: '+' };

function unifiedHunk(hunk: Hunk, c: Colors): string[] {
  const header = rangeOf(hunk);
  const line = (side: Side) =>
    paintFor(side.kind, c)(SIGNS[side.kind]) + paintSegments(side.segments, side.kind, c);
  const out = [c.cyan(header)];
  let removed: string[] = [];
  let added: string[] = [];
  // Git prints a block's removed lines before its added ones, however the panels pair them.
  const flush = () => {
    out.push(...removed, ...added);
    removed = [];
    added = [];
  };
  for (const [left, right] of rowsOf(hunk)) {
    if (left?.kind === 'context') {
      flush();
      out.push(line(left));
      continue;
    }
    if (left) removed.push(line(left));
    if (right) added.push(line(right));
  }
  flush();
  return out;
}

function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (ZERO_WIDTH.includes(code) || COMBINING_MARK.test(char)) return 0;
  return WIDE_RANGES.some(([low = 0, high = 0]) => code >= low && code <= high) ? 2 : 1;
}

const textWidth = (text: string) => [...text].reduce((sum, char) => sum + charWidth(char), 0);

/** Cuts segments to `width` columns, ending in an ellipsis when cut, then pads them to it. */
function fit(segments: Segment[], width: number): Segment[] {
  const expanded = segments.map((part) => ({ ...part, text: part.text.replaceAll('	', TAB) }));
  const total = expanded.reduce((sum, part) => sum + textWidth(part.text), 0);
  if (total <= width) return pad(expanded, total, width);
  const out: Segment[] = [];
  let used = 0;
  for (const { text, changed } of expanded) {
    let kept = '';
    for (const char of text) {
      if (used + charWidth(char) > width - 1) {
        out.push({ text: kept, changed }, { text: ELLIPSIS, changed: false });
        return pad(out, used + 1, width);
      }
      kept += char;
      used += charWidth(char);
    }
    out.push({ text: kept, changed });
  }
  return pad(out, used, width);
}

function pad(segments: Segment[], used: number, width: number): Segment[] {
  return used < width
    ? [...segments, { text: ' '.repeat(width - used), changed: false }]
    : segments;
}

function splitSide(side: Side | undefined, digits: number, width: number, c: Colors): string {
  if (!side) return ' '.repeat(width);
  const number = c.dim(String(side.number).padStart(digits));
  const text = fit(side.segments, width - digits - 3);
  const sign = paintFor(side.kind, c)(SIGNS[side.kind]);
  return `${number} ${sign} ${paintSegments(text, side.kind, c)}`;
}

function lastLine(hunks: Hunk[]): number {
  return Math.max(
    1,
    ...hunks.map(({ oldStart, oldLines, newStart, newLines }) =>
      Math.max(oldStart + oldLines, newStart + newLines),
    ),
  );
}

function rule(label: string, width: number, c: Colors): string {
  return c.dim(`── ${label} ${'─'.repeat(Math.max(0, width - label.length - 4))}`);
}

function splitHunks(hunks: Hunk[], width: number, c: Colors): string[] {
  const digits = String(lastLine(hunks)).length;
  const side = Math.max(digits + 8, Math.floor((width - 3) / 2));
  return hunks.flatMap((hunk) => [
    rule(rangeOf(hunk), width, c),
    ...rowsOf(hunk).map(
      ([left, right]) =>
        `${splitSide(left, digits, side, c)} ${c.dim('│')} ${splitSide(right, digits, side, c)}`,
    ),
  ]);
}

const STATUS: Record<FileDiff['status'], string> = {
  added: 'new file',
  modified: 'modified',
  deleted: 'deleted',
};

function fileTitle(diff: FileDiff, width: number, c: Colors): string {
  const label = ` ${shown(diff.path)}  ${STATUS[diff.status]}  +${diff.additions} -${diff.deletions} `;
  const bar = '━'.repeat(Math.max(3, width - label.length - 3));
  return c.bold(`━━━${label}${bar}`);
}

/** Lines before the first hunk: git's headers, or the note on a binary file. */
const headerOf = (patch: string) => {
  const lines = linesOf(patch).map(shown);
  const first = lines.findIndex((line) => line.startsWith('@@'));
  return first === -1 ? lines : lines.slice(0, first);
};

function drawFile(diff: FileDiff, view: DiffView, c: Colors): string[] {
  const [parsed] = parsePatch(diff.patch);
  const hunks = parsed?.hunks ?? [];
  if (view.layout === 'split') {
    const binary = hunks.length === 0 ? headerOf(diff.patch).slice(1) : [];
    return [fileTitle(diff, view.width, c), ...binary, ...splitHunks(hunks, view.width, c), ''];
  }
  return [
    ...headerOf(diff.patch).map((line) => c.bold(line)),
    ...hunks.flatMap((h) => unifiedHunk(h, c)),
  ];
}

/**
 * Draws diffs. Unified and without colour, the text is the patch itself, which `git apply` takes.
 * Side by side, each file gets a title bar and two numbered panels, old on the left.
 */
export function formatDiffs(diffs: FileDiff[], view: DiffView): string {
  if (!view.color && view.layout === 'unified') {
    return diffs.map(({ patch }) => linesOf(patch).map(shown).join('\n')).join('\n');
  }
  const c = pc.createColors(view.color);
  return diffs.flatMap((diff) => drawFile(diff, view, c)).join('\n');
}

/** A file's score before and after a fix. Null means it had none, as a new or deleted file. */
export interface ScoreChange {
  before: number | null;
  after: number | null;
}

function formatChange({ before, after }: ScoreChange, c: Colors): string {
  if (before === null || after === null) {
    return after === null ? '' : `  score ${formatScore(after)}`;
  }
  const delta = Math.round((after - before) * 100) / 100;
  const sign = delta > 0 ? `+${delta}` : String(delta);
  const paint = delta > 0 ? c.green : delta < 0 ? c.red : c.dim;
  return `  score ${formatScore(before)} -> ${formatScore(after)} ${paint(`(${sign})`)}`;
}

/** Summarises diffs as `git diff --stat` does, with each file's score change when it is known. */
export function formatDiffStat(
  diffs: FileDiff[],
  color: boolean,
  scores: Map<string, ScoreChange> = new Map(),
): string {
  const c = pc.createColors(color);
  const width = Math.max(...diffs.map(({ path }) => shown(path).length));
  const countWidth = Math.max(...diffs.map((d) => `+${d.additions} -${d.deletions}`.length));
  const rows = diffs.map((diff) => {
    const { path, status, additions, deletions } = diff;
    const counts = `${c.green(`+${additions}`)} ${c.red(`-${deletions}`)}`;
    const padding = ' '.repeat(countWidth - `+${additions} -${deletions}`.length);
    const note = status === 'modified' ? '' : `  (${status === 'added' ? 'new' : 'deleted'})`;
    const score = scores.get(path);
    return ` ${shown(path).padEnd(width)} | ${counts}${padding}${score ? formatChange(score, c) : ''}${note}`;
  });
  const sum = (key: 'additions' | 'deletions') => diffs.reduce((total, d) => total + d[key], 0);
  const files = diffs.length === 1 ? '1 file' : `${diffs.length} files`;
  const total = ` ${files} changed, ${sum('additions')} insertions(+), ${sum('deletions')} deletions(-)`;
  return [...rows, total].join('\n');
}
