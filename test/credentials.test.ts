import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, UserError } from '../src/config.ts';
import {
  envKeysAllowed,
  getApiKey,
  KEY_ENV,
  keySource,
  removeApiKey,
  setApiKey,
  setEnvKeysAllowed,
} from '../src/credentials.ts';

let home: string;

const modeOf = async (path: string) => (await stat(path)).mode & 0o777;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'jevlint-credentials-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', join(home, 'config'));
  for (const variable of Object.values(KEY_ENV)) vi.stubEnv(variable, '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('credentials', () => {
  it('has no key by default', async () => {
    expect(await getApiKey('openai')).toBeUndefined();
    expect(await keySource('openai')).toBeNull();
  });

  it('stores keys with private modes and preserves other providers', async () => {
    await setApiKey('openai', 'one');
    await setApiKey('gateway', 'two');
    expect(await getApiKey('openai')).toBe('one');
    expect(await getApiKey('gateway')).toBe('two');
    expect(await keySource('openai')).toBe('file');
    expect(await modeOf(paths.credentialsFile())).toBe(0o600);
    expect(await modeOf(paths.configDir())).toBe(0o700);
    expect(await readdir(paths.configDir())).toEqual(['credentials.toml']);
  });

  it('tightens an existing directory and file', async () => {
    await mkdir(dirname(paths.credentialsFile()), { recursive: true });
    await chmod(paths.configDir(), 0o755);
    await writeFile(paths.credentialsFile(), 'openai = "old"\n', { mode: 0o644 });
    await setApiKey('openai', 'new');
    expect(await modeOf(paths.credentialsFile())).toBe(0o600);
    expect(await modeOf(paths.configDir())).toBe(0o700);
  });

  it('ignores the environment until allowed', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'from-env');
    expect(await envKeysAllowed()).toBeUndefined();
    expect(await getApiKey('openai')).toBeUndefined();
    expect(await keySource('openai')).toBeNull();
    await setEnvKeysAllowed(false);
    expect(await envKeysAllowed()).toBe(false);
    expect(await getApiKey('openai')).toBeUndefined();
  });

  it('prefers the environment once allowed', async () => {
    await setApiKey('openai', 'from-file');
    await setEnvKeysAllowed(true);
    vi.stubEnv('OPENAI_API_KEY', 'from-env');
    expect(await getApiKey('openai')).toBe('from-env');
    expect(await keySource('openai')).toBe('env');
  });

  it('removes only the named key', async () => {
    await setApiKey('openai', 'one');
    await setApiKey('gateway', 'two');
    expect(await removeApiKey('openai')).toBe(true);
    expect(await removeApiKey('openai')).toBe(false);
    expect(await getApiKey('gateway')).toBe('two');
    expect(await readFile(paths.credentialsFile(), 'utf8')).not.toContain('one');
  });

  it('does not echo a corrupt file', async () => {
    await mkdir(paths.configDir(), { recursive: true });
    await writeFile(paths.credentialsFile(), 'openai = "sk-hidden\n');
    const error = await getApiKey('openai').catch((caught) => caught);
    expect(error).toBeInstanceOf(UserError);
    expect(error.message).not.toContain('sk-hidden');
  });
});
