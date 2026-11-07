/** Formats spec reports and the loaded spec for the terminal. */
import pc from 'picocolors';
import { formatScore, formatUsage, plural, withoutControlCharacters } from '../report.ts';
import type {
  Spec,
  SpecCheckReport,
  SpecDriftReport,
  SpecItemRef,
  SpecItemResult,
} from '../types.ts';
import { fullId, GLOBAL } from './load.ts';

const longest = (texts: string[]) => Math.max(0, ...texts.map(({ length }) => length));

function itemLines(items: SpecItemRef[]): string[] {
  const width = longest(items.map(({ id }) => id));
  return items.map(({ id, text }) => `  ${id.padEnd(width)}  ${text}`);
}

/** A blank line, then the lines, or nothing when there are none. */
function section(lines: string[], title?: string): string[] {
  if (lines.length === 0) return [];
  return title === undefined ? ['', ...lines] : ['', title, ...lines];
}

const confidence = (value: number | null) => (value === null ? '' : `(${value.toFixed(2)})`);

const MARKS: Record<string, string> = {
  agrees: pc.green('✓'),
  satisfies: pc.green('✓'),
  absent: pc.dim('·'),
  'not-applicable': pc.dim('·'),
};

/** One row per file or document, then the items given for it, with confidence when asked. */
function problemRows(
  rows: { path: string; feature: string | null; featureConfidence: number | null; extra: string }[],
  shownItems: SpecItemResult<string>[][],
  withConfidence = false,
): string[] {
  const pathWidth = longest(rows.map(({ path }) => path));
  const featureWidth = longest(rows.map(({ feature }) => feature ?? '-'));
  const width = longest(shownItems.flat().map(({ id }) => id));
  return rows.flatMap(({ path, feature, featureConfidence, extra }, index) => [
    `  ${path.padEnd(pathWidth)}  ${(feature ?? '-').padEnd(featureWidth)}  ${confidence(featureConfidence).padEnd(6)}  ${extra}`.trimEnd(),
    ...(shownItems[index] ?? []).map(
      (item) =>
        `    ${MARKS[item.verdict] ?? pc.red('✗')} ${item.id.padEnd(width)}  ${withConfidence ? `${confidence(item.confidence)}  ` : ''}${item.text}`,
    ),
  ]);
}

/** How items were judged, as `3 agree, 1 absent, 0 contradict`. */
function verdictCounts(items: SpecItemResult<string>[], labels: [string, string][]): string {
  const count = (verdict: string) => items.filter((item) => item.verdict === verdict).length;
  return labels.map(([verdict, label]) => `${count(verdict)} ${label}`).join(', ');
}

const CHECK_LABELS: [string, string][] = [
  ['satisfies', 'satisfy'],
  ['violates', 'violate'],
  ['not-applicable', 'n/a'],
];
const DRIFT_LABELS: [string, string][] = [
  ['agrees', 'agree'],
  ['absent', 'absent'],
  ['contradicts', 'contradict'],
];

function warningLines(report: {
  warnings: string[];
  files?: { path: string; warnings: string[] }[];
  docs?: { path: string; warnings: string[] }[];
}): string[] {
  const entries = [...(report.files ?? []), ...(report.docs ?? [])];
  return [
    ...report.warnings.map((warning) => `  ${warning}`),
    ...entries.flatMap(({ path, warnings }) => warnings.map((warning) => `  ${path}: ${warning}`)),
  ];
}

/**
 * Lists every file with how its items were judged and its violated items, then the items no file
 * satisfies. `verbose` lists every item with its verdict and confidence.
 */
