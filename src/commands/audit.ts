/** `jevlint audit`: scores files and ranks them. */
import { defineCommand } from 'citty';
import { planAudit } from '../audit.ts';
import { newIssues, readBaseline } from '../baseline.ts';
import { type ConfigOverrides, UserError } from '../config.ts';
import { configuredTarget, createDecisionModel } from '../decision/providers.ts';
import { auditIssues, formatIssues, type OutputFormat } from '../formats.ts';
import { formatPlan, formatReport, formatScore, plural } from '../report.ts';
import type { AuditReport } from '../types.ts';
import {
  auditProject,
  everyProviderCallFailed,
  FORMAT_ARG,
  parseCount,
  parseFormat,
  parseThreshold,
  printJson,
  projectConfig,
  refuseUnansweredEnvKey,
  resolvePaths,
  warnAboutScope,
} from './shared.ts';

const DEFAULT_TOP = 20;

function parsePresets(value: string): string[] {
  const presets = value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (presets.length === 0) throw new UserError('--preset needs at least one preset name.');
  return presets;
}

function parseOverrides(flags: {
  preset?: string;
  concurrency?: string;
  failUnder?: string;
}): ConfigOverrides {
  const concurrency = parseCount('--concurrency', flags.concurrency);
  const failUnder = parseThreshold('--fail-under', flags.failUnder);
  return {
    ...(flags.preset !== undefined && { presets: parsePresets(flags.preset) }),
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

/** The `audit` command, which also runs when no command is given. */
export const auditCommand = defineCommand({
  meta: { name: 'jevlint audit', description: 'Score files and rank them' },
  args: {
    paths: {
      type: 'positional',
      required: false,
      description: 'Files or directories to audit (default: the whole repository)',
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
    const overrides = parseOverrides({ ...args, failUnder: args['fail-under'] });
    const config = await projectConfig(overrides);
    const paths = args._;
    const astOnly = Boolean(args['ast-only']);
    const ignorePins = Boolean(args['ignore-pins']);
    if (args['dry-run']) {
      if (format !== 'text' && format !== 'json') {
        throw new UserError(`--dry-run has no findings to print as ${format}.`);
      }
      await warnAboutScope(config, resolvePaths(paths));
      const target = astOnly
        ? null
        : ((await createDecisionModel(config)) ?? configuredTarget(config));
      const plan = await planAudit(config, {
        paths: resolvePaths(paths),
        ignorePins,
        noCache: !args.cache,
        target,
      });
      if (format === 'json') return printJson(plan);
      return console.log(formatPlan(plan, target?.provider ?? null));
    }

    const failUnder = config.scoring.fail_under;
    const gated = failUnder > 0 || Boolean(args.new);
    if (gated && !astOnly) await refuseUnansweredEnvKey(config);
    const baseline = args.new ? await readBaseline(config.root) : null;
    const report = await auditProject(config, {
      paths,
      astOnly,
      ignorePins,
      noCache: !args.cache,
    });
    const shown = baseline ? newIssues(report, baseline) : report;
    printReport(shown, format, { top, onlyNew: baseline !== null });

    const check =
      failUnder > 0
        ? `the score cannot be checked against ${failUnder}`
        : 'nothing can be compared';
    if (gated && !report.files.some(({ ast, model, pin }) => ast || model || pin)) {
      throw new UserError(`No file was scored, so ${check}.`);
    }
    if (gated && everyProviderCallFailed(report)) {
      throw new UserError(`Every provider request failed, so ${check}.`);
    }
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
