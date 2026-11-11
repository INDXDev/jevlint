import { describe, expect, it } from 'vitest';
import {
  checkEdges,
  type DocumentInput,
  documentDrift,
  documentProblems,
  parseCitation,
} from '../src/architecture/views.ts';
import type { ArchitectureSsot, FactModule, GraphView } from '../src/types.ts';

const mod = (
  path: string,
  imports: [string, number][] = [],
  externals: [string, number][] = [],
): FactModule => ({
  path,
  language: 'typescript',
  lines: 20,
  imports: imports.map(([target, line]) => ({ path: target, line })),
  externals: externals.map(([name, line]) => ({ package: name, line })),
  symbols: [],
  types:
    path === 'src/db/order.ts'
      ? [{ name: 'Order', line: 1, fields: [{ name: 'id', type: 'string' }] }]
      : [],
});

const modules = [
  mod('src/web/routes.ts', [['src/core/checkout.ts', 3]]),
  mod('src/core/checkout.ts', [['src/db/order.ts', 4]], [['stripe', 2]]),
  mod('src/db/order.ts'),
];

const view: GraphView = {
  id: 'overview',
  kind: 'graph',
  title: 'Overview',
  groups: [],
  nodes: [
    { id: 'shopper', label: 'Shopper', kind: 'actor' },
    { id: 'web', label: 'Web', kind: 'component', path: 'src/web' },
    { id: 'core', label: 'Core', kind: 'component', component: 'core' },
    { id: 'db', label: 'DB', kind: 'store', path: 'src/db/**' },
    { id: 'stripe', label: 'Stripe', kind: 'external', packages: ['stripe'] },
    { id: 'mail', label: 'Mail', kind: 'external', packages: ['nodemailer'] },
  ],
  edges: [
    { from: 'web', to: 'core', verb: 'calls', style: 'solid' },
    { from: 'db', to: 'core', verb: 'notifies', style: 'solid' },
    { from: 'web', to: 'db', verb: 'reads', style: 'solid' },
    { from: 'shopper', to: 'web', verb: 'browses', style: 'solid' },
    { from: 'core', to: 'stripe', verb: 'charges', style: 'solid' },
    { from: 'core', to: 'mail', verb: 'emails', style: 'dashed' },
  ],
};

const ssot: ArchitectureSsot = {
  dir: '.jevlint/architecture',
  index: {
    version: 1,
    name: 's',
    description: 'd',
    layers: [],
    ignore: [],
    externals: [],
    rules: [],
    checklist: [],
  },
  components: [
    {
      id: 'core',
      title: 'Core',
      summary: 's',
      paths: ['src/core/**'],
      key_files: [],
      interface: [],
      uses: [],
      rules: [],
      checklist: [],
      status: 'current',
    },
  ],
  flows: [],
  views: [view],
  chapters: [],
};

const files: Record<string, number> = {
  'src/web/routes.ts': 20,
  'src/core/checkout.ts': 20,
  'src/db/order.ts': 20,
  'README.md': 5,
};
const input: DocumentInput = {
  modules,
  exists: (path) => path in files || ['src/web', 'src/db'].includes(path),
  lineCount: (path) => files[path],
};

describe('checkEdges', () => {
  it('finds the import behind each arrow, in the caller’s direction', () => {
    expect(checkEdges(view, ssot, modules)).toEqual([
      {
        support: 'supported',
        evidence: { path: 'src/web/routes.ts', line: 3, target: 'src/core/checkout.ts' },
      },
      {
        support: 'reversed',
        evidence: { path: 'src/core/checkout.ts', line: 4, target: 'src/db/order.ts' },
      },
      { support: 'unsupported' },
      { support: 'unchecked' },
      {
        support: 'supported',
        evidence: { path: 'src/core/checkout.ts', line: 2, target: 'stripe' },
      },
      { support: 'unsupported' },
    ]);
  });
});

describe('parseCitation', () => {
  it.each([
    ['src/a.ts', { path: 'src/a.ts' }],
    ['src/a.ts:12', { path: 'src/a.ts', line: 12 }],
    ['src/a.ts:12-30', { path: 'src/a.ts', line: 12, end: 30 }],
    ['commit:abc1234', { commit: 'abc1234' }],
    ['../etc/passwd', null],
    ['/etc/passwd', null],
    ['has space', null],
  ])('parses %s', (text, expected) => {
    expect(parseCitation(text)).toEqual(expected);
  });
});

