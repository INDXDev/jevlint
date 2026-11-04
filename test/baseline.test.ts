import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  type Baseline,
  newIssues,
  readBaseline,
  toBaseline,
  writeBaseline,
} from '../src/baseline.ts';
import { usesProviderKey } from '../src/commands/auth.ts';
import { UserError } from '../src/config.ts';
import type { AstFinding, AuditReport, FileReport, ModelAnswer } from '../src/types.ts';

vi.setConfig({ testTimeout: 60_000 });

const CLI = join(import.meta.dirname, '../src/cli.ts');
const MESSY = 'export function f(a, b, c, d, e, g) { return a + b + c + d + e + g; }\n';
const WORSE = 'export function f(a, b, c, d, e, g, h) { return a + b + c + d + e + g + h; }\n';
const ALSO_MESSY = 'export function k(a, b, c, d, e, g) { return a + b + c + d + e + g; }\n';
const BASELINE = '.jevlint/baseline.json';

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), 'jevlint-baseline-')));

const finding = (rule: string, value: number, symbol = 'f', line = 1): AstFinding => ({
  rule,
  message: `${rule} ${value}`,
  line,
  symbol,
  value,
  limit: 4,
});

const answer = (id: string, compliance: number, extra: Partial<ModelAnswer> = {}): ModelAnswer => ({
  id,
  title: id,
  compliance,
  weight: 1,
  fix: 'Fix it.',
  ...extra,
});

function file(
  path: string,
  findings: AstFinding[],
  answers: ModelAnswer[] = [],
  extra: Partial<FileReport> = {},
): FileReport {
  return {
    path,
    language: 'typescript',
    lines: 10,
    score: 50,
    priority: 1,
    commits: 0,
    ast: { score: 0.5, findings },
    model: {
      score: 0.5,
      answers,
      presets: {},
      cached: false,
      truncated: false,
      inputTokens: 0,
    },
    warnings: [],
    ...extra,
  };
}

const report = (files: FileReport[]) => ({ score: 58, files }) as AuditReport;

describe('toBaseline', () => {
  it('keeps only rule, symbol, value and weak unpinned answers, in a stable order', () => {
    const pin = { value: 0.1, reason: 'ok', line: 1 };
    const answers = [
      answer('q.z', 0.2),
      answer('q.a', 0.5),
      answer('q.good', 0.9),
      answer('q.pinned', 0.1, { pin }),
    ];
    const findings = [finding('params', 6), finding('nesting', 5, 'b'), finding('nesting', 5, 'a')];
    const files = [file('b.ts', findings, answers), file('a.ts', [finding('params', 5)])];
    const baseline = toBaseline(report(files));
    expect(baseline).toEqual({
      files: [
        { path: 'a.ts', findings: [{ rule: 'params', symbol: 'f', value: 5 }], answers: [] },
        {
          path: 'b.ts',
          findings: [
            { rule: 'nesting', symbol: 'a', value: 5 },
            { rule: 'nesting', symbol: 'b', value: 5 },
            { rule: 'params', symbol: 'f', value: 6 },
          ],
          answers: [
            { id: 'q.a', compliance: 0.5 },
            { id: 'q.z', compliance: 0.2 },
          ],
        },
      ],
    });
    expect(toBaseline(report(files.toReversed()))).toEqual(baseline);
  });

  it('leaves out clean files', () => {
    expect(toBaseline(report([file('a.ts', [])])).files).toEqual([]);
  });

  it('records findings of a pinned file, for when the pin goes', () => {
    const pin = { value: 1, reason: 'ok', line: 1 };
    const pinned = file('a.ts', [finding('params', 6)], [], { pin, model: null });
    expect(toBaseline(report([pinned])).files).toHaveLength(1);
  });
});

