import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { parseFormat } from '../src/commands/shared.ts';
import {
  auditIssues,
  formatGithub,
  formatSarif,
  type Issue,
  reviewIssues,
} from '../src/formats.ts';
import type { AuditReport, ChangeReview, FileReport, ModelAnswer } from '../src/types.ts';

vi.setConfig({ testTimeout: 60_000 });

const CLI = join(import.meta.dirname, '../src/cli.ts');
const MESSY = 'export function f(a, b, c, d, e, g) { return a + b + c + d + e + g; }\n';
const CLEAN = 'export const a = 1;\n';

const answer = (compliance: number, extra: Partial<ModelAnswer> = {}): ModelAnswer => ({
  id: 'readable-code.naming',
  title: 'Names pack information',
  compliance,
  weight: 1,
  fix: 'Rename them.',
  ...extra,
});

const finding = { rule: 'params', message: '6 parameters (max 4)', line: 3, symbol: 'f' };

function file(extra: Partial<FileReport> = {}): FileReport {
  return {
    path: 'src/a.ts',
    language: 'typescript',
    lines: 10,
    score: 50,
    priority: 1,
    commits: 0,
    ast: { score: 0.5, findings: [finding] },
    model: {
      score: 0.5,
      answers: [answer(0.2), answer(0.9, { id: 'readable-code.good' })],
      presets: {},
      cached: false,
      truncated: false,
      inputTokens: 0,
    },
    warnings: [],
    ...extra,
  };
}

const report = (files: FileReport[]) => ({ files }) as AuditReport;

describe('auditIssues', () => {
  it('lists findings on their line, and weak answers on line 1', () => {
    expect(auditIssues(report([file()]))).toEqual([
      { path: 'src/a.ts', rule: 'params', line: 3, message: '6 parameters (max 4) in f' },
      {
        path: 'src/a.ts',
        rule: 'readable-code.naming',
        line: 1,
        message: 'Names pack information: Rename them.',
      },
    ]);
  });

  it('skips pinned answers and pinned files', () => {
    const pin = { value: 0.2, reason: 'accepted', line: 1 };
    const model = { ...file().model, answers: [answer(0.2, { pin })] } as FileReport['model'];
    expect(auditIssues(report([file({ model, ast: null })]))).toEqual([]);
    expect(auditIssues(report([file({ pin })]))).toEqual([]);
  });
});

describe('reviewIssues', () => {
  it('reports only what a change made worse', () => {
    const changed = {
      path: 'a.ts',
      before: 90,
      after: 50,
      findings: [finding],
      answers: [answer(0.2)],
      warnings: [],
    };
    const issues = reviewIssues([{ files: [changed] } as unknown as ChangeReview]);
    expect(issues.map(({ rule }) => rule)).toEqual(['params', 'readable-code.naming']);
  });
});

describe('formatSarif', () => {
  const issue: Issue = { path: 'src/a.ts', rule: 'params', line: 3, message: 'too many' };

  it('writes one run, with the tool, its rules and located results', () => {
    const issues = [issue, { ...issue, line: 9 }, { ...issue, rule: 'nesting' }];
    const log = JSON.parse(formatSarif(issues));
    expect(log.version).toBe('2.1.0');
    expect(log.runs).toHaveLength(1);
    const [{ tool, results }] = log.runs;
    expect(tool.driver.name).toBe('jevlint');
    expect(tool.driver.version).toBe(pkg.version);
    expect(tool.driver.rules.map(({ id }: { id: string }) => id)).toEqual(['nesting', 'params']);
    expect(results[0]).toEqual({
      ruleId: 'params',
      level: 'warning',
      message: { text: 'too many' },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: 'src/a.ts' },
            region: { startLine: 3 },
          },
        },
      ],
    });
  });

  it('percent-encodes each path segment, keeping the separators', () => {
    const log = JSON.parse(formatSarif([{ ...issue, path: 'a b/c:d#e%f\n.ts' }]));
    const [location] = log.runs[0].results[0].locations;
    expect(location.physicalLocation.artifactLocation.uri).toBe('a%20b/c%3Ad%23e%25f%0A.ts');
  });

  it('survives a path that is not valid Unicode', () => {
    expect(() => formatSarif([{ ...issue, path: 'a\ud800.ts' }])).not.toThrow();
  });

  it('drops control characters from messages', () => {
    const log = JSON.parse(formatSarif([{ ...issue, message: 'a\u001b[31m\u202eb' }]));
    expect(log.runs[0].results[0].message.text).toBe('a?[31m?b');
  });

  it('is valid with no issues', () => {
    expect(JSON.parse(formatSarif([])).runs[0].results).toEqual([]);
  });
});

