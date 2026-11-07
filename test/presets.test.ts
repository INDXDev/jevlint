import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { patternMatches } from '../src/ast/analyze.ts';
import { paths, UserError } from '../src/config.ts';
import {
  activeQuestions,
  closestName,
  createPreset,
  editablePreset,
  installPreset,
  listPresets,
  loadPresets,
  parsePreset,
  presetsInArgs,
  removePreset,
} from '../src/presets.ts';
import type { Preset } from '../src/types.ts';

/** For each `bug-hunt` pattern, code it must flag and code it must leave alone. */
const BUG_HUNT_SAMPLES: Record<string, [bad: string, good: string]> = {
  '$A.forEach(async ($$$P) => { $$$B })': [
    'xs.forEach(async (x) => { await f(x); });',
    'for (const x of xs) await f(x);',
  ],
  '$A.forEach(async function ($$$P) { $$$B })': [
    'xs.forEach(async function (x) { await f(x); });',
    'xs.forEach(function (x) { f(x); });',
  ],
  'new Promise(async ($$$P) => { $$$B })': [
    'new Promise(async (resolve) => { resolve(await f()); });',
    'new Promise((resolve) => { resolve(1); });',
  ],
  'try { $$$A } catch ($E) { }': ['try { f(); } catch (e) { }', 'try { f(); } catch (e) { g(e); }'],
  'try { $$$A } catch { }': ['try { f(); } catch { }', 'try { f(); } catch { g(); }'],
  '$A === NaN': ['if (x === NaN) y();', 'if (Number.isNaN(x)) y();'],
  '$A !== NaN': ['if (x !== NaN) y();', 'if (x !== 1) y();'],
  '$A === $A': ['if (a.b === a.b) y();', 'if (a.b === a.c) y();'],
  'if ($A = $B) { $$$C }': ['if (x = 1) { y(); }', 'if (x === 1) { y(); }'],
  'def $F($$$A, $P=[], $$$B): $$$C': [
    'def f(a, b=[], c=1):\n    pass\n',
    'def f(a, c=1):\n    pass\n',
  ],
  'def $F($$$A, $P=[]): $$$C': ['def f(b=[]):\n    pass\n', 'def f(b=None):\n    pass\n'],
  'def $F($$$A, $P={}, $$$B): $$$C': [
    'def f(a, b={}, c=1):\n    pass\n',
    'def f(a, c=1):\n    pass\n',
  ],
  'def $F($$$A, $P={}): $$$C': ['def f(a, b={}):\n    pass\n', 'def f(a, b=None):\n    pass\n'],
  'try:\n    $$$A\nexcept:\n    $$$B': [
    'try:\n    f()\nexcept:\n    g()\n',
    'try:\n    f()\nexcept ValueError:\n    g()\n',
  ],
  'try:\n    $$$A\nexcept $E:\n    pass': [
    'try:\n    f()\nexcept ValueError as e:\n    pass\n',
    'try:\n    f()\nexcept ValueError:\n    g()\n',
  ],
  'open($$$A).read()': ['x = open(p).read()\n', 'with open(p) as f:\n    x = f.read()\n'],
  'datetime.utcnow()': ['x = datetime.utcnow()\n', 'x = datetime.now(timezone.utc)\n'],
  '$A == $A': ['a.b == a.b', 'a.b == a.c'],
  'assert ($A, $B)': ['assert (x, "m")\n', 'assert x, "m"\n'],
  '$V, _ := $F($$$A)': [
    'package a\nfunc f() { v, _ := g(1); h(v) }\n',
    'package a\nfunc f() { v, err := g(1); h(v, err) }\n',
  ],
  '_ = $F($$$A)': [
    'package a\nfunc f() { _ = g(1) }\n',
    'package a\nfunc f() { x := g(1); h(x) }\n',
  ],
  '$A.unwrap()': ['fn f() { let a = g().unwrap(); }', 'fn f() { let a = g()?; }'],
  'todo!($$$A)': ['fn f() { todo!(); }', 'fn f() { g(); }'],
  'unimplemented!($$$A)': ['fn f() { unimplemented!(); }', 'fn f() { g(); }'],
};

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

  it('suggests the preset a typo most likely meant', async () => {
    await expect(loadPresets(['secruity'], root)).rejects.toThrow(
      'Unknown preset "secruity". Did you mean "security"?',
    );
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

  it('keeps bug-hunt within what every provider can ask in one request', async () => {
    const [bugHunt] = await loadPresets(['bug-hunt'], root);
    expect(bugHunt?.questions.length).toBeGreaterThanOrEqual(30);
    expect(bugHunt?.questions.length).toBeLessThanOrEqual(64);
  });

  it('flags the bad sample of every bug-hunt pattern, and not the good one', async () => {
    const [bugHunt] = await loadPresets(['bug-hunt'], root);
    for (const pattern of bugHunt?.patterns ?? []) {
      const [bad, good] = BUG_HUNT_SAMPLES[pattern.pattern] ?? [];
      // Go needs a file around the expression, and the shape differs per language.
      const wrap = (code = '') =>
        pattern.pattern !== '$A == $A' || pattern.language === 'python'
          ? code
          : pattern.language === 'go'
            ? `package a\nfunc f() bool { return ${code} }\n`
            : `fn f() -> bool { ${code} }`;
      const count = (code: string) =>
        patternMatches(wrap(code), pattern.language, [pattern])[0]?.matches.length;
      expect(bad, pattern.id).toBeDefined();
      expect(count(bad ?? ''), `${pattern.id} on bad`).toBe(1);
      expect(count(good ?? ''), `${pattern.id} on good`).toBe(0);
    }
  });

  it('refuses to overwrite a file that holds a differently named preset', async () => {
    await writePreset(paths.presetsDir(), 'foo', preset('bar', 'precious'));
    const file = join(paths.presetsDir(), 'foo.toml');
    await expect(createPreset('foo', { repo: false, root })).rejects.toThrow(
      'holds the preset "bar"',
    );
    expect(await readFile(file, 'utf8')).toContain('precious');
  });

  it('still replaces a preset of the same name when adding it again', async () => {
    await writePreset(paths.presetsDir(), 'house', preset('house', 'old'));
    const update = join(home, 'update.toml');
    await writeFile(update, preset('house', 'new'));
    await installPreset(update, { repo: false, root });
    const [loaded] = await loadPresets(['house'], root);
    expect(loaded?.description).toBe('new');
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

describe('createPreset', () => {
  it('writes a valid blank preset to the user directory, or the repository with repo', async () => {
    const user = await createPreset('house', { repo: false, root });
    expect(user).toBe(join(paths.presetsDir(), 'house.toml'));
    expect(parsePreset(await readFile(user, 'utf8')).name).toBe('house');
    const repo = await createPreset('team', { repo: true, root });
    expect(repo).toBe(join(repoDir(), 'team.toml'));
  });

  it('copies another preset under the new name, keeping its comments', async () => {
    await writePreset(paths.presetsDir(), 'base', `# kept\n${preset('base', 'from base')}`);
    const path = await createPreset('derived', { repo: false, root, from: 'base' });
    const toml = await readFile(path, 'utf8');
    expect(toml).toContain('# kept');
    expect(parsePreset(toml)).toMatchObject({ name: 'derived', description: 'from base' });
  });

  it('copies a built-in', async () => {
    const path = await createPreset('my-security', { repo: false, root, from: 'security' });
    expect(parsePreset(await readFile(path, 'utf8')).name).toBe('my-security');
  });

  it('refuses a name a user or repository preset already has', async () => {
    await writePreset(repoDir(), 'house', preset('house'));
    await expect(createPreset('house', { repo: false, root })).rejects.toThrow(/preset edit house/);
  });

  it('refuses a name that is not a safe file name', async () => {
    await expect(createPreset('../evil', { repo: false, root })).rejects.toThrow(UserError);
    await expect(readdir(home)).resolves.not.toContain('evil.toml');
  });

  it('refuses an unknown base', async () => {
    const create = createPreset('x', { repo: false, root, from: 'nope' });
    await expect(create).rejects.toThrow(/Unknown preset "nope"/);
  });
});

describe('editablePreset', () => {
  it('copies a built-in, which then overrides it', async () => {
    const { path, copied } = await editablePreset('solid', { repo: false, root });
    expect(copied).toBe(true);
    expect(path).toBe(join(paths.presetsDir(), 'solid.toml'));
    expect((await listPresets(root)).find(({ name }) => name === 'solid')?.origin).toBe('user');
  });

  it('returns an installed preset where it is', async () => {
    await writePreset(repoDir(), 'house', preset('house'));
    const edited = await editablePreset('house', { repo: false, root });
    expect(edited).toEqual({ path: join(repoDir(), 'house.toml'), copied: false });
  });

  it('refuses an unknown name', async () => {
    await expect(editablePreset('nope', { repo: false, root })).rejects.toThrow(/Unknown preset/);
  });
});

describe('presetsInArgs', () => {
  it('picks out preset names and leaves everything else as paths', async () => {
    await mkdir(join(root, 'src'));
    const split = await presetsInArgs(['security', 'src', 'missing.ts', 'solid'], {
      root,
      cwd: root,
    });
    expect(split).toEqual({
      presets: ['security', 'solid'],
      paths: ['src', 'missing.ts'],
      shadowed: [],
      typos: {},
    });
  });

  it('keeps an existing path a path, from the current directory or the root', async () => {
    await mkdir(join(root, 'solid'));
    await mkdir(join(root, 'sub', 'security'), { recursive: true });
    const split = await presetsInArgs(['solid', 'security'], { root, cwd: join(root, 'sub') });
    expect(split).toEqual({
      presets: [],
      paths: ['solid', 'security'],
      shadowed: ['solid', 'security'],
      typos: {},
    });
  });

  it('notes the preset a missing path most likely meant', async () => {
    const split = await presetsInArgs(['secruity', 'src'], { root, cwd: root });
    expect(split).toMatchObject({ paths: ['secruity', 'src'], typos: { secruity: 'security' } });
  });
});

describe('closestName', () => {
  const names = ['security', 'solid', 'clean-code', 'clean-architecture'];

  it.each([
    ['secruity', 'security'],
    ['solidd', 'solid'],
    ['clean-cod', 'clean-code'],
    ['sec', 'security'],
  ])('suggests %s -> %s', (typo, expected) => {
    expect(closestName(typo, names)).toBe(expected);
  });

  it.each(['src', 'lib', 's', 'something-else'])('suggests nothing for %s', (name) => {
    expect(closestName(name, names)).toBeUndefined();
  });
});

describe('used_by', () => {
  it('defaults to audit, and marks the presets other commands use', async () => {
    expect(parsePreset(preset('house')).used_by).toBe('audit');
    const listed = await listPresets(root);
    const use = (name: string) => listed.find((entry) => entry.name === name)?.used_by;
    expect([use('security'), use('architecture-class'), use('change-intent')]).toEqual([
      'audit',
      'architecture',
      'intent',
    ]);
  });

  it('refuses an unknown command', () => {
    const toml = preset('house').replace('source = "s"', 'source = "s"\nused_by = "lint"');
    expect(() => parsePreset(toml)).toThrow(/used_by/);
  });
});
