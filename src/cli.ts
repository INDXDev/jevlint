#!/usr/bin/env node
/** Entry point: declares commands and maps errors to exit codes. */
// jevlint-score 76 -- Reviewed; the remaining gap is within model noise
import { existsSync } from 'node:fs';
import { type ArgsDef, type CommandDef, defineCommand, renderUsage, runCommand } from 'citty';
import pc from 'picocolors';
import pkg from '../package.json' with { type: 'json' };
import { architectureCommand } from './commands/architecture.ts';
import { auditCommand } from './commands/audit.ts';
import { askAboutEnvKeys, authCommand, usesProviderKey } from './commands/auth.ts';
import { baselineCommand } from './commands/baseline.ts';
import { cacheCommand } from './commands/cache.ts';
import { configCommand } from './commands/config.ts';
import { explainCommand } from './commands/explain.ts';
import { fixCommand } from './commands/fix.ts';
import { hookCommand } from './commands/hook.ts';
import { initCommand } from './commands/init.ts';
import { formatPresetList, presetCommand } from './commands/preset.ts';
import { promptCommand } from './commands/prompt.ts';
import { commitsCommand, prCommand } from './commands/review.ts';
import { testCommand } from './commands/test.ts';
import { UserError } from './config.ts';
import { isPatchedNode } from './node-version.ts';
import { withoutEscapes } from './report.ts';

const EXIT_ERROR = 2;
const HELP_FLAGS = ['--help', '-h'];
const VERSION_FLAGS = ['--version', '-v'];

const subCommands = {
  audit: auditCommand,
  baseline: baselineCommand,
  explain: explainCommand,
  architecture: architectureCommand,
  pr: prCommand,
  commits: commitsCommand,
  test: testCommand,
  prompt: promptCommand,
  fix: fixCommand,
  hook: hookCommand,
  init: initCommand,
  auth: authCommand,
  preset: presetCommand,
  cache: cacheCommand,
  config: configCommand,
};

const main = defineCommand({
  meta: {
    name: 'jevlint',
    version: pkg.version,
    description: 'A model-based linter that tells you what to refactor first. Defaults to audit',
  },
  subCommands,
});

const isRootFlag = (arg: string) => [...HELP_FLAGS, ...VERSION_FLAGS].includes(arg);

/** A flag belongs to audit unless the root handles it, and a path is something to audit. */
function startsAuditArgs(arg: string): boolean {
  return arg.startsWith('-') ? !isRootFlag(arg) : existsSync(arg);
}

/** Citty only falls back to a default command with no arguments at all, so route here instead. */
function withDefaultCommand(argv: string[]): string[] {
  const [first] = argv;
  if (first === undefined) return ['audit'];
  if (Object.hasOwn(subCommands, first)) return argv;
  return startsAuditArgs(first) ? ['audit', ...argv] : argv;
}

const subCommandsOf = (command: CommandDef) =>
  (command.subCommands ?? {}) as Record<string, CommandDef>;

/** Walks command names down from the root, returning the last match and the arguments after it. */
function resolveCommand(argv: string[]): { command: CommandDef; commandArgs: string[] } {
  let command = main as CommandDef;
  let depth = 0;
  for (const arg of argv) {
    const subCommands = subCommandsOf(command);
    if (!Object.hasOwn(subCommands, arg)) break;
    command = subCommands[arg] as CommandDef;
    depth += 1;
  }
  return { command, commandArgs: argv.slice(depth) };
}

const commandName = (command: CommandDef) => (command.meta as { name: string }).name;

function flagNames(args: ArgsDef): string[] {
  return Object.entries(args).flatMap(([name, { type }]) => {
    if (type === 'positional') return [];
    return type === 'boolean' ? [name, `no-${name}`] : [name];
  });
}

/** Everything after `--` is a positional argument. A negative number is a bad value, not a flag. */
function flagsIn(argv: string[]): string[] {
  const separator = argv.indexOf('--');
  const beforeSeparator = separator === -1 ? argv : argv.slice(0, separator);
  return beforeSeparator.filter((arg) => arg.startsWith('-') && !/^-\d/.test(arg));
}

