/** `jevlint pr` and `jevlint commits`: review what a change did, not the whole repository. */
import { defineCommand } from 'citty';
import { type Config, UserError } from '../config.ts';
import { formatIssues, type OutputFormat, reviewIssues } from '../formats.ts';
import { changedFiles, commitsFrom, pullRequestChange } from '../git.ts';
import { formatReview } from '../report.ts';
import { reviewChange } from '../review.ts';
import type { Change, ChangeReview } from '../types.ts';
import {
  FORMAT_ARG,
  parseCount,
  parseFormat,
  printFallbackNotice,
  printJson,
  printNoKeyNotice,
  projectConfig,
  withSpinner,
} from './shared.ts';

const DEFAULT_COUNT = 10;

const REVIEW_ARGS = {
  json: { type: 'boolean', description: 'Print a JSON array, with one review per change' },
  format: FORMAT_ARG,
  'ast-only': { type: 'boolean', description: 'Use AST analysis only, with no provider requests' },
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
  intent: {
    type: 'boolean',
    description: "Judge each change against its message and the repository's instructions",
  },
} as const;

interface ReviewFlags {
  'ast-only'?: boolean;
  cache?: boolean;
  'ignore-pins'?: boolean;
  intent?: boolean;
}

/** Runs before a pull request is fetched, so a bad combination costs nothing. */
function assertUsableFlags(flags: ReviewFlags, format: OutputFormat): void {
  if (flags.intent && flags['ast-only']) {
    throw new UserError('--intent asks a model, so it cannot run with --ast-only.');
  }
  // These formats report per file, so a paid judgement of the whole change would vanish.
  if (flags.intent && format !== 'text' && format !== 'json') {
    throw new UserError(`--intent judges a whole change, so --format ${format} cannot show it.`);
  }
}

async function warnAboutSize(config: Config, changes: Change[]): Promise<void> {
  const files = await Promise.all(changes.map((change) => changedFiles(config.root, change)));
  const total = files.reduce((sum, { length }) => sum + length, 0);
  if (total > config.warn_file_count) {
    console.error(
      `Warning: ${total} changed files are in scope, and each is audited on both sides, which may be slow and costly. Press Ctrl-C to stop.`,
    );
  }
}

async function printReviews(
  config: Config,
  changes: Change[],
  flags: ReviewFlags,
  format: OutputFormat,
): Promise<void> {
  await warnAboutSize(config, changes);
  const astOnly = Boolean(flags['ast-only']);
  const options = {
    astOnly,
    ignorePins: Boolean(flags['ignore-pins']),
    noCache: !flags.cache,
    intent: Boolean(flags.intent),
  };
  const reviews = await withSpinner(async (onProgress) => {
    const done: ChangeReview[] = [];
    for (const change of changes) {
      done.push(await reviewChange(config, change, { ...options, onProgress }));
    }
    return done;
  });
  const [first] = reviews;
  if (first?.model === null && !astOnly) printNoKeyNotice(config);
  if (first) printFallbackNotice(config, first.provider);
  if (format === 'json') return printJson(reviews);
  if (format === 'text') return console.log(reviews.map(formatReview).join('\n\n'));
  console.log(formatIssues(reviewIssues(reviews), format));
}

/** The `pr` command. */
export const prCommand = defineCommand({
  meta: { name: 'jevlint pr', description: 'Review what a GitHub pull request changes' },
  args: {
    number: { type: 'positional', required: true, description: 'Pull request number' },
    ...REVIEW_ARGS,
  },
  async run({ args }) {
    const format = parseFormat(args);
    assertUsableFlags(args, format);
    const number = parseCount('The pull request number', args.number) as number;
    const config = await projectConfig();
    await printReviews(config, [await pullRequestChange(config.root, number)], args, format);
  },
});

/** The `commits` command. */
export const commitsCommand = defineCommand({
  meta: { name: 'jevlint commits', description: 'Review commits one by one, newest first' },
  args: {
    revision: {
      type: 'positional',
      required: false,
      default: 'HEAD',
      description: 'Commit to start from',
    },
    count: {
      type: 'string',
      valueHint: 'n',
      description: `Commits to review (default ${DEFAULT_COUNT})`,
    },
    ...REVIEW_ARGS,
  },
  async run({ args }) {
    const format = parseFormat(args);
    assertUsableFlags(args, format);
    const count = parseCount('--count', args.count) ?? DEFAULT_COUNT;
    const config = await projectConfig();
    await printReviews(config, await commitsFrom(config.root, args.revision, count), args, format);
  },
});