describe('formatGithub', () => {
  const issue: Issue = { path: 'src/a.ts', rule: 'params', line: 3, message: 'too many' };

  it('writes one warning command per issue', () => {
    expect(formatGithub([issue, { ...issue, line: 4 }])).toBe(
      [
        '::warning file=src/a.ts,line=3,title=params::too many',
        '::warning file=src/a.ts,line=4,title=params::too many',
      ].join('\n'),
    );
  });

  it('cannot be made to start another command by a message', () => {
    const message = 'x\n::add-mask::secret\r::error::boom';
    const output = formatGithub([{ ...issue, message }]);
    expect(output.split(/[\r\n]/)).toHaveLength(1);
    expect(output).toContain('::x%0A::add-mask::secret%0D::error::boom');
  });

  it('cannot be made to start another command, or set a property, by a path', () => {
    const path = 'a.ts,line=99,title=x::\n::stop-commands::t\r.ts';
    const output = formatGithub([{ ...issue, path }]);
    expect(output.split(/[\r\n]/)).toHaveLength(1);
    expect(output).toBe(
      '::warning file=a.ts%2Cline=99%2Ctitle=x%3A%3A%0A%3A%3Astop-commands%3A%3At%0D.ts,line=3,title=params::too many',
    );
  });

  it('escapes the rule like any other property', () => {
    expect(formatGithub([{ ...issue, rule: 'a:b,c\nd' }])).toContain('title=a%3Ab%2Cc%0Ad::');
  });

  it('escapes % first, so an encoded line break stays literal text', () => {
    expect(formatGithub([{ ...issue, message: '100%0A::error::x' }])).toContain(
      '::100%250A::error::x',
    );
    expect(formatGithub([{ ...issue, path: '%0A.ts' }])).toContain('file=%250A.ts,');
  });

  it('removes other control characters and direction overrides', () => {
    const output = formatGithub([
      { ...issue, path: 'a\u0007\u001b\u202e.ts', message: 'a\tb\u0085c\u2028d\u0000e' },
    ]);
    expect(output).toBe('::warning file=a.ts,line=3,title=params::abcde');
  });

  it('prints nothing with no issues', () => {
    expect(formatGithub([])).toBe('');
  });
});

describe('parseFormat', () => {
  it('defaults to text, and treats --json as --format json', () => {
    expect(parseFormat({})).toBe('text');
    expect(parseFormat({ json: true })).toBe('json');
    expect(parseFormat({ json: true, format: 'json' })).toBe('json');
    expect(parseFormat({ format: 'sarif' })).toBe('sarif');
  });

  it('refuses an unknown format, and --json with another format', () => {
    expect(() => parseFormat({ format: 'xml' })).toThrow(/--format must be one of/);
    expect(() => parseFormat({ format: '' })).toThrow(/--format must be one of/);
    expect(() => parseFormat({ json: true, format: 'github' })).toThrow(/cannot go with/);
  });
});

function jevlint(cwd: string, ...args: string[]) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jevlint-home-')));
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home };
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
}

function project(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevlint-format-')));
  for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  const identity = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];
  spawnSync('git', [...identity, ...args], { cwd });
}

describe('--format on the command line', () => {
  it('prints SARIF and workflow commands from audit, with nothing else on stdout', () => {
    const dir = project({ 'a.ts': MESSY });
    const sarif = jevlint(dir, 'audit', '--ast-only', '--format', 'sarif');
    expect(sarif.status).toBe(0);
    expect(JSON.parse(sarif.stdout).runs[0].results[0].ruleId).toBe('params');
    const github = jevlint(dir, 'audit', '--ast-only', '--format=github');
    expect(github.stdout).toMatch(/^::warning file=a\.ts,line=1,title=params::/);
  });

  it('prints the same JSON for --json and --format json', () => {
    const dir = project({ 'a.ts': MESSY });
    const flag = JSON.parse(jevlint(dir, 'audit', '--ast-only', '--json').stdout);
    const format = JSON.parse(jevlint(dir, 'audit', '--ast-only', '--format', 'json').stdout);
    expect(format.files).toEqual(flag.files);
  });

  it.each([
    [['--format', 'xml'], '--format must be one of'],
    [['--json', '--format', 'sarif'], 'cannot go with'],
    [['--dry-run', '--format', 'sarif'], '--dry-run'],
  ])('exits 2 for %j', (flags, message) => {
    const { status, stderr } = jevlint(project({ 'a.ts': MESSY }), 'audit', '--ast-only', ...flags);
    expect(status).toBe(2);
    expect(stderr).toContain(message);
  });

  it('leaves the exit code to the score, not the format', () => {
    const dir = project({ 'a.ts': MESSY });
    for (const format of ['text', 'json', 'sarif', 'github']) {
      const run = jevlint(dir, 'audit', '--ast-only', '--fail-under', '99', '--format', format);
      expect(run.status).toBe(1);
    }
  });

  it('reports only what a commit made worse from commits', () => {
    const dir = project({ 'old.ts': MESSY, 'a.ts': CLEAN });
    git(dir, 'init', '-q');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'first');
    writeFileSync(join(dir, 'a.ts'), MESSY);
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'second');
    const { stdout, status } = jevlint(
      dir,
      'commits',
      '--count',
      '1',
      '--ast-only',
      '--format',
      'github',
    );
    expect(status).toBe(0);
    expect(stdout).toContain('file=a.ts,');
    expect(stdout).not.toContain('old.ts');
  });

  it('refuses a bad format before reading commits', () => {
    const { status, stderr } = jevlint(project({}), 'commits', '--format', 'xml');
    expect(status).toBe(2);
    expect(stderr).toContain('--format must be one of');
  });
});
