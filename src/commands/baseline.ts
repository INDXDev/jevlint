/** `jevlint baseline`: records today's findings, so that `audit --new` shows only later ones. */
import { defineCommand } from 'citty';
import { BASELINE_PATH, toBaseline, writeBaseline } from '../baseline.ts';
import { UserError } from '../config.ts';
import { plural } from '../report.ts';
import {
  auditProject,
  everyProviderCallFailed,
  projectConfig,
  refuseUnansweredEnvKey,
} from './shared.ts';

/** The `baseline` command. */
export const baselineCommand = defineCommand({
  meta: { name: 'jevlint baseline', description: 'Record current issues for audit --new' },
  args: {
    paths: {
      type: 'positional',
      required: false,
      description: 'Files or directories to record (default: the whole repository)',
    },
    'ast-only': { type: 'boolean', description: 'Use AST analysis only, with no network' },
  },
  async run({ args }) {
    const config = await projectConfig();
    const astOnly = Boolean(args['ast-only']);
    if (!astOnly) await refuseUnansweredEnvKey(config);
    const report = await auditProject(config, { paths: args._, astOnly });
    // Without answers, every weak answer would count as new at the next gate.
    if (everyProviderCallFailed(report)) {
      throw new UserError('Every provider request failed, so no baseline was written.');
    }
    const baseline = toBaseline(report);
    await writeBaseline(config.root, baseline);
    console.log(`Wrote ${BASELINE_PATH}, with ${plural(baseline.files.length, 'file')} of issues.`);
  },
});
