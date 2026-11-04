/** Reads and writes API keys: the user's credentials file, and the environment if they allow it. */
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { stringify } from 'smol-toml';
import { z } from 'zod';
import { ifExists, parseToml, parseWith, paths, writeFileAtomic } from './config.ts';
import type { ProviderName } from './types.ts';

/** The environment variable holding each provider's key. */
export const KEY_ENV: Record<ProviderName, string> = {
  typesafe: 'TYPESAFE_AI_API_KEY',
  openai: 'OPENAI_API_KEY',
  gateway: 'AI_GATEWAY_API_KEY',
  cloudflare: 'CLOUDFLARE_API_TOKEN',
  microsoft: 'AZURE_API_KEY',
  compatible: 'JEVLINT_API_KEY',
};

/** Lives beside the keys, in a user-only file, so a repository config cannot turn it on. */
const USE_ENV = 'use_env';

const keysSchema = z.record(z.string(), z.string());

async function readKeys(): Promise<Record<string, string>> {
  const file = paths.credentialsFile();
  const text = await ifExists(readFile(file, 'utf8'));
  return text === undefined ? {} : parseWith(keysSchema, parseToml(text, file), file);
}

async function writeKeys(keys: Record<string, string>): Promise<void> {
  const file = paths.credentialsFile();
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir leaves the mode of an existing directory alone.
  await chmod(dir, 0o700);
  await writeFileAtomic(file, stringify(keys), 0o600);
}

const envKey = (keys: Record<string, string>, provider: ProviderName) =>
  keys[USE_ENV] === 'yes' ? process.env[KEY_ENV[provider]] : undefined;

/** Returns the key for a provider, if one is set. */
export async function getApiKey(provider: ProviderName): Promise<string | undefined> {
  const keys = await readKeys();
  return envKey(keys, provider) || keys[provider];
}

/** Says where a provider's key comes from, without exposing it. */
export async function keySource(provider: ProviderName): Promise<'env' | 'file' | null> {
  const keys = await readKeys();
  if (envKey(keys, provider)) return 'env';
  return keys[provider] ? 'file' : null;
}

/** Says whether the user allowed keys from the environment, or `undefined` if never asked. */
export async function envKeysAllowed(): Promise<boolean | undefined> {
  const choice = (await readKeys())[USE_ENV];
  return choice === undefined ? undefined : choice === 'yes';
}

/** Records whether keys may come from the environment. */
export async function setEnvKeysAllowed(allowed: boolean): Promise<void> {
  await writeKeys({ ...(await readKeys()), [USE_ENV]: allowed ? 'yes' : 'no' });
}

/** Stores a key, keeping those of other providers. */
export async function setApiKey(provider: ProviderName, key: string): Promise<void> {
  await writeKeys({ ...(await readKeys()), [provider]: key });
}

/** Deletes a stored key, returning whether there was one. */
export async function removeApiKey(provider: ProviderName): Promise<boolean> {
  const { [provider]: removed, ...others } = await readKeys();
  if (removed === undefined) return false;
  await writeKeys(others);
  return true;
}
