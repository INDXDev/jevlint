/** Formats results for CI tools. Pure: every function returns a string or data. */
import pkg from '../package.json' with { type: 'json' };
import { weakAnswers } from './prompt.ts';
import { describeFinding, withoutControlCharacters } from './report.ts';
import type { AstFinding, AuditReport, ChangeReview, ModelAnswer } from './types.ts';

const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const WHOLE_FILE_LINE = 1;

// Line and paragraph separators too, in case a log viewer breaks a line on them.
const UNSAFE_IN_COMMAND = /[^\P{Cc}\r\n]|[\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu;

/** Every value of `--format`. */
export const OUTPUT_FORMATS = ['text', 'json', 'sarif', 'github'] as const;

/** A value of `--format`. */
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** One problem at one place, whichever engine found it. */
export interface Issue {
  path: string;
  /** An AST rule, or a question's full id. */
  rule: string;
  /** 1-indexed. A model answer is about the whole file, so it points at line 1. */
  line: number;
  message: string;
}

function issuesOf(path: string, findings: AstFinding[], answers: ModelAnswer[]): Issue[] {
  return [
    ...findings.map((finding) => ({
      path,
      rule: finding.rule,
      line: finding.line,
      message: describeFinding(finding),
    })),
    ...answers.map(({ id, title, fix }) => ({
      path,
      rule: id,
      line: WHOLE_FILE_LINE,
      message: `${title}: ${fix}`,
    })),
  ];
}

/** Lists an audit's findings and weak answers. A pinned file is settled, as in `hasIssues`. */
export function auditIssues(report: AuditReport): Issue[] {
  return report.files
    .filter(({ pin }) => !pin)
    .flatMap((file) => issuesOf(file.path, file.ast?.findings ?? [], weakAnswers(file)));
}

/** Lists only what each change made worse. */
export function reviewIssues(reviews: ChangeReview[]): Issue[] {
  return reviews.flatMap(({ files }) =>
    files.flatMap(({ path, findings, answers }) => issuesOf(path, findings, answers)),
  );
}

/** A lone surrogate would make `encodeURIComponent` throw, and Windows file names can hold one. */
const relativeUri = (path: string) =>
  path.toWellFormed().split('/').map(encodeURIComponent).join('/');

/** Renders a SARIF 2.1.0 log with one run. */
export function formatSarif(issues: Issue[]): string {
  const ruleIds = [...new Set(issues.map(({ rule }) => rule))].sort();
  const log = {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'jevlint',
            version: pkg.version,
            rules: ruleIds.map((id) => ({ id, shortDescription: { text: id } })),
          },
        },
        results: issues.map(({ path, rule, line, message }) => ({
          ruleId: rule,
          level: 'warning',
          message: { text: withoutControlCharacters(message) },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: relativeUri(path) },
                region: { startLine: line },
              },
            },
          ],
        })),
      },
    ],
  };
  return JSON.stringify(log, null, 2);
}

/** A line break in repository text would start a workflow command of the repository's choosing. */
const escapeCommandData = (text: string) =>
  text
    .replace(UNSAFE_IN_COMMAND, '')
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');

/** `:` and `,` end a property, so a raw one would let a path set the others. */
const escapeCommandProperty = (text: string) =>
  escapeCommandData(text).replaceAll(':', '%3A').replaceAll(',', '%2C');

/** Renders GitHub Actions workflow commands, one line per issue. */
export function formatGithub(issues: Issue[]): string {
  return issues
    .map(({ path, rule, line, message }) => {
      const file = escapeCommandProperty(path);
      const title = escapeCommandProperty(rule);
      return `::warning file=${file},line=${line},title=${title}::${escapeCommandData(message)}`;
    })
    .join('\n');
}

/** Renders issues in a format for a CI tool. */
export function formatIssues(issues: Issue[], format: 'sarif' | 'github'): string {
  return format === 'sarif' ? formatSarif(issues) : formatGithub(issues);
}
