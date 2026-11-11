import { describe, expect, it } from 'vitest';
import { mapEdges } from '../src/architecture/conformance.ts';
import { draftSsot } from '../src/architecture/draft.ts';
import { buildFacts } from '../src/architecture/facts.ts';
import { chapterHtml, renderShowHtml } from '../src/architecture/html.ts';
import {
  dataViewDiagram,
  flowDiagram,
  graphViewDiagram,
  renderMarkdown,
  renderView,
} from '../src/architecture/markdown.ts';
import {
  renderCheckPrompt,
  renderCompilePrompt,
  renderDriftPrompt,
  renderPlanPrompt,
  renderRepairPrompt,
} from '../src/architecture/prompt.ts';
import {
  allChecklistRefs,
  checkRequest,
  componentOutline,
  designState,
  documentItems,
  documentRequest,
  routeQuestion,
} from '../src/architecture/questions.ts';
import type { ShowModel } from '../src/architecture/show.ts';
import {
  formatAddedViolations,
  formatArchitectureCheck,
  formatArchitectureDrift,
  formatArchitecturePlan,
  formatShow,
  formatSsotList,
} from '../src/architecture/terminal.ts';
import type {
  ArchitectureCheckReport,
  ArchitectureSsot,
  ArchitectureViolation,
  DataView,
  FactModule,
  GraphView,
} from '../src/types.ts';

const EVIL = '\u001b[31m<script>alert(1)</script>‮';

const mod = (path: string, imports: string[] = [], symbols: string[] = []): FactModule => ({
  path,
  language: 'typescript',
  lines: 3,
  imports: imports.map((target) => ({ path: target, line: 1 })),
  externals: [],
  symbols,
});

const modules = [
  mod('src/web/a.ts', ['src/db/c.ts']),
  mod('src/web/b.ts'),
  mod('src/web/e.ts'),
  mod('src/web/f.ts'),
  mod('src/db/c.ts', [], ['query']),
  mod('src/db/d.ts'),
  mod('src/db/g.ts'),
];
const facts = buildFacts({
  root: '/r',
  commit: 'abc1234',
  modules,
  entrypoints: [],
  churn: new Map(),
  commits: [],
  warnings: [],
});

const ssot: ArchitectureSsot = {
  dir: '.jevlint/architecture',
  index: {
    version: 1,
    name: 'shop',
    compiled_at: 'abc1234',
    description: `A shop ${EVIL}`,
    layers: ['web', 'data'],
    ignore: [],
    externals: [{ id: 'postgres', title: 'PostgreSQL', packages: ['pg'] }],
    rules: [{ id: 'down', kind: 'layers' }],
    checklist: [{ id: 'errors', text: 'Errors are typed.' }],
  },
  components: [
    {
      id: 'web',
      title: `Web ${EVIL}`,
      summary: 'Serves "pages".',
      layer: 'web',
      paths: ['src/web/**'],
      key_files: [{ path: 'src/web/a.ts', role: 'routes' }],
      interface: [],
      depends_on: ['db'],
      uses: [],
      rules: [],
      checklist: [{ id: 'thin', text: 'Handlers stay thin.' }],
      status: 'current',
    },
    {
      id: 'db',
      title: 'Database',
      summary: 'Stores orders.',
      layer: 'data',
      paths: ['src/db/**'],
      key_files: [],
      interface: ['query'],
      depends_on: ['web'],
      uses: ['postgres'],
      rules: [],
      checklist: [],
      status: 'current',
    },
  ],
  flows: [
    {
      id: 'buy',
      title: 'Buy',
      steps: [
        { from: 'web', to: 'db', verb: 'stores' },
        { from: 'db', to: 'web', verb: 'calls back' },
      ],
    },
  ],
  views: [],
  chapters: [],
};

const model: ShowModel = { root: '/r', draft: false, ssot, edges: mapEdges(ssot, modules), facts };