describe('newIssues', () => {
  const baseline: Baseline = {
    files: [
      {
        path: 'a.ts',
        findings: [{ rule: 'params', symbol: 'f', value: 6 }],
        answers: [{ id: 'q.naming', compliance: 0.5 }],
      },
    ],
  };

  it('drops a file with nothing new, even on another line or with a better value', () => {
    const moved = file('a.ts', [finding('params', 5, 'f', 40)], [answer('q.naming', 0.6)]);
    expect(newIssues(report([moved]), baseline).files).toEqual([]);
  });

  it('keeps findings that are new or worse, and only those', () => {
    const findings = [finding('params', 6), finding('nesting', 9)];
    const [kept] = newIssues(report([file('a.ts', findings)]), baseline).files;
    expect(kept?.ast?.findings.map(({ rule }) => rule)).toEqual(['nesting']);
    const worse = report([file('a.ts', [finding('params', 7)])]);
    expect(newIssues(worse, baseline).files).toHaveLength(1);
  });

  it('counts every issue of a file the baseline does not know', () => {
    const fresh = file('b.ts', [finding('params', 6)], [answer('q.naming', 0.5)]);
    const [kept] = newIssues(report([fresh]), baseline).files;
    expect(kept?.ast?.findings).toHaveLength(1);
    expect(kept?.model?.answers).toHaveLength(1);
  });

  it('applies the weak-answer rule of a change review', () => {
    const answers = [
      answer('q.naming', 0.4),
      answer('q.fresh', 0.6),
      answer('q.fine', 0.8),
      answer('q.pinned', 0.1, { pin: { value: 0.1, reason: 'ok', line: 1 } }),
    ];
    const [kept] = newIssues(report([file('a.ts', [], answers)]), baseline).files;
    expect(kept?.model?.answers.map(({ id }) => id)).toEqual(['q.naming', 'q.fresh']);
  });

  it('keeps the shape and totals of the report, and leaves it unchanged', () => {
    const original = report([file('b.ts', [finding('params', 6)]), file('a.ts', [])]);
    const copy = structuredClone(original);
    const filtered = newIssues(original, baseline);
    expect(filtered.score).toBe(58);
    expect(filtered.files[0]?.score).toBe(50);
    expect(original).toEqual(copy);
  });

  it('copes with a file that has no AST or model result', () => {
    const empty = file('a.ts', [], [], { ast: null, model: null });
    expect(newIssues(report([empty]), baseline).files).toEqual([]);
  });

  it('treats a pinned file as settled', () => {
    const pin = { value: 1, reason: 'ok', line: 1 };
    const pinned = file('b.ts', [finding('params', 9)], [], { pin });
    expect(newIssues(report([pinned]), baseline).files).toEqual([]);
  });
});

describe('writeBaseline and readBaseline', () => {
  const baseline: Baseline = {
    files: [{ path: 'a.ts', findings: [{ rule: 'file-lines', value: 900 }], answers: [] }],
  };

  it('round-trips, ending the file with a line break', async () => {
    const root = tempDir();
    await writeBaseline(root, baseline);
    expect(await readBaseline(root)).toEqual(baseline);
    expect(readFileSync(join(root, BASELINE), 'utf8').endsWith('}\n')).toBe(true);
  });

  it('replaces a symlink at the destination rather than writing through it', async () => {
    const root = tempDir();
    const outside = join(tempDir(), 'victim');
    writeFileSync(outside, 'keep');
    mkdirSync(join(root, '.jevlint'));
    symlinkSync(outside, join(root, BASELINE));
    await writeBaseline(root, baseline);
    expect(readFileSync(outside, 'utf8')).toBe('keep');
  });

  it('refuses a .jevlint that links outside the repository', async () => {
    const root = tempDir();
    const outside = tempDir();
    symlinkSync(outside, join(root, '.jevlint'));
    await expect(writeBaseline(root, baseline)).rejects.toThrow(/links outside/);
    expect(existsSync(join(outside, 'baseline.json'))).toBe(false);
    writeFileSync(join(outside, 'baseline.json'), '{"files":[]}');
    await expect(readBaseline(root)).rejects.toThrow(/links outside/);
  });

  it('refuses a dangling .jevlint link, leaving nothing outside', async () => {
    const root = tempDir();
    const outside = join(tempDir(), 'missing');
    symlinkSync(outside, join(root, '.jevlint'));
    await expect(writeBaseline(root, baseline)).rejects.toBeInstanceOf(UserError);
    expect(existsSync(outside)).toBe(false);
  });

  it('reports a file planted at .jevlint as a UserError', async () => {
    const root = tempDir();
    writeFileSync(join(root, '.jevlint'), '');
    await expect(writeBaseline(root, baseline)).rejects.toBeInstanceOf(UserError);
    await expect(readBaseline(root)).rejects.toBeInstanceOf(UserError);
  });

  it('allows a .jevlint that links inside the repository', async () => {
    const root = tempDir();
    mkdirSync(join(root, 'config'));
    symlinkSync(join(root, 'config'), join(root, '.jevlint'));
    await writeBaseline(root, baseline);
    expect(await readBaseline(root)).toEqual(baseline);
  });

  it('refuses a baseline file that links outside the repository', async () => {
    const root = tempDir();
    const outside = join(tempDir(), 'secret.json');
    writeFileSync(outside, '{"files":[]}');
    mkdirSync(join(root, '.jevlint'));
    symlinkSync(outside, join(root, BASELINE));
    await expect(readBaseline(root)).rejects.toThrow(/links outside/);
  });

  it('refuses a directory where the file should be', async () => {
    const root = tempDir();
    mkdirSync(join(root, BASELINE), { recursive: true });
    await expect(readBaseline(root)).rejects.toThrow(/not a regular file/);
  });

  it('asks for a baseline when there is none', async () => {
    const error = await readBaseline(tempDir()).catch((caught) => caught);
    expect(error).toBeInstanceOf(UserError);
    expect(error.message).toContain('jevlint baseline');
  });

  it.each([
    ['not JSON', 'root:x:0:0'],
    ['the wrong shape', '{"files":{}}'],
    ['an unknown key', '{"files":[],"run":"x"}'],
    ['a wrong value', '{"files":[{"path":"a","findings":[{"rule":1}],"answers":[]}]}'],
  ])('refuses %s as a UserError', async (_, text) => {
    const root = tempDir();
    mkdirSync(join(root, '.jevlint'));
    writeFileSync(join(root, BASELINE), text);
    const error = await readBaseline(root).catch((caught) => caught);
    expect(error).toBeInstanceOf(UserError);
    expect(error.message).not.toContain('root:x');
  });

  it('does not let a path collide with an object key', async () => {
    const root = tempDir();
    mkdirSync(join(root, '.jevlint'));
    const text = '{"files":[{"path":"__proto__","findings":[],"answers":[]}]}';
    writeFileSync(join(root, BASELINE), text);
    const loaded = await readBaseline(root);
    const constructor = file('constructor', [finding('params', 6)]);
    expect(newIssues(report([constructor]), loaded).files).toHaveLength(1);
  });
});

