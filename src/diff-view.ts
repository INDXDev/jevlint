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

/** The colour of a line of this kind: red removed, green added, plain context. */
function paintFor(kind: Kind, c: Colors): (text: string) => string {
  if (kind === 'removed') return c.red;
  return kind === 'added' ? c.green : (text) => text;
}

/** Paints a line, with its changed words in reverse video. */
function paintSegments(segments: Segment[], kind: Kind, c: Colors): string {
  const text = segments.map((part) => (part.changed ? c.inverse(part.text) : part.text)).join('');
  return paintFor(kind, c)(text);
}

/** One row of a hunk: the old side on the left and the new on the right. Either may be missing. */
type Row = [Side | undefined, Side | undefined];

/** Line numbers in the old and the new file. */
interface LineNumbers {
  old: number;
  new: number;
}

/** A stretch of a hunk: unchanged lines, then the lines removed, then the lines added after them. */
interface Block {
  context: string[];
  removed: string[];
  added: string[];
}

/** The lines from `start` on that begin with `sign`, without the sign. */
function runOf(lines: string[], start: number, sign: string): string[] {
  const end = lines.findIndex((line, index) => index >= start && !line.startsWith(sign));
  return lines.slice(start, end === -1 ? lines.length : end).map((line) => line.slice(1));
}

/** Splits a hunk's lines, each starting with ` `, `-` or `+`, into blocks. */
function blocksOf(lines: string[]): Block[] {
  const blocks: Block[] = [];
  for (let start = 0; start < lines.length; ) {
    const context = runOf(lines, start, ' ');
    const removed = runOf(lines, start + context.length, '-');
    const added = runOf(lines, start + context.length + removed.length, '+');
    blocks.push({ context, removed, added });
    start += context.length + removed.length + added.length;
  }
  return blocks;
}

/** Unchanged lines, the same on both sides, numbered from `first`. */
function contextRows(lines: string[], first: LineNumbers): Row[] {
  return lines.map((text, i) => {
    const segments = whole(text);
    return [
      { number: first.old + i, kind: 'context', segments },
      { number: first.new + i, kind: 'context', segments },
    ];
  });
}

/**
 * Pairs removed lines with the added lines that replaced them, numbered from `first`. When as many
 * lines were added as removed, each pair is compared word by word, as git's diff-highlight does.
 */
function changeRows(removed: string[], added: string[], first: LineNumbers): Row[] {
  const lineForLine = removed.length === added.length;
  return Array.from({ length: Math.max(removed.length, added.length) }, (_, i) => {
    const before = removed[i];
    const after = added[i];
    const words =
      lineForLine && before !== undefined && after !== undefined
        ? wordSegments(before, after)
        : undefined;
    const left: Side | undefined =
      before === undefined
        ? undefined
        : { number: first.old + i, kind: 'removed', segments: words?.[0] ?? whole(before) };
    const right: Side | undefined =
      after === undefined
        ? undefined
        : { number: first.new + i, kind: 'added', segments: words?.[1] ?? whole(after) };
    return [left, right];
  });
}

/** A hunk as numbered rows, old beside new. Lines that are not diff lines, as `\ No newline`, are left out. */
function rowsOf(hunk: Hunk): Row[] {
  const lines = hunk.lines.filter((line) => /^[ +-]/.test(line)).map(shown);
  let blockStart: LineNumbers = { old: hunk.oldStart, new: hunk.newStart };
  return blocksOf(lines).flatMap(({ context, removed, added }) => {
    const changeStart = {
      old: blockStart.old + context.length,
      new: blockStart.new + context.length,
    };
    const rows = [...contextRows(context, blockStart), ...changeRows(removed, added, changeStart)];
    blockStart = { old: changeStart.old + removed.length, new: changeStart.new + added.length };
    return rows;
  });
}

/** Where a range starts as git writes it: jsdiff stores an empty range one line later. */
const gitStart = (start: number, count: number) => (count === 0 ? start - 1 : start);

/** A hunk's `@@` header, as git writes it. */
const rangeOf = ({ oldStart, oldLines, newStart, newLines }: Hunk) =>
  `@@ -${gitStart(oldStart, oldLines)},${oldLines} +${gitStart(newStart, newLines)},${newLines} @@`;

const SIGNS: Record<Kind, string> = { context: ' ', removed: '-', added: '+' };

/** A hunk as git prints it, with changed words highlighted. */
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

/** The terminal columns a character takes: 0, 1 or 2. */
function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (ZERO_WIDTH.includes(code) || COMBINING_MARK.test(char)) return 0;
  return WIDE_RANGES.some(([low = 0, high = 0]) => code >= low && code <= high) ? 2 : 1;
}

/** The terminal columns text takes, which `length` gets wrong for wide characters. */
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

/** Pads segments that take `used` columns out to `width`. */
function pad(segments: Segment[], used: number, width: number): Segment[] {
  return used < width
    ? [...segments, { text: ' '.repeat(width - used), changed: false }]
    : segments;
}

/** The size of one side-by-side panel. */
interface Panel {
  /** Columns for the line number. */
  digits: number;
  /** Columns for the whole panel. */
  width: number;
}

/** Room a panel needs besides its text: a space, the sign and a space. */
const PANEL_GUTTER = 3;

