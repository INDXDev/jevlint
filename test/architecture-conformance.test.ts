import { describe, expect, it } from 'vitest';
import { matchCalls } from '../src/architecture/collect.ts';
import {
  addedViolations,
  assign,
  callSearches,
  conformance,
  mapEdges,
  staticDrift,
} from '../src/architecture/conformance.ts';
import type {
  ArchitectureComponent,
  ArchitectureIndex,
  ArchitectureSsot,
  FactModule,
} from '../src/types.ts';

const component = (
  id: string,
  fields: Partial<ArchitectureComponent> = {},
): ArchitectureComponent => ({
  id,
  title: id,
  summary: `${id} summary`,
  paths: [`src/${id}/**`],
  key_files: [],
  interface: [],
  uses: [],
  rules: [],
  checklist: [],
  status: 'current',
  ...fields,
});

const ssotOf = (
  components: ArchitectureComponent[],
  index: Partial<ArchitectureIndex> = {},
  flows: ArchitectureSsot['flows'] = [],
): ArchitectureSsot => ({
  dir: '.jevlint/architecture',
  index: {
    version: 1,
    name: 'shop',
    description: 'd',
    layers: ['web', 'core', 'data'],
    ignore: [],
    externals: [{ id: 'postgres', title: 'PostgreSQL', packages: ['pg'] }],
    rules: [],
    checklist: [],
    ...index,
  },
  components,
  flows,
  views: [],
  chapters: [],
});

const mod = (
  path: string,
  imports: [string, number][] = [],
  externals: [string, number][] = [],
  symbols: string[] = [],
): FactModule => ({
  path,
  language: 'typescript',
  lines: 5,
  imports: imports.map(([target, line]) => ({ path: target, line })),
  externals: externals.map(([name, line]) => ({ package: name, line })),
  symbols,
});

const layered = [
  component('web', { layer: 'web' }),
  component('core', { layer: 'core' }),
  component('db', { layer: 'data' }),
];

const check = (ssot: ArchitectureSsot, modules: FactModule[], exists = (_: string) => true) =>
  conformance(ssot, { modules, exists, calls: [] });

