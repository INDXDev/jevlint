import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Experimental_DecisionMockModelV4 as MockModel } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeViolations, checkArchitecture } from '../src/architecture/check.ts';
import { prepareCompile, validateSsot } from '../src/architecture/compile.ts';
import { driftArchitecture } from '../src/architecture/drift.ts';
import { loadArchitecture } from '../src/architecture/load.ts';
import { reviewArchitecture } from '../src/architecture/review.ts';
import { architectureBaseline, writeBaseline } from '../src/baseline.ts';
import { type Config, loadConfig, UserError } from '../src/config.ts';
import { createDecisionModel, type ResolvedModel } from '../src/decision/providers.ts';
import type { ArchitectureSsot } from '../src/types.ts';

vi.mock('../src/decision/providers.ts', () => ({ createDecisionModel: vi.fn() }));

let root: string;
let config: Config;
const DIR = '.jevlint/architecture';

const write = async (files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
};

const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd: root,
    encoding: 'utf8',
  }).trim();

const commit = (message: string) => {
  git('add', '-A');
  git('commit', '-qm', message);
  return git('rev-parse', 'HEAD');
};

const SSOT = {
  [`${DIR}/index.yaml`]: `version: 1
name: shop
description: A shop.
layers: [web, data]
rules:
  - { id: down, kind: layers }
checklist:
  - { id: typed, text: "Errors are typed." }
  - { id: never, text: "Nothing satisfies this." }
`,
  [`${DIR}/components/web.yaml`]: `id: web
title: Web
summary: Serves pages.
layer: web
paths: ["src/web/**"]
depends_on: [db]
`,
  [`${DIR}/components/db.yaml`]: `id: db
title: Database
summary: Stores orders.
layer: data
paths: ["src/db/**"]
depends_on: []
`,
};

const CODE = {
  'src/web/page.ts':
    "import { query } from '../db/client.ts';\nexport const page = () => query();\n",
  'src/db/client.ts': 'export function query() { return 1; }\n',
};

/** Answers every choice with `pick(id, state)`, and every boolean with `fits`. */
function useModel(pick: (id: string, state: string) => string, fits = 0.9) {
  const requests: string[] = [];
  const model = new MockModel({
    doDecide: async ({ state, questions }) => {
      const text = JSON.stringify(state);
      requests.push(text);
      const answers = Object.entries(questions).map(([id, question]) => {
        const q = question as { type: string; criteria?: Record<string, string> };
        if (q.type === 'boolean') return [id, { type: 'boolean', probability: fits }];
        if (q.type === 'score') return [id, { type: 'score', score: 2 }];
        const choice = pick(id, text);
        const options = Object.keys(q.criteria ?? {});
        const probabilities = Object.fromEntries(
          options.map((o) => [o, o === choice ? 0.9 : 0.1 / (options.length - 1)]),
        );
        return [id, { type: 'choice', choice, probabilities }];
      });
      return {
        answers: Object.fromEntries(answers),
        usage: { inputTokens: 3 },
        warnings: [],
      } as never;
    },
  });
  vi.mocked(createDecisionModel).mockResolvedValue({
    model,
    provider: 'typesafe',
    modelId: 'm',
  } as unknown as ResolvedModel);
  return requests;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jevlint-architecture-check-'));
  vi.mocked(createDecisionModel).mockResolvedValue(null);
  const loaded = await loadConfig({ cwd: root });
  config = {
    ...loaded,
    root,
    cache: { dir: join(root, '.cache-dir') },
    exclude: ['.cache-dir/**'],
  };
  await write({ ...SSOT, ...CODE });
});
afterEach(() => rm(root, { recursive: true, force: true }));

const ssot = async () => (await loadArchitecture(config)) as ArchitectureSsot;