describe('questions', () => {
  it('names items by scope and asks one choice per item', () => {
    expect(allChecklistRefs(ssot).map(({ id }) => id)).toEqual(['global.errors', 'web.thin']);
    const request = checkRequest(ssot, ssot.components[0] ?? null, [
      { id: 'web.thin', text: 'Handlers stay thin.' },
    ]);
    expect(request['web.thin']).toMatchObject({
      type: 'choice',
      criteria: { satisfies: expect.any(String) },
    });
    expect(Object.keys(routeQuestion(ssot).criteria as object)).toEqual(['web', 'db', 'global']);
    const items = documentItems(ssot, null);
    expect(items[0]).toEqual({ id: 'global.summary', text: `A shop ${EVIL}` });
    expect(Object.keys(documentRequest(items))).toEqual([
      'global.summary',
      'global.errors',
      'uncovered',
    ]);
  });

  it('outlines a component with names, not code, and the design without compiled_at', () => {
    const outline = componentOutline(
      ssot.components[1] as never,
      [modules[4] as FactModule],
      model.edges,
    );
    expect(outline).toContain('- src/db/c.ts (3 lines): query');
    expect(outline).toContain('Used by: web (1)');
    expect(designState(ssot)).not.toContain('abc1234');
    expect(designState(ssot)).toContain('components:');
  });
});

describe('markdown', () => {
  it('renders an ARCHITECTURE.md with a Mermaid map, flagging what breaks the SSOT', () => {
    const markdown = renderMarkdown(model);
    expect(markdown).toContain('```mermaid\nflowchart LR');
    expect(markdown).toContain('c_web -->|1| c_db');
    expect(markdown).toContain('c_db -.->|declared, unused| c_web');
    expect(markdown).toContain('## Flows');
    expect(markdown).toContain('Note over c_db,c_web: no import in the code');
    expect(markdown).not.toContain('<script>');
    expect(markdown).not.toContain('\u001b');
  });

  it('renders one view', () => {
    expect(renderView(model, { kind: 'layers' })).toContain('subgraph layer_web');
    expect(renderView(model, { kind: 'component', id: 'db' })).toContain(
      '`src/db/c.ts` (3 lines): `query`',
    );
  });
});

describe('renderShowHtml', () => {
  it('has no scripts and escapes repository text', () => {
    const html = renderShowHtml(model);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('no import in the code');
  });
});

describe('prompts', () => {
  const draft = draftSsot(facts, 'shop', '.jevlint/architecture');
  const base = {
    dir: '.jevlint/architecture',
    facts,
    draft,
    ssot: null,
    ssotFiles: [],
    delta: null,
    docs: [],
    commits: [],
    comments: [],
    instructions: [],
  };

  it('asks for a new SSOT from the facts and the draft, with paths and lines only', () => {
    const prompt = renderCompilePrompt(base);
    expect(prompt).toContain('# Write the architecture document');
    expect(prompt).toContain('## The draft');
    expect(prompt).toContain('jevlint architecture list');
    expect(prompt).toContain('src/web/a.ts:1');
    expect(prompt).toContain('Set `compiled_at` to abc1234');
  });

  it('asks for an update with the drift, and says why the SSOT does not load', () => {
    const update = renderCompilePrompt({
      ...base,
      ssot,
      ssotFiles: ['.jevlint/architecture/index.yaml'],
      delta: {
        base: 'def5678',
        added: ['src/new/x.ts'],
        removed: [],
        items: [
          {
            kind: 'unmapped-code',
            component: null,
            path: 'src/new/x.ts',
            since: true,
            message: 'a file in no component',
          },
        ],
      },
      docs: ['README.md'],
    });
    expect(update).toContain('# Update the architecture document');
    expect(update).toContain('compiled from def5678');
    expect(update).toContain(
      '- unmapped-code: src/new/x.ts: a file in no component (new since compiled_at)',
    );
    expect(update).toContain('- README.md');
    expect(update).not.toContain('## The draft');
    const broken = renderCompilePrompt({ ...base, loadError: 'index.yaml: bad' });
    expect(broken).toContain('## The current SSOT does not load\n\nindex.yaml: bad');
  });

  it('renders the drift, check and plan prompts without control characters', () => {
    const drift = renderDriftPrompt(
      {
        root: '/r',
        dir: '.jevlint/architecture',
        provider: null,
        model: null,
        compiledAt: 'abc1234',
        head: 'fff',
        items: [{ kind: 'stale-summary', component: 'db', path: `x${EVIL}`, message: 'm' }],
        added: [],
        removed: [],
        docs: [],
        usage: { inputTokens: 0, estimatedCostUsd: null, cacheHits: 0, modelCalls: 0 },
        warnings: [],
      },
      ['.jevlint/architecture/index.yaml'],
    );
    expect(drift).toContain('set `compiled_at` to fff');
    expect(drift).not.toContain('\u001b');
    expect(
      renderPlanPrompt({ root: '/r', dir: null, steps: [], warnings: [] }, '.jevlint/architecture'),
    ).toContain('.jevlint/architecture/plan.md');
    expect(renderCheckPrompt(checkReport([violation]))).toContain(
      '- src/db/c.ts:1 layer-violation (down)',
    );
  });
});

