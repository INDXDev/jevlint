/** `jevlint prompt`: prints or copies a fix prompt. */
import { defineCommand } from 'citty';
import clipboard from 'clipboardy';
import { UserError } from '../config.ts';
import { renderPrompt } from '../prompt.ts';
import { withoutEscapes } from '../report.ts';
import {
  auditProject,
  FILE_SELECTION_ARGS,
  parseCount,
  projectConfig,
  selectFiles,
} from './shared.ts';

/** The `prompt` command. */
export const promptCommand = defineCommand({
  meta: { name: 'jevlint prompt', description: 'Print or copy a fix prompt for a coding agent' },
  args: {
    ...FILE_SELECTION_ARGS,
    copy: { type: 'boolean', description: 'Copy to the clipboard instead of printing' },
  },
  async run({ args }) {
    const top = parseCount('--top', args.top);
    const config = await projectConfig();
    const report = await auditProject(config, { paths: args._ });
    const files = selectFiles(report, args._, top);
    const prompt = withoutEscapes(renderPrompt(files, report));
    if (!args.copy || files.length === 0) return console.log(prompt);
    await clipboard.write(prompt).catch((error: Error) => {
      throw new UserError(`Could not copy the prompt: ${error.message}`);
    });
    console.error('Copied the prompt to the clipboard.');
  },
});