describe('checkArchitecture', () => {
  it('passes code that follows the SSOT, statically', async () => {
    const report = await checkArchitecture(config, await ssot(), { static: true });
    expect(report).toMatchObject({
      violations: [],
      files: [],
      unimplemented: [],
      complete: true,
      provider: null,
    });
    expect(createDecisionModel).not.toHaveBeenCalled();
  });

  it('reports an import against the layers, narrowed by paths', async () => {
    await write({
      'src/db/client.ts': "import '../web/page.ts';\nexport function query() { return 1; }\n",
    });
    const all = await checkArchitecture(config, await ssot(), { static: true });
    expect(all.violations.map(({ rule, path, line }) => [rule, path, line])).toEqual([
      ['layer-violation', 'src/db/client.ts', 1],
      ['undeclared-dependency', 'src/db/client.ts', 1],
    ]);
    const narrowed = await checkArchitecture(config, await ssot(), {
      static: true,
      paths: [join(root, 'src/web')],
    });
    expect(narrowed.violations).toEqual([]);
    expect(narrowed.complete).toBe(false);
  });

  it('judges checklists per file and lists items no file satisfies', async () => {
    const requests = useModel((id, state) =>
      id === 'global.typed' && state.includes('function query')
        ? 'satisfies'
        : id === 'global.typed'
          ? 'violates'
          : 'not-applicable',
    );
    const report = await checkArchitecture(config, await ssot(), {});
    expect(requests).toHaveLength(2);
    expect(report.checklistViolations).toBe(1);
    expect(report.files[0]).toMatchObject({ path: 'src/web/page.ts', component: 'web' });
    expect(report.unimplemented.map(({ id }) => id)).toEqual(['global.never']);
    expect(report.usage.modelCalls).toBe(2);
  });

  it('needs a model for checklists, unless --static', async () => {
    await expect(checkArchitecture(config, await ssot(), {})).rejects.toThrow(UserError);
  });

  it('leaves out violations the baseline records with --new', async () => {
    await write({
      'src/db/client.ts': "import '../web/page.ts';\nexport function query() { return 1; }\n",
    });
    const before = await checkArchitecture(config, await ssot(), { static: true });
    await writeBaseline(root, { files: [], architecture: architectureBaseline(before.violations) });
    const after = await checkArchitecture(config, await ssot(), { static: true, new: true });
    expect(after.violations).toEqual([]);
    expect(after.baselined).toBe(2);
  });

  it('reports a target component separately', async () => {
    await write({
      [`${DIR}/components/db.yaml`]: `${SSOT[`${DIR}/components/db.yaml`]}status: target\n`,
      'src/db/client.ts': "import '../web/page.ts';\nexport function query() { return 1; }\n",
    });
    const report = await checkArchitecture(config, await ssot(), { static: true });
    expect(report.violations).toEqual([]);
    expect(report.targetGaps).toHaveLength(2);
  });
});

describe('with git history', () => {
  beforeEach(() => {
    git('init', '-q');
  });

  it('reports exactly the one violation a change against the layers adds', async () => {
    const base = commit('base');
    await write({
      'src/db/client.ts':
        "import { page } from '../web/page.ts';\nexport function query() { return 1; }\n",
    });
    const report = await checkArchitecture(
      config,
      {
        ...(await ssot()),
        components: (await ssot()).components.map((c) => ({ ...c, depends_on: undefined })),
      },
      { static: true, diff: base },
    );
    expect(report.violations.map(({ rule, path, line }) => [rule, path, line])).toEqual([
      ['layer-violation', 'src/db/client.ts', 1],
    ]);
    expect(report.base).toBe(base);
    const head = commit('reverse');
    const added = await changeViolations(config, await ssot(), base, head);
    expect(added.map(({ rule }) => rule)).toEqual(['layer-violation', 'undeclared-dependency']);
    expect(await changeViolations(config, await ssot(), head, head)).toEqual([]);
  });

  it('reads key files and tsconfig aliases from the commits it compares', async () => {
    await write({
      [`${DIR}/components/web.yaml`]: `${SSOT[`${DIR}/components/web.yaml`]}key_files:\n  - { path: src/web/page.ts, role: pages }\n`,
      'tsconfig.json': '{ "compilerOptions": { "paths": { "@app/*": ["src/web/*"] } } }',
    });
    const base = commit('base');
    await rm(join(root, 'src/web/page.ts'));
    await write({
      'src/web/other.ts': 'export const other = 1;\n',
      'src/db/client.ts':
        "import { other } from '@app/other.ts';\nexport function query() { return other; }\n",
    });
    const head = commit('remove the key file, import web from db');
    // The checkout is back at base, so only the commits can show what the change did.
    git('checkout', '-q', base);
    const added = await changeViolations(config, await ssot(), base, head);
    expect(added.map(({ rule, target }) => [rule, target])).toEqual(
      expect.arrayContaining([
        ['stale-reference', 'src/web/page.ts'],
        ['layer-violation', 'src/web/other.ts'],
      ]),
    );
  });

  it('measures a narrowed compile against the whole SSOT', async () => {
    const base = commit('base');
    await write({
      [`${DIR}/index.yaml`]: SSOT[`${DIR}/index.yaml`].replace(
        'name: shop',
        `name: shop\ncompiled_at: ${base}`,
      ),
    });
    const input = await prepareCompile(config, { paths: ['src/web'] });
    expect(input.facts.modules.map(({ path }) => path)).toEqual(['src/web/page.ts']);
    expect(input.delta).toEqual(expect.objectContaining({ removed: [], items: [] }));
  });

  it('reports a directory added since compiled_at as new unmapped code', async () => {
    const base = commit('base');
    await write({
      [`${DIR}/index.yaml`]: SSOT[`${DIR}/index.yaml`].replace(
        'name: shop',
        `name: shop\ncompiled_at: ${base}`,
      ),
    });
    await write({
      'src/jobs/a.ts': 'export const a = 1;\n',
      'src/jobs/b.ts': 'export const b = 1;\n',
    });
    const report = await driftArchitecture(config, await ssot(), { static: true });
    expect(report.items).toEqual([
      expect.objectContaining({ kind: 'unmapped-code', path: 'src/jobs/', since: true }),
    ]);
    expect(report.added).toEqual(['src/jobs/a.ts', 'src/jobs/b.ts']);
    expect(report.compiledAt).toBe(base);
    expect(report.provider).toBeNull();
  });
});

