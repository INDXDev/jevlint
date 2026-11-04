/** `jevlint preset`: lists, shows and installs principle presets. */
import { resolve } from 'node:path';
import { defineCommand } from 'citty';
import { UserError } from '../config.ts';
import { installPreset, listPresets, loadPresets, removePreset } from '../presets.ts';
import { withoutEscapes } from '../report.ts';
import type { Preset } from '../types.ts';
import { projectConfig } from './shared.ts';

function formatPreset({ name, description, questions, patterns, rules }: Preset): string {
  return [
    `${name}: ${description}`,
    '',
    ...questions.map(({ id, title }) => `  ${name}.${id}  ${title}`),
    ...[...patterns, ...rules].map(({ id, message }) => `  ${id}  ${message}`),
  ].join('\n');
}

const listCommand = defineCommand({
  meta: { name: 'jevlint preset list', description: 'Show available presets and their origin' },
  async run() {
    const { root } = await projectConfig();
    const presets = await listPresets(root);
    const width = Math.max(...presets.map(({ name }) => name.length));
    for (const { name, origin, description } of presets) {
      console.log(withoutEscapes(`${name.padEnd(width)}  ${origin.padEnd(8)}  ${description}`));
    }
  },
});

const showCommand = defineCommand({
  meta: { name: 'jevlint preset show', description: "Print a preset's questions" },
  args: { name: { type: 'positional', required: true, description: 'Preset name' } },
  async run({ args }) {
    const { root } = await projectConfig();
    const presets = await loadPresets([args.name], root);
    console.log(withoutEscapes(presets.map(formatPreset).join('\n\n')));
  },
});

const addCommand = defineCommand({
  meta: { name: 'jevlint preset add', description: 'Install a preset TOML for your user' },
  args: {
    file: { type: 'positional', required: true, description: 'Preset TOML file' },
    repo: { type: 'boolean', description: 'Install into .jevlint/presets/ instead' },
  },
  async run({ args }) {
    const { root } = await projectConfig();
    const installed = await installPreset(resolve(args.file), {
      repo: Boolean(args.repo),
      root,
    });
    console.error(`Installed ${installed}`);
  },
});

const removeCommand = defineCommand({
  meta: { name: 'jevlint preset remove', description: 'Remove an installed preset' },
  args: { name: { type: 'positional', required: true, description: 'Preset name' } },
  async run({ args }) {
    const { root } = await projectConfig();
    if (!(await removePreset(args.name, root))) {
      throw new UserError(`No installed preset named "${args.name}". Run: jevlint preset list`);
    }
    console.error(`Removed ${args.name}.`);
  },
});

/** The `preset` command group. */
export const presetCommand = defineCommand({
  meta: { name: 'jevlint preset', description: 'Manage principle presets' },
  subCommands: {
    list: listCommand,
    show: showCommand,
    add: addCommand,
    remove: removeCommand,
  },
});
