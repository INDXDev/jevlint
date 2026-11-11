/**
 * `jevlint architecture`: reviews the structure, and compiles, shows, checks and keeps current
 * the architecture SSOT. With no subcommand, it runs `review`.
 */
import { relative, resolve, sep } from 'node:path';
import { defineCommand } from 'citty';
import clipboard from 'clipboardy';
import { agentFailure, launchAgent, runAgent } from '../agent.ts';
import { checkArchitecture } from '../architecture/check.ts';
import { prepareCompile } from '../architecture/compile.ts';
import { assign } from '../architecture/conformance.ts';
import { driftArchitecture } from '../architecture/drift.ts';
import { renderArchitectureHtml, renderShowHtml } from '../architecture/html.ts';
import { architectureFiles, budgetWarnings, loadArchitecture } from '../architecture/load.ts';
import { renderMarkdown, renderView } from '../architecture/markdown.ts';
import { planArchitecture } from '../architecture/plan.ts';
import {
  renderCheckPrompt,
  renderCompilePrompt,
  renderDriftPrompt,
  renderPlanPrompt,
  renderReviewPrompt,
} from '../architecture/prompt.ts';
import { PERSPECTIVES, reviewArchitecture } from '../architecture/review.ts';
import { showArchitecture, type View } from '../architecture/show.ts';
import {
  formatArchitecture,
  formatArchitectureCheck,
  formatArchitectureDrift,
  formatArchitecturePlan,
  formatShow,
  formatSsotList,
} from '../architecture/terminal.ts';
import { type Config, UserError, writeFileAtomic } from '../config.ts';
import { withoutEscapes } from '../report.ts';
import type { ArchitectureSsot, Perspective } from '../types.ts';
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

const JSON_ARG = { type: 'boolean', description: 'Print the JSON report' } as const;
const CACHE_ARG = {
  type: 'boolean',
  default: true,
  description: 'Use cached decisions and outlines',
  negativeDescription: 'Ignore cached decisions and outlines, and do not store new ones',
} as const;
const COPY_ARG = {
  type: 'boolean',
  description: 'Also copy a prompt for a coding agent to the clipboard',
} as const;
const PROMPT_ARG = {
  type: 'boolean',
  description: 'Print the prompt for a coding agent instead of the report',
} as const;
const AGENT_ARGS = {
  copy: { type: 'boolean', description: 'Copy the prompt to the clipboard instead of printing it' },
  agent: {
    type: 'string',
    valueHint: 'name',
    description: 'Run this agent on the prompt, such as claude',
  },
  'agent-login': {
    type: 'boolean',
    description: "Use the agent's own login, not an API key in the environment",
  },
} as const;

function parsePerspectives(value: string | undefined): Perspective[] | undefined {
  if (value === undefined) return undefined;
  const names = value.split(',').map((name) => name.trim());
  const unknown = names.find((name) => !PERSPECTIVES.includes(name as Perspective));
  if (unknown !== undefined) {
    throw new UserError(`Unknown perspective "${unknown}". Use: ${PERSPECTIVES.join(', ')}`);
  }
  return names as Perspective[];
}

/** A flag right after --html is taken as its value, which would write a file named `--json`. */
function htmlTarget(value: string | undefined): string | undefined {
  if (value === '' || value?.startsWith('-')) throw new UserError('--html needs a file name.');
  return value;
}

async function writeHtml(path: string, html: string): Promise<void> {
  // Atomic, so a symlink the repository planted at this path is replaced, not written through.
  await writeFileAtomic(path, html).catch((error: Error) => {
    throw new UserError(`Could not write ${path}: ${error.message}`);
  });
}

async function copyPrompt(prompt: string): Promise<void> {
  await clipboard.write(prompt).catch((error: Error) => {
    throw new UserError(`Could not copy the prompt: ${error.message}`);
  });
  console.error('Copied the prompt to the clipboard.');
}

