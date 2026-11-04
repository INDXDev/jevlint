/** `jevlint cache`: inspects and empties the result cache. */
import { defineCommand } from 'citty';
import { cacheInfo, clearCache } from '../cache.ts';
import { projectConfig } from './shared.ts';

const infoCommand = defineCommand({
  meta: { name: 'jevlint cache info', description: 'Show the location, entry count and size' },
  async run() {
    const { cache } = await projectConfig();
    const { dir, entries, bytes } = await cacheInfo(cache.dir);
    console.log(`Location  ${dir}\nEntries   ${entries}\nSize      ${bytes} bytes`);
    if (cache.remote) console.log(`Remote    ${cache.remote}`);
  },
});

const clearCommand = defineCommand({
  meta: { name: 'jevlint cache clear', description: 'Delete all cached decisions' },
  async run() {
    const { cache } = await projectConfig();
    console.log(`Deleted ${await clearCache(cache.dir)} cached decisions.`);
  },
});

/** The `cache` command group. */
export const cacheCommand = defineCommand({
  meta: { name: 'jevlint cache', description: 'Inspect or empty the result cache' },
  subCommands: { info: infoCommand, clear: clearCommand },
});