describe('documentProblems', () => {
  it('reports arrows with no import, reversed ones, and missing paths, but not dashed arrows', () => {
    const problems = documentProblems(
      {
        ...ssot,
        views: [
          {
            ...view,
            nodes: [
              ...view.nodes,
              { id: 'gone', label: 'Gone', kind: 'component', path: 'src/gone' },
            ],
          },
        ],
      },
      input,
    ).join('\n');
    expect(problems).toContain('DB → Core: the import runs the other way (src/core/checkout.ts:4)');
    expect(problems).toContain('Web → DB: no import in the code');
    expect(problems).toContain('node gone: src/gone matches nothing');
    expect(problems).not.toContain('Mail');
    expect(problems).not.toContain('Web → Core');
  });

  it('checks entities against declared types', () => {
    const data: ArchitectureSsot = {
      ...ssot,
      views: [
        {
          id: 'data',
          kind: 'data',
          title: 'Data',
          entities: [
            { id: 'order', name: 'Order', path: 'src/db/order.ts', fields: [] },
            { id: 'ghost', name: 'Ghost', path: 'src/db/order.ts', fields: [] },
            { id: 'away', name: 'Away', path: 'src/away.ts', fields: [] },
          ],
          relations: [],
        },
      ],
    };
    expect(documentProblems(data, input)).toEqual([
      '.jevlint/architecture/views/data.yaml: entity ghost: src/db/order.ts declares no data type Ghost',
      '.jevlint/architecture/views/data.yaml: entity away: src/away.ts does not exist',
    ]);
  });

  it('checks chapter evidence and backticked references', () => {
    const chapters: ArchitectureSsot['chapters'] = [
      {
        id: '10-a',
        title: 'A',
        evidence: [
          'src/web/routes.ts:3',
          'src/web/routes.ts:99',
          'src/nope.ts',
          'commit:abc1234',
          'not a path',
        ],
        body: 'See `src/db/order.ts:50` and `src/db/order.ts:2`, and `npm test`.',
      },
      { id: '20-b', title: 'B', evidence: [], body: 'Nothing cited.' },
    ];
    const problems = documentProblems({ ...ssot, views: [], chapters }, input);
    expect(problems).toEqual([
      '.jevlint/architecture/chapters/10-a.md: evidence src/web/routes.ts has only 20 lines, not 99',
      '.jevlint/architecture/chapters/10-a.md: evidence src/nope.ts does not exist',
      '.jevlint/architecture/chapters/10-a.md: evidence "not a path" is neither a path nor commit:<hash>',
      '.jevlint/architecture/chapters/10-a.md: src/db/order.ts has only 20 lines, not 50',
      '.jevlint/architecture/chapters/20-b.md: no evidence; cite the files the chapter is based on',
    ]);
  });
});

describe('documentDrift', () => {
  const chapters: ArchitectureSsot['chapters'] = [
    { id: '10-a', title: 'Routes', evidence: ['src/web/routes.ts:3', 'commit:abc1234'], body: '' },
    { id: '20-b', title: 'Data', evidence: ['src/db'], body: '' },
    { id: '30-c', title: 'Other', evidence: ['README.md'], body: '' },
  ];

  it('reports chapters citing changed files, and views that no longer fit', () => {
    const items = documentDrift(
      { ...ssot, chapters },
      input,
      new Set(['src/web/routes.ts', 'src/db/order.ts']),
    );
    const stale = items.filter(({ kind }) => kind === 'stale-chapter');
    expect(stale.map(({ path, target }) => [path, target])).toEqual([
      ['.jevlint/architecture/chapters/10-a.md', 'src/web/routes.ts'],
      ['.jevlint/architecture/chapters/20-b.md', 'src/db'],
    ]);
    const views = items.filter(({ kind }) => kind === 'stale-view');
    expect(views).toHaveLength(2);
    expect(views[0]?.path).toBe('.jevlint/architecture/views/overview.yaml');
  });

  it('reports no chapter when nothing changed', () => {
    const items = documentDrift({ ...ssot, views: [], chapters }, input, new Set());
    expect(items).toEqual([]);
  });
});
