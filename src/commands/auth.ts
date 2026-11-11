/** `jevlint auth`: manages stored API keys. */
import { text } from 'node:stream/consumers';
import { confirm, password } from '@clack/prompts';
import { defineCommand } from 'citty';
import { UserError } from '../config.ts';
import {
  envKeysAllowed,
  KEY_ENV,
  keySource,
  removeApiKey,
  setApiKey,
  setEnvKeysAllowed,
} from '../credentials.ts';
import type { ProviderName } from '../types.ts';
import { answered, PROMPT_IO } from './shared.ts';

const PROVIDERS = Object.keys(KEY_ENV) as ProviderName[];
const PROVIDER_ARG = {
  provider: { type: 'positional', required: true, description: `One of: ${PROVIDERS.join(', ')}` },
} as const;

function parseProvider(name: string): ProviderName {
  const provider = PROVIDERS.find((known) => known === name);
  if (provider) return provider;
  throw new UserError(`Unknown provider "${name}". Available: ${PROVIDERS.join(', ')}`);
}

async function readKey(provider: ProviderName): Promise<string> {
  const key = process.stdin.isTTY
    ? answered(await password({ message: `API key for ${provider}`, ...PROMPT_IO }))
    : await text(process.stdin);
  return key.trim();
}

async function describeSource(provider: ProviderName): Promise<string> {
  const source = await keySource(provider);
  if (source === 'env') return `environment (${KEY_ENV[provider]})`;
  return source === 'file' ? 'credentials file' : 'not set';
}

const setCommand = defineCommand({
  meta: { name: 'jevlint auth set', description: 'Store a key. Pipe it in for scripts' },
  args: PROVIDER_ARG,
  async run({ args }) {
    const provider = parseProvider(args.provider);
    const key = await readKey(provider);
    if (!key) throw new UserError('No key given, so nothing was stored.');
    await setApiKey(provider, key);
    console.error(`Stored a key for ${provider}.`);
  },
});

const listCommand = defineCommand({
  meta: { name: 'jevlint auth list', description: 'Show where each provider key comes from' },
  async run() {
    const width = Math.max(...PROVIDERS.map((provider) => provider.length));
    for (const provider of PROVIDERS) {
      console.log(`${provider.padEnd(width)}  ${await describeSource(provider)}`);
    }
  },
});

const removeCommand = defineCommand({
  meta: { name: 'jevlint auth remove', description: 'Delete a stored key' },
  args: PROVIDER_ARG,
  async run({ args }) {
    const provider = parseProvider(args.provider);
    const removed = await removeApiKey(provider);
    console.error(removed ? `Removed the key for ${provider}.` : `No stored key for ${provider}.`);
  },
});

const envCommand = defineCommand({
  meta: { name: 'jevlint auth env', description: 'Allow or refuse keys from the environment' },
  args: { state: { type: 'positional', required: true, description: 'on or off' } },
  async run({ args }) {
    if (args.state !== 'on' && args.state !== 'off') {
      throw new UserError(`Expected on or off, got "${args.state}".`);
    }
    await setEnvKeysAllowed(args.state === 'on');
    console.error(`Environment keys are ${args.state}.`);
  },
});

const KEY_COMMANDS = [
  'audit',
  'architecture review',
  'architecture check',
  'architecture drift',
  'baseline',
  'commits',
  'explain',
  'fix',
  'quickfix',
  'pr',
  'prompt',
  'spec check',
  'spec drift',
  'test',
].map((name) => `jevlint ${name}`);

/** Whether a command would use a provider key, so that only those stop to ask about one. */
export const usesProviderKey = (name: string, args: string[]) =>
  KEY_COMMANDS.includes(name) && !args.includes('--ast-only') && !args.includes('--static');

/** Asks once, on the first interactive run that finds a key in the environment. */
export async function askAboutEnvKeys(): Promise<void> {
  const found = Object.values(KEY_ENV).filter((variable) => process.env[variable]);
  if (!process.stdin.isTTY || found.length === 0) return;
  if ((await envKeysAllowed()) !== undefined) return;
  const message = `Found ${found.join(', ')} in your environment. Let jevlint use it?`;
  const allowed = answered(await confirm({ message, initialValue: false, ...PROMPT_IO }));
  await setEnvKeysAllowed(allowed);
}

/** The `auth` command group. */
export const authCommand = defineCommand({
  meta: { name: 'jevlint auth', description: 'Manage API keys' },
  subCommands: { set: setCommand, list: listCommand, remove: removeCommand, env: envCommand },
});
