/**
 * Which repositories' `quickfix.after` commands the user approved. The record lives in the user's
 * config directory, keyed by project root, with a hash of the exact command list.
 */
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type Fixer,
  ifExists,
  isTable,
  paths,
  readRegularFile,
  UserError,
  writeFileAtomic,
} from './config.ts';

/** Hashes everything about the commands that changes what runs or what reaches the agent. */
export function fixersHash(fixers: Fixer[]): string {
  const canonical = fixers.map(({ command, files, retry }) => ({
    command,
    files: files ?? null,
    retry: retry ?? false,
  }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

async function readRecord(): Promise<Record<string, string>> {
  const file = paths.trustFile();
  const text = await ifExists(readRegularFile(file));
  if (text === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isTable(parsed)) throw new Error('not an object');
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    throw new UserError(`${file} is not valid JSON. Delete it to approve commands again.`);
  }
}

async function writeRecord(record: Record<string, string>): Promise<void> {
  const file = paths.trustFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`, 0o600);
}

/** True when the user approved exactly these commands for this project root. */
export async function isTrusted(root: string, fixers: Fixer[]): Promise<boolean> {
  const record = await readRecord();
  return Object.hasOwn(record, root) && record[root] === fixersHash(fixers);
}

/** Records the user's approval of these commands for this project root. */
export async function trust(root: string, fixers: Fixer[]): Promise<void> {
  await writeRecord({ ...(await readRecord()), [root]: fixersHash(fixers) });
}

/** Forgets any approval for this project root. Returns whether there was one. */
export async function untrust(root: string): Promise<boolean> {
  const record = await readRecord();
  if (!Object.hasOwn(record, root)) return false;
  const { [root]: _, ...rest } = record;
  await writeRecord(rest);
  return true;
}