/** Prints, copies or hands a prompt to an agent, whose output goes to stderr. */
async function deliverPrompt(
  config: Config,
  prompt: string,
  flags: { copy?: boolean; agent?: string; 'agent-login'?: boolean },
  subject: string,
): Promise<void> {
  if (flags.agent !== undefined) {
    const launch = launchAgent(config, flags.agent, 'fix', Boolean(flags['agent-login']));
    const options = { output: 'stderr' as const, unsetEnv: launch.login ? launch.keyEnv : [] };
    const code = await runAgent(launch.command, prompt, config.root, options);
    if (code !== 0) throw agentFailure(launch, code, subject);
    return;
  }
  if (flags.copy) return copyPrompt(prompt);
  console.log(prompt);
}

async function requireSsot(config: Config): Promise<ArchitectureSsot> {
  const ssot = await loadArchitecture(config);
  if (!ssot) {
    throw new UserError(
      `No architecture SSOT in ${withoutEscapes(config.architecture.dir)}. Run: jevlint architecture compile`,
    );
  }
  return ssot;
}

/** `--docs` alone means `spec.docs`; `--docs=a.md,b.md` names documents. Undefined means none. */
function parseDocs(config: Config, value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(',')
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => {
      const relativePath = relative(config.root, resolve(path));
      if (relativePath.startsWith(`..${sep}`) || relativePath === '..') {
        throw new UserError(`No document ${path} in the repository.`);
      }
      return relativePath.split(sep).join('/');
    });
}

function parseView(value: string | undefined, ssot: ArchitectureSsot): View {
  if (value === undefined || value === 'map') return { kind: 'map' };
  if (value === 'layers') return { kind: 'layers' };
  const [kind, id = ''] = value.split(/:(.*)/s);
  const known =
    kind === 'flow'
      ? ssot.flows.map((flow) => flow.id)
      : kind === 'component'
        ? ssot.components.map((component) => component.id)
        : null;
  if (known === null) {
    throw new UserError(`Unknown view "${value}". Use map, layers, flow:<id> or component:<id>`);
  }
  if (!known.includes(id)) {
    throw new UserError(`No ${kind} "${id}". Known: ${known.join(', ') || 'none'}`);
  }
  return { kind: kind as 'flow' | 'component', id };
}

const reviewCommand = defineCommand({
  meta: {
    name: 'jevlint architecture review',
    description: 'Review the codebase, directories, classes and SSOT, and rank them worst to best',
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
      description: `Comma-separated, from ${PERSPECTIVES.join(', ')} (default: all; component and design need an SSOT)`,
    },
    top: { type: 'string', valueHint: 'n', description: `Rows to show (default ${DEFAULT_TOP})` },
    html: { type: 'string', valueHint: 'file', description: 'Write a visual report to this file' },
    json: JSON_ARG,
    copy: COPY_ARG,
    prompt: PROMPT_ARG,
    'ast-only': { type: 'boolean', description: 'Use AST analysis only, with no network' },
    cache: CACHE_ARG,
  },
  async run({ args }) {
    const top = parseCount('--top', args.top) ?? DEFAULT_TOP;
    const perspectives = parsePerspectives(args.perspective);
    const html = htmlTarget(args.html);
    const config = await projectConfig();
    const astOnly = Boolean(args['ast-only']);
    const paths = resolvePaths(args._);
    await warnAboutScope(config, paths);
    const ssot = await loadArchitecture(config);
    const report = await withSpinner((onProgress) =>
      reviewArchitecture(config, {
        paths,
        astOnly,
        perspectives,
        ssot,
        noCache: !args.cache,
        onProgress,
      }),
    );
    if (report.model === null && !astOnly) printNoKeyNotice(config);
    printFallbackNotice(config, report.provider);
    if (html) await writeHtml(html, renderArchitectureHtml(report));
    const prompt = args.copy || args.prompt ? withoutEscapes(renderReviewPrompt(report, ssot)) : '';
    if (args.prompt) console.log(prompt);
    else if (args.json) printJson(report);
    else if (html) console.error(`Wrote ${html}`);
    else console.log(formatArchitecture(report, { top }));
    if (args.copy) await copyPrompt(prompt);
  },
});

