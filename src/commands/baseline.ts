/** `jevlint baseline`: records today's findings, so that `audit --new` shows only later ones. */
import { defineCommand } from 'citty';
import { violationsOf } from '../architecture/check.ts';
import { collect } from '../architecture/collect.ts';
import { loadArchitecture } from '../architecture/load.ts';
import { architectureBaseline, BASELINE_PATH, toBaseline, writeBaseline } from '../baseline.ts';
import { type Config, UserError } from '../config.ts';
import { plural, withoutControlCharacters } from '../report.ts';
import {
  auditProject,
  everyProviderCallFailed,
  PRESET_ARG,
  presetOverride,
  projectConfig,
  refuseUnansweredEnvKey,
  splitPositionals,
} from './shared.ts';

/**
 * The SSOT's structural violations, when there is an SSOT, for `architecture check --new`. An SSOT
 * that does not load leaves them out with a warning: the audit baseline does not depend on it.
 */
async function architectureEntries(config: Config) {
  try {
    const ssot = await loadArchitecture(config);
    if (!ssot) return undefined;
    const collected = await collect(config, { keepSources: true, skipHistory: true });
    return architectureBaseline(violationsOf(ssot, collected));
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    console.error(
      `Warning: no architecture violations recorded: ${withoutControlCharacters(error.message)}`,
    );
    return undefined;
  }
}

/** The `baseline` command. */
export const baselineCommand = defineCommand({
  meta: {
    name: 'jevlint baseline',
    description: 'Record current issues for audit --new and architecture check --new',
  },
  args: {
    paths: {
      type: 'positional',
      required: false,
      description:
        'Files or directories to record (default: the whole repository). A preset name works like --preset',
    },
    preset: PRESET_ARG,
    'ast-only': { type: 'boolean', description: 'Use AST analysis only, with no network' },
  },
  async run({ args }) {
    const { named, paths } = await splitPositionals(args._);
    const config = await projectConfig(presetOverride(args.preset, named));
    const astOnly = Boolean(args['ast-only']);
    if (!astOnly) await refuseUnansweredEnvKey(config);
    const report = await auditProject(config, { paths, astOnly });
    // Without answers, every weak answer would count as new at the next gate.
    if (everyProviderCallFailed(report)) {
      throw new UserError('Every provider request failed, so no baseline was written.');
    }
    const architecture = await architectureEntries(config);
    const baseline = { ...toBaseline(report), ...(architecture ? { architecture } : {}) };
    await writeBaseline(config.root, baseline);
    const recorded = architecture
      ? ` and ${plural(architecture.length, 'architecture violation')}`
      : '';
    console.error(
      `Wrote ${BASELINE_PATH}, with ${plural(baseline.files.length, 'file')} of issues${recorded}.`,
    );
  },
});