describe('usesProviderKey', () => {
  it('stops to ask about keys for a baseline that uses a model', () => {
    expect(usesProviderKey('jevlint baseline', [])).toBe(true);
    expect(usesProviderKey('jevlint baseline', ['--ast-only'])).toBe(false);
  });
});

function jevlint(cwd: string, ...args: string[]) {
  const home = tempDir();
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home };
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
}

function project(files: Record<string, string>): string {
  const dir = tempDir();
  for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
  return dir;
}

describe('baseline and audit --new on the command line', () => {
  it('passes on an unchanged repository, and writes the same file twice', () => {
    const dir = project({ 'a.ts': MESSY, 'b.ts': ALSO_MESSY });
    expect(jevlint(dir, 'baseline', '--ast-only').status).toBe(0);
    const first = readFileSync(join(dir, BASELINE), 'utf8');
    jevlint(dir, 'baseline', '--ast-only');
    expect(readFileSync(join(dir, BASELINE), 'utf8')).toBe(first);
    const { status, stdout } = jevlint(dir, 'audit', '--new', '--ast-only');
    expect(status).toBe(0);
    expect(stdout).toContain('No new issues');
  });

  it('exits 1 for a worse or new finding, in every format', () => {
    const dir = project({ 'a.ts': MESSY, 'b.ts': MESSY });
    jevlint(dir, 'baseline', '--ast-only');
    writeFileSync(join(dir, 'a.ts'), WORSE);
    writeFileSync(join(dir, 'c.ts'), ALSO_MESSY);
    for (const format of ['text', 'json', 'sarif', 'github']) {
      const run = jevlint(dir, 'audit', '--new', '--ast-only', '--format', format);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('2 files with new issues');
      expect(run.stdout).toContain('a.ts');
      expect(run.stdout).toContain('c.ts');
      expect(run.stdout).not.toContain('b.ts');
    }
  });

  it('keeps the report shape in JSON, with files narrowed', () => {
    const dir = project({ 'a.ts': MESSY, 'b.ts': MESSY });
    jevlint(dir, 'baseline', '--ast-only');
    writeFileSync(join(dir, 'c.ts'), ALSO_MESSY);
    const full = JSON.parse(jevlint(dir, 'audit', '--ast-only', '--json').stdout);
    const narrowed = JSON.parse(jevlint(dir, 'audit', '--new', '--ast-only', '--json').stdout);
    expect(Object.keys(narrowed)).toEqual(Object.keys(full));
    expect(narrowed.score).toBe(full.score);
    expect(narrowed.files.map(({ path }: { path: string }) => path)).toEqual(['c.ts']);
  });

  it('exits 2 and asks for a baseline when there is none', () => {
    const { status, stderr } = jevlint(project({ 'a.ts': MESSY }), 'audit', '--new', '--ast-only');
    expect(status).toBe(2);
    expect(stderr).toContain('jevlint baseline');
  });

  it('exits 2 when no file was scored, as nothing was compared', () => {
    const dir = project({ 'a.ts': MESSY });
    jevlint(dir, 'baseline', '--ast-only');
    const { status, stderr } = jevlint(dir, 'audit', '--new', '--ast-only', 'missing-dir');
    expect(status).toBe(2);
    expect(stderr).not.toBe('');
  });

  it('still applies fail_under beside --new', () => {
    const dir = project({ 'a.ts': MESSY });
    jevlint(dir, 'baseline', '--ast-only');
    const { status, stderr } = jevlint(dir, 'audit', '--new', '--ast-only', '--fail-under', '99');
    expect(status).toBe(1);
    expect(stderr).toContain('is below 99');
  });

  it('does not count a baseline as source to audit', () => {
    const dir = project({ 'a.ts': MESSY });
    jevlint(dir, 'baseline', '--ast-only');
    const { stdout } = jevlint(dir, 'audit', '--ast-only', '--json');
    expect(JSON.parse(stdout).files).toHaveLength(1);
  });

  it('refuses a linked .jevlint with exit 2', () => {
    const dir = project({ 'a.ts': MESSY });
    symlinkSync(tempDir(), join(dir, '.jevlint'));
    const { status, stderr } = jevlint(dir, 'baseline', '--ast-only');
    expect(status).toBe(2);
    expect(stderr).toContain('links outside');
  });
});
