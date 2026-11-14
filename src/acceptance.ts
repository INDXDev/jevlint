/**
 * Acceptance criteria for `jevlint pr --acceptance`: cuts a pull request's body and the issues it
 * closes into chunks, each a candidate criterion. Line-based on purpose, with no Markdown parser:
 * the text is hostile, and a parser would be a large surface for it.
 */
import type { CriterionChunk } from './types.ts';

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
// Any indent, as a fence inside a nested list item has more than Markdown's three spaces.
const FENCE = /^\s*(`{3,}|~{3,})/;
const CHECKLIST_ITEM = /^\s*[-*+]\s+\[[ xX]\](?:\s+(.*))?$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s+(.*)$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
/** The row under a table's header, which may have no outer pipes: `--- | :---:`. */
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;
/** A line of HTML that frames rather than states, such as `<details>` or `<summary>Logs</summary>`. */
const HTML_BLOCK =
  /^\s*(?:<\/?(?:details|summary|div|p|img|picture|source|table|br|hr|h[1-6])\b|(?:<\/?[a-zA-Z][^>]*>\s*)+$)/i;
/** Where one sentence ends and the next begins, as `budgetWarnings` counts them. */
const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z0-9`"'(*_[])/g;

interface Line {
  line: number;
  text: string;
}

/** Removes HTML comments, which may span lines, keeping the line count. */
function withoutComments(lines: string[]): string[] {
  let open = false;
  return lines.map((line) => {
    let rest = line;
    let kept = '';
    while (rest) {
      const marker = open ? '-->' : '<!--';
      const at = rest.indexOf(marker);
      if (at < 0) return open ? kept : kept + rest;
      if (!open) kept += rest.slice(0, at);
      rest = rest.slice(at + marker.length);
      open = !open;
    }
    return kept;
  });
}

const tidy = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Splits a paragraph into sentences, each with the line it starts on. */
function sentences(lines: Line[]): Line[] {
  const starts: number[] = [];
  let joined = '';
  for (const { text } of lines) {
    starts.push(joined.length);
    joined += `${text} `;
  }
  const lineAt = (offset: number) =>
    lines[starts.findLastIndex((start) => start <= offset)]?.line ?? 0;
  const bounds = [...joined.matchAll(SENTENCE_END)].map(({ index, 0: gap }) => [
    index,
    index + gap.length,
  ]);
  const found: Line[] = [];
  let from = 0;
  for (const [end, next] of [...bounds, [joined.length, joined.length]] as [number, number][]) {
    const text = tidy(joined.slice(from, end));
    if (text) found.push({ line: lineAt(from), text });
    from = next;
  }
  return found;
}

/**
 * Cuts one source into chunks: each checklist item, each list item, and each sentence of a
 * paragraph, with its line and the headings above it. Code blocks, tables, HTML comments and
 * quoted text are left out. Headings are context, not a filter: what sits under "Out of scope" is
 * still a chunk, for the model to reject. Pure.
 */
export function chunkCriteria(source: string, text: string): CriterionChunk[] {
  const chunks: CriterionChunk[] = [];
  const headings: string[] = [];
  let fence: string | null = null;
  let table = false;
  let item: CriterionChunk | null = null;
  let paragraph: Line[] = [];
  const headingPath = () => headings.filter(Boolean).join(' > ');
  const close = () => {
    if (item?.text) chunks.push({ ...item, text: tidy(item.text) });
    item = null;
    const heading = headingPath();
    for (const sentence of sentences(paragraph)) chunks.push({ source, heading, ...sentence });
    paragraph = [];
  };
  withoutComments(text.split(/\r\n|\r|\n/)).forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (fence !== null) {
      // A fence closes only on a bare run of its own character, at least as long as it opened.
      const closing = raw.match(FENCE)?.[1] ?? '';
      if (closing[0] === fence[0] && closing.length >= fence.length && trimmed === closing) {
        fence = null;
      }
      return;
    }
    const opening = raw.match(FENCE)?.[1];
    if (opening) {
      close();
      fence = opening;
      return;
    }
    if (table && trimmed.includes('|')) return;
    table = false;
    if (TABLE_DELIMITER.test(raw)) {
      // The header row was read as text before its delimiter showed it was a table.
      if (paragraph.at(-1)?.text.includes('|')) paragraph.pop();
      close();
      table = true;
      return;
    }
    const title = raw.match(HEADING);
    if (title) {
      close();
      const level = (title[1] as string).length;
      headings.length = level;
      headings[level - 1] = tidy(title[2] as string);
      return;
    }
    if (
      !trimmed ||
      trimmed.startsWith('|') ||
      trimmed.startsWith('>') ||
      THEMATIC_BREAK.test(raw) ||
      HTML_BLOCK.test(raw)
    ) {
      close();
      return;
    }
    const checklist = raw.match(CHECKLIST_ITEM);
    const listed = checklist ? (checklist[1] ?? '') : raw.match(LIST_ITEM)?.[1];
    if (listed !== undefined) {
      close();
      item = { source, line, heading: headingPath(), text: listed };
      return;
    }
    // A line that follows a list item without a blank line continues it.
    if (item) item.text += ` ${trimmed}`;
    else paragraph.push({ line, text: trimmed });
  });
  close();
  return chunks;
}
