import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commandLine,
  formatExplain,
  formatPlan,
  formatReport,
  formatUsage,
} from '../src/report.ts';
import type { AuditReport, FileReport } from '../src/types.ts';

const file = (overrides: Partial<FileReport> = {}): FileReport => ({
  path: 'src/orders/process.ts',
  language: 'typescript',
  lines: 212,
  score: 21,
  priority: 1.1,
  commits: 31,
  ast: {
    score: 0.39,
    findings: [
      { rule: 'params', message: 'params 5 (max 4)', line: 3, value: 5, limit: 4 },
      {
        rule: 'cognitive-complexity',
        message: 'cognitive complexity 38 (max 15)',
        line: 12,
        symbol: 'handleOrder',
        value: 38,
        limit: 15,
      },
    ],
  },
  model: null,
  warnings: [],
  ...overrides,
});

const answer = (compliance: number) => ({
  id: 'readable-code.naming',
  title: 'Names pack information',
  compliance,
  weight: 2,
  fix: 'Rename vague identifiers.',
});

const model = (compliance: number): FileReport['model'] => ({
  score: compliance,
  answers: [answer(compliance)],
  presets: {},
  cached: true,
  truncated: false,
  inputTokens: 10,
});

const report = (overrides: Partial<AuditReport> = {}): AuditReport => ({
  root: '/repo',
  provider: 'typesafe',
  model: 'jev-latest',
  presets: ['readable-code'],
  scale: 100,
  score: 58,
  files: [file()],
  skipped: [],
  usage: { inputTokens: 0, estimatedCostUsd: null, cacheHits: 0, modelCalls: 0 },
  ...overrides,
});

const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

const plain = (r: AuditReport, top = 20) => stripVTControlCharacters(formatReport(r, { top }));

describe('formatReport', () => {
  const columns = process.stdout.columns;
  afterEach(() => {
    process.stdout.columns = columns;
  });

  it('shows the header, a ranked row and next steps', () => {
    const output = plain(report());
    expect(output).toContain('/repo  ·  typesafe/jev-latest  ·  readable-code');
    expect(output).toContain('Repository score 58/100  ·  1 file  ·  1 below 50');
    expect(output).toMatch(/1 +21 {2}src\/orders\/process\.ts:12 {2}cognitive complexity 38/);
    expect(output).toContain('in handleOrder');
    expect(output).toContain('Next: jevlint explain src/orders/process.ts');
  });

  it('quotes a path in the next step, because it gets pasted into a shell', () => {
    const base = report();
    const [first] = base.files as [AuditReport['files'][number]];
    const output = plain({ ...base, files: [{ ...first, path: "a;curl x|sh;'.ts" }] });
    expect(output).toContain(`Next: jevlint explain 'a;curl x|sh;'\\''.ts'`);
    expect(output).toContain(`jevlint quickfix 'a;curl x|sh;'\\''.ts' --agent claude`);
  });

  it('neutralises bidirectional overrides, which disguise a file name', () => {
    expect(
      formatPlan(
        { files: ['a\u202Est.ts'], skipped: 0, estimatedTokens: 1, estimatedCostUsd: null },
        null,
      ),
    ).not.toContain('\u202E');
  });

  it('uses the configured scale', () => {
    const output = plain(report({ scale: 1, score: 0.58, files: [file({ score: 0.21 })] }));
    expect(output).toContain('0.58/1');
    expect(output).toContain('1 below 0.5');
  });

  it('picks whichever of finding and question is worse', () => {
    const worseQuestion = plain(report({ files: [file({ model: model(0.1) })] }));
    expect(worseQuestion).toContain('Names pack information');
    const worseFinding = plain(report({ files: [file({ model: model(0.9) })] }));
    expect(worseFinding).toContain('cognitive complexity 38');
  });

  it('handles an empty repository', () => {
    const output = plain(report({ files: [], score: 0 }));
    expect(output).toContain('No files to audit');
    expect(output).not.toContain('Repository score');
  });

  it('handles every file being skipped', () => {
    expect(plain(report({ files: [], skipped: ['a.txt', 'b.txt'] }))).toContain('Skipped 2 files');
  });

  it('says how many rows --top hid', () => {
    const output = plain(report({ files: [file(), file({ path: 'b.ts' })] }), 1);
    expect(output).toContain('1 more');
    expect(output).not.toContain('b.ts');
  });

  it('keeps the end of long paths in a narrow terminal', () => {
    process.stdout.columns = 60;
    const path = `${'deep/'.repeat(20)}process.ts`;
    const lines = plain(report({ files: [file({ path })] })).split('\n');
    const row = lines.find((line) => line.includes('process.ts:12')) as string;
    expect(row).toContain('…');
    expect(row.length).toBeLessThanOrEqual(60);
  });

  it('renders more rows than a call can take arguments', () => {
    const files = Array.from({ length: 150_000 }, () => file({ ast: null }));
    expect(plain(report({ files }), files.length)).toContain('150000');
  }, 30_000);

  it('treats a terminal reporting no width like a pipe', () => {
    process.stdout.columns = 0;
    const path = `${'deep/'.repeat(20)}process.ts`;
    expect(plain(report({ files: [file({ path })] }))).toContain(`${path}:12`);
  });

  it('neutralises control characters from the repository', () => {
    const evil = '\u001b]0;pwned\u0007\u009b31m\r\n';
    const pin = { value: 0.5, reason: `Reason${evil}`, line: 1 };
    const output = formatReport(
      report({
        root: `/repo${evil}`,
        files: [file({ path: `a${evil}.ts` }), file({ path: 'b.ts', pin })],
      }),
      { top: 20 },
    );
    expect(stripVTControlCharacters(output)).not.toMatch(CONTROL_EXCEPT_NEWLINE);
    expect(output).not.toContain('pwned\u0007');
  });

  it('drops the issue column when there is no room for it', () => {
    process.stdout.columns = 30;
    const row = plain(report())
      .split('\n')
      .find((line) => line.includes('process.ts:12'));
    expect(row).not.toContain('cognitive');
  });
});

