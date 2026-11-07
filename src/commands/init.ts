/** `jevlint init`: creates a repository or user config. */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { multiselect, select } from '@clack/prompts';
import { defineCommand } from 'citty';
import {
  type Config,
  loadConfig,
  paths,
  REPO_CONFIG,
  UserError,
  writeFileAtomic,
} from '../config.ts';
import { KEY_ENV, keySource } from '../credentials.ts';
import { installPreCommitHook } from '../hook.ts';
import { auditChoices, listPresets, loadPresets } from '../presets.ts';
import { withoutControlCharacters } from '../report.ts';
import type { ProviderName } from '../types.ts';
import { answered, PROMPT_IO, parsePresetList, projectConfig } from './shared.ts';

interface Choices {
  provider: ProviderName;
  presets: string[];
}

/** Only keys a repository may set, so the same text is valid in either config file. */
function renderConfig({ provider, presets }: Choices): string {
  return `# jevlint config. Every key is optional: see docs/configuration.md
presets = ${JSON.stringify(presets)}
# include = ["src/**"]
# exclude = ["**/*.generated.ts"]

[provider]
name = "${provider}"
# model = "..."  # defaults to the provider's recommended model

[scoring]
scale = 100
fail_under = 0    # exit 1 below this, for CI
`;
}

async function askChoices(config: Config, initial: string[]): Promise<Choices> {
  const provider = answered(
    await select<ProviderName>({
      message: 'Which provider runs the decision model?',
      options: (Object.keys(KEY_ENV) as ProviderName[]).map((value) => ({ value })),
      initialValue: config.provider.name,
      ...PROMPT_IO,
    }),
  );
  const available = auditChoices(await listPresets(config.root));
  const presets = answered(
    await multiselect<string>({
      message: 'Which presets should files be audited against? full runs them all',
      options: withoutControlCharacters(available).map(({ name, description }) => ({
        value: name,
        hint: description,
      })),
      initialValues: initial,
      required: true,
      ...PROMPT_IO,
    }),
  );
  return { provider, presets };
}

/** The `init` command. */
export const initCommand = defineCommand({
  meta: { name: 'jevlint init', description: 'Create a repository or user config' },
  args: {
    user: { type: 'boolean', description: 'Write your user config instead of jevlint.toml' },
    yes: { type: 'boolean', description: 'Accept defaults without prompting' },
    force: { type: 'boolean', description: 'Replace an existing file' },
    preset: {
      type: 'string',
      valueHint: 'names',
      description: 'Comma-separated default presets. In a terminal, preselects them in the prompt',
    },
    'pre-commit': {
      type: 'boolean',
      description: 'Only install a git pre-commit hook that runs jevlint hook --staged',
    },
  },
  async run({ args }) {
    const config = await projectConfig().catch((error) => {
      if (!args.force || !(error instanceof UserError)) throw error;
      return loadConfig({ cwd: process.cwd(), skip: args.user ? 'user' : 'repo' });
    });
    if (args['pre-commit']) {
      const hook = await installPreCommitHook(config.root, Boolean(args.force));
      return console.error(`Wrote ${withoutControlCharacters(hook)}`);
    }
    const target = args.user ? paths.configFile() : join(config.root, REPO_CONFIG);
    if (existsSync(target) && !args.force) {
      throw new UserError(`${target} already exists. Pass --force to replace it.`);
    }

    const presets = args.preset === undefined ? config.presets : parsePresetList(args.preset);
    if (args.preset !== undefined) await loadPresets(presets, config.root);
    const interactive = process.stdin.isTTY && !args.yes;
    const defaults = { provider: config.provider.name, presets };
    const choices = interactive ? await askChoices(config, presets) : defaults;
    await mkdir(dirname(target), { recursive: true });
    // Atomic, so a symlink the repository planted here is replaced, not written through.
    await writeFileAtomic(target, renderConfig(choices));

    const hasKey = (await keySource(choices.provider)) !== null;
    const next = hasKey ? 'jevlint audit --dry-run' : `jevlint auth set ${choices.provider}`;
    console.error(`Wrote ${target}\nNext: ${next}`);
  },
});