const violation: ArchitectureViolation = {
  rule: 'layer-violation',
  ruleId: 'down',
  component: 'db',
  path: 'src/db/c.ts',
  line: 1,
  target: 'src/web/a.ts',
  message: `db imports web ${EVIL}`,
  status: 'current',
};

function checkReport(violations: ArchitectureViolation[]): ArchitectureCheckReport {
  return {
    root: '/r',
    dir: '.jevlint/architecture',
    provider: null,
    model: null,
    complete: true,
    violations,
    targetGaps: [],
    baselined: 2,
    files: [],
    checklistViolations: 0,
    unimplemented: [{ id: 'global.errors', text: 'Errors are typed.' }],
    usage: { inputTokens: 0, estimatedCostUsd: null, cacheHits: 0, modelCalls: 0 },
    warnings: [],
  };
}

describe('terminal', () => {
  const clean = (text: string) => {
    expect(text).not.toContain('‮');
    expect(text).not.toContain('\u001b[31m<script>');
  };

  it('strips control characters from every report', () => {
    clean(formatSsotList(ssot, []));
    clean(formatShow(model, { kind: 'map' }));
    clean(formatShow(model, { kind: 'flow', id: 'buy' }));
    clean(formatShow(model, { kind: 'component', id: 'web' }, [modules[0] as FactModule]));
    clean(formatArchitectureCheck(checkReport([violation])));
    clean(formatAddedViolations([violation]));
    clean(
      formatArchitecturePlan({
        root: '/r',
        dir: null,
        steps: [{ rank: 1, priority: 1, problem: EVIL, move: 'm', component: null, evidence: [] }],
        warnings: [],
      }),
    );
    clean(
      formatArchitectureDrift({
        root: '/r',
        dir: 'd',
        provider: null,
        model: null,
        compiledAt: null,
        head: null,
        items: [{ kind: 'document', component: null, path: EVIL, message: 'm' }],
        added: [],
        removed: [],
        docs: [],
        usage: { inputTokens: 0, estimatedCostUsd: null, cacheHits: 0, modelCalls: 0 },
        warnings: [],
      }),
    );
  });

  it('lists the check report sections', () => {
    const text = formatArchitectureCheck(checkReport([violation]));
    expect(text).toContain('1 structural violation');
    expect(text).toContain('2 violations in the baseline left out');
    expect(text).toContain('Unimplemented');
    expect(formatAddedViolations([])).toContain('no new violations');
  });
});

const overview: GraphView = {
  id: 'overview',
  kind: 'graph',
  title: 'Overview',
  description: 'How a page is served.',
  groups: [
    { id: 'front', label: 'Front "end"' },
    { id: 'back', label: 'Back' },
  ],
  nodes: [
    { id: 'shopper', label: 'Shopper', kind: 'actor' },
    { id: 'web', label: `Web <b>${EVIL}`, kind: 'component', path: 'src/web/a.ts', group: 'front' },
    { id: 'db', label: 'Database', kind: 'store', path: 'src/db/**', group: 'back' },
    { id: 'pg', label: 'Postgres', kind: 'external', packages: ['pg'] },
    { id: 'jobs', label: 'Jobs', kind: 'queue' },
    { id: 'doc', label: 'Doc', kind: 'document' },
  ],
  edges: [
    { from: 'shopper', to: 'web', verb: 'browses', style: 'solid' },
    { from: 'web', to: 'db', verb: 'reads', style: 'solid' },
    { from: 'db', to: 'web', verb: 'pushes', style: 'solid' },
    { from: 'db', to: 'pg', verb: 'queries', style: 'dashed' },
  ],
};

const dataView: DataView = {
  id: 'data-model',
  kind: 'data',
  title: 'Data',
  entities: [
    {
      id: 'order',
      name: 'Order',
      path: 'src/db/c.ts',
      description: 'A paid basket.',
      fields: [
        { name: 'lines', type: 'OrderLine[]' },
        { name: 'status', type: 'string | null', note: 'paid "or" shipped' },
        { name: 'meta', type: 'readonly Record<string, X>' },
      ],
    },
    { id: 'line', name: 'Order Line', path: 'src/db/c.ts', fields: [] },
  ],
  relations: [
    { from: 'order', to: 'line', cardinality: 'one-to-many', label: 'holds' },
    { from: 'line', to: 'order', cardinality: 'many-to-one', label: 'belongs' },
    { from: 'order', to: 'order', cardinality: 'one-to-one', label: 'self' },
    { from: 'line', to: 'line', cardinality: 'many-to-many', label: 'pairs' },
  ],
};