describe('conformance', () => {
  it('finds an import that points up the layers', () => {
    const ssot = ssotOf(layered, { rules: [{ id: 'down', kind: 'layers' }] });
    const violations = check(ssot, [
      mod('src/web/a.ts', [['src/core/b.ts', 1]]),
      mod('src/core/b.ts', [['src/db/c.ts', 2]]),
      mod('src/db/c.ts', [['src/web/a.ts', 7]]),
    ]);
    expect(violations).toEqual([
      expect.objectContaining({
        rule: 'layer-violation',
        ruleId: 'down',
        component: 'db',
        path: 'src/db/c.ts',
        line: 7,
        target: 'src/web/a.ts',
        status: 'current',
      }),
    ]);
  });

  it('finds a dependency depends_on does not allow', () => {
    const ssot = ssotOf([
      component('web', { depends_on: ['core'] }),
      component('core'),
      component('db'),
    ]);
    const violations = check(ssot, [
      mod('src/web/a.ts', [
        ['src/core/b.ts', 1],
        ['src/db/c.ts', 3],
      ]),
      mod('src/core/b.ts'),
      mod('src/db/c.ts'),
    ]);
    expect(violations.map(({ rule, ruleId, path, line }) => [rule, ruleId, path, line])).toEqual([
      ['undeclared-dependency', 'web.depends_on', 'src/web/a.ts', 3],
    ]);
  });

  it('restricts an external to its owners, from index.yaml or a component', () => {
    const fromIndex = ssotOf(layered, {
      rules: [{ id: 'pg-in-db', kind: 'only', externals: ['postgres'], components: ['db'] }],
    });
    const modules = [mod('src/web/a.ts', [], [['pg', 4]]), mod('src/db/c.ts', [], [['pg', 1]])];
    expect(check(fromIndex, modules)).toEqual([
      expect.objectContaining({
        rule: 'restricted-external',
        ruleId: 'pg-in-db',
        path: 'src/web/a.ts',
        line: 4,
        target: 'pg',
      }),
    ]);
    const fromComponent = ssotOf([
      component('web'),
      component('db', { rules: [{ id: 'owns-pg', kind: 'only', externals: ['postgres'] }] }),
    ]);
    expect(check(fromComponent, modules).map(({ ruleId, path }) => [ruleId, path])).toEqual([
      ['db.owns-pg', 'src/web/a.ts'],
    ]);
  });

  it('forbids packages by pattern and components', () => {
    const ssot = ssotOf([
      component('web'),
      component('core', {
        rules: [{ id: 'pure', kind: 'forbid', packages: ['node:*'], components: ['web'] }],
      }),
    ]);
    const violations = check(ssot, [
      mod(
        'src/core/b.ts',
        [['src/web/a.ts', 2]],
        [
          ['node:fs', 1],
          ['zod', 3],
        ],
      ),
      mod('src/web/a.ts', [], [['node:fs', 1]]),
    ]);
    expect(violations.map(({ rule, line, target }) => [rule, line, target])).toEqual([
      ['forbidden-dependency', 1, 'node:fs'],
      ['forbidden-dependency', 2, 'web'],
    ]);
  });

  it('finds forbidden calls with ast-grep, outside except', () => {
    const ssot = ssotOf([component('web'), component('core')], {
      rules: [{ id: 'quiet', kind: 'forbid-call', pattern: 'console.$M($$$)', except: ['web'] }],
    });
    const modules = [mod('src/web/a.ts'), mod('src/core/b.ts')];
    const sources = new Map([
      ['src/web/a.ts', 'console.log("ok");\n'],
      ['src/core/b.ts', 'const x = 1;\nconsole.error("no");\n'],
    ]);
    const calls = matchCalls(callSearches(ssot, modules), sources);
    expect(calls).toEqual([
      { ruleId: 'quiet', path: 'src/core/b.ts', line: 2, text: 'console.error("no")' },
    ]);
    expect(conformance(ssot, { modules, exists: () => true, calls })).toEqual([
      expect.objectContaining({ rule: 'forbidden-call', component: 'core', line: 2 }),
    ]);
  });

  it('searches a rule with no language only where its pattern reads', () => {
    const ssot = ssotOf([component('web')], {
      rules: [{ id: 'axios', kind: 'forbid-call', pattern: "import $X from 'axios'" }],
    });
    const modules = [mod('src/web/a.ts'), { ...mod('src/web/b.py'), language: 'python' as const }];
    const sources = new Map([
      ['src/web/a.ts', "import x from 'axios';\n"],
      ['src/web/b.py', 'import os\n'],
    ]);
    expect(matchCalls(callSearches(ssot, modules), sources)).toEqual([
      expect.objectContaining({ ruleId: 'axios', path: 'src/web/a.ts', line: 1 }),
    ]);
    const onlyPython = callSearches(ssot, [modules[1] as FactModule]);
    expect(() => matchCalls(onlyPython, sources)).toThrow('cannot read the pattern for python');
  });

  it('finds cycles between components', () => {
    const ssot = ssotOf([component('a'), component('b')], {
      rules: [{ id: 'acyclic', kind: 'no-cycles' }],
    });
    const violations = check(ssot, [
      mod('src/a/x.ts', [['src/b/y.ts', 2]]),
      mod('src/b/y.ts', [['src/a/x.ts', 5]]),
    ]);
    expect(violations).toEqual([
      expect.objectContaining({
        rule: 'component-cycle',
        ruleId: 'acyclic',
        message: 'components in a cycle: a, b',
      }),
    ]);
  });

  it('finds flow steps with no import behind them', () => {
    const flows = [
      {
        id: 'buy',
        title: 'Buy',
        steps: [
          { from: 'web', to: 'core', verb: 'asks' },
          { from: 'core', to: 'db', verb: 'stores' },
        ],
      },
    ];
    const ssot = ssotOf(layered, {}, flows);
    const violations = check(ssot, [
      mod('src/web/a.ts', [['src/core/b.ts', 1]]),
      mod('src/core/b.ts'),
      mod('src/db/c.ts'),
    ]);
    expect(violations).toEqual([
      expect.objectContaining({
        rule: 'missing-flow-step',
        path: '.jevlint/architecture/flows/buy.yaml',
        target: 'db',
      }),
    ]);
  });

  it('finds key files and interface names that do not exist', () => {
    const ssot = ssotOf([
      component('core', {
        key_files: [
          { path: 'src/core/gone.ts', role: 'r' },
          { path: 'src/core/b.ts', role: 'r' },
        ],
        interface: ['placeOrder', 'ghost'],
      }),
    ]);
    const violations = check(
      ssot,
      [mod('src/core/b.ts', [], [], ['placeOrder'])],
      (path) => path === 'src/core/b.ts',
    );
    expect(violations.map(({ rule, target }) => [rule, target])).toEqual([
      ['stale-reference', 'src/core/gone.ts'],
      ['stale-reference', 'ghost'],
    ]);
  });

  it('finds unmapped files, except those in ignore', () => {
    const ssot = ssotOf([component('core')], { ignore: ['scripts/**'] });
    const violations = check(ssot, [
      mod('src/core/b.ts'),
      mod('src/stray.ts'),
      mod('scripts/build.ts'),
    ]);
    expect(violations.map(({ rule, path, component: owner }) => [rule, path, owner])).toEqual([
      ['unmapped-file', 'src/stray.ts', null],
    ]);
  });

  it('marks the violations of a target component as known debt', () => {
    const ssot = ssotOf([
      component('web', { depends_on: [], status: 'target' }),
      component('core'),
    ]);
    const [violation] = check(ssot, [
      mod('src/web/a.ts', [['src/core/b.ts', 1]]),
      mod('src/core/b.ts'),
    ]);
    expect(violation?.status).toBe('target');
  });
});

