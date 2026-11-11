import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, UserError } from '../src/config.ts';
import { fixersHash, isTrusted, trust, untrust } from '../src/trust.ts';

let home: string;
const FIXERS = [{ command: ['pnpm', 'biome', 'check', '--write'], files: ['**/*.ts'] }];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'jevlint-trust-'));
  vi.stubEnv('XDG_CONFIG_HOME', home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('trust', () => {
  it('approves exactly these commands for this root', async () => {
    expect(await isTrusted('/repo', FIXERS)).toBe(false);
    await trust('/repo', FIXERS);
    expect(await isTrusted('/repo', FIXERS)).toBe(true);
    expect(await isTrusted('/other', FIXERS)).toBe(false);
  });

  it.each([
    ['an argument', [{ ...FIXERS[0], command: ['pnpm', 'biome', 'check', '--unsafe'] }]],
    ['the files', [{ ...FIXERS[0], files: ['**/*'] }]],
    ['retry', [{ ...FIXERS[0], retry: true }]],
    ['another command', [...FIXERS, { command: ['ruff'] }]],
  ])('asks again when %s changes', async (_, changed) => {
    await trust('/repo', FIXERS);
    expect(await isTrusted('/repo', changed as typeof FIXERS)).toBe(false);
  });

  it('hashes an unset retry or files the same as their defaults', () => {
    expect(fixersHash([{ command: ['x'] }])).toBe(fixersHash([{ command: ['x'], retry: false }]));
  });

  it('keeps other roots when approving and revoking', async () => {
    await trust('/a', FIXERS);
    await trust('/b', FIXERS);
    expect(await untrust('/a')).toBe(true);
    expect(await untrust('/a')).toBe(false);
    expect(await isTrusted('/a', FIXERS)).toBe(false);
    expect(await isTrusted('/b', FIXERS)).toBe(true);
  });

  it('replaces a planted symlink rather than writing through it', async () => {
    const target = join(home, 'target');
    await writeFile(target, '{}');
    await mkdir(paths.configDir(), { recursive: true });
    await symlink(target, paths.trustFile());
    await trust('/repo', FIXERS);
    expect(await readFile(target, 'utf8')).toBe('{}');
    expect(await isTrusted('/repo', FIXERS)).toBe(true);
  });

  it('reports a broken record as something the user can fix', async () => {
    await mkdir(paths.configDir(), { recursive: true });
    await writeFile(paths.trustFile(), 'not json');
    await expect(isTrusted('/repo', FIXERS)).rejects.toThrow(UserError);
  });
});
