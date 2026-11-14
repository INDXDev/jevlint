import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  architectureFiles,
  BUDGET,
  budgetWarnings,
  loadArchitecture,
} from '../src/architecture/load.ts';
import { type Config, loadConfig } from '../src/config.ts';
import type { ArchitectureSsot } from '../src/types.ts';

let root: string;
let config: Config;
const DIR = '.jevlint/architecture';

const write = async (files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
};

const INDEX = `version: 1
name: shop
compiled_at: abc1234
description: >
  An online
  shop.
layers: [web, data]
externals:
  - { id: postgres, title: PostgreSQL, packages: [pg] }
rules:
  - { id: layers-point-down, kind: layers }
`;
const WEB = `id: web
title: Web
summary: Serves pages.
layer: web
paths: ["src/web/**"]
depends_on: [db]
`;
const DB = `id: db
title: Database
summary: Stores orders.
layer: data
paths: ["src/db/**"]
uses: [postgres]
rules:
  - { id: owns-pg, kind: only, externals: [postgres] }
`;
const FLOW = `id: checkout
title: Check out
steps:
  - { from: web, to: db, verb: stores }
`;

const valid = () =>
  write({
    [`${DIR}/index.yaml`]: INDEX,
    [`${DIR}/components/web.yaml`]: WEB,
    [`${DIR}/components/db.yaml`]: DB,
    [`${DIR}/flows/checkout.yaml`]: FLOW,
  });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jevlint-ssot-'));
  config = { ...(await loadConfig({ cwd: root })), root };
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('loadArchitecture', () => {
  it('returns null with no index.yaml', async () => {
    expect(await loadArchitecture(config)).toBeNull();
  });

  it('loads a valid SSOT with defaults, sorted, and folds prose onto one line', async () => {
    await valid();
    const ssot = (await loadArchitecture(config)) as ArchitectureSsot;
    expect(ssot.dir).toBe(DIR);
    expect(ssot.index.description).toBe('An online shop.');
    expect(ssot.components.map(({ id }) => id)).toEqual(['db', 'web']);
    expect(ssot.components[0]).toMatchObject({ key_files: [], status: 'current', checklist: [] });
    expect(ssot.components[1]?.depends_on).toEqual(['db']);
    expect(ssot.index.ignore).toEqual([]);
    expect(architectureFiles(ssot)).toEqual([
      `${DIR}/index.yaml`,
      `${DIR}/components/db.yaml`,
      `${DIR}/components/web.yaml`,
      `${DIR}/flows/checkout.yaml`,
    ]);
  });

  it('needs at least one component', async () => {
    await write({ [`${DIR}/index.yaml`]: INDEX });
    await expect(loadArchitecture(config)).rejects.toThrow('has no components');
  });

  it.each([
    ['a bad id', WEB.replace('id: web', 'id: Web_1'), 'web.yaml'],
    ['an id that differs from the file name', WEB.replace('id: web', 'id: other'), 'web.yaml'],
    ['the reserved id global', WEB.replace('id: web', 'id: global'), 'global.yaml'],
    ['a path with ..', WEB.replace('src/web/**', '../outside/**'), 'web.yaml'],
    ['an unknown key', `${WEB}color: red\n`, 'web.yaml'],
    ['a forbid with nothing to forbid', `${WEB}rules:\n  - { id: x, kind: forbid }\n`, 'web.yaml'],
    ['an unknown rule kind', `${WEB}rules:\n  - { id: x, kind: magic }\n`, 'web.yaml'],
  ])('rejects %s', async (_, content, file) => {
    await valid();
    await rm(join(root, DIR, 'components/web.yaml'));
    await write({ [`${DIR}/components/${file}`]: content });
    await expect(loadArchitecture(config)).rejects.toThrow(file);
  });

  it.each([
    ['an unknown layer', WEB.replace('layer: web', 'layer: nowhere'), 'no layer nowhere'],
    ['an unknown dependency', WEB.replace('[db]', '[ghost]'), 'no component ghost'],
    ['an unknown external', `${WEB}uses: [redis]\n`, 'no external redis'],
    [
      'a rule naming an unknown component',
      `${WEB}rules:\n  - { id: x, kind: forbid, components: [ghost] }\n`,
      'rule x: no component ghost',
    ],
  ])('cross-checks %s', async (_, content, message) => {
    await valid();
    await write({ [`${DIR}/components/web.yaml`]: content });
    await expect(loadArchitecture(config)).rejects.toThrow(message);
  });

  it('cross-checks flow steps', async () => {
    await valid();
    await write({ [`${DIR}/flows/checkout.yaml`]: FLOW.replace('to: db', 'to: ghost') });
    await expect(loadArchitecture(config)).rejects.toThrow('checkout.yaml: no component ghost');
  });

  it('refuses architecture.dir outside the root', async () => {
    const outside = { ...config, architecture: { ...config.architecture, dir: '../elsewhere' } };
    await expect(loadArchitecture(outside)).rejects.toThrow(
      'architecture.dir must be inside the root',
    );
  });

  it('reports invalid YAML without quoting it', async () => {
    await valid();
    await write({ [`${DIR}/index.yaml`]: 'version: [1\nsecret: hunter2' });
    const error = await loadArchitecture(config).catch((e: Error) => e);
    expect(String(error)).toContain('invalid YAML');
    expect(String(error)).not.toContain('hunter2');
  });
});

