import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { fixerPaths, runFixers, TIMED_OUT_CODE } from '../src/fixers.ts';

const node = (script: string) => [process.execPath, '-e', script];

describe('fixerPaths', () => {
  const paths = ['a.ts', 'src/b.tsx', 'c.py', '.hidden/d.ts'];

  it('takes every path with no patterns', () => {
    expect(fixerPaths({ command: ['x'] }, paths)).toEqual(paths);
  });

  it('takes the paths matching gitignore-style patterns', () => {
    expect(fixerPaths({ command: ['x'], files: ['**/*.ts', '*.tsx'] }, paths)).toEqual([
      'a.ts',
      'src/b.tsx',
      '.hidden/d.ts',
    ]);
    expect(fixerPaths({ command: ['x'], files: ['*.rs'] }, paths)).toEqual([]);
  });
});

describe('runFixers', () => {
  // Prints its arguments as JSON, then exits with the code.
  const echo = (code: number) =>
    node(`console.log(JSON.stringify(process.argv.slice(1))); process.exit(${code})`);

  it('appends each path as one argument, never through a shell', async () => {
    const cwd = realpathSync(tmpdir());
    const output: string[] = [];
    const runs = await runFixers(cwd, [{ command: echo(0) }], ['a;rm -rf x.ts', '$(id).ts'], {
      onOutput: (text) => output.push(text),
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.code).toBe(0);
    expect(JSON.parse(output.join(''))).toEqual(['./a;rm -rf x.ts', './$(id).ts']);
    expect(runs[0]?.output).toBe(output.join(''));
  });

  it('runs only fixers that match a path, and reports failures without throwing', async () => {
    const cwd = realpathSync(tmpdir());
    const started: string[][] = [];
    const runs = await runFixers(
      cwd,
      [
        { command: echo(3), retry: true },
        { command: echo(0), files: ['*.py'] },
        { command: ['jevlint-no-such-command'] },
      ],
      ['a.ts'],
      { onStart: (_, paths) => started.push(paths) },
    );
    expect(started).toEqual([['a.ts'], ['a.ts']]);
    expect(runs.map(({ code, retry }) => ({ code, retry }))).toEqual([
      { code: 3, retry: true },
      { code: 127, retry: false },
    ]);
    expect(runs[1]?.output).toContain('Command not found: jevlint-no-such-command');
  });

  it('stops a command that runs past its timeout, and counts it as failed', async () => {
    const cwd = realpathSync(tmpdir());
    const started = Date.now();
    const runs = await runFixers(
      cwd,
      [{ command: node('setTimeout(() => {}, 60000)'), timeout: 0.3, retry: true }],
      ['a.ts'],
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(runs[0]).toMatchObject({ code: TIMED_OUT_CODE, timedOut: true });
    expect(runs[0]?.output).toContain('Timed out after 0.3s');
  });
});
