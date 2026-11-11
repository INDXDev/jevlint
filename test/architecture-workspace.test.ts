import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  goModuleOf,
  manifestEntries,
  stripJsonComments,
  tsconfigAliases,
  workspacePackages,
} from '../src/architecture/workspace.ts';

let root: string;
const write = async (files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jevlint-workspace-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('stripJsonComments', () => {
  it('removes comments and trailing commas, and leaves strings alone', () => {
    const text = `{
  // a comment
  "url": "http://x//y", /* block */
  "list": [1, 2,],
  "quote": "a \\" // b",
}`;
    expect(JSON.parse(stripJsonComments(text))).toEqual({
      url: 'http://x//y',
      list: [1, 2],
      quote: 'a " // b',
    });
  });
});

describe('tsconfigAliases', () => {
  it('makes targets root-relative from baseUrl, most specific first, and drops escapes', async () => {
    await write({
      'tsconfig.json': `{
        // JSONC
        "compilerOptions": {
          "baseUrl": "src",
          "paths": { "@/*": ["./*"], "@/lib/*": ["lib/*"], "out": ["../../x.ts"] },
        },
      }`,
    });
    expect(await tsconfigAliases(root)).toEqual([
      { pattern: '@/lib/*', targets: ['src/lib/*'] },
      { pattern: '@/*', targets: ['src/*'] },
    ]);
  });

  it('is empty with no tsconfig or a broken one', async () => {
    expect(await tsconfigAliases(root)).toEqual([]);
    await write({ 'tsconfig.json': '{ nope' });
    expect(await tsconfigAliases(root)).toEqual([]);
  });
});

describe('workspacePackages', () => {
  it('reads npm workspaces and pnpm-workspace.yaml, with entries', async () => {
    await write({
      'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
      'pnpm-workspace.yaml': 'packages:\n  - "apps/*"\n  - "!apps/skip"\n',
      'packages/core/package.json': JSON.stringify({
        name: '@acme/core',
        main: './dist/index.js',
        exports: { '.': { import: './src/index.ts' } },
      }),
      'apps/web/package.json': JSON.stringify({ name: 'web' }),
      'packages/nameless/package.json': '{}',
    });
    const packages = await workspacePackages(root);
    expect(packages.map(({ name, dir }) => [name, dir])).toEqual([
      ['@acme/core', 'packages/core'],
      ['web', 'apps/web'],
    ]);
    expect(packages[0]?.entries).toEqual([
      'packages/core/src/index.ts',
      'packages/core/dist/index.js',
    ]);
  });

  it('skips a manifest linked from outside the repository', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'jevlint-outside-'));
    await writeFile(join(outside, 'package.json'), JSON.stringify({ name: 'stolen' }));
    await write({ 'package.json': JSON.stringify({ workspaces: { packages: ['pkgs/*'] } }) });
    await mkdir(join(root, 'pkgs/a'), { recursive: true });
    await symlink(join(outside, 'package.json'), join(root, 'pkgs/a/package.json'));
    expect(await workspacePackages(root)).toEqual([]);
    await rm(outside, { recursive: true, force: true });
  });
});

describe('manifestEntries and goModuleOf', () => {
  it('reads bin and main, and the Go module', async () => {
    await write({
      'package.json': JSON.stringify({ bin: { a: './dist/cli.mjs' }, main: 'lib/index.js' }),
      'go.mod': 'module example.com/app\n\ngo 1.22\n',
    });
    expect([...(await manifestEntries(root))]).toEqual([
      ['dist/cli.mjs', 'package-bin'],
      ['lib/index.js', 'package-main'],
    ]);
    expect(await goModuleOf(root)).toBe('example.com/app');
  });
});