describe('budgetWarnings', () => {
  const component = (id: string) => ({
    id,
    title: id,
    summary: 'One. Two. Three. Four.',
    paths: [`${id}/**`],
    key_files: Array.from({ length: BUDGET.keyFiles + 1 }, (_, i) => ({
      path: `${id}/${i}.ts`,
      role: 'r',
    })),
    interface: [],
    uses: [],
    rules: [],
    checklist: [],
    status: 'current' as const,
  });

  it('is silent within the budget', () => {
    const ssot: ArchitectureSsot = {
      dir: DIR,
      index: {
        version: 1,
        name: 'x',
        description: 'y',
        layers: [],
        ignore: [],
        externals: [],
        rules: [],
        checklist: [],
      },
      components: [{ ...component('a'), summary: 'One.', key_files: [] }],
      flows: [],
      views: [],
      chapters: [],
    };
    expect(budgetWarnings(ssot)).toEqual([]);
  });

  it('warns about components, sentences, key files and tokens', () => {
    const many = Array.from({ length: BUDGET.components + 1 }, (_, i) => component(`c${i}`));
    const ssot: ArchitectureSsot = {
      dir: DIR,
      index: {
        version: 1,
        name: 'x',
        description: 'y'.repeat(30_000),
        layers: [],
        ignore: [],
        externals: [],
        rules: [],
        checklist: [],
      },
      components: many,
      flows: [],
      views: [],
      chapters: [],
    };
    const warnings = budgetWarnings(ssot).join('\n');
    expect(warnings).toContain(`${BUDGET.components + 1} components`);
    expect(warnings).toContain('c0: the summary has more than 3 sentences');
    expect(warnings).toContain(`c0: ${BUDGET.keyFiles + 1} key files`);
    expect(warnings).toContain('tokens in all');
  });
});

const OVERVIEW = `title: Overview
groups:
  - { id: front, label: Front }
nodes:
  - { id: shopper, label: Shopper, kind: actor }
  - { id: web, label: Web, component: web, group: front }
  - { id: db, label: Database, kind: store, path: src/db }
edges:
  - { from: shopper, to: web, verb: browses }
  - { from: web, to: db, verb: stores }
`;
const DATA = `kind: data
title: Orders
entities:
  - { id: order, name: Order, path: src/db/order.ts, fields: [{ name: id, type: string }] }
  - { id: line, name: Line, path: src/db/order.ts }
relations:
  - { from: order, to: line, cardinality: one-to-many, label: holds }
`;
const CHAPTER = `---
title: Overview
evidence: [src/web/a.ts:1]
---

Text.

<!-- jevlint:diagram overview -->
`;

