import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lineCountIn } from '../src/architecture/collect.ts';

let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jevlint-lines-'));
  outside = await mkdtemp(join(tmpdir(), 'jevlint-lines-out-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('lineCountIn', () => {
  it('counts the lines of a regular file inside the root', async () => {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/a.ts'), 'a\nb\nc');
    expect(lineCountIn(root)('src/a.ts')).toBe(3);
  });

  it('gives undefined for a missing file, a directory, a link outside, or a device', async () => {
    await mkdir(join(root, 'dir'));
    await writeFile(join(outside, 'secret.txt'), 'x\ny\n');
    await symlink(join(outside, 'secret.txt'), join(root, 'out.txt'));
    await symlink('/dev/zero', join(root, 'zero'));
    const count = lineCountIn(root);
    expect(count('missing.ts')).toBeUndefined();
    expect(count('dir')).toBeUndefined();
    expect(count('out.txt')).toBeUndefined();
    expect(count('zero')).toBeUndefined();
  });
});
