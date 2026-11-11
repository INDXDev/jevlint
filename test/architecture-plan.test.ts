import { describe, expect, it } from 'vitest';
import { assign, conformance } from '../src/architecture/conformance.ts';
import { componentDependencies } from '../src/architecture/facts.ts';
import { rankSteps } from '../src/architecture/plan.ts';
import type { ArchitectureComponent, ArchitectureSsot, FactModule } from '../src/types.ts';

const component = (
  id: string,
  fields: Partial<ArchitectureComponent> = {},
): ArchitectureComponent => ({
  id,
  title: id,
  summary: 's',
  paths: [`src/${id}/**`],
  key_files: [],
  interface: [],
  uses: [],
  rules: [],
  checklist: [],
  status: 'current',
  ...fields,
});

const ssotOf = (components: ArchitectureComponent[]): ArchitectureSsot => ({
  dir: '.jevlint/architecture',
  index: {
    version: 1,
    name: 'x',
    description: 'd',
    layers: [],
    ignore: [],
    externals: [],
    rules: [{ id: 'acyclic', kind: 'no-cycles' }],
    checklist: [],
  },
  components,
  flows: [],
  views: [],
  chapters: [],
});

const mod = (path: string, imports: string[] = []): FactModule => ({
  path,
  language: 'typescript',
  lines: 1,
  imports: imports.map((target, index) => ({ path: target, line: index + 1 })),
  externals: [],
  symbols: [],
});

function plan(
  ssot: ArchitectureSsot,
  modules: FactModule[],
  extra: Partial<Parameters<typeof rankSteps>[2]> = {},
) {
  const violations = conformance(ssot, { modules, exists: () => true, calls: [] });
  const dependencies = componentDependencies(modules, assign(ssot).componentOf);
  return rankSteps(violations, ssot, { dependencies, churn: new Map(), hubs: [], ...extra });
}

describe('rankSteps', () => {
  it('cuts the edge of a cycle with the fewest imports first', () => {
    const modules = [
      mod('src/a/1.ts', ['src/b/x.ts']),
      mod('src/a/2.ts', ['src/b/x.ts']),
      mod('src/a/3.ts', ['src/b/x.ts']),
      mod('src/b/x.ts', ['src/a/1.ts']),
    ];
    const [first] = plan(ssotOf([component('a'), component('b')]), modules);
    expect(first).toMatchObject({ rank: 1, priority: 1, component: 'b' });
    expect(first?.move).toMatch(/^Cut b → a \(1 import\)/);
    expect(first?.evidence).toEqual([{ path: 'src/b/x.ts', line: 1, target: 'src/a/1.ts' }]);
  });

  it('groups violations of one kind between the same ends into one step', () => {
    const ssot = ssotOf([component('web', { depends_on: [] }), component('db')]);
    const modules = [
      mod('src/web/1.ts', ['src/db/x.ts']),
      mod('src/web/2.ts', ['src/db/x.ts']),
      mod('src/db/x.ts'),
      mod('src/stray.ts'),
    ];
    const steps = plan(ssot, modules);
    expect(steps.map(({ problem }) => problem)).toEqual([
      expect.stringContaining(
        'undeclared-dependency: web does not declare db in depends_on (2 places)',
      ),
      '1 file in no component',
    ]);
    expect(steps[0]?.evidence).toHaveLength(2);
    expect(steps[0]?.move).toContain("Declare db in web's depends_on");
  });

  it('weighs churn, and proposes splitting a hub by its users', () => {
    const ssot = ssotOf([component('a'), component('b'), component('c')]);
    const hubs = [
      {
        path: 'src/a/hub.ts',
        component: 'a',
        users: new Map([
          ['b', 3],
          ['c', 1],
        ]),
      },
    ];
    const steps = plan(ssot, [mod('src/a/hub.ts'), mod('src/b/x.ts'), mod('src/c/y.ts')], { hubs });
    expect(steps).toEqual([
      expect.objectContaining({
        problem: 'src/a/hub.ts is a hub: it uses and serves many modules',
        move: 'Split src/a/hub.ts by its users, one part each for: b (3), c (1).',
      }),
    ]);
  });
});