describe('driftArchitecture', () => {
  it('finds nothing when the SSOT fits, statically', async () => {
    const report = await driftArchitecture(config, await ssot(), { static: true });
    expect(report.items).toEqual([]);
  });

  it('asks whether summaries still fit, and reports the stale ones', async () => {
    const requests = useModel(() => 'agrees', 0.1);
    const report = await driftArchitecture(config, await ssot(), {});
    expect(report.items.map(({ kind, component }) => [kind, component]).sort()).toEqual([
      ['stale-summary', 'db'],
      ['stale-summary', 'web'],
    ]);
    expect(requests.join()).toContain('Summary: Stores orders.');
    expect(requests.join()).not.toContain('return 1');
  });

  it('reports a failed summary request as a provider error', async () => {
    useModel(() => 'agrees');
    const resolved = await createDecisionModel(config);
    const failing = new MockModel({
      doDecide: async () => {
        throw new Error('429 rate limited');
      },
    });
    vi.mocked(createDecisionModel).mockResolvedValue({ ...resolved, model: failing } as never);
    const report = await driftArchitecture(config, await ssot(), {});
    expect(report.items).toEqual([]);
    expect(report.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Provider error: .*429 rate limited/)]),
    );
  });

  it('compares documents with the SSOT', async () => {
    await write({ 'docs/arch.md': '# Arch\nThe web layer talks to the database.\n' });
    useModel(
      (id) => (id === 'route' ? 'web' : id === 'web.summary' ? 'contradicts' : 'agrees'),
      0.9,
    );
    const report = await driftArchitecture(config, await ssot(), { docs: ['docs/arch.md'] });
    expect(report.docs).toEqual([
      expect.objectContaining({ path: 'docs/arch.md', feature: 'web' }),
    ]);
    expect(report.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'document', target: 'web.summary' }),
      ]),
    );
  });
});

describe('reviewArchitecture with an SSOT', () => {
  it('adds a unit per component and one for the design', async () => {
    const report = await reviewArchitecture(config, { astOnly: true });
    expect(
      report.units
        .filter(({ perspective }) => perspective === 'component')
        .map(({ name }) => name)
        .sort(),
    ).toEqual(['db', 'web']);
    expect(report.units.some(({ perspective }) => perspective === 'design')).toBe(true);
    expect(Object.keys(report.perspectives)).toEqual(
      expect.arrayContaining(['component', 'design']),
    );
  });

  it('is unchanged without one, and refuses SSOT perspectives', async () => {
    await rm(join(root, DIR), { recursive: true });
    const report = await reviewArchitecture(config, { astOnly: true });
    expect(new Set(report.units.map(({ perspective }) => perspective))).toEqual(
      new Set(['codebase', 'directory']),
    );
    await expect(
      reviewArchitecture(config, { astOnly: true, perspectives: ['design'] }),
    ).rejects.toThrow('The design perspective reviews the architecture SSOT');
  });

  it('reviews without an SSOT that does not load, unless a perspective needs it', async () => {
    await write({ [`${DIR}/index.yaml`]: 'version: [' });
    const codebase = await reviewArchitecture(config, {
      astOnly: true,
      perspectives: ['codebase'],
    });
    expect(codebase.warnings).toEqual([]);
    const fallback = await reviewArchitecture(config, { astOnly: true });
    expect(fallback.warnings[0]).toContain('The SSOT does not load');
    expect(fallback.units.some(({ perspective }) => perspective === 'design')).toBe(false);
    await expect(
      reviewArchitecture(config, { astOnly: true, perspectives: ['design'] }),
    ).rejects.toThrow(UserError);
  });

  it('sends the design as YAML, never code', async () => {
    const requests = useModel(() => 'agrees');
    await reviewArchitecture(config, { perspectives: ['design', 'component'] });
    const design = requests.find((state) => state.includes('components:'));
    expect(design).toContain('Serves pages.');
    expect(requests.join()).not.toContain('return 1');
    expect(await readFile(join(root, 'src/db/client.ts'), 'utf8')).toContain('return 1');
  });
});

