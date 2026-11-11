import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    };
    const warnings = budgetWarnings(ssot).join('\n');
    expect(warnings).toContain(`${BUDGET.components + 1} components`);
    expect(warnings).toContain('c0: the summary has more than 3 sentences');
    expect(warnings).toContain(`c0: ${BUDGET.keyFiles + 1} key files`);
    expect(warnings).toContain('tokens in all');
  });
});
