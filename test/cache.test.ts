import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cacheInfo, cacheKey, clearCache, readCache, writeCache } from '../src/cache.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jevlint-cache-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('cacheKey', () => {
  it('ignores object key order at any depth', () => {
    expect(cacheKey({ a: 1, b: { c: 2, d: [{ e: 3, f: 4 }] } })).toBe(
      cacheKey({ b: { d: [{ f: 4, e: 3 }], c: 2 }, a: 1 }),
    );
  });

  it('depends on values and array order', () => {
    expect(cacheKey({ a: 1 })).not.toBe(cacheKey({ a: 2 }));
    expect(cacheKey([1, 2])).not.toBe(cacheKey([2, 1]));
  });

  it('is a sha256 hex digest', () => {
    expect(cacheKey('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('entries', () => {
  const key = cacheKey('entry');
  const file = () => join(dir, 'decisions', key.slice(0, 2), `${key}.json`);

  it('round-trips under decisions/ab/<key>.json with no temp files left', async () => {
    await writeCache(dir, key, { value: 1 });
    expect(await readCache(dir, key)).toEqual({ value: 1 });
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({ value: 1 });
    expect(await readdir(dirname(file()))).toEqual([`${key}.json`]);
  });

  it('treats missing and corrupt entries as misses', async () => {
    expect(await readCache(dir, key)).toBeUndefined();
    await mkdir(dirname(file()), { recursive: true });
    await writeFile(file(), '{not json');
    expect(await readCache(dir, key)).toBeUndefined();
  });
});

describe('cacheInfo and clearCache', () => {
  it('reports an empty or missing cache', async () => {
    const missing = join(dir, 'missing');
    expect(await cacheInfo(missing)).toEqual({ dir: missing, entries: 0, bytes: 0 });
    expect(await clearCache(missing)).toBe(0);
  });

  it('counts entries and size', async () => {
    await writeCache(dir, cacheKey(1), [1]);
    await writeCache(dir, cacheKey(2), [2, 2]);
    expect(await cacheInfo(dir)).toEqual({ dir, entries: 2, bytes: 8 });
  });

  it('deletes only the decisions directory', async () => {
    await writeCache(dir, cacheKey(1), 1);
    await writeFile(join(dir, 'precious.txt'), 'keep');
    expect(await clearCache(dir)).toBe(1);
    expect(await readdir(dir)).toEqual(['precious.txt']);
  });
});