describe('views and chapters', () => {
  const withViews = (files: Record<string, string>) =>
    valid().then(() =>
      write({
        [`${DIR}/views/overview.yaml`]: OVERVIEW,
        [`${DIR}/views/data-model.yaml`]: DATA,
        [`${DIR}/chapters/10-overview.md`]: CHAPTER,
        ...files,
      }),
    );

  it('loads graph views by default, data views, and chapters in name order', async () => {
    await withViews({
      [`${DIR}/chapters/05-intro.md`]: '---\ntitle: Intro\n---\nHi.\n',
    });
    const ssot = (await loadArchitecture(config)) as ArchitectureSsot;
    expect(ssot.views.map(({ id, kind }) => [id, kind])).toEqual([
      ['data-model', 'data'],
      ['overview', 'graph'],
    ]);
    const overview = ssot.views.find(({ id }) => id === 'overview');
    expect(overview).toMatchObject({
      kind: 'graph',
      edges: [{ style: 'solid' }, { style: 'solid' }],
    });
    expect(ssot.chapters.map(({ id }) => id)).toEqual(['05-intro', '10-overview']);
    expect(ssot.chapters[0]).toEqual({ id: '05-intro', title: 'Intro', evidence: [], body: 'Hi.' });
    expect(ssot.chapters[1]?.evidence).toEqual(['src/web/a.ts:1']);
    expect(architectureFiles(ssot)).toContain(`${DIR}/views/overview.yaml`);
    expect(architectureFiles(ssot)).toContain(`${DIR}/chapters/10-overview.md`);
  });

  const nodes = (count: number) =>
    Array.from({ length: count }, (_, i) => `  - { id: n${i}, label: N${i} }`).join('\n');
  const edges = (count: number) =>
    Array.from({ length: count }, () => '  - { from: n0, to: n1, verb: calls }').join('\n');

  it.each([
    ['an id that differs from the file name', `id: other\n${OVERVIEW}`, 'overview.yaml'],
    ['more than 34 nodes', `title: T\nnodes:\n${nodes(35)}\n`, 'overview.yaml'],
    [
      'more than 48 edges',
      `title: T\nnodes:\n${nodes(2)}\nedges:\n${edges(49)}\n`,
      'overview.yaml',
    ],
    [
      'a node with both a path and a component',
      'title: T\nnodes:\n  - { id: a, label: A, path: src, component: web }\n',
      'a path or a component, not both',
    ],
    [
      'an unknown group',
      'title: T\nnodes:\n  - { id: a, label: A, group: ghost }\n',
      'no group ghost',
    ],
    [
      'an unknown component',
      'title: T\nnodes:\n  - { id: a, label: A, component: ghost }\n',
      'no component ghost',
    ],
    [
      'an edge to an unknown node',
      'title: T\nnodes:\n  - { id: a, label: A }\nedges:\n  - { from: a, to: ghost, verb: x }\n',
      'no node ghost',
    ],
  ])('rejects a view with %s', async (_, content, message) => {
    await withViews({ [`${DIR}/views/overview.yaml`]: content });
    await expect(loadArchitecture(config)).rejects.toThrow(message);
  });

  it('rejects a relation to an unknown entity', async () => {
    await withViews({ [`${DIR}/views/data-model.yaml`]: DATA.replace('to: line', 'to: ghost') });
    await expect(loadArchitecture(config)).rejects.toThrow('no entity ghost');
  });

  it.each([
    ['no frontmatter', 'Just text.\n', 'must start with --- frontmatter'],
    ['no title', '---\nevidence: []\n---\nText\n', '10-overview.md'],
    [
      'an unknown diagram',
      CHAPTER.replace('diagram overview', 'diagram ghost'),
      'no diagram ghost',
    ],
  ])('rejects a chapter with %s', async (_, content, message) => {
    await withViews({ [`${DIR}/chapters/10-overview.md`]: content });
    await expect(loadArchitecture(config)).rejects.toThrow(message);
  });

  it('rejects a chapter with a bad name, or one that is too large', async () => {
    await withViews({ [`${DIR}/chapters/Intro.md`]: CHAPTER });
    await expect(loadArchitecture(config)).rejects.toThrow('name chapters with lowercase');
    await rm(join(root, DIR, 'chapters/Intro.md'));
    await write({ [`${DIR}/chapters/20-big.md`]: `---\ntitle: Big\n---\n${'x'.repeat(61_000)}` });
    await expect(loadArchitecture(config)).rejects.toThrow('larger than');
  });

  it('accepts built-in, flow and component diagrams', async () => {
    const body = ['map', 'layers', 'components', 'flow:checkout', 'component:web', 'data-model']
      .map((name) => `<!-- jevlint:diagram ${name} -->`)
      .join('\n\n');
    await withViews({ [`${DIR}/chapters/10-overview.md`]: `---\ntitle: T\n---\n${body}\n` });
    expect((await loadArchitecture(config))?.chapters).toHaveLength(1);
  });

  it('refuses a chapter linked from outside the repository', async () => {
    await withViews({});
    const outside = await mkdtemp(join(tmpdir(), 'jevlint-outside-'));
    await writeFile(join(outside, 'secret.md'), CHAPTER);
    await symlink(join(outside, 'secret.md'), join(root, DIR, 'chapters/30-linked.md'));
    await expect(loadArchitecture(config)).rejects.toThrow();
    await rm(outside, { recursive: true, force: true });
  });
});

