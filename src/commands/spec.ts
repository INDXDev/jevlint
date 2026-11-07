/** `jevlint spec`: compiles a spec from the documents, and checks code and documents against it. */
import { existsSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { defineCommand } from 'citty';
import clipboard from 'clipboardy';
import { type Config, UserError } from '../config.ts';
import { discoverDocs } from '../files.ts';
import { withoutEscapes } from '../report.ts';
import { checkSpec } from '../spec/check.ts';
import { driftSpec } from '../spec/drift.ts';
import { loadSpec, specFiles } from '../spec/load.ts';
import { renderCompilePrompt } from '../spec/prompt.ts';
import { formatSpecCheck, formatSpecDrift, formatSpecList } from '../spec/terminal.ts';
import type { Spec } from '../types.ts';
import {
  printFallbackNotice,
  printJson,
  projectConfig,
  resolvePaths,
  withSpinner,
} from './shared.ts';

const JSON_ARG = { type: 'boolean', description: 'Print the JSON report' } as const;
const CACHE_ARG = {
  type: 'boolean',
  default: true,
  description: 'Use cached decisions',
  negativeDescription: 'Ignore cached decisions, and do not store new ones',
} as const;

async function requireSpec(config: Config): Promise<Spec> {
  const spec = await loadSpec(config);
  if (!spec) {
    throw new UserError(`No spec in ${withoutEscapes(config.spec.dir)}. Run: jevlint spec compile`);
  }
  return spec;
}

/** Turns named documents into root-relative paths, refusing ones that are missing or outside. */
function namedDocs({ root }: Config, paths: string[]): string[] {
  return paths.map((path) => {
    const relativePath = relative(root, resolve(path));
    if (!existsSync(path) || relativePath.startsWith(`..${sep}`) || relativePath === '..') {
      throw new UserError(`No document ${path} in the repository.`);
    }
    return relativePath.split(sep).join('/');
  });
}

const compileCommand = defineCommand({
  meta: {
    name: 'jevlint spec compile',
    description: 'Print or copy a prompt that tells a coding agent to write the spec',
  },
  args: {
    docs: {
      type: 'positional',
      required: false,
      description: 'Documents to compile from (default: spec.docs)',
    },
    copy: { type: 'boolean', description: 'Copy to the clipboard instead of printing' },
  },
  async run({ args }) {
    const config = await projectConfig();
    const docs = args._.length > 0 ? namedDocs(config, args._) : await discoverDocs(config);
    let spec: Spec | null = null;
    let loadError: string | undefined;
    try {
      spec = await loadSpec(config);
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      loadError = error.message;
    }
    const prompt = renderCompilePrompt({
      dir: config.spec.dir,
      docs,
      spec,
      specFiles: spec ? specFiles(spec) : [],
      loadError,
    });
    if (!args.copy) return console.log(prompt);
    await clipboard.write(prompt).catch((error: Error) => {
      throw new UserError(`Could not copy the prompt: ${error.message}`);
    });
    console.error('Copied the prompt to the clipboard.');
  },
});

const checkCommand = defineCommand({
  meta: { name: 'jevlint spec check', description: 'Judge code files against the spec' },
  args: {
    paths: {
      type: 'positional',
      required: false,
      description: 'Files or directories to check (default: the whole repository)',
    },
    json: JSON_ARG,
    cache: CACHE_ARG,
  },
  async run({ args }) {
    const config = await projectConfig();
    const spec = await requireSpec(config);
    const paths = resolvePaths(args._);
    const report = await withSpinner((onProgress) =>
      checkSpec(config, spec, { paths, noCache: !args.cache, onProgress }),
    );
    printFallbackNotice(config, report.provider);
    if (args.json) printJson(report);
    else console.log(formatSpecCheck(report));
    if (report.violations > 0 || report.unimplemented.length > 0) process.exitCode = 1;
  },
});

const driftCommand = defineCommand({
  meta: { name: 'jevlint spec drift', description: 'Compare the documents with the spec' },
  args: {
    docs: {
      type: 'positional',
      required: false,
      description: 'Documents to compare (default: spec.docs)',
    },
    json: JSON_ARG,
    cache: CACHE_ARG,
  },
  async run({ args }) {
    const config = await projectConfig();
    const spec = await requireSpec(config);
    const paths = resolvePaths(args._);
    const report = await withSpinner((onProgress) =>
      driftSpec(config, spec, { paths, noCache: !args.cache, onProgress }),
    );
    printFallbackNotice(config, report.provider);
    if (args.json) printJson(report);
    else console.log(formatSpecDrift(report));
    const { contradictions, uncovered, unbacked, undocumented } = report;
    if (contradictions + uncovered.length + unbacked.length + undocumented.length > 0) {
      process.exitCode = 1;
    }
  },
});

const listCommand = defineCommand({
  meta: { name: 'jevlint spec list', description: 'Load the spec and print it' },
  args: { json: { type: 'boolean', description: 'Print the spec as JSON' } },
  async run({ args }) {
    const spec = await requireSpec(await projectConfig());
    if (args.json) printJson(spec);
    else console.log(formatSpecList(spec));
  },
});

/** The `spec` command group. */
export const specCommand = defineCommand({
  meta: {
    name: 'jevlint spec',
    description: 'Keep documents, a checklist spec and code in agreement',
  },
  subCommands: {
    compile: compileCommand,
    check: checkCommand,
    drift: driftCommand,
    list: listCommand,
  },
});