describe('assign', () => {
  it('gives a file to the most specific glob', () => {
    const ssot = ssotOf([
      component('all', { paths: ['src/**'] }),
      component('core', { paths: ['src/core/**'] }),
      component('one', { paths: ['src/core/x.ts'] }),
    ]);
    const { componentOf } = assign(ssot);
    expect(componentOf('src/core/x.ts')).toBe('one');
    expect(componentOf('src/core/y.ts')).toBe('core');
    expect(componentOf('src/z.ts')).toBe('all');
    expect(componentOf('lib/z.ts')).toBeNull();
  });
});

describe('addedViolations', () => {
  it('ignores a violation that only moved lines, and keeps a new one', () => {
    const base = {
      rule: 'layer-violation' as const,
      ruleId: 'down',
      component: 'db',
      path: 'a.ts',
      target: 'b.ts',
      message: 'm',
      status: 'current' as const,
    };
    const before = [{ ...base, line: 3 }];
    const after = [
      { ...base, line: 9 },
      { ...base, line: 10, target: 'c.ts' },
    ];
    expect(addedViolations(before, after)).toEqual([{ ...base, line: 10, target: 'c.ts' }]);
  });
});

describe('mapEdges', () => {
  it('lays the real dependencies over the declared ones', () => {
    const ssot = ssotOf([
      component('web', { depends_on: ['core', 'db'] }),
      component('core'),
      component('db', { depends_on: [] }),
    ]);
    const edges = mapEdges(ssot, [
      mod('src/web/a.ts', [['src/core/b.ts', 1]]),
      mod('src/core/b.ts', [['src/db/c.ts', 1]]),
      mod('src/db/c.ts', [['src/core/b.ts', 1]]),
    ]);
    expect(edges.map(({ from, to, status }) => `${from}>${to}:${status}`).sort()).toEqual([
      'core>db:actual',
      'db>core:violation',
      'web>core:declared',
      'web>db:unused',
    ]);
  });
});

describe('staticDrift', () => {
  it('reports each kind of drift', () => {
    const ssot = ssotOf(
      [
        component('web', {
          depends_on: ['db'],
          uses: ['postgres'],
          key_files: [{ path: 'src/web/gone.ts', role: 'r' }],
        }),
        component('core', { paths: ['src/core/**', 'src/legacy/**'] }),
        component('empty', { paths: ['src/empty/**'] }),
      ],
      { layers: [] },
    );
    const modules = [
      mod('src/web/a.ts', [['src/core/b.ts', 4]]),
      mod(
        'src/core/b.ts',
        [],
        [
          ['pg', 2],
          ['ioredis', 3],
        ],
      ),
      mod('src/new/x.ts'),
      mod('src/new/y.ts'),
      mod('src/lone.ts'),
    ];
    const items = staticDrift(ssot, {
      modules,
      exists: (path) =>
        !path.includes('gone') && !path.includes('legacy') && !path.includes('empty'),
      added: new Set(['src/new/x.ts', 'src/new/y.ts']),
    });
    const summary = items.map(({ kind, path, target, since }) => [
      kind,
      path,
      target ?? null,
      since ?? null,
    ]);
    expect(summary).toEqual(
      expect.arrayContaining([
        ['unmapped-code', 'src/new/', null, true],
        ['unmapped-code', 'src/lone.ts', null, false],
        ['undocumented-dependency', 'src/web/a.ts', 'core', null],
        ['undocumented-external', 'src/core/b.ts', 'postgres', null],
        ['undocumented-external', 'src/core/b.ts', 'ioredis', null],
        ['stale-reference', '.jevlint/architecture/components/web.yaml', 'src/web/gone.ts', null],
        ['stale-reference', '.jevlint/architecture/components/web.yaml', 'db', null],
        ['stale-reference', '.jevlint/architecture/components/web.yaml', 'postgres', null],
        ['stale-reference', '.jevlint/architecture/components/core.yaml', 'src/legacy/**', null],
        ['stale-reference', '.jevlint/architecture/components/empty.yaml', 'empty', null],
        ['stale-reference', '.jevlint/architecture/components/empty.yaml', 'src/empty/**', null],
      ]),
    );
    expect(items).toHaveLength(11);
  });
});
