import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadConfig,
  paths,
  renderConfigToml,
  saveDefaultPresets,
  UserError,
  withPresets,
} from '../src/config.ts';

let home: string;
let repo: string;

const writeUser = async (toml: string) => {
  await mkdir(paths.configDir(), { recursive: true });
  await writeFile(paths.configFile(), toml);
};
const writeRepo = (toml: string) => writeFile(join(repo, 'jevlint.toml'), toml);

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'jevlint-config-'));
  repo = join(home, 'repo');
  await mkdir(repo);
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', join(home, 'config'));
  vi.stubEnv('XDG_CACHE_HOME', join(home, 'cache'));
  vi.stubEnv('JEVLINT_CACHE_DIR', '');
  vi.stubEnv('JEVLINT_BASE_URL', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('defaults', () => {
  it('works with no config and includes the documented agents', async () => {
    const config = await loadConfig({ cwd: repo });
    expect(config.sources).toEqual([]);
    expect(config.presets).toEqual(['full']);
    expect(config.cache.dir).toBe(join(home, 'cache', 'jevlint'));
    expect(config.agents.claude?.command[0]).toBe('claude');
    expect(config.agents.codex?.command).toContain('workspace-write');
  });
});

describe('layering', () => {
  it('applies defaults < user < repo < overrides, merging tables by key', async () => {
    await writeUser('[scoring]\nscale = 10\nprecision = 1\nfail_under = 1\n');
    await writeRepo('[scoring]\nprecision = 2\nfail_under = 2\n');
    const config = await loadConfig({ cwd: repo, overrides: { scoring: { fail_under: 3 } } });
    expect(config.scoring).toMatchObject({ scale: 10, precision: 2, fail_under: 3 });
    expect(config.scoring.ast_weight).toBe(0.4);
    expect(config.sources).toEqual([paths.configFile(), join(repo, 'jevlint.toml')]);
  });

  it('replaces arrays', async () => {
    await writeUser('presets = ["solid", "clean-code"]\n');
    await writeRepo('presets = ["kiss-dry-yagni"]\n');
    expect((await loadConfig({ cwd: repo })).presets).toEqual(['kiss-dry-yagni']);
  });

  it('ignores undefined overrides', async () => {
    await writeRepo('concurrency = 2\n');
    const config = await loadConfig({ cwd: repo, overrides: { concurrency: undefined } });
    expect(config.concurrency).toBe(2);
  });
});

describe('environment', () => {
  it('lets env override user config', async () => {
    await writeUser('[provider]\nbase_url = "https://a.example"\n[cache]\ndir = "/from-config"\n');
    vi.stubEnv('JEVLINT_BASE_URL', 'https://b.example');
    vi.stubEnv('JEVLINT_CACHE_DIR', '/from-env');
    const config = await loadConfig({ cwd: repo });
    expect(config.provider.base_url).toBe('https://b.example');
    expect(config.cache.dir).toBe('/from-env');
  });

  it('reads the cache bucket from user config, and lets env override it', async () => {
    await writeUser(
      '[cache]\nremote = "s3://mine/ci"\nendpoint = "https://r2.example"\nregion = "auto"\n',
    );
    expect((await loadConfig({ cwd: repo })).cache).toMatchObject({
      remote: 's3://mine/ci',
      endpoint: 'https://r2.example',
      region: 'auto',
    });
    vi.stubEnv('JEVLINT_CACHE_REMOTE', 's3://other');
    vi.stubEnv('JEVLINT_CACHE_ENDPOINT', 'https://minio.example');
    vi.stubEnv('JEVLINT_CACHE_REGION', 'eu');
    expect((await loadConfig({ cwd: repo })).cache).toMatchObject({
      remote: 's3://other',
      endpoint: 'https://minio.example',
      region: 'eu',
    });
  });

  it('falls back to AWS_REGION for the cache bucket', async () => {
    vi.stubEnv('AWS_REGION', 'ap-northeast-1');
    expect((await loadConfig({ cwd: repo })).cache.region).toBe('ap-northeast-1');
  });

  it('rejects a cache.remote that is not an s3:// location', async () => {
    await writeUser('[cache]\nremote = "https://bucket.example/x"\n');
    await expect(loadConfig({ cwd: repo })).rejects.toThrow('s3://bucket');
  });

  it('expands a leading ~ in cache.dir', async () => {
    await writeUser('[cache]\ndir = "~/somewhere"\n');
    expect((await loadConfig({ cwd: repo })).cache.dir).toBe(join(home, 'somewhere'));
  });
});

describe('validation', () => {
  it('names the file and key path of an unknown key', async () => {
    await writeRepo('[scoring]\nscael = 1\n');
    const load = loadConfig({ cwd: repo });
    await expect(load).rejects.toThrow(UserError);
    await expect(load).rejects.toThrow(/jevlint\.toml: scoring\.scael: unknown key/);
  });

  it.each([
    ['top level', 'api_key = "sk-hidden"\n'],
    ['provider table', '[provider]\napi_key = "sk-hidden"\n'],
    ['array of tables', '[[patterns]]\napi_key = "sk-hidden"\n'],
  ])('rejects api_key at %s without echoing it', async (_where, toml) => {
    await writeUser(toml);
    const error = await loadConfig({ cwd: repo }).catch((caught) => caught);
    expect(error).toBeInstanceOf(UserError);
    expect(error.message).toMatch(/API keys do not belong/);
    expect(error.message).not.toContain('sk-hidden');
  });

  it('rejects a precision that Number.prototype.toFixed cannot use', async () => {
    await writeRepo('[scoring]\nprecision = 101\n');
    await expect(loadConfig({ cwd: repo })).rejects.toThrow(/scoring\.precision/);
  });

  it('rejects weights that leave nothing to blend, which would make every file perfect', async () => {
    await writeRepo('[scoring]\nast_weight = 0\nmodel_weight = 0\n');
    await expect(loadConfig({ cwd: repo })).rejects.toThrow(UserError);
  });

  it('accepts one engine at weight 0', async () => {
    await writeRepo('[scoring]\nast_weight = 0\n');
    expect((await loadConfig({ cwd: repo })).scoring.ast_weight).toBe(0);
  });

  it('does not echo the source line of a TOML syntax error', async () => {
    await writeUser('api_key = "sk-hidden\n');
    const error = await loadConfig({ cwd: repo }).catch((caught) => caught);
    expect(error).toBeInstanceOf(UserError);
    expect(error.message).toContain('invalid TOML at line 1');
    expect(error.message).not.toContain('sk-hidden');
  });
});

describe('semantic rules', () => {
  const rule = (extra = '') =>
    `[[rules]]\nid = "r"\nlanguage = "typescript"\npattern = "a()"\nquestion = "Q?"\nmessage = "M"\nfix = "F"\n${extra}\n`;

  it('default to none, at 20 matches per rule', async () => {
    expect(await loadConfig({ cwd: repo })).toMatchObject({ rules: [], max_rule_matches: 20 });
  });

  it('read from jevlint.toml, with a default threshold', async () => {
    await writeRepo(rule());
    expect((await loadConfig({ cwd: repo })).rules[0]).toMatchObject({ id: 'r', threshold: 0.8 });
  });

  it('take max_rule_matches from the user config', async () => {
    await writeUser('max_rule_matches = 5\n');
    expect((await loadConfig({ cwd: repo })).max_rule_matches).toBe(5);
  });

  it.each([
    ['a threshold above 1', rule('threshold = 1.5'), 'rules.0.threshold'],
    ['a duplicate id', rule() + rule(), 'Rule ids must be unique'],
    ['a built-in finding id', rule().replace('"r"', '"nesting"'), 'built-in finding'],
    ['a missing question', rule().replace('question = "Q?"\n', ''), 'rules.0.question'],
  ])('refuse %s', async (_, toml, problem) => {
    await writeRepo(toml);
    await expect(loadConfig({ cwd: repo })).rejects.toThrow(problem);
  });

  it('refuse a max_rule_matches of 0', async () => {
    await writeUser('max_rule_matches = 0\n');
    await expect(loadConfig({ cwd: repo })).rejects.toThrow('max_rule_matches');
  });
});

describe('repository restrictions', () => {
  it.each([
    ['provider.base_url', '[provider]\nbase_url = "https://evil.example"\n'],
    ['provider.base_url', 'provider = { base_url = "https://evil.example" }\n'],
    ['agents', '[agents.claude]\ncommand = ["sh", "-c", "evil"]\n'],
    ['agents', 'agents = "not even a table"\n'],
    ['cache', '[cache]\ndir = "/home/me"\n'],
    ['cache', '[cache]\nremote = "s3://attacker"\n'],
    ['cache', '[cache]\nendpoint = "https://evil.example"\n'],
    ['max_rule_matches', 'max_rule_matches = 1000000\n'],
  ])('refuses %s in jevlint.toml', async (key, toml) => {
    await writeRepo(toml);
    const load = loadConfig({ cwd: repo });
    await expect(load).rejects.toThrow(UserError);
    await expect(load).rejects.toThrow(`${key} is only allowed in user config`);
  });

  it('keeps the user base_url from a provider the repository switched to', async () => {
    await writeUser('[provider]\nname = "compatible"\nbase_url = "https://mine.example"\n');
    await writeRepo('[provider]\nname = "microsoft"\n');
    expect((await loadConfig({ cwd: repo })).provider.base_url).toBeUndefined();
  });

  it('keeps the user base_url when the repository names the same provider', async () => {
    await writeUser('[provider]\nname = "compatible"\nbase_url = "https://mine.example"\n');
    await writeRepo('[provider]\nname = "compatible"\n');
    expect((await loadConfig({ cwd: repo })).provider.base_url).toBe('https://mine.example');
  });

  it('allows the same keys in user config', async () => {
    await writeUser(
      '[provider]\nbase_url = "https://ok.example"\n[agents.mine]\ncommand = ["x"]\n[cache]\ndir = "/c"\n',
    );
    const config = await loadConfig({ cwd: repo });
    expect(config.provider.base_url).toBe('https://ok.example');
    expect(config.agents.mine?.command).toEqual(['x']);
    expect(config.agents.claude).toBeDefined();
  });
});

describe('root discovery', () => {
  it('prefers the nearest jevlint.toml over the git root', async () => {
    const pkg = join(repo, 'packages', 'a');
    const deep = join(pkg, 'src');
    await mkdir(join(repo, '.git'));
    await mkdir(deep, { recursive: true });
    await writeFile(join(pkg, 'jevlint.toml'), '');
    expect((await loadConfig({ cwd: deep })).root).toBe(pkg);
  });

  it('falls back to the git root', async () => {
    const deep = join(repo, 'src');
    await mkdir(join(repo, '.git'));
    await mkdir(deep);
    expect((await loadConfig({ cwd: deep })).root).toBe(repo);
  });

  it('falls back to the current directory', async () => {
    expect((await loadConfig({ cwd: repo })).root).toBe(repo);
  });
});

describe('renderConfigToml', () => {
  it('round-trips settings and omits root and sources', async () => {
    const config = await loadConfig({ cwd: repo });
    const rendered = parse(renderConfigToml(config));
    expect(rendered.concurrency).toBe(8);
    expect(rendered).not.toHaveProperty('root');
    expect(rendered).not.toHaveProperty('sources');
  });
});

describe('withPresets', () => {
  const set = (toml: string) => withPresets(toml, ['security', 'solid'], 'c.toml');

  it('replaces the existing key, keeping comments and tables', () => {
    const toml = '# top\npresets = ["readable-code"] # why\n\n[scoring]\nscale = 10\n';
    expect(set(toml)).toBe('# top\npresets = ["security","solid"]\n\n[scoring]\nscale = 10\n');
  });

  it('replaces a key that spans lines', () => {
    const toml = 'presets = [\n  "a",\n  "b",\n]\nconcurrency = 2\n';
    expect(set(toml)).toBe('presets = ["security","solid"]\nconcurrency = 2\n');
  });

  it('adds the key before the first table, where top-level keys belong', () => {
    const result = set('# top\nconcurrency = 2\n[provider]\nname = "openai"\n');
    expect(result).toBe(
      '# top\nconcurrency = 2\npresets = ["security","solid"]\n\n[provider]\nname = "openai"\n',
    );
    expect(parse(result)).toMatchObject({ presets: ['security', 'solid'], concurrency: 2 });
  });

  it('writes an empty or missing file', () => {
    expect(set('')).toBe('presets = ["security","solid"]\n');
  });

  it('ignores a commented-out key and a presets key inside a table', () => {
    const result = set('# presets = ["x"]\n[weights]\npresets = 1\n');
    expect(parse(result)).toMatchObject({
      presets: ['security', 'solid'],
      weights: { presets: 1 },
    });
  });

  it('refuses invalid TOML rather than guess', () => {
    expect(() => set('presets = [')).toThrow(UserError);
  });
});

describe('saveDefaultPresets', () => {
  it('writes the user config, or jevlint.toml with repo, and both load', async () => {
    await saveDefaultPresets(['solid'], { repo: false, root: repo });
    expect((await loadConfig({ cwd: repo })).presets).toEqual(['solid']);
    await saveDefaultPresets(['security'], { repo: true, root: repo });
    expect((await loadConfig({ cwd: repo })).presets).toEqual(['security']);
  });
});