function flagNameOf(flag: string): string {
  const [name = ''] = flag.replace(/^--?/, '').split('=');
  return name;
}

/** Citty ignores unknown flags, which would silently drop a typo like `--ast-onyl`. */
function rejectUnknownFlags(command: CommandDef, argv: string[]): void {
  const known = flagNames((command.args ?? {}) as ArgsDef);
  const unknownFlag = flagsIn(argv).find((flag) => !known.includes(flagNameOf(flag)));
  if (unknownFlag === undefined) return;
  const name = commandName(command);
  throw new UserError(`Unknown flag ${unknownFlag} for ${name}. Run: ${name} --help`);
}

/** Citty finds `constructor` on the prototype of its command table, and then does nothing. */
function rejectUnknownCommand(command: CommandDef, [first]: string[]): void {
  if (!command.subCommands || first === undefined || first.startsWith('-')) return;
  throw new UserError(`Unknown command ${first}. Run: ${commandName(command)} --help`);
}

/** Citty's own usage errors are not exported as a class, so they are matched by name. */
function asUsageError(error: Error, command: CommandDef): Error {
  if (error.name !== 'CLIError') return error;
  const sentence = error.message.replace(/\.$/, '');
  return new UserError(`${sentence}. Run: ${commandName(command)} --help`);
}

const PRESET_EXAMPLES = `Examples:
  jevlint audit security            Audit with one preset
  jevlint audit security solid src  Two presets, on src only
  jevlint preset                    Pick a preset, then show, edit or make it a default
  jevlint preset default            Choose the presets every audit uses
  jevlint preset new house-style    Write your own preset`;

/** Extra help for commands that take presets: what is available, and how to use it. */
async function helpFooter(command: CommandDef): Promise<string> {
  const name = commandName(command);
  if (name === 'jevlint') {
    return 'Presets choose what an audit checks. See them with: jevlint preset list';
  }
  if (!['jevlint audit', 'jevlint init', 'jevlint preset'].includes(name)) return '';
  // Help must still work in a directory whose config is broken.
  const list = await formatPresetList().catch(() => 'Run jevlint preset list to see them.');
  return `Presets:\n\n${list}\n\n${PRESET_EXAMPLES}`;
}

const isVersionRequest = (args: string[]) =>
  args.length === 1 && VERSION_FLAGS.includes(args[0] as string);

async function run(rawArgs: string[]): Promise<void> {
  if (!isPatchedNode(process.version)) {
    throw new UserError(
      `Node.js ${process.version} has known security holes. Upgrade to 24.22.1 or later, or to 22.23.4 or 26.12.1 on those lines.`,
    );
  }
  if (isVersionRequest(rawArgs)) return console.log(pkg.version);
  const argv = withDefaultCommand(rawArgs);
  const { command, commandArgs } = resolveCommand(argv);
  const wantsHelp = argv.some((arg) => HELP_FLAGS.includes(arg));
  if (wantsHelp) {
    const footer = await helpFooter(command);
    return console.log([await renderUsage(command), footer].filter(Boolean).join('\n'));
  }
  rejectUnknownCommand(command, commandArgs);
  rejectUnknownFlags(command, commandArgs);
  if (usesProviderKey(commandName(command), commandArgs)) await askAboutEnvKeys();
  await runCommand(main, { rawArgs: argv }).catch((error: Error) => {
    throw asUsageError(error, command);
  });
}

function reportError(error: unknown): void {
  process.exitCode = EXIT_ERROR;
  const isUserError = error instanceof UserError;
  const { message, stack } = error instanceof Error ? error : new Error(String(error));
  const shown = withoutEscapes(message);
  console.error(`${pc.red(isUserError ? 'Error:' : 'Unexpected error:')} ${shown}`);
  if (process.env.DEBUG && !isUserError) console.error(stack);
}

await run(process.argv.slice(2)).catch(reportError);
