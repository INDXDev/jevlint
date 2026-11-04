import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, UserError } from '../src/config.ts';
import {
  activeQuestions,
  installPreset,
  listPresets,
  loadPresets,
  parsePreset,
  removePreset,
} from '../src/presets.ts';
import type { Preset } from '../src/types.ts';

const boolean = (extra = 'good = false') => `
[[questions]]
id = "q"
type = "boolean"
title = "t"
instructions = "i"
fix = "f"
${extra}
`;

const score = (levels: number) => `
[[questions]]
id = "s"
type = "score"
title = "t"
instructions = "i"
fix = "f"
levels = ${JSON.stringify(Array.from({ length: levels }, (_, index) => `level ${index}`))}
`;

const preset = (name: string, description = 'd', questions = boolean()) =>
  `name = "${name}"\ndescription = "${description}"\nsource = "s"\n${questions}`;

let home: string;
let root: string;

const writePreset = async (dir: string, name: string, toml: string) => {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.toml`), toml);
};
const repoDir = () => join(root, '.jevlint', 'presets');

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'jevlint-presets-'));
  root = join(home, 'repo');
  await mkdir(root);
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', join(home, 'config'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('parsePreset', () => {
  const rule = (id = 'r', extra = '') =>
    `[[rules]]\nid = "${id}"\nlanguage = "go"\npattern = "a()"\nquestion = "Q?"\nmessage = "M"\nfix = "F"\n${extra}\n`;

  it('reads rules, defaulting their threshold, and allows none', () => {
    expect(parsePreset(preset('p', 'd', boolean() + rule())).rules).toEqual([
      {
        id: 'r',
        language: 'go',
        pattern: 'a()',
        question: 'Q?',
        message: 'M',
        fix: 'F',
        threshold: 0.8,
      },
    ]);
    expect(parsePreset(preset('p')).rules).toEqual([]);
  });

  it('refuses a duplicate rule id', () => {
    const toml = preset('p', 'd', boolean() + rule() + rule());
    expect(() => parsePreset(toml)).toThrow('Rule ids must be unique');
  });

  it('refuses a rule id that a built-in finding uses', () => {
    const toml = preset('p', 'd', boolean() + rule('file-lines'));
    expect(() => parsePreset(toml)).toThrow('built-in finding');
  });

  it('refuses a threshold outside 0 to 1', () => {
    const toml = preset('p', 'd', boolean() + rule('r', 'threshold = -0.1'));
    expect(() => parsePreset(toml)).toThrow('threshold');
  });

  it('applies defaults for weight and patterns', () => {
    const parsed = parsePreset(preset('house'));
    expect(parsed.questions[0]?.weight).toBe(1);
    expect(parsed.patterns).toEqual([]);
  });

  it.each([2, 10])('accepts %i levels', (levels) => {
    expect(() => parsePreset(preset('house', 'd', score(levels)))).not.toThrow();
  });

  it.each([1, 11])('rejects %i levels', (levels) => {
    expect(() => parsePreset(preset('house', 'd', score(levels)))).toThrow(/questions\.0\.levels/);
  });

  it('requires good on boolean questions', () => {
    expect(() => parsePreset(preset('house', 'd', boolean('')))).toThrow(/questions\.0\.good/);
  });

  it('rejects a bad question id', () => {
    const toml = preset('house').replace('id = "q"', 'id = "not ok"');
    expect(() => parsePreset(toml)).toThrow(UserError);
  });

  it('rejects duplicate question ids', () => {
    const toml = preset('house', 'd', boolean() + boolean());
    expect(() => parsePreset(toml)).toThrow(/unique/);
  });
});

describe('loading', () => {
  it('prefers repository over user', async () => {
    await writePreset(paths.presetsDir(), 'house', preset('house', 'user'));
    await writePreset(repoDir(), 'house', preset('house', 'repo'));
    const [loaded] = await loadPresets(['house'], root);
    expect(loaded?.description).toBe('repo');
    const listed = (await listPresets(root)).filter(({ name }) => name === 'house');
    expect(listed).toMatchObject([{ origin: 'repo', description: 'repo' }]);
  });

  it('lists what is available when a name is unknown', async () => {
    await writePreset(paths.presetsDir(), 'house', preset('house'));
    const load = loadPresets(['nope'], root);
    await expect(load).rejects.toThrow(UserError);
    await expect(load).rejects.toThrow(/Unknown preset "nope".*house/);
  });

  it('resolves every built-in from the package presets directory', async () => {
    const builtIns = (await listPresets(root)).filter(({ origin }) => origin === 'built-in');
    expect(builtIns.map(({ name }) => name)).toContain('readable-code');
    expect(await loadPresets(['readable-code'], root)).toHaveLength(1);
  });

  it('never resolves a traversal name to a file', async () => {
    await writeFile(join(home, 'evil.toml'), preset('evil'));
    await expect(loadPresets(['../../evil'], root)).rejects.toThrow(/Unknown preset/);
  });

  it('loads a named preset once when it is listed twice', async () => {
    const loaded = await loadPresets(['solid', 'clean-code', 'solid'], root);
    expect(loaded.map(({ name }) => name)).toEqual(['solid', 'clean-code']);
  });

  it('creates nothing outside the repository through a linked .jevlint', async () => {
    const outside = join(home, 'outdir');
    await mkdir(outside);
    await symlink(outside, join(root, '.jevlint'));
    const file = join(home, 'p.toml');
    await writeFile(file, preset('house'));
    await expect(installPreset(file, { repo: true, root })).rejects.toThrow(/links outside/);
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses a repository preset file that links outside the root', async () => {
    await writeFile(join(home, 'outside.toml'), preset('outside'));
    await mkdir(repoDir(), { recursive: true });
    await symlink(join(home, 'outside.toml'), join(repoDir(), 'link.toml'));
    const load = loadPresets(['outside'], root);
    await expect(load).rejects.toThrow(UserError);
    await expect(load).rejects.toThrow(/links outside the repository/);
  });

  it('refuses a repository presets directory that links outside the root', async () => {
    await writePreset(paths.presetsDir(), 'house', preset('house'));
    await mkdir(join(root, '.jevlint'));
    await symlink(paths.presetsDir(), repoDir());
    await expect(removePreset('house', root)).rejects.toThrow(/links outside the repository/);
    expect(await readdir(paths.presetsDir())).toEqual(['house.toml']);
  });

  it('follows a repository symlink that stays inside the root', async () => {
    await writeFile(join(root, 'shared.toml'), preset('shared'));
    await mkdir(repoDir(), { recursive: true });
    await symlink(join(root, 'shared.toml'), join(repoDir(), 'link.toml'));
    expect(await loadPresets(['shared'], root)).toHaveLength(1);
  });

  it('follows symlinks in the user directory, which the user controls', async () => {
    await writeFile(join(home, 'dotfile.toml'), preset('dotfile'));
    await mkdir(paths.presetsDir(), { recursive: true });
    await symlink(join(home, 'dotfile.toml'), join(paths.presetsDir(), 'dotfile.toml'));
    expect(await loadPresets(['dotfile'], root)).toHaveLength(1);
  });
});

describe('installPreset', () => {
  it('copies to the user directory, or the repository with repo', async () => {
    const file = join(home, 'anything.toml');
    await writeFile(file, preset('house'));
    expect(await installPreset(file, { repo: false, root })).toBe(
      join(paths.presetsDir(), 'house.toml'),
    );
    expect(await installPreset(file, { repo: true, root })).toBe(join(repoDir(), 'house.toml'));
  });

  it('rejects a name that would escape the presets directory', async () => {
    const file = join(home, 'evil.toml');
    await writeFile(file, preset('../../evil'));
    await expect(installPreset(file, { repo: false, root })).rejects.toThrow(UserError);
    expect(await readdir(home)).toEqual(['evil.toml', 'repo']);
  });

  it('replaces a repository symlink instead of writing through it', async () => {
    const victim = join(home, 'victim');
    await writeFile(victim, 'untouched');
    await mkdir(repoDir(), { recursive: true });
    await symlink(victim, join(repoDir(), 'house.toml'));
    const file = join(home, 'anything.toml');
    await writeFile(file, preset('house'));
    const installed = await installPreset(file, { repo: true, root });
    expect(await readFile(victim, 'utf8')).toBe('untouched');
    expect((await lstat(installed)).isSymbolicLink()).toBe(false);
  });

  it('refuses a repository presets directory that links outside the root', async () => {
    const victim = join(home, 'config', 'jevlint');
    await mkdir(victim, { recursive: true });
    await writeFile(join(victim, 'credentials.toml'), 'typesafe = "key"\n');
    await mkdir(join(root, '.jevlint'));
    await symlink(victim, repoDir());
    const file = join(home, 'anything.toml');
    await writeFile(file, preset('credentials'));
    await expect(installPreset(file, { repo: true, root })).rejects.toThrow(
      /links outside the repository/,
    );
    expect(await readFile(join(victim, 'credentials.toml'), 'utf8')).toBe('typesafe = "key"\n');
  });

  it('reports a missing file', async () => {
    await expect(installPreset(join(home, 'no.toml'), { repo: false, root })).rejects.toThrow(
      UserError,
    );
  });
});

describe('removePreset', () => {
  it('removes an installed preset', async () => {
    await writePreset(paths.presetsDir(), 'house', preset('house'));
    expect(await removePreset('house', root)).toBe(true);
    expect(await removePreset('house', root)).toBe(false);
  });

  it('refuses to remove a built-in', async () => {
    await expect(removePreset('readable-code', root)).rejects.toThrow(UserError);
  });

  it('removes a user copy that shadows a built-in', async () => {
    await writePreset(paths.presetsDir(), 'readable-code', preset('readable-code'));
    expect(await removePreset('readable-code', root)).toBe(true);
    const listed = (await listPresets(root)).find(({ name }) => name === 'readable-code');
    expect(listed?.origin).toBe('built-in');
  });

  it('cannot delete through a traversal name', async () => {
    await writePreset(paths.presetsDir(), 'house', preset('house'));
    const victim = join(home, 'victim.toml');
    await writeFile(victim, preset('victim'));
    expect(await removePreset('../../../victim', root)).toBe(false);
    expect(await readdir(home)).toContain('victim.toml');
  });
});

describe('activeQuestions', () => {
  const presets: Preset[] = [parsePreset(preset('a', 'd', boolean() + score(2)))];

  it('prefixes ids and applies weights', () => {
    const questions = activeQuestions(presets, { 'a.q': 3 });
    expect(questions.map(({ id, weight }) => [id, weight])).toEqual([
      ['a.q', 3],
      ['a.s', 1],
    ]);
  });

  it('drops weight 0', () => {
    expect(activeQuestions(presets, { 'a.q': 0 }).map(({ id }) => id)).toEqual(['a.s']);
  });
});