const compileCommand = defineCommand({
  meta: {
    name: 'jevlint architecture compile',
    description:
      'Print, copy or run a prompt that tells a coding agent to write the SSOT from the code',
  },
  args: {
    paths: {
      type: 'positional',
      required: false,
      description: 'Files or directories to compile from (default: the whole repository)',
    },
    docs: {
      type: 'string',
      valueHint: 'files',
      description: 'Add documents as context: spec.docs, or --docs=a.md,b.md',
    },
    since: {
      type: 'string',
      valueHint: 'commit',
      description: 'Update from this commit instead of compiled_at',
    },
    ...AGENT_ARGS,
    cache: CACHE_ARG,
  },
  async run({ args }) {
    const config = await projectConfig();
    const paths = resolvePaths(args._);
    const input = await prepareCompile(config, {
      paths,
      docs: parseDocs(config, args.docs),
      since: args.since,
      noCache: !args.cache,
    });
    await deliverPrompt(config, renderCompilePrompt(input), args, input.dir);
  },
});

const listCommand = defineCommand({
  meta: {
    name: 'jevlint architecture list',
    description: 'Load the SSOT, validate it and print it',
  },
  args: { json: { type: 'boolean', description: 'Print the SSOT as JSON' } },
  async run({ args }) {
    const ssot = await requireSsot(await projectConfig());
    const warnings = budgetWarnings(ssot);
    if (args.json) printJson(ssot);
    else console.log(formatSsotList(ssot, []));
    for (const warning of warnings) console.error(`Warning: ${withoutEscapes(warning)}`);
  },
});

const showCommand = defineCommand({
  meta: {
    name: 'jevlint architecture show',
    description: 'Draw the SSOT, or a draft from the code, with the real dependencies laid over it',
  },
  args: {
    view: {
      type: 'string',
      valueHint: 'view',
      description: 'map (default), layers, flow:<id> or component:<id>',
    },
    html: {
      type: 'string',
      valueHint: 'file',
      description: 'Write a page with no scripts to this file',
    },
    markdown: { type: 'boolean', description: 'Print an ARCHITECTURE.md with Mermaid diagrams' },
    json: JSON_ARG,
    cache: CACHE_ARG,
  },
  async run({ args }) {
    const html = htmlTarget(args.html);
    const config = await projectConfig();
    const ssot = await loadArchitecture(config);
    const model = await showArchitecture(config, ssot, { noCache: !args.cache });
    const view = parseView(args.view, model.ssot);
    if (model.draft) {
      console.error(
        'This is a draft from the code. Run: jevlint architecture compile, to turn it into an SSOT.',
      );
    }
    if (html) await writeHtml(html, renderShowHtml(model));
    if (args.json) return printJson(model);
    if (args.markdown) {
      return console.log(args.view === undefined ? renderMarkdown(model) : renderView(model, view));
    }
    if (html) return console.error(`Wrote ${html}`);
    const { componentOf } = assign(model.ssot);
    const modules =
      view.kind === 'component'
        ? model.facts.modules.filter(({ path }) => componentOf(path) === view.id)
        : [];
    console.log(formatShow(model, view, modules));
  },
});