describe('decision records', () => {
  const record = (id: string, fields = '', body = '### Context\n\nWhy.\n') =>
    `---\nid: ${id}\ntitle: ${id} title\ndate: 2026-10-02\nstatus: accepted\n${fields}---\n\n${body}`;
  const withDecisions = (files: Record<string, string>) =>
    valid().then(() =>
      write(
        Object.fromEntries(
          Object.entries(files).map(([name, content]) => [`${DIR}/decisions/${name}`, content]),
        ),
      ),
    );

  it('leaves the SSOT as it was when there are no records', async () => {
    await valid();
    await mkdir(join(root, DIR, 'decisions'));
    const ssot = (await loadArchitecture(config)) as ArchitectureSsot;
    expect(ssot).not.toHaveProperty('decisions');
    expect(Object.keys(ssot)).toEqual(['dir', 'index', 'components', 'flows', 'views', 'chapters']);
  });

  it('loads records with defaults, in number order, and lists their files', async () => {
    await withDecisions({
      '10-later.md': record('later', 'supersedes: [first]\n'),
      '9-first.md': record('first', 'status: superseded\nsuperseded_by: later\n').replace(
        'status: accepted\n',
        '',
      ),
      '0011-owned.md': record(
        'owned',
        'components: [db]\nenforced_by: [layers-point-down, db.owns-pg]\nevidence: [commit:abc1234]\n',
      ),
      'README.txt': 'not a record',
    });
    const ssot = (await loadArchitecture(config)) as ArchitectureSsot;
    expect(ssot.decisions?.map(({ file }) => file)).toEqual(['9-first', '10-later', '0011-owned']);
    expect(ssot.decisions?.[1]).toEqual({
      id: 'later',
      file: '10-later',
      title: 'later title',
      date: '2026-10-02',
      status: 'accepted',
      supersedes: ['first'],
      superseded_by: null,
      components: [],
      enforced_by: [],
      evidence: [],
      body: '### Context\n\nWhy.',
    });
    expect(ssot.decisions?.[2]).toMatchObject({
      components: ['db'],
      enforced_by: ['layers-point-down', 'db.owns-pg'],
    });
    expect(architectureFiles(ssot)).toContain(`${DIR}/decisions/0011-owned.md`);
  });

  it('reads compiled_on and refuses a date that is not real', async () => {
    await valid();
    await write({ [`${DIR}/index.yaml`]: `${INDEX}compiled_on: 2026-11-12\n` });
    expect((await loadArchitecture(config))?.index.compiled_on).toBe('2026-11-12');
    await write({ [`${DIR}/index.yaml`]: `${INDEX}compiled_on: 2026-02-30\n` });
    await expect(loadArchitecture(config)).rejects.toThrow('compiled_on: must be a real date');
  });

  it.each([
    ['a duplicate id', { '1-a.md': record('a'), '2-a.md': record('a') }, 'duplicate id a'],
    [
      'a supersedes id that does not exist',
      { '1-a.md': record('a', 'supersedes: [ghost]\n') },
      'no decision ghost',
    ],
    [
      'a superseded record with no successor',
      { '1-a.md': record('a').replace('accepted', 'superseded') },
      'superseded_by must name its successor',
    ],
    [
      'a successor that does not agree',
      {
        '1-a.md': record('a', 'superseded_by: b\n').replace('accepted', 'superseded'),
        '2-b.md': record('b'),
      },
      'b does not list a in supersedes',
    ],
    [
      'superseded_by on a record that is still accepted',
      { '1-a.md': record('a', 'superseded_by: b\n'), '2-b.md': record('b', 'supersedes: [a]\n') },
      'superseded_by is set, so status must be superseded',
    ],
    [
      'a cycle',
      {
        '1-a.md': record('a', 'supersedes: [b]\nsuperseded_by: b\n').replace(
          'accepted',
          'superseded',
        ),
        '2-b.md': record('b', 'supersedes: [a]\nsuperseded_by: a\n').replace(
          'accepted',
          'superseded',
        ),
      },
      'decisions supersede each other: a → b → a',
    ],
    [
      'an enforced_by id that is not a rule or checklist item',
      { '1-a.md': record('a', 'enforced_by: [owns-pg]\n') },
      'no rule or checklist item owns-pg',
    ],
    ['an unknown component', { '1-a.md': record('a', 'components: [ghost]\n') }, 'no component'],
    [
      'an id that differs from the file name',
      { '1-a.md': record('b') },
      'must equal the file name',
    ],
    ['a file name with no number', { 'a.md': record('a') }, 'name decision records'],
    [
      'a date that is not ISO',
      { '1-a.md': record('a').replace('2026-10-02', '02/10/2026') },
      'must be a date as YYYY-MM-DD',
    ],
    ['an unknown status', { '1-a.md': record('a').replace('accepted', 'done') }, '1-a.md: status'],
    ['an unknown key', { '1-a.md': record('a', 'owner: me\n') }, 'owner: unknown key'],
  ])('rejects %s', async (_, files, message) => {
    await withDecisions(files);
    await expect(loadArchitecture(config)).rejects.toThrow(message);
  });

  it('places the records with a decisions directive', async () => {
    await withDecisions({ '1-a.md': record('a') });
    await write({
      [`${DIR}/chapters/70-decisions.md`]:
        '---\ntitle: D\n---\n<!-- jevlint:diagram decisions -->\n',
    });
    expect((await loadArchitecture(config))?.chapters).toHaveLength(1);
  });

  it('refuses a record linked from outside the repository, and one that is too large', async () => {
    await withDecisions({ '1-a.md': record('a', '', 'x'.repeat(61_000)) });
    await expect(loadArchitecture(config)).rejects.toThrow('larger than');
    await rm(join(root, DIR, 'decisions/1-a.md'));
    const outside = await mkdtemp(join(tmpdir(), 'jevlint-outside-'));
    await writeFile(join(outside, 'secret.md'), record('b'));
    await symlink(join(outside, 'secret.md'), join(root, DIR, 'decisions/2-b.md'));
    await expect(loadArchitecture(config)).rejects.toThrow();
    await rm(outside, { recursive: true, force: true });
  });

  it('leaves records out of the token budget', async () => {
    const big = Array.from({ length: 40 }, (_, i) =>
      record(`d${i}`, '', 'word '.repeat(BUDGET.tokens)),
    );
    await withDecisions(Object.fromEntries(big.map((content, i) => [`${i}-d${i}.md`, content])));
    const ssot = (await loadArchitecture(config)) as ArchitectureSsot;
    expect(budgetWarnings(ssot).join('\n')).not.toContain('tokens in all');
  });
});

