/** `jevlint config`: shows the merged config and where it came from. */
import { defineCommand } from 'citty';
import { renderConfigToml } from '../config.ts';
import { withoutEscapes } from '../report.ts';
import { projectConfig } from './shared.ts';

const showCommand = defineCommand({
  meta: { name: 'jevlint config show', description: 'Print the merged config as TOML' },
  async run() {
    console.log(withoutEscapes(renderConfigToml(await projectConfig())));
  },
});

const pathCommand = defineCommand({
  meta: { name: 'jevlint config path', description: 'Print the config files in use, in order' },
  async run() {
    const { sources } = await projectConfig();
    if (sources.length === 0) console.error('No config files found, so defaults apply.');
    for (const source of sources) console.log(source);
  },
});

/** The `config` command group. */
export const configCommand = defineCommand({
  meta: { name: 'jevlint config', description: 'Show the merged config and where it came from' },
  subCommands: { show: showCommand, path: pathCommand },
});