const checkCommand = defineCommand({
  meta: { name: 'jevlint architecture check', description: 'Check that the code follows the SSOT' },
  args: {
    paths: {
      type: 'positional',
      required: false,
      description: 'Files or directories to report on (default: the whole repository)',
    },
    diff: {
      type: 'string',
      valueHint: 'base',
      description: 'Report only what changed since this commit',
    },
    static: { type: 'boolean', description: 'Decide the structural rules only, with no model' },
    new: {
      type: 'boolean',
      description: 'Leave out violations recorded in .jevlint/baseline.json',
    },
    json: JSON_ARG,
    copy: COPY_ARG,
    prompt: PROMPT_ARG,
    verbose: { type: 'boolean', description: 'List every judged checklist item with its verdict' },
    cache: CACHE_ARG,
  },
  async run({ args }) {
    const config = await projectConfig();
    const ssot = await requireSsot(config);
    const report = await withSpinner((onProgress) =>
      checkArchitecture(config, ssot, {
        paths: resolvePaths(args._),
        diff: args.diff,
        static: Boolean(args.static),
        new: Boolean(args.new),
        noCache: !args.cache,
        onProgress,
      }),
    );
    if (report.provider) printFallbackNotice(config, report.provider);
    const prompt = args.copy || args.prompt ? withoutEscapes(renderCheckPrompt(report)) : '';
    if (args.prompt) console.log(prompt);
    else if (args.json) printJson(report);
    else console.log(formatArchitectureCheck(report, args.verbose));
    if (args.copy) await copyPrompt(prompt);
    const failed =
      report.violations.length + report.checklistViolations + report.unimplemented.length;
    if (failed > 0) process.exitCode = 1;
  },
});

const driftCommand = defineCommand({
  meta: {
    name: 'jevlint architecture drift',
    description: 'Find where the SSOT no longer describes the code',
  },
  args: {
    static: {
      type: 'boolean',
      description: 'AST only, with no model: no summaries and no documents',
    },
    docs: {
      type: 'string',
      valueHint: 'files',
      description: 'Also compare documents: spec.docs, or --docs=a.md,b.md',
    },
    since: {
      type: 'string',
      valueHint: 'commit',
      description: 'Compare with this commit instead of compiled_at',
    },
    json: JSON_ARG,
    copy: COPY_ARG,
    prompt: PROMPT_ARG,
    cache: CACHE_ARG,
  },
  async run({ args }) {
    const config = await projectConfig();
    const docs = parseDocs(config, args.docs);
    if (docs && args.static)
      throw new UserError('--docs asks a model, so it cannot run with --static.');
    const ssot = await requireSsot(config);
    const report = await withSpinner((onProgress) =>
      driftArchitecture(config, ssot, {
        static: Boolean(args.static),
        docs,
        since: args.since,
        noCache: !args.cache,
        onProgress,
      }),
    );
    if (report.provider) printFallbackNotice(config, report.provider);
    const prompt =
      args.copy || args.prompt
        ? withoutEscapes(renderDriftPrompt(report, architectureFiles(ssot)))
        : '';
    if (args.prompt) console.log(prompt);
    else if (args.json) printJson(report);
    else console.log(formatArchitectureDrift(report));
    if (args.copy) await copyPrompt(prompt);
    if (report.items.length > 0) process.exitCode = 1;
  },
});

const planCommand = defineCommand({
  meta: {
    name: 'jevlint architecture plan',
    description:
      'Rank structural problems, compute a move for each, and prompt an agent for plan.md',
  },
  args: {
    json: { type: 'boolean', description: 'Print the plan as JSON, as plan.json' },
    prompt: {
      type: 'boolean',
      description: 'Print the prompt that asks an agent to write plan.md',
    },
    ...AGENT_ARGS,
  },
  async run({ args }) {
    const config = await projectConfig();
    const ssot = await loadArchitecture(config);
    const plan = await withSpinner(() => planArchitecture(config, ssot));
    const wantsPrompt = args.prompt || args.copy || args.agent !== undefined;
    if (!wantsPrompt) {
      if (args.json) return printJson(plan);
      return console.log(formatArchitecturePlan(plan));
    }
    const prompt = withoutEscapes(renderPlanPrompt(plan, ssot?.dir ?? config.architecture.dir));
    await deliverPrompt(config, prompt, args, 'plan.md');
  },
});

/** The `architecture` command group. With no subcommand, `cli.ts` routes to `review`. */
export const architectureCommand = defineCommand({
  meta: {
    name: 'jevlint architecture',
    description:
      'Review the structure, and compile, show and check the architecture SSOT. Defaults to review',
  },
  subCommands: {
    review: reviewCommand,
    compile: compileCommand,
    list: listCommand,
    show: showCommand,
    check: checkCommand,
    drift: driftCommand,
    plan: planCommand,
  },
});
