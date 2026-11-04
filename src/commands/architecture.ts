/** `jevlint architecture`: maps the repository's structure and shows where it is weakest. */
import { defineCommand } from 'citty';
import { renderArchitectureHtml } from '../architecture/html.ts';
import { PERSPECTIVES, reviewArchitecture } from '../architecture/review.ts';
import { formatArchitecture } from '../architecture/terminal.ts';
import { UserError, writeFileAtomic } from '../config.ts';
import type { Perspective } from '../types.ts';
import {
  parseCount,
  printFallbackNotice,
  printJson,
  printNoKeyNotice,
  projectConfig,
  resolvePaths,
  warnAboutScope,
  withSpinner,
} from './shared.ts';

const DEFAULT_TOP = 20;

function parsePerspectives(value: string | undefined): Perspective[] | undefined {
  if (value === undefined) return undefined;
  const names = value.split(',').map((name) => name.trim());
  const unknown = names.find((name) => !PERSPECTIVES.includes(name as Perspective));
  if (unknown !== undefined) {
    throw new UserError(`Unknown perspective "${unknown}". Use: ${PERSPECTIVES.join(', ')}`);
  }
  return names as Perspective[];
}

/** The `architecture` command. */
export const architectureCommand = defineCommand({
  meta: {
    name: 'jevlint architecture',
    description: 'Review the codebase, directories and classes, and rank them worst to best',
  },
  args: {
    paths: {
      type: 'positional',
      required: false,
      description: 'Files or directories to map (default: the whole repository)',
    },
    perspective: {
      type: 'string',
      valueHint: 'names',
      description: `Comma-separated, from ${PERSPECTIVES.join(', ')} (default: all)`,
    },
    top: { type: 'string', valueHint: 'n', description: `Rows to show (default ${DEFAULT_TOP})` },
    html: { type: 'string', valueHint: 'file', description: 'Write a visual report to this file' },
    json: { type: 'boolean', description: 'Print the JSON report' },
    'ast-only': { type: 'boolean', description: 'Use AST analysis only, with no network' },
    cache: {
      type: 'boolean',
      default: true,
      description: 'Use cached decisions',
      negativeDescription: 'Ignore cached decisions, and do not store new ones',
    },
  },
  async run({ args }) {
    const top = parseCount('--top', args.top) ?? DEFAULT_TOP;
    const perspectives = parsePerspectives(args.perspective);
    // A flag right after --html is taken as its value, which would write a file named `--json`.
    if (args.html === '' || args.html?.startsWith('-')) {
      throw new UserError('--html needs a file name.');
    }
    const config = await projectConfig();
    const astOnly = Boolean(args['ast-only']);
    const paths = resolvePaths(args._);
    await warnAboutScope(config, paths);
    const report = await withSpinner((onProgress) =>
      reviewArchitecture(config, {
        paths,
        astOnly,
        perspectives,
        noCache: !args.cache,
        onProgress,
      }),
    );
    if (report.model === null && !astOnly) printNoKeyNotice(config);
    printFallbackNotice(config, report.provider);
    if (args.html) {
      // Atomic, so a symlink the repository planted at this path is replaced, not written through.
      await writeFileAtomic(args.html, renderArchitectureHtml(report)).catch((error: Error) => {
        throw new UserError(`Could not write ${args.html}: ${error.message}`);
      });
    }
    if (args.json) printJson(report);
    else if (args.html) console.log(`Wrote ${args.html}`);
    else console.log(formatArchitecture(report, { top }));
  },
});
