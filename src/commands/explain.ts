/** `jevlint explain`: shows everything about one file. */
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineCommand } from 'citty';
import { UserError } from '../config.ts';
import { formatExplain } from '../report.ts';
import {
  auditProject,
  PRESET_ARG,
  presetOverride,
  printJson,
  projectConfig,
  resolvePaths,
  splitPositionals,
} from './shared.ts';

/** The `explain` command. */
export const explainCommand = defineCommand({
  meta: { name: 'jevlint explain', description: 'Show every finding and score for one file' },
  args: {
    file: {
      type: 'positional',
      required: true,
      description: 'File to explain. A preset name beside it works like --preset',
    },
    preset: PRESET_ARG,
    json: { type: 'boolean', description: 'Print the file report as JSON' },
  },
  async run({ args }) {
    const { named, paths } = await splitPositionals(args._);
    const [file] = paths;
    if (file === undefined) throw new UserError('Name a file to explain.');
    const config = await projectConfig(presetOverride(args.preset, named));
    const [path = file] = resolvePaths([file]) ?? [];
    // Checked first, because auditing a directory would send all of it to the provider.
    if (statSync(resolve(config.root, path), { throwIfNoEntry: false })?.isDirectory()) {
      throw new UserError(`${file} is a directory. Name a single file.`);
    }
    const report = await auditProject(config, { paths: [file] });
    const [result] = report.files;
    if (!result) {
      throw new UserError(
        `${file} was skipped: no AST support and no model ran. Run: jevlint auth list`,
      );
    }
    if (args.json) printJson(result);
    else console.log(formatExplain(result, report));
  },
});
