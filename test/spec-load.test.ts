import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Config, UserError } from '../src/config.ts';
import { fullId, GLOBAL, loadSpec, specFiles } from '../src/spec/load.ts';

let home: string;
let root: string;

const DIR = '.jevlint/spec';
const INDEX = 'version: 1\nname: Shop\ndescription: An online shop.\n';
const feature = (id: string) =>
  `id: ${id}\ntitle: ${id}\nsummary: The ${id} feature.\nchecklist:\n  - id: one\n    text: It works.\n`;

const write = async (files: Record<string, string>) => {
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, DIR, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
};
const configWith = (dir = DIR) => ({ root, spec: { dir, docs: [] } }) as unknown as Config;
const load = () => loadSpec(configWith());
const rejection = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(UserError);
  return (error as Error).message;
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'jevlint-spec-'));
  root = join(home, 'repo');
  await mkdir(root);
});

afterEach(() => rm(home, { recursive: true, force: true }));

describe('loadSpec', () => {
  it('loads a valid spec, sorts features by id and ignores other files', async () => {
    await write({
      'index.yaml': `${INDEX}checklist:\n  - id: no-secrets\n    text: No secrets.\n    source: docs/a.md\n`,
      'features/a.yaml': feature('a'),
      'features/a-b.yaml': feature('a-b'),
      'features/notes.md': 'ignored',
      'features/nested/x.yaml': 'ignored: true',
      'other.yaml': 'ignored: true',
    });
    const spec = await load();
    expect(spec?.dir).toBe(DIR);
    expect(spec?.index).toEqual({
      version: 1,
      name: 'Shop',
      description: 'An online shop.',
      checklist: [{ id: 'no-secrets', text: 'No secrets.', source: 'docs/a.md' }],
      accept_uncovered: [],
    });
    expect(spec?.features.map(({ id }) => id)).toEqual(['a', 'a-b']);
    expect(specFiles(spec as NonNullable<typeof spec>)).toEqual([
      `${DIR}/index.yaml`,
      `${DIR}/features/a.yaml`,
      `${DIR}/features/a-b.yaml`,
    ]);
    expect(fullId(GLOBAL, { id: 'x' })).toBe('global.x');
  });

  it('defaults the project checklist to none', async () => {
    await write({ 'index.yaml': INDEX, 'features/a.yaml': feature('a') });
    expect((await load())?.index.checklist).toEqual([]);
  });

  it('reads accept_uncovered, and defaults it to none', async () => {
    await write({ 'index.yaml': INDEX, 'features/a.yaml': feature('a') });
    expect((await load())?.index.accept_uncovered).toEqual([]);
    await write({
      'index.yaml': `${INDEX}accept_uncovered:\n  - { path: docs/README.md, reason: Links only. }\n`,
    });
    expect((await load())?.index.accept_uncovered).toEqual([
      { path: 'docs/README.md', reason: 'Links only.' },
    ]);
  });

  it('returns null without index.yaml', async () => {
    await write({ 'features/a.yaml': feature('a') });
    expect(await load()).toBeNull();
  });

  it.each([
    ['index.yaml', 'version: 2\nname: S\ndescription: D\n', 'version'],
    ['index.yaml', `${INDEX}extra: 1\n`, 'extra: unknown key'],
    ['index.yaml', 'version: 1\nname: S\n', 'description'],
    ['index.yaml', `${INDEX}checklist:\n  - id: Bad_Id\n    text: T\n`, 'checklist.0.id'],
    [
      'index.yaml',
      `${INDEX}checklist:\n  - { id: a, text: T }\n  - { id: a, text: U }\n`,
      'duplicate id a',
    ],
    ['index.yaml', `${INDEX}accept_uncovered:\n  - { path: docs/README.md }\n`, 'reason'],
    ['features/a.yaml', feature('b'), 'must equal the file name'],
    ['features/a.yaml', 'id: a\ntitle: A\nsummary: S\nchecklist: []\n', 'checklist'],
    ['features/a.yaml', 'id: a\ntitle: A\nsummary: S\n', 'checklist'],
    ['features/a.yaml', '- a list\n', 'must be a mapping'],
  ])('rejects an invalid %s: %s', async (file, content, problem) => {
    await write({ 'index.yaml': INDEX, 'features/a.yaml': feature('a'), [file]: content });
    const message = await rejection(load());
    expect(message).toContain(`${DIR}/${file}`);
    expect(message).toContain(problem);
  });

  it('reserves global as a feature id', async () => {
    await write({ 'index.yaml': INDEX, 'features/global.yaml': feature('global') });
    expect(await rejection(load())).toContain('global is reserved');
  });

  it('names every problem in a file', async () => {
    await write({ 'index.yaml': INDEX, 'features/a.yaml': 'id: a\ntypo: 1\n' });
    const message = await rejection(load());
    expect(message).toContain('typo: unknown key');
    expect(message).toContain('title');
    expect(message).toContain('summary');
  });

  it('requires at least one feature', async () => {
    await write({ 'index.yaml': INDEX });
    expect(await rejection(load())).toContain(`has no features. Add ${DIR}/features/<id>.yaml`);
  });

  it('allows at most 255 features', async () => {
    const files: Record<string, string> = { 'index.yaml': INDEX };
    for (let i = 0; i < 256; i++) files[`features/f${i}.yaml`] = feature(`f${i}`);
    await write(files);
    expect(await rejection(load())).toContain('256 features');
  });

  it('rejects a spec.dir outside the root', async () => {
    expect(await rejection(loadSpec(configWith('../elsewhere')))).toContain('outside the root');
    expect(await rejection(loadSpec(configWith(home)))).toContain('outside the root');
  });

  it('refuses a feature file that links out of the repository', async () => {
    await writeFile(join(home, 'outside.yaml'), feature('a'));
    await write({ 'index.yaml': INDEX, 'features/b.yaml': feature('b') });
    await symlink(join(home, 'outside.yaml'), join(root, DIR, 'features', 'a.yaml'));
    expect(await rejection(load())).toContain('links outside the repository');
  });

  it('refuses a spec directory that links out of the repository', async () => {
    await mkdir(join(home, 'spec'));
    await writeFile(join(home, 'spec', 'index.yaml'), INDEX);
    await mkdir(join(root, '.jevlint'));
    await symlink(join(home, 'spec'), join(root, DIR));
    expect(await rejection(load())).toContain('links outside the repository');
  });

  it('reports bad YAML by position without echoing the source', async () => {
    await write({
      'index.yaml': 'version: 1\nname: "sk-secret-key\n',
      'features/a.yaml': feature('a'),
    });
    const message = await rejection(load());
    expect(message).toMatch(/index\.yaml: invalid YAML at line \d+, column \d+$/);
    expect(message).not.toContain('sk-secret');
  });

  it('rejects an alias bomb', async () => {
    const bomb = [
      'a: &a ["x","x","x","x","x","x","x","x","x"]',
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      'd: [*c,*c,*c,*c,*c,*c,*c,*c,*c]',
    ].join('\n');
    await write({ 'index.yaml': INDEX, 'features/a.yaml': bomb });
    expect(await rejection(load())).toContain('features/a.yaml: too many YAML aliases');
  });
});
