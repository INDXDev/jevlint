/** `jevlint explain`: shows everything about one file. */
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineCommand } from 'citty';
import { UserError } from '../config.ts';
import { formatExplain } from '../report.ts';
import { auditProject, printJson, projectConfig, resolvePaths } from './shared.ts';

/** The `explain` command. */
export const explainCommand = defineCommand({
  meta: { name: 'jevlint explain', description: 'Show every finding and score for one file' },
  args: {
    file: { type: 'positional', required: true, description: 'File to explain' },
    json: { type: 'boolean', description: 'Print the file report as JSON' },
  },
  async run({ args }) {
    const config = await projectConfig();
    const [path = args.file] = resolvePaths([args.file]) ?? [];
    // Checked first, because auditing a directory would send all of it to the provider.
    if (statSync(resolve(config.root, path), { throwIfNoEntry: false })?.isDirectory()) {
      throw new UserError(`${args.file} is a directory. Name a single file.`);
    }
    const report = await auditProject(config, { paths: [args.file] });
    const [file] = report.files;
    if (!file) {
      throw new UserError(
        `${args.file} was skipped: no AST support and no model ran. Run: jevlint auth list`,
      );
    }
    if (args.json) printJson(file);
    else console.log(formatExplain(file, report));
  },
});
