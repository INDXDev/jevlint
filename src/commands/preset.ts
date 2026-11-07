/** `jevlint preset`: lists, shows, picks, writes and installs principle presets. */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { confirm, multiselect, select, text } from '@clack/prompts';
import { defineCommand } from 'citty';
import { saveDefaultPresets, UserError, writeFileAtomic } from '../config.ts';
import {
  auditChoices,
  createPreset,
  editablePreset,
  installPreset,
  listPresets,
  loadPresets,
  type PresetOrigin,
  parsePreset,
  removePreset,
} from '../presets.ts';
import { withoutControlCharacters, withoutEscapes } from '../report.ts';
import type { Preset, PresetUse } from '../types.ts';
import { answered, PROMPT_IO, projectConfig } from './shared.ts';

const REPO_ARG = {
  type: 'boolean',
  description: 'Write into .jevlint/presets/ instead of your user presets',
} as const;

function formatPreset({ name, description, includes, questions, patterns, rules }: Preset): string {
  return [
    `${name}: ${description}`,
    '',
    ...includes.map((included) => `  includes ${included}`),
    ...questions.map(({ id, title }) => `  ${name}.${id}  ${title}`),
    ...[...patterns, ...rules].map(({ id, message }) => `  ${id}  ${message}`),
  ].join('\n');
}

interface Listed {
  name: string;
  description: string;
  used_by: PresetUse;
  origin: PresetOrigin;
  path: string;
}

const GROUPS: Record<PresetUse, string> = {
  audit: 'For audits (* = default):',
  architecture: 'For jevlint architecture:',
  intent: 'For --intent on jevlint pr and jevlint commits:',
};

async function presetTable(): Promise<{ root: string; defaults: string[]; presets: Listed[] }> {
  const { root, presets: defaults } = await projectConfig();
  return { root, defaults, presets: withoutControlCharacters(await listPresets(root)) };
}

/** Presets grouped by the command they serve, with `*` on the defaults: `preset list`. */
export async function formatPresetList(): Promise<string> {
  const { defaults, presets } = await presetTable();
  const width = Math.max(...presets.map(({ name }) => name.length));
  const line = ({ name, origin, description }: Listed) => {
    const mark = defaults.includes(name) ? '*' : ' ';
    return `${mark} ${name.padEnd(width)}  ${origin.padEnd(8)}  ${description}`;
  };
  return (Object.keys(GROUPS) as PresetUse[])
    .map((use) => [use, presets.filter(({ used_by }) => used_by === use)] as const)
    .filter(([, members]) => members.length > 0)
    .map(([use, members]) => [GROUPS[use], ...members.map(line)].join('\n'))
    .join('\n\n');
}

const listCommand = defineCommand({
  meta: {
    name: 'jevlint preset list',
    description: 'Show available presets and their origin. * marks the default ones',
  },
  async run() {
    console.log(await formatPresetList());
  },
});

/** Asks which preset to use when a command was given no name, or says how to name one. */
async function pickPreset(
  message: string,
  filter: (preset: Listed) => boolean = () => true,
): Promise<string> {
  const { defaults, presets } = await presetTable();
  const order = Object.keys(GROUPS);
  const choices = presets
    .filter(filter)
    .sort((a, b) => order.indexOf(a.used_by) - order.indexOf(b.used_by));
  if (!process.stdin.isTTY) throw new UserError('Name a preset. Run: jevlint preset list');
  if (choices.length === 0) throw new UserError('No preset to choose from.');
  return answered(
    await select<string>({
      message,
      options: choices.map(({ name, origin, used_by, description }) => ({
        value: name,
        label: defaults.includes(name) ? `${name} *` : name,
        hint: [origin, ...(used_by === 'audit' ? [] : [`for ${used_by}`]), description].join(' · '),
      })),
      ...PROMPT_IO,
    }),
  );
}

const nameArg = (description = 'Preset name. Omit it to pick from a list') =>
  ({ type: 'positional', required: false, description }) as const;

async function showPreset(name: string, { toml }: { toml: boolean }): Promise<void> {
  const { root } = await projectConfig();
  const [preset] = await loadPresets([name], root);
  if (!toml) return console.log(withoutEscapes(formatPreset(preset as Preset)));
  const { path } = (await listPresets(root)).find((entry) => entry.name === name) as Listed;
  console.log(withoutEscapes(await readFile(path, 'utf8')));
}

const showCommand = defineCommand({
  meta: { name: 'jevlint preset show', description: "Print a preset's questions" },
  args: {
    name: nameArg(),
    toml: { type: 'boolean', description: 'Print the TOML file itself' },
  },
  async run({ args }) {
    const name = args.name ?? (await pickPreset('Which preset do you want to see?'));
    await showPreset(name, { toml: Boolean(args.toml) });
  },
});

