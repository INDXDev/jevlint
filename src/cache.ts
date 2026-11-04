/** Content-addressed storage of decisions on disk. */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ifExists, isTable, writeFileAtomic } from './config.ts';

const decisionsDir = (dir: string) => join(dir, 'decisions');

/** An entry's path relative to the cache root, the same on disk and in a bucket. */
export const entryName = (key: string) => `decisions/${key.slice(0, 2)}/${key}.json`;

const entryPath = (dir: string, key: string) => join(dir, entryName(key));

const sortKeys = (_key: string, value: unknown) =>
  isTable(value)
    ? Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, value[key]]),
      )
    : value;

async function entryFiles(dir: string): Promise<string[]> {
  const names = (await ifExists(readdir(decisionsDir(dir), { recursive: true }))) ?? [];
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(decisionsDir(dir), name));
}

/** Hashes any JSON value, ignoring the order of object keys. */
export function cacheKey(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts, sortKeys)).digest('hex');
}

/** Reads an entry. A missing or corrupt entry is a cache miss. */
export async function readCache<T>(dir: string, key: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(entryPath(dir, key), 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Stores an entry atomically, so a crash cannot leave a partial one. */
export async function writeCache(dir: string, key: string, value: unknown): Promise<void> {
  const file = entryPath(dir, key);
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, JSON.stringify(value));
}

/** Reports the cache's location, entry count and size. */
export async function cacheInfo(
  dir: string,
): Promise<{ dir: string; entries: number; bytes: number }> {
  const files = await entryFiles(dir);
  const sizes = await Promise.all(files.map(async (file) => (await stat(file)).size));
  return { dir, entries: files.length, bytes: sizes.reduce((sum, size) => sum + size, 0) };
}

/** Deletes stored decisions and nothing else in `dir`, returning how many there were. */
export async function clearCache(dir: string): Promise<number> {
  const { length } = await entryFiles(dir);
  await rm(decisionsDir(dir), { recursive: true, force: true });
  return length;
}
