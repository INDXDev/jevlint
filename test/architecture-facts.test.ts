import { describe, expect, it } from 'vitest';
import { entryKind } from '../src/architecture/entrypoints.ts';
import { classifyPackage, matchesPackage } from '../src/architecture/externals.ts';
import { buildFacts, type FactsInput, isTestPath } from '../src/architecture/facts.ts';
import type { FactModule } from '../src/types.ts';

const mod = (
  path: string,
  imports: string[] = [],
  externals: string[] = [],
  symbols: string[] = [],
): FactModule => ({
  path,
  language: 'typescript',
  lines: 10,
  imports: imports.map((target, index) => ({ path: target, line: index + 1 })),
  externals: externals.map((name, index) => ({ package: name, line: index + 1 })),
  symbols,
});

const facts = (modules: FactModule[], extra: Partial<FactsInput> = {}) =>
  buildFacts({
    root: '/r',
    commit: 'abc',
    modules,
    entrypoints: [],
    churn: new Map(),
    commits: [],
    warnings: [],
    ...extra,
  });

describe('isTestPath', () => {
  it.each([
    ['test/a.ts', true],
    ['src/__tests__/a.ts', true],
    ['src/a.test.ts', true],
    ['pkg/a_test.go', true],
    ['tests/test_a.py', true],
    ['spec/a.rb', true],
    ['packages/runtime-tests/a.ts', true],
    ['app/e2e/login.ts', true],
    ['src/contests/a.ts', false],
    ['src/spec/check.ts', false],
    ['src/latest.ts', false],
  ])('%s is a test: %s', (path, expected) => {
    expect(isTestPath(path)).toBe(expected);
  });
});