/** `$VISUAL` or `$EDITOR` may carry flags, as in `code -w`, so it is split rather than run in a shell. */
function editorCommand(): string[] {
  const configured = (process.env.VISUAL || process.env.EDITOR || '').trim();
  if (configured) return configured.split(/\s+/);
  return [process.platform === 'win32' ? 'notepad' : 'vi'];
}

function runEditor(path: string): void {
  const [editor = 'vi', ...flags] = editorCommand();
  // No shell: the path may come from the repository, and must never be read as a command.
  const { status, error } = spawnSync(editor, [...flags, path], { stdio: 'inherit' });
  if (error) {
    throw new UserError(`Could not start ${editor}: ${error.message}. Set VISUAL or EDITOR.`);
  }
  if (status !== 0) throw new UserError(`${editor} exited with status ${status}.`);
}

/**
 * Edits a copy of a preset, and replaces the preset only once the copy is valid. A broken preset
 * would stop every command that reads presets, including this one.
 */
async function openInEditor(path: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'jevlint-preset-'));
  const draft = join(dir, basename(path));
  try {
    await writeFile(draft, await readFile(path, 'utf8'));
    for (;;) {
      runEditor(draft);
      const toml = await readFile(draft, 'utf8');
      try {
        parsePreset(toml, path);
        // Atomic, so a symlink planted at the preset is replaced rather than written through.
        return await writeFileAtomic(path, toml);
      } catch (error) {
        if (!(error instanceof UserError)) throw error;
        console.error(withoutEscapes(error.message));
        const again = await confirm({
          message: 'Edit again? No discards your changes',
          ...PROMPT_IO,
        });
        if (!answered(again))
          throw new UserError('Discarded your changes. The preset is unchanged.');
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function editPreset(
  name: string,
  { repo, pathOnly = false }: { repo: boolean; pathOnly?: boolean },
): Promise<void> {
  const { root } = await projectConfig();
  const { path, copied } = await editablePreset(name, { repo, root });
  const shown = withoutControlCharacters(path);
  if (copied) console.error(`Copied built-in ${name} to ${shown}, which now overrides it.`);
  if (pathOnly) return console.log(shown);
  if (!process.stdin.isTTY) throw new UserError(`No terminal to edit in. The file is ${shown}`);
  await openInEditor(path);
  console.error(`Saved ${shown}`);
}

const newCommand = defineCommand({
  meta: { name: 'jevlint preset new', description: 'Create a preset and open it in your editor' },
  args: {
    name: { type: 'positional', required: true, description: 'Name of the new preset' },
    from: { type: 'string', valueHint: 'preset', description: 'Start from a copy of this preset' },
    repo: REPO_ARG,
    edit: {
      type: 'boolean',
      default: true,
      description: 'Open the new file in your editor',
      negativeDescription: 'Only write the file',
    },
  },
  async run({ args }) {
    const { root } = await projectConfig();
    const path = await createPreset(args.name, {
      repo: Boolean(args.repo),
      root,
      ...(args.from !== undefined && { from: args.from }),
    });
    console.error(`Wrote ${withoutControlCharacters(path)}`);
    if (args.edit && process.stdin.isTTY) await openInEditor(path);
    console.error(`Audit with it: jevlint audit ${args.name}`);
  },
});

const editCommand = defineCommand({
  meta: {
    name: 'jevlint preset edit',
    description: 'Open a preset in your editor. A built-in one is copied first, then overrides it',
  },
  args: {
    name: nameArg(),
    repo: REPO_ARG,
    path: { type: 'boolean', description: 'Only print the path of the file to edit' },
  },
  async run({ args }) {
    const name = args.name ?? (await pickPreset('Which preset do you want to edit?'));
    await editPreset(name, { repo: Boolean(args.repo), pathOnly: Boolean(args.path) });
  },
});

function parseNames(values: string[]): string[] {
  return values
    .flatMap((value) => value.split(','))
    .map((name) => name.trim())
    .filter(Boolean);
}

async function pickDefaults(): Promise<string[]> {
  const { defaults, presets } = await presetTable();
  const forAudits = auditChoices(presets);
  return answered(
    await multiselect<string>({
      message: 'Which presets should files be audited against by default?',
      options: forAudits.map(({ name, description }) => ({ value: name, hint: description })),
      initialValues: defaults,
      required: true,
      ...PROMPT_IO,
    }),
  );
}

async function setDefaults(names: string[], { repo }: { repo: boolean }): Promise<void> {
  const { root } = await projectConfig();
  await loadPresets(names, root);
  const file = await saveDefaultPresets(names, { repo, root });
  console.error(`Default presets: ${names.join(', ')}\nWrote ${withoutControlCharacters(file)}`);
  const effective = (await projectConfig()).presets;
  if (!repo && effective.join() !== names.join()) {
    console.error(
      withoutControlCharacters(
        `jevlint.toml in this repository sets presets = ${JSON.stringify(effective)}, which wins here. Use --repo to change it.`,
      ),
    );
  }
}

const defaultCommand = defineCommand({
  meta: {
    name: 'jevlint preset default',
    description: 'Show the default presets, or set them with names or by picking in a terminal',
  },
  args: {
    names: { type: 'positional', required: false, description: 'Presets to audit with by default' },
    repo: { type: 'boolean', description: 'Write jevlint.toml instead of your user config' },
  },
  async run({ args }) {
    const names = parseNames(args._);
    if (names.length === 0 && !process.stdin.isTTY) {
      return console.log(withoutEscapes((await projectConfig()).presets.join('\n')));
    }
    const repo = Boolean(args.repo);
    await setDefaults(names.length > 0 ? names : await pickDefaults(), { repo });
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

async function removeInstalled(name: string): Promise<void> {
  const { root } = await projectConfig();
  const listed = (await listPresets(root)).find((preset) => preset.name === name);
  if (!(await removePreset(name, root))) {
    throw new UserError(`No installed preset named "${name}". Run: jevlint preset list`);
  }
  const shown = withoutControlCharacters(listed?.path ?? name);
  console.error(
    `Removed ${shown}. A built-in preset of the same name applies again, if there is one.`,
  );
}

const removeCommand = defineCommand({
  meta: { name: 'jevlint preset remove', description: 'Remove an installed preset' },
  args: { name: nameArg() },
  async run({ args }) {
    const name =
      args.name ??
      (await pickPreset(
        'Which preset do you want to remove?',
        ({ origin }) => origin !== 'built-in',
      ));
    await removeInstalled(name);
  },
});

type MenuAction = 'show' | 'edit' | 'default-add' | 'default-remove' | 'copy' | 'remove';

async function pickAction(preset: Listed, isDefault: boolean): Promise<MenuAction> {
  const options: { value: MenuAction; label: string; hint?: string }[] = [
    { value: 'show', label: 'Show its questions' },
    {
      value: 'edit',
      label: 'Edit it',
      ...(preset.origin === 'built-in' && { hint: 'edits a copy, which then overrides it' }),
    },
    ...(preset.used_by !== 'audit'
      ? []
      : [
          isDefault
            ? { value: 'default-remove' as const, label: 'Stop auditing with it by default' }
            : { value: 'default-add' as const, label: 'Audit with it by default' },
        ]),
    { value: 'copy', label: 'Start a new preset from it' },
    ...(preset.origin === 'built-in'
      ? []
      : [{ value: 'remove' as const, label: 'Remove it', hint: preset.origin }]),
  ];
  return answered(
    await select<MenuAction>({ message: `${preset.name}: what next?`, options, ...PROMPT_IO }),
  );
}

async function askNewName(base: string): Promise<string> {
  const name = answered(
    await text({
      message: 'Name of the new preset',
      placeholder: `my-${base}`,
      validate: (value) =>
        /^[A-Za-z0-9_-]+$/.test(value ?? '') ? undefined : 'Use letters, digits, - and _',
      ...PROMPT_IO,
    }),
  );
  return name;
}

/** `jevlint preset` alone: pick a preset, then what to do with it. In a pipe, it lists them. */
async function presetMenu(): Promise<void> {
  if (!process.stdin.isTTY) return console.log(await formatPresetList());
  const name = await pickPreset('Which preset? (* audits by default)');
  const { defaults, presets } = await presetTable();
  const preset = presets.find((entry) => entry.name === name) as Listed;
  const action = await pickAction(preset, defaults.includes(name));
  const others = defaults.filter((entry) => entry !== name);
  if (action === 'show') await showPreset(name, { toml: false });
  if (action === 'edit') await editPreset(name, { repo: false });
  if (action === 'default-add') await setDefaults([...defaults, name], { repo: false });
  if (action === 'default-remove') {
    if (others.length === 0) throw new UserError('At least one preset must stay the default.');
    await setDefaults(others, { repo: false });
  }
  if (action === 'copy') {
    const path = await createPreset(await askNewName(name), {
      repo: false,
      root: (await projectConfig()).root,
      from: name,
    });
    console.error(`Wrote ${withoutControlCharacters(path)}`);
    await openInEditor(path);
  }
  if (action === 'remove') await removeInstalled(name);
  if (action !== 'remove' && preset.used_by === 'audit') {
    console.error(`Audit with it: jevlint audit ${name}`);
  }
}

/** The `preset` command group. Run alone, it opens a menu. */
export const presetCommand = defineCommand({
  meta: {
    name: 'jevlint preset',
    description: 'Choose, view, write and manage principle presets. Run alone to pick from a menu',
  },
  async run({ rawArgs }) {
    // Citty runs a group's own handler after a subcommand too.
    if (rawArgs.length === 0) await presetMenu();
  },
  subCommands: {
    list: listCommand,
    show: showCommand,
    default: defaultCommand,
    new: newCommand,
    edit: editCommand,
    add: addCommand,
    remove: removeCommand,
  },
});