describe('formatExplain', () => {
  it('lists findings and questions, worst first', () => {
    const target = file({ model: model(0.12), warnings: ['File truncated'] });
    const output = stripVTControlCharacters(formatExplain(target, report()));
    expect(output).toContain('Score 21/100');
    expect(output.indexOf('line 12')).toBeLessThan(output.indexOf('line  3'));
    expect(output).toContain('0.12  Names pack information (readable-code.naming)');
    expect(output).toContain('File truncated');
  });

  it('neutralises control characters from the repository', () => {
    const evil = '\u001b[2J\r';
    const target = file({
      path: `a${evil}.ts`,
      warnings: [`Provider error: ${evil}`],
      ast: {
        score: 1,
        findings: [{ rule: 'p', message: `m${evil}`, line: 1, symbol: `s${evil}` }],
      },
      model: model(0.1),
    });
    const output = formatExplain(target, report());
    expect(stripVTControlCharacters(output)).not.toMatch(CONTROL_EXCEPT_NEWLINE);
    expect(output).not.toContain('\u001b[2J');
  });

  it('says so when a file is clean', () => {
    const clean = file({ score: 100, ast: { score: 1, findings: [] } });
    expect(formatExplain(clean, report())).toContain('No findings');
  });
});

describe('formatUsage', () => {
  const usage = { inputTokens: 12345, estimatedCostUsd: 0.00052, cacheHits: 2, modelCalls: 3 };

  it('shows calls, tokens, cost and cache hits', () => {
    expect(formatUsage(usage)).toEqual([
      ' 3 model calls, 12,345 input tokens, about $0.0005. 2 cached, at no cost.',
    ]);
  });

  it('leaves out a cost it does not know, and a run with no model', () => {
    expect(formatUsage({ ...usage, estimatedCostUsd: null })[0]).not.toContain('$');
    expect(formatUsage({ ...usage, cacheHits: 0, modelCalls: 0 })).toEqual([]);
  });

  it('never rounds a real cost down to nothing', () => {
    expect(formatUsage({ ...usage, estimatedCostUsd: 0.00001 })[0]).toContain('under $0.0001');
  });
});

describe('formatPlan', () => {
  const plan = {
    files: ['a.ts', 'b.ts'],
    skipped: 0,
    estimatedTokens: 12345,
    estimatedCostUsd: null,
  };

  it('names the provider and token estimate', () => {
    const output = formatPlan(plan, 'typesafe');
    expect(output).toContain('a.ts');
    expect(output).toContain('2 files, about 12,345 tokens, would be sent to typesafe');
  });

  it('shows the cost and what was not counted', () => {
    const output = formatPlan({ ...plan, skipped: 3, estimatedCostUsd: 0.00052 }, 'typesafe');
    expect(output).toContain('about 12,345 tokens (about $0.0005), would be sent');
    expect(output).toContain('3 files pinned, blank or cached, and not counted.');
  });

  it('neutralises control characters in paths', () => {
    expect(formatPlan({ ...plan, files: ['a\u001b[2J.ts'] }, null)).not.toContain('\u001b');
  });

  it('promises nothing leaves the machine with no provider', () => {
    expect(formatPlan(plan, null)).toContain('nothing would be sent');
  });
});

describe('commandLine', () => {
  it('quotes arguments so a reader sees where each one ends', () => {
    expect(commandLine(['pnpm', 'biome', 'check', '--write'])).toBe('pnpm biome check --write');
    expect(commandLine(['node', 'fmt.js --check'])).toBe("node 'fmt.js --check'");
    expect(commandLine(['node', 'fmt.js', '--check'])).toBe('node fmt.js --check');
    expect(commandLine(['echo', "it's", ''])).toBe(`echo 'it'\\''s' ''`);
  });

  it('keeps control characters out', () => {
    expect(commandLine(['a\nb\u001b[2J'])).toBe("'a?b?[2J'");
  });
});