const documented: ShowModel = {
  ...model,
  ssot: {
    ...ssot,
    flows: [
      {
        id: 'buy',
        title: 'Buy',
        steps: [
          { from: 'web', to: 'db', verb: 'stores', returns: 'an id' },
          { from: 'web', to: 'db', verb: 'notifies', optional: true },
        ],
      },
    ],
    views: [overview, dataView],
    chapters: [
      {
        id: '10-overview',
        title: `Overview ${EVIL}`,
        evidence: ['src/web/a.ts'],
        body: `Line one.\nLine two \u001b[2J.\n\n<!-- jevlint:diagram overview -->\n\n<!-- jevlint:diagram flow:buy -->`,
      },
    ],
  },
};

describe('graph and data views', () => {
  it('compiles a graph view to a flowchart with groups, tones, shapes and verbs', () => {
    const diagram = graphViewDiagram(overview, model);
    expect(diagram).toContain('```mermaid\nflowchart TD');
    expect(diagram).toContain('subgraph g_front["Front #quot;end#quot;"]');
    expect(diagram).toContain('n_shopper(("Shopper"))');
    expect(diagram).toContain('n_db[("Database<br/>[src/db/]")]');
    expect(diagram).toContain('n_pg{{"Postgres"}}');
    expect(diagram).toContain('n_jobs[["Jobs"]]');
    expect(diagram).toContain('n_doc[/"Doc"/]');
    expect(diagram).toContain('[a.ts]');
    expect(diagram).toContain('Web #lt;b#gt;');
    expect(diagram).toContain('n_web -->|"reads"| n_db');
    // db → web has no import behind it here, so it is drawn dashed though declared solid.
    expect(diagram).toContain('n_db -.->|"pushes"| n_web');
    expect(diagram).toContain('n_db -.->|"queries"| n_pg');
    expect(diagram).toContain('classDef toneBlue fill:#dbeafe');
    expect(diagram).toContain('class n_shopper,n_web toneBlue');
    expect(diagram).toContain('class n_db,n_jobs toneAmber');
    expect(diagram).toContain('class n_doc toneNeutral');
    expect(diagram).toContain('classDef toneAmber');
    expect(diagram).toContain('classDef toneIndigo');
  });

  it('compiles a data view to an ER diagram', () => {
    const diagram = dataViewDiagram(dataView);
    expect(diagram).toContain('```mermaid\nerDiagram');
    expect(diagram).toContain('Order ||--o{ Order_Line : "holds"');
    expect(diagram).toContain('Order_Line }o--|| Order : "belongs"');
    expect(diagram).toContain('Order ||--|| Order : "self"');
    expect(diagram).toContain('Order_Line }o--o{ Order_Line : "pairs"');
    expect(diagram).toContain('OrderLine[] lines');
    expect(diagram).toContain('string status "paid #quot;or#quot; shipped"');
    expect(diagram).toContain('Record meta');
  });

  it('draws flow returns and optional steps', () => {
    const diagram = flowDiagram(documented.ssot.flows[0] as never, documented);
    expect(diagram).toContain('participant c_web as Web');
    expect(diagram).toContain('c_web->>c_db: stores');
    expect(diagram).toContain('c_db-->>c_web: an id');
    expect(diagram).toContain('c_web-->>c_db: notifies');
  });
});

describe('the document', () => {
  it('builds around chapters, placing diagrams and appending the rest and a reference', () => {
    const markdown = renderMarkdown(documented);
    expect(markdown).toContain('## Overview');
    expect(markdown).toContain('Line one.\nLine two ?[2J.');
    expect(markdown).not.toContain('\u001b');
    expect(markdown).not.toContain('jevlint:diagram');
    expect(markdown).toContain('flowchart TD');
    expect(markdown).toContain('sequenceDiagram');
    expect(markdown).toContain('## More diagrams\n\n### Data');
    expect(markdown).toContain('erDiagram');
    expect(markdown).not.toContain('### Buy');
    expect(markdown).toContain('## Reference\n\n### Components');
    expect(markdown).toContain('### External systems');
    expect(markdown.indexOf('## Overview')).toBeLessThan(markdown.indexOf('## Reference'));
  });

  it('includes the views in the structural document when there are no chapters', () => {
    const markdown = renderMarkdown({ ...documented, ssot: { ...documented.ssot, chapters: [] } });
    expect(markdown).toContain('## Overview\n\nHow a page is served.');
    expect(markdown).toContain('## Data\n\n```mermaid\nerDiagram');
    expect(markdown).toContain('## Map');
    expect(renderView(documented, { kind: 'view', id: 'data-model' })).toContain('erDiagram');
  });
});

