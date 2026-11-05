/** `jevlint audit`: scores files and ranks them. */
import { defineCommand } from 'citty';
import { planAudit } from '../audit.ts';
import { newIssues, readBaseline } from '../baseline.ts';
import { type Config, type ConfigOverrides, UserError } from '../config.ts';
import { configuredTarget, createDecisionModel } from '../decision/providers.ts';
import { auditIssues, formatIssues, type OutputFormat } from '../formats.ts';
import { presetsInArgs } from '../presets.ts';
import {
  formatPlan,
  formatReport,
  formatScore,
  plural,
  withoutControlCharacters,
} from '../report.ts';
import type { AuditReport } from '../types.ts';
import {
  auditProject,
  everyProviderCallFailed,
  FORMAT_ARG,
  parseCount,
  parseFormat,
  parsePresetList,
  parseThreshold,
  printJson,
  projectConfig,
  refuseUnansweredEnvKey,
  resolvePaths,
  warnAboutScope,
} from './shared.ts';

const DEFAULT_TOP = 20;

interface AuditScope {
  astOnly: boolean;
  ignorePins: boolean;
  noCache: boolean;
}

/** Tells preset names from paths, and stops on a near miss of a preset name. */
async function splitPositionals(positionals: string[]) {
  const { root } = await projectConfig();
  const {
    presets: named,
    paths,
    shadowed,
    typos,
  } = await presetsInArgs(positionals, {
    root,
    cwd: process.cwd(),
  });
  const [typo, meant] = Object.entries(typos)[0] ?? [];
  if (typo !== undefined) {
    throw new UserError(`No file or preset named "${typo}". Did you mean the preset "${meant}"?`);
  }
  for (const name of shadowed) {
    console.error(
      withoutControlCharacters(
        `${name} is both a path and a preset, so it is audited as a path. For the preset, use --preset ${name}.`,
      ),
    );
  }
  return { named, paths };
}

function parseOverrides(flags: {
  preset?: string;
  named: string[];
  concurrency?: string;
  failUnder?: string;
}): ConfigOverrides {
  const concurrency = parseCount('--concurrency', flags.concurrency);
  const failUnder = parseThreshold('--fail-under', flags.failUnder);
  const flagged = flags.preset === undefined ? [] : parsePresetList(flags.preset);
  const presets = [...new Set([...flagged, ...flags.named])];
  return {
    ...(presets.length > 0 && { presets }),
    ...(concurrency !== undefined && { concurrency }),
    ...(failUnder !== undefined && { scoring: { fail_under: failUnder } }),
  };
}

function printReport(
  report: AuditReport,
  format: OutputFormat,
  { top, onlyNew }: { top: number; onlyNew: boolean },
): void {
  if (format === 'json') return printJson(report);
  if (format !== 'text') return console.log(formatIssues(auditIssues(report), format));
  const nothingNew = onlyNew && report.files.length === 0;
  console.log(nothingNew ? 'No new issues.' : formatReport(report, { top }));
}

async function printDryRun(
  config: Config,
  format: OutputFormat,
  paths: string[],
  { astOnly, ignorePins, noCache }: AuditScope,
): Promise<void> {
  if (format !== 'text' && format !== 'json') {
    throw new UserError(`--dry-run has no findings to print as ${format}.`);
  }
  await warnAboutScope(config, resolvePaths(paths));
  const target = astOnly ? null : ((await createDecisionModel(config)) ?? configuredTarget(config));
  const plan = await planAudit(config, { paths: resolvePaths(paths), ignorePins, noCache, target });
  if (format === 'json') return printJson(plan);
  console.log(formatPlan(plan, target?.provider ?? null));
}

/** A gate must not pass on a report that holds no score to compare. */
function refuseUncheckableReport(report: AuditReport, failUnder: number): void {
  const consequence =
    failUnder > 0 ? `the score cannot be checked against ${failUnder}` : 'nothing can be compared';
  const anyFileScored = report.files.some(({ ast, model, pin }) => ast || model || pin);
  if (!anyFileScored) throw new UserError(`No file was scored, so ${consequence}.`);
  if (everyProviderCallFailed(report)) {
    throw new UserError(`Every provider request failed, so ${consequence}.`);
  }
}

/** The `audit` command, which also runs when no command is given. */
export const auditCommand = defineCommand({
  meta: { name: 'jevlint audit', description: 'Score files and rank them' },
  args: {
    paths: {
      type: 'positional',
      required: false,
      description:
        'Files or directories to audit (default: the whole repository). A preset name, as in `audit security`, works like --preset',
    },
    preset: {
      type: 'string',
      valueHint: 'names',
      description: 'Comma-separated presets, replacing the configured ones',
    },
    top: { type: 'string', valueHint: 'n', description: `Rows to show (default ${DEFAULT_TOP})` },
    json: { type: 'boolean', description: 'Print the JSON report, with every file' },
    format: FORMAT_ARG,
    new: {
      type: 'boolean',
      description: 'Show only what is new or worse than the baseline, and exit 1 if anything is',
    },
    'dry-run': {
      type: 'boolean',
      description: 'List files and estimate tokens and cost, with no provider requests',
    },
    'ast-only': { type: 'boolean', description: 'Use AST analysis only, with no network' },
    cache: {
      type: 'boolean',
      default: true,
      description: 'Use cached decisions',
      negativeDescription: 'Ignore cached decisions, and do not store new ones',
    },
    'ignore-pins': {
      type: 'boolean',
      description: 'Score files as if no jevlint-score comment existed',
    },
    'fail-under': {
      type: 'string',
      valueHint: 'n',
      description: 'Exit 1 if the repository score is below n',
    },
    concurrency: {
      type: 'string',
      valueHint: 'n',
      description: 'Maximum parallel provider requests',
    },
  },
  async run({ args }) {
    const top = parseCount('--top', args.top) ?? DEFAULT_TOP;
    const format = parseFormat(args);
    const { named, paths } = await splitPositionals(args._);
    const overrides = parseOverrides({ ...args, named, failUnder: args['fail-under'] });
    const config = await projectConfig(overrides);
    const scope: AuditScope = {
      astOnly: Boolean(args['ast-only']),
      ignorePins: Boolean(args['ignore-pins']),
      noCache: !args.cache,
    };
    if (args['dry-run']) return printDryRun(config, format, paths, scope);

    const failUnder = config.scoring.fail_under;
    const gated = failUnder > 0 || Boolean(args.new);
    if (gated && !scope.astOnly) await refuseUnansweredEnvKey(config);
    const baseline = args.new ? await readBaseline(config.root) : null;
    const report = await auditProject(config, { paths, ...scope });
    const shown = baseline ? newIssues(report, baseline) : report;
    printReport(shown, format, { top, onlyNew: baseline !== null });

    if (gated) refuseUncheckableReport(report, failUnder);
    if (report.score < failUnder) {
      console.error(`Repository score ${formatScore(report.score)} is below ${failUnder}.`);
      process.exitCode = 1;
    }
    if (baseline && shown.files.length > 0) {
      console.error(`${plural(shown.files.length, 'file')} with new issues since the baseline.`);
      process.exitCode = 1;
    }
  },
});