describe('buildFacts', () => {
  const layered = [
    mod('src/web/routes.ts', ['src/core/orders.ts'], ['express']),
    mod('src/web/views.ts', ['src/core/orders.ts']),
    mod('src/core/orders.ts', ['src/db/client.ts'], [], ['placeOrder']),
    mod('src/core/stock.ts', ['src/db/client.ts']),
    mod('src/db/client.ts', [], ['pg', 'node:fs'], ['query']),
    mod('src/db/schema.ts'),
    mod('src/web/forms.ts'),
    mod('src/core/prices.ts'),
    mod('test/orders.test.ts', ['src/core/orders.ts']),
  ];

  it('seeds components from directories and leaves tests out', () => {
    const result = facts(layered);
    expect(result.components.map(({ id, paths }) => [id, paths])).toEqual([
      ['core', ['src/core/**']],
      ['db', ['src/db/**']],
      ['web', ['src/web/**']],
    ]);
    expect(result.tests).toEqual(['test/**']);
    expect(result.files).toBe(8);
  });

  it('infers layers, dependencies with evidence, and the interface others use', () => {
    const result = facts(layered);
    const byId = Object.fromEntries(result.components.map((c) => [c.id, c]));
    expect([byId.web?.layer, byId.core?.layer, byId.db?.layer]).toEqual([2, 1, 0]);
    expect(result.layers).toBe(3);
    expect(result.dependencies.find(({ from }) => from === 'web')).toMatchObject({
      to: 'core',
      weight: 2,
      evidence: [
        { path: 'src/web/routes.ts', line: 1, target: 'src/core/orders.ts' },
        expect.anything(),
      ],
    });
    expect(byId.db?.interface).toEqual(['query']);
    expect(byId.db?.central).toEqual(['src/db/client.ts']);
    expect(result.cycles).toEqual([]);
  });

  it('classifies externals', () => {
    const result = facts(layered);
    const byId = Object.fromEntries(result.externals.map((e) => [e.id, e]));
    expect(byId.postgres).toMatchObject({ kind: 'system', users: ['db'] });
    expect(byId['node:fs']).toMatchObject({ kind: 'runtime' });
    expect(byId.express).toMatchObject({ kind: 'system', title: 'Express' });
    expect(result.components.find(({ id }) => id === 'db')?.externals).toEqual(['postgres']);
  });

  it('maps entry points to components and follows flows from them', () => {
    const result = facts(layered, {
      entrypoints: [{ path: 'src/web/routes.ts', kind: 'express-handler' }],
    });
    expect(result.entrypoints).toEqual([
      { path: 'src/web/routes.ts', kind: 'express-handler', component: 'web' },
    ]);
    expect(result.flows).toEqual([
      { entry: 'src/web/routes.ts', components: ['web', 'core', 'db'] },
    ]);
  });

  it('reports components that change together without an import', () => {
    const commits = Array.from({ length: 3 }, () => ['src/web/views.ts', 'src/db/schema.ts']);
    expect(facts(layered, { commits }).coChanges).toEqual([{ a: 'db', b: 'web', commits: 3 }]);
  });

  it('collapses directories when there are too many to read', () => {
    const many = Array.from({ length: 14 }, (_, i) =>
      Array.from({ length: 2 }, (_, j) => mod(`src/plugins/p${i}/f${j}.ts`)),
    ).flat();
    const result = facts([...many, ...layered]);
    expect(result.components.find(({ paths }) => paths.includes('src/plugins/**'))).toBeDefined();
    expect(result.components.length).toBeLessThanOrEqual(12);
  });

  it('groups loose files left alone after clustering by directory', () => {
    const loose = [
      ...layered,
      mod('src/a.ts'),
      mod('src/b.ts'),
      mod('src/c.ts', ['src/d.ts']),
      mod('src/d.ts'),
    ];
    const ids = facts(loose).components.map(({ files }) =>
      files.filter((f) => /^src\/[a-d]\.ts$/.test(f)),
    );
    const leftovers = ids.filter((files) => files.length > 0);
    expect(leftovers.flat().sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
    expect(leftovers.every((files) => files.length > 1)).toBe(true);
  });

  it('splits a directory that mixes layers until no candidates form a cycle', () => {
    // `mixed` holds both a top file that uses `other` and a bottom file that `other` uses.
    const tangled = [
      mod('src/mixed/top.ts', ['src/other/a.ts']),
      mod('src/mixed/top2.ts', ['src/other/a.ts']),
      mod('src/mixed/top3.ts', ['src/other/a.ts']),
      mod('src/mixed/top4.ts', ['src/other/a.ts']),
      mod('src/mixed/base.ts'),
      mod('src/other/a.ts', ['src/mixed/base.ts']),
      mod('src/other/b.ts'),
      mod('src/third/c.ts'),
    ];
    const result = facts(tangled);
    expect(result.cycles).toEqual([]);
    const mixedParts = result.components.filter(({ files }) =>
      files.some((f) => f.startsWith('src/mixed/')),
    );
    expect(mixedParts).toHaveLength(2);
    expect(mixedParts.map(({ id }) => id).every((id) => id.startsWith('mixed-'))).toBe(true);
  });
});

describe('externals table', () => {
  it('matches package patterns', () => {
    expect(matchesPackage('@ai-sdk/*', '@ai-sdk/openai')).toBe(true);
    expect(matchesPackage('node:*', 'node:fs')).toBe(true);
    expect(matchesPackage('ai', 'aix')).toBe(false);
  });

  it('classifies systems, runtimes and libraries', () => {
    expect(classifyPackage('ai')).toMatchObject({ id: 'ai_sdk', kind: 'system' });
    expect(classifyPackage('os')).toMatchObject({ kind: 'runtime' });
    expect(classifyPackage('@scope/lib-x')).toEqual({
      id: 'scope_lib_x',
      title: '@scope/lib-x',
      kind: 'library',
    });
  });
});

describe('entryKind', () => {
  it('recognises manifests, paths and sources', () => {
    const manifest = new Map([['src/cli.ts', 'package-bin']]);
    expect(entryKind('src/cli.ts', 'typescript', '', manifest)).toBe('package-bin');
    expect(entryKind('app/shop/page.tsx', 'tsx', '', new Map())).toBe('next-route');
    expect(entryKind('cmd/main.go', 'go', 'package main\n', new Map())).toBe('go-main');
    expect(entryKind('a.py', 'python', 'if __name__ == "__main__":\n  x()', new Map())).toBe(
      'python-main',
    );
    expect(entryKind('a.ts', 'typescript', "app.get('/x', h)", new Map())).toBe('express-handler');
    expect(entryKind('a.ts', 'typescript', 'const x = 1', new Map())).toBeNull();
  });
});