describe('chapterHtml', () => {
  it('converts Markdown with everything escaped and links reduced to text', () => {
    const html = chapterHtml(
      [
        '### Why <script>alert(1)</script>',
        'A **bold** `code` and [a link](https://evil.example/x).',
        '- one\n- two',
        '1. first\n2. second',
        '| A | B |\n| --- | --- |\n| `x` | y |',
        '> quoted',
        '```ts\nconst a = "<b>";\n```',
        '<!-- jevlint:diagram data-model -->',
      ].join('\n\n'),
      documented,
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('<h4>Why &lt;script&gt;alert(1)&lt;/script&gt;</h4>');
    expect(html).toContain('A <b>bold</b> <code>code</code> and a link.');
    expect(html).not.toContain('evil.example');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>');
    expect(html).toContain('<th>A</th>');
    expect(html).toContain('<td><code>x</code></td>');
    expect(html).toContain('<blockquote>quoted</blockquote>');
    expect(html).toContain('<pre><code>const a = &quot;&lt;b&gt;&quot;;</code></pre>');
    expect(html).toContain('<code>Order</code>');
  });

  it('puts chapters and views on the show page, with no scripts', () => {
    const html = renderShowHtml(documented);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('<h2>Overview');
    expect(html).toContain('<svg');
    expect(html).toContain('<summary>Arrows</summary>');
    expect(html).toContain('A paid basket.');
  });
});

describe('the compile prompt', () => {
  const draft = draftSsot(facts, 'shop', '.jevlint/architecture');
  const input = {
    dir: '.jevlint/architecture',
    facts: {
      ...facts,
      dataTypes: [
        {
          name: 'Order',
          path: 'src/db/c.ts',
          line: 3,
          fields: [{ name: 'id', type: 'string' }],
          component: 'db',
          refs: [],
          usedBy: 2,
        },
      ],
    },
    draft,
    ssot: null,
    ssotFiles: [],
    delta: null,
    docs: [],
    commits: [
      { hash: 'abc1234', subject: 'Cache outlines', body: 'Because parsing is slow.', files: 7 },
    ],
    comments: [{ path: 'src/db/c.ts', line: 9, text: 'Kept because the pool is shared.' }],
    instructions: ['AGENTS.md'],
  };

  it('sets out the process, the formats, the rules, the outline and the material', () => {
    const prompt = renderCompilePrompt(input);
    for (const heading of [
      '## How to work',
      '## The SSOT format',
      '## The views and chapters format',
      '## How to draw the views',
      '## The chapters to write',
      '## How to write the chapters',
      '## Material for the document',
      '## The facts',
      '## The draft',
    ]) {
      expect(prompt).toContain(heading);
    }
    expect(prompt).toContain('jevlint architecture list');
    expect(prompt).toContain('20-principles.md');
    expect(prompt).toContain('<!-- jevlint:diagram');
    expect(prompt).toContain('- AGENTS.md');
    expect(prompt).toContain('- Order (src/db/c.ts:3, used by 2): id: string');
    expect(prompt).toContain('- src/db/c.ts:9: Kept because the pool is shared.');
    expect(prompt).toContain('- abc1234 (7 files) Cache outlines: Because parsing is slow.');
  });

  it('asks an update to rewrite only stale chapters and views', () => {
    const update = renderCompilePrompt({
      ...input,
      ssot,
      ssotFiles: ['.jevlint/architecture/index.yaml'],
      delta: {
        base: 'def5678',
        added: [],
        removed: [],
        items: [
          {
            kind: 'stale-chapter',
            component: null,
            path: '.jevlint/architecture/chapters/10-a.md',
            message: 'cites a changed file',
          },
        ],
      },
    });
    expect(update).toContain('stale-chapter');
    expect(update).toContain(
      '- stale-chapter: .jevlint/architecture/chapters/10-a.md: cites a changed file',
    );
    expect(update).not.toContain('## The draft');
  });

  it('lists the problems in the repair prompt, without control characters', () => {
    const repair = renderRepairPrompt('.jevlint/architecture', [
      `a.yaml: no import ${EVIL}`,
      'b.md: no evidence',
    ]);
    expect(repair).toContain('jevlint architecture list');
    expect(repair).toContain('- b.md: no evidence');
    expect(repair).not.toContain('\u001b');
  });
});
