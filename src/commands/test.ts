/** `jevlint test`: proves that questions work on fixtures, and notices when a model moves them. */
import { defineCommand } from 'citty';
import { UserError } from '../config.ts';
import { DEFAULT_DRIFT_LIMIT, testFixtures } from '../fixtures.ts';
import { formatFixtures, withoutControlCharacters } from '../report.ts';
import {
  PRESET_ARG,
  parseThreshold,
  presetOverride,
  printFallbackNotice,
  printJson,
  projectConfig,
  withSpinner,
} from './shared.ts';

/** The `test` command. */
export const testCommand = defineCommand({
  meta: {
    name: 'jevlint test',
    description: 'Check questions against .jevlint/fixtures, and report drift from a record',
  },
  args: {
    questions: {
      type: 'positional',
      required: false,
      description: 'Question ids to test, as <preset>.<id> (default: all with fixtures)',
    },
    preset: PRESET_ARG,
    json: { type: 'boolean', description: 'Print the results as JSON' },
    record: { type: 'boolean', description: 'Write the results to .jevlint/calibration.json' },
    drift: { type: 'boolean', description: 'Ask afresh and compare with the record' },
    'drift-limit': {
      type: 'string',
      valueHint: 'n',
      description: `Compliance change that counts as a move (default ${DEFAULT_DRIFT_LIMIT})`,
    },
  },
  async run({ args }) {
    const questionIds = args._;
    const { record, drift } = args;
    const driftLimit = parseThreshold('--drift-limit', args['drift-limit']);
    if (record && drift) throw new UserError('Use --record or --drift, not both.');
    if (driftLimit !== undefined && !drift) throw new UserError('--drift-limit needs --drift.');
    // A record of some questions would replace the record of them all.
    if (record && questionIds.length > 0) {
      throw new UserError('--record covers every fixture, so it takes no question ids.');
    }
    if (record && args.preset !== undefined) {
      throw new UserError('--record covers every fixture, so it takes no --preset.');
    }
    const config = await projectConfig(presetOverride(args.preset));
    const report = await withSpinner((onProgress) =>
      testFixtures(config, { questionIds, record, drift, driftLimit, onProgress }),
    );
    printFallbackNotice(config, report.provider);
    for (const warning of report.warnings) {
      console.error(`Warning: ${withoutControlCharacters(warning)}`);
    }
    if (args.json) printJson(report);
    else console.log(formatFixtures(report));
    if (record) console.error('Wrote .jevlint/calibration.json');
    if (report.results.some(({ passed, moved }) => !passed || moved)) process.exitCode = 1;
  },
});