export function formatSpecCheck(untrusted: SpecCheckReport, verbose = false): string {
  const report = withoutControlCharacters(untrusted);
  const failing = report.files.map(({ items }) => items.filter((i) => i.verdict === 'violates'));
  const failingFiles = failing.filter((items) => items.length > 0).length;
  const counts = [
    `${plural(report.violations, 'violation')} in ${plural(failingFiles, 'file')}`,
    ...(report.complete ? [plural(report.unimplemented.length, 'unimplemented item')] : []),
  ];
  const clean = report.violations === 0 && report.unimplemented.length === 0;
  const header = clean
    ? pc.green(
        `Spec check: no problems in ${plural(report.files.length, 'file')} (${report.specDir})`,
      )
    : `Spec check: ${counts.join(', ')} (${report.specDir})`;
  const rows = report.files.map((file) => ({
    ...file,
    extra: [
      verdictCounts(file.items, CHECK_LABELS),
      file.score === null ? 'score -' : `score ${formatScore(file.score)}`,
    ].join('  '),
  }));
  return [
    header,
    ...section(
      problemRows(rows, verbose ? report.files.map(({ items }) => items) : failing, verbose),
    ),
    ...section(itemLines(report.unimplemented), 'Unimplemented: no file satisfies these items.'),
    ...(report.complete
      ? []
      : ['', pc.dim('Paths narrowed the run, so unimplemented items were not worked out.')]),
    ...section(warningLines(report), 'Warnings'),
    ...section(formatUsage(report.usage)),
  ].join('\n');
}

/**
 * Lists every document with how its items were judged and its contradicted items, then the
 * repository-wide drift. `verbose` lists every item with its verdict and confidence.
 */
export function formatSpecDrift(untrusted: SpecDriftReport, verbose = false): string {
  const report = withoutControlCharacters(untrusted);
  const shownItems = report.docs.map(({ items }) =>
    verbose ? items : items.filter((i) => i.verdict === 'contradicts'),
  );
  const counts = [
    plural(report.contradictions, 'contradiction'),
    `${report.uncovered.length} uncovered`,
    ...(report.complete
      ? [
          plural(report.unbacked.length, 'unbacked item'),
          plural(report.undocumented.length, 'undocumented feature'),
        ]
      : []),
  ];
  const clean =
    report.contradictions === 0 &&
    report.uncovered.length === 0 &&
    report.unbacked.length === 0 &&
    report.undocumented.length === 0;
  const header = clean
    ? pc.green(
        `Spec drift: no drift in ${plural(report.docs.length, 'document')} (${report.specDir})`,
      )
    : `Spec drift: ${counts.join(', ')} (${report.specDir})`;
  const rows = report.docs.map((doc) => ({
    ...doc,
    extra: [
      verdictCounts(doc.items, DRIFT_LABELS),
      doc.uncovered === null ? 'uncovered -' : `uncovered ${doc.uncovered.toFixed(2)}`,
      ...(doc.uncoveredAccepted === undefined ? [] : ['accepted']),
    ].join('  '),
  }));
  return [
    header,
    ...section(problemRows(rows, shownItems, verbose)),
    ...section(
      report.uncovered.map((path) => `  ${path}`),
      'Uncovered: these documents state requirements the spec misses. Recompile to add them.',
    ),
    ...section(itemLines(report.unbacked), 'Unbacked: no document states these items.'),
    ...section(
      report.undocumented.map((id) => `  ${id}`),
      'Undocumented: no document describes these features.',
    ),
    ...(report.complete
      ? []
      : [
          '',
          pc.dim(
            'Paths narrowed the run, so unbacked items and undocumented features were not worked out.',
          ),
        ]),
    ...section(warningLines(report), 'Warnings'),
    ...section(formatUsage(report.usage)),
  ].join('\n');
}

/** Prints the project, then each checklist with its full item ids. */
export function formatSpecList(untrusted: Spec): string {
  const { dir, index, features } = withoutControlCharacters(untrusted);
  const items = index.checklist.length + features.reduce((n, f) => n + f.checklist.length, 0);
  const groups = [
    { id: GLOBAL, label: 'Project checklist', checklist: index.checklist },
    ...features.map(({ id, title, summary, checklist }) => ({
      id,
      label: `${title}: ${summary}`,
      checklist,
    })),
  ];
  const width = longest(groups.flatMap(({ id, checklist }) => checklist.map((i) => fullId(id, i))));
  return [
    `${pc.bold(index.name)} (${dir}): ${plural(features.length, 'feature')}, ${plural(items, 'item')}`,
    `  ${index.description.trim()}`,
    ...groups.flatMap(({ id, label, checklist }) => [
      '',
      `  ${pc.bold(id)}  ${label}`,
      ...checklist.map((item) => `    ${fullId(id, item).padEnd(width)}  ${item.text}`),
    ]),
  ].join('\n');
}