describe('budgetWarnings for chapters', () => {
  const ssotWith = (
    chapters: ArchitectureSsot['chapters'],
    views: ArchitectureSsot['views'] = [],
  ) =>
    ({
      dir: DIR,
      index: {
        version: 1,
        name: 'x',
        description: 'y',
        layers: [],
        ignore: [],
        externals: [],
        rules: [],
        checklist: [],
      },
      components: [],
      flows: [],
      views,
      chapters,
    }) as ArchitectureSsot;
  const words = (count: number) => Array.from({ length: count }, () => 'word').join(' ');

  it('warns about a long chapter and a long document', () => {
    const one = budgetWarnings(
      ssotWith([{ id: 'a', title: 'A', evidence: [], body: words(BUDGET.chapterWords + 1) }]),
    );
    expect(one.join('\n')).toContain(`chapter a: ${BUDGET.chapterWords + 1} words`);
    const many = Array.from({ length: 7 }, (_, i) => ({
      id: `c${i}`,
      title: 'C',
      evidence: [],
      body: words(1400),
    }));
    expect(budgetWarnings(ssotWith(many)).join('\n')).toContain('The chapters have 9800 words');
  });

  it('leaves views and chapters out of the token count', () => {
    const big = words(BUDGET.chapterWords);
    const chapters = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      title: 'C',
      evidence: [],
      body: big,
    }));
    expect(budgetWarnings(ssotWith(chapters)).join('\n')).not.toContain('tokens in all');
  });
});