/** One panel of a row: line number, sign and text, cut or padded to the panel's width. */
function splitSide(side: Side | undefined, panel: Panel, c: Colors): string {
  const { digits, width } = panel;
  if (!side) return ' '.repeat(width);
  const number = c.dim(String(side.number).padStart(digits));
  const text = fit(side.segments, width - digits - PANEL_GUTTER);
  const sign = paintFor(side.kind, c)(SIGNS[side.kind]);
  return `${number} ${sign} ${paintSegments(text, side.kind, c)}`;
}

/** The highest line number any hunk shows, which sets the width of the number column. */
function lastLine(hunks: Hunk[]): number {
  return Math.max(
    1,
    ...hunks.map(({ oldStart, oldLines, newStart, newLines }) =>
      Math.max(oldStart + oldLines, newStart + newLines),
    ),
  );
}

/** A dim rule across the screen, with a label near its start. */
function rule(label: string, width: number, c: Colors): string {
  return c.dim(`── ${label} ${'─'.repeat(Math.max(0, width - textWidth(label) - 4))}`);
}

/** Fewest columns of text a panel keeps, however narrow the terminal. */
const MIN_PANEL_TEXT = 5;
/** The ` │ ` between the two panels. */
const DIVIDER_WIDTH = 3;

/** Hunks as two numbered panels, old on the left, each under a rule with its range. */
function splitHunks(hunks: Hunk[], width: number, c: Colors): string[] {
  const digits = String(lastLine(hunks)).length;
  const panelWidth = Math.max(
    digits + PANEL_GUTTER + MIN_PANEL_TEXT,
    Math.floor((width - DIVIDER_WIDTH) / 2),
  );
  const panel: Panel = { digits, width: panelWidth };
  const divider = c.dim('│');
  return hunks.flatMap((hunk) => [
    rule(rangeOf(hunk), width, c),
    ...rowsOf(hunk).map(
      ([left, right]) => `${splitSide(left, panel, c)} ${divider} ${splitSide(right, panel, c)}`,
    ),
  ]);
}

const STATUS: Record<FileDiff['status'], string> = {
  added: 'new file',
  modified: 'modified',
  deleted: 'deleted',
};

/** A bold bar across the screen naming a file, its status and its line counts. */
function fileTitle(diff: FileDiff, width: number, c: Colors): string {
  const label = ` ${shown(diff.path)}  ${STATUS[diff.status]}  +${diff.additions} -${diff.deletions} `;
  const bar = '━'.repeat(Math.max(3, width - textWidth(label) - 3));
  return c.bold(`━━━${label}${bar}`);
}

/** Lines before the first hunk: git's headers, or the note on a binary file. */
const headerOf = (patch: string) => {
  const lines = linesOf(patch).map(shown);
  const first = lines.findIndex((line) => line.startsWith('@@'));
  return first === -1 ? lines : lines.slice(0, first);
};

/** One file's diff: unified under git's headers, or split under a title bar. */
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

/** Colours a score delta: green up, red down, dim unchanged. */
function paintDelta(delta: number, c: Colors): (text: string) => string {
  if (delta > 0) return c.green;
  return delta < 0 ? c.red : c.dim;
}

/** A score change as `score 70 -> 85 (+15)`, just the score when there was none before, or empty. */
function formatChange({ before, after }: ScoreChange, c: Colors): string {
  if (after === null) return '';
  if (before === null) return `  score ${formatScore(after)}`;
  const delta = Math.round((after - before) * 100) / 100;
  const sign = delta > 0 ? `+${delta}` : String(delta);
  const paint = paintDelta(delta, c);
  return `  score ${formatScore(before)} -> ${formatScore(after)} ${paint(`(${sign})`)}`;
}

/** What `formatDiffStat` adds after a file that was not just modified. */
const STAT_NOTE: Record<FileDiff['status'], string> = {
  added: '  (new)',
  modified: '',
  deleted: '  (deleted)',
};

/** Summarises diffs as `git diff --stat` does, with each file's score change when it is known. */
export function formatDiffStat(
  diffs: FileDiff[],
  color: boolean,
  scores: Map<string, ScoreChange> = new Map(),
): string {
  const c = pc.createColors(color);
  const plainCounts = ({ additions, deletions }: FileDiff) => `+${additions} -${deletions}`;
  const pathWidth = Math.max(...diffs.map(({ path }) => textWidth(shown(path))));
  const countWidth = Math.max(...diffs.map((diff) => plainCounts(diff).length));
  const rows = diffs.map((diff) => {
    const path = shown(diff.path);
    const pathPadding = ' '.repeat(pathWidth - textWidth(path));
    const counts = `${c.green(`+${diff.additions}`)} ${c.red(`-${diff.deletions}`)}`;
    const countPadding = ' '.repeat(countWidth - plainCounts(diff).length);
    const score = scores.get(diff.path);
    const scoreNote = score ? formatChange(score, c) : '';
    return ` ${path}${pathPadding} | ${counts}${countPadding}${scoreNote}${STAT_NOTE[diff.status]}`;
  });
  const sum = (key: 'additions' | 'deletions') => diffs.reduce((total, d) => total + d[key], 0);
  const files = diffs.length === 1 ? '1 file' : `${diffs.length} files`;
  const total = ` ${files} changed, ${sum('additions')} insertions(+), ${sum('deletions')} deletions(-)`;
  return [...rows, total].join('\n');
}