const CHAPTER = `---
title: How pages are served
evidence: [src/web/page.ts:1]
---

The web layer asks the database through \`src/db/client.ts:1\`.
`;
const OVERVIEW = `title: Overview
nodes:
  - { id: web, label: Web, component: web }
  - { id: db, label: Database, kind: store, component: db }
edges:
  - { from: web, to: db, verb: queries }
`;

describe('chapters and views', () => {
  it('reviews each chapter from its text, with the chapter perspective', async () => {
    await write({ [`${DIR}/chapters/10-pages.md`]: CHAPTER });
    const requests = useModel(() => 'agrees');
    const report = await reviewArchitecture(config, { perspectives: ['chapter'] });
    expect(report.units.map(({ perspective, name, path }) => [perspective, name, path])).toEqual([
      ['chapter', '10-pages', `${DIR}/chapters/10-pages.md`],
    ]);
    expect(report.units[0]?.model?.answers.length).toBeGreaterThan(0);
    expect(requests.join()).toContain('Chapter: How pages are served');
    expect(requests.join()).toContain('Evidence: src/web/page.ts:1');
    expect(requests.join()).not.toContain('return 1');
  });

  it('refuses the chapter perspective without an SSOT', async () => {
    await rm(join(root, DIR), { recursive: true });
    await expect(
      reviewArchitecture(config, { astOnly: true, perspectives: ['chapter'] }),
    ).rejects.toThrow('The chapter perspective reviews the architecture SSOT');
  });

  it('reports a chapter whose cited file changed since compiled_at', async () => {
    git('init', '-q');
    const base = commit('base');
    await write({
      [`${DIR}/index.yaml`]: SSOT[`${DIR}/index.yaml`].replace(
        'name: shop',
        `name: shop\ncompiled_at: ${base}`,
      ),
      [`${DIR}/chapters/10-pages.md`]: CHAPTER,
      [`${DIR}/views/overview.yaml`]: OVERVIEW,
    });
    commit('document');
    // Only the SSOT changed, and a file the chapter mentions without citing does not count.
    await write({ 'src/db/client.ts': 'export function query() { return 2; }\n' });
    const quiet = await driftArchitecture(config, await ssot(), { static: true });
    expect(quiet.items).toEqual([]);
    await write({
      'src/web/page.ts':
        "import { query } from '../db/client.ts';\nexport const page = () => query() + 1;\n",
    });
    const items = (await driftArchitecture(config, await ssot(), { static: true })).items;
    expect(items).toEqual([
      expect.objectContaining({
        kind: 'stale-chapter',
        path: `${DIR}/chapters/10-pages.md`,
        target: 'src/web/page.ts',
      }),
    ]);
  });

  it('reports no stale chapter without compiled_at', async () => {
    await write({ [`${DIR}/chapters/10-pages.md`]: CHAPTER });
    const report = await driftArchitecture(config, await ssot(), { static: true });
    expect(report.items).toEqual([]);
  });
});

describe('validateSsot', () => {
  it('says why the SSOT does not load', async () => {
    await write({ [`${DIR}/index.yaml`]: 'version: 2\n' });
    const result = await validateSsot(config);
    expect(result.ssot).toBeNull();
    expect(result.error).toContain('index.yaml');
  });

  it('is clean without views or chapters, and reports what does not fit when there are', async () => {
    expect(await validateSsot(config)).toMatchObject({ problems: [] });
    await write({
      [`${DIR}/views/overview.yaml`]: OVERVIEW.replace(
        '{ from: web, to: db',
        '{ from: db, to: web',
      ),
      [`${DIR}/chapters/10-pages.md`]: CHAPTER.replace('src/web/page.ts:1', 'src/web/page.ts:40'),
    });
    const { problems } = await validateSsot(config);
    expect(problems).toEqual([
      `${DIR}/views/overview.yaml: Database → Web: the import runs the other way (src/web/page.ts:1); the caller owns the arrow`,
      `${DIR}/chapters/10-pages.md: evidence src/web/page.ts has only 3 lines, not 40`,
    ]);
  });

  it('is null with no SSOT and no error', async () => {
    await rm(join(root, DIR), { recursive: true });
    expect(await validateSsot(config)).toEqual({ ssot: null, problems: [] });
  });
});
