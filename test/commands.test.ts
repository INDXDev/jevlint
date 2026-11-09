import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { confirm, multiselect, select, spinner } from '@clack/prompts';
import clipboard from 'clipboardy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { askAboutEnvKeys, usesProviderKey } from '../src/commands/auth.ts';
import { initCommand } from '../src/commands/init.ts';
import { promptCommand } from '../src/commands/prompt.ts';
import { everyProviderCallFailed, selectFiles, withSpinner } from '../src/commands/shared.ts';
import { getApiKey } from '../src/credentials.ts';
import type { AuditReport, FileReport } from '../src/types.ts';

vi.mock('@clack/prompts', async (original) => ({
  ...(await original<typeof import('@clack/prompts')>()),
  confirm: vi.fn(),
  select: vi.fn(),
  multiselect: vi.fn(),
  spinner: vi.fn(),
  isCancel: (answer: unknown) => answer === null,
}));
vi.mock('clipboardy', () => ({ default: { write: vi.fn() } }));

// Each case starts a real process, which is slow while the whole suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 });

const CLI = join(import.meta.dirname, '../src/cli.ts');
const NO_KEY_NOTICE = 'No API key found';
const MESSY = 'export function f(a, b, c, d, e, g) { return a + b + c + d + e + g; }\n';

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), 'jevlint-cli-')));

/** A directory with no config or keys, so a run stays AST-only and off the network. */
function project(files: Record<string, string> = {}): string {
  const dir = tempDir();
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function jevlintAt(home: string, cwd: string, ...args: string[]) {
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home };
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
}

const jevlint = (cwd: string, ...args: string[]) => jevlintAt(tempDir(), cwd, ...args);

describe('scope warnings', () => {
  const HOME_WARNING = 'running in your home directory';
  const MANY_WARNING = 'files are in scope';

  it.each([[['--ast-only']], [['--dry-run', '--json']], [['architecture', '--ast-only']]])(
    'warns about the home directory for %j',
    (args) => {
      const home = project({ 'a.ts': 'const a = 1;\n' });
      expect(jevlintAt(home, home, ...args).stderr).toContain(HOME_WARNING);
    },
  );

  it('does not warn when paths narrow a run in the home directory', () => {
    const home = project({ 'a.ts': 'const a = 1;\n' });
    expect(jevlintAt(home, home, 'a.ts', '--ast-only').stderr).not.toContain(HOME_WARNING);
  });

  it('warns only above the file limit, and keeps stdout as JSON', () => {
    const files = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${i}.ts`, '']));
    const many = jevlint(project(files(1001)), '--dry-run', '--json');
    expect(many.stderr).toContain(`1001 ${MANY_WARNING}`);
    expect(JSON.parse(many.stdout).files).toEqual([]);
    expect(jevlint(project(files(1000)), '--dry-run', '--json').stderr).not.toContain(MANY_WARNING);
  });

  it('takes the file limit from warn_file_count', () => {
    const cwd = project({ 'jevlint.toml': 'warn_file_count = 1\n', 'a.ts': '', 'b.ts': '' });
    expect(jevlint(cwd, '--dry-run', '--json').stderr).toContain(`2 ${MANY_WARNING}`);
  });
});

describe('command routing', () => {
  it.each([['constructor'], ['__proto__'], ['auth', 'constructor'], ['toString', '--json']])(
    'rejects %s as an unknown command',
    (...args) => {
      const { status, stderr } = jevlint(project(), ...args);
      expect(status).toBe(2);
      expect(stderr).toContain('Unknown command');
    },
  );

  it('treats a path named after an Object method as a path', () => {
    const cwd = project({ 'constructor/a.ts': MESSY });
    const { status, stdout } = jevlint(cwd, 'audit', 'constructor', '--ast-only', '--json');
    expect(status).toBe(0);
    expect(JSON.parse(stdout).files).toHaveLength(1);
  });
});

describe('--fail-under', () => {
  it('exits 1 when the score is below the threshold', () => {
    const { status } = jevlint(project({ 'a.ts': MESSY }), '--ast-only', '--fail-under', '100');
    expect(status).toBe(1);
  });

  it('exits 2 when no file was scored, rather than passing on nothing', () => {
    const { status, stderr } = jevlint(project(), '--ast-only', '--fail-under', '60');
    expect(status).toBe(2);
    expect(stderr).toContain('No file was scored');
  });

  it('exits 2 when every file was skipped', () => {
    const cwd = project({ 'a.sh': 'hello\n' });
    expect(jevlint(cwd, 'a.sh', '--ast-only', '--fail-under', '60').status).toBe(2);
  });

  it('counts a pinned file as scored', () => {
    const cwd = project({ 'a.sh': '# jevlint-score 90 -- Reviewed\n' });
    expect(jevlint(cwd, 'a.sh', '--ast-only', '--fail-under', '60').status).toBe(0);
  });

  it('accepts an empty audit when no gate is set', () => {
    expect(jevlint(project(), '--ast-only').status).toBe(0);
  });
});

describe('argument validation happens before the audit', () => {
  it.each([
    [['prompt', '--top', 'abc']],
    [['fix', '--agent', 'claude', '--yes', '--allow-dirty', '--top', 'abc']],
  ])('rejects a bad --top: %j', (args) => {
    const { status, stderr } = jevlint(project({ 'a.ts': MESSY }), ...args);
    expect(status).toBe(2);
    expect(stderr).toContain('--top must be');
    expect(stderr).not.toContain(NO_KEY_NOTICE);
  });

  it('rejects a directory given to explain', () => {
    const cwd = project({ 'src/a.ts': MESSY, 'src/b.ts': MESSY });
    const { status, stderr } = jevlint(cwd, 'explain', 'src');
    expect(status).toBe(2);
    expect(stderr).toContain('is a directory');
    expect(stderr).not.toContain(NO_KEY_NOTICE);
  });

  it('still explains a file', () => {
    const { status, stdout } = jevlint(project({ 'src/a.ts': MESSY }), 'explain', 'src/a.ts');
    expect(status).toBe(0);
    expect(stdout).toContain('src/a.ts');
  });

  it.each([[['--html']], [['--html', '--json']]])('needs a file for %j', (flags) => {
    const cwd = project({ 'a.ts': MESSY });
    const { status, stderr } = jevlint(cwd, 'architecture', '--ast-only', ...flags);
    expect(status).toBe(2);
    expect(stderr).toContain('--html needs a file');
    expect(existsSync(join(cwd, '--json'))).toBe(false);
  });
});

describe('architecture --html', () => {
  it('reports an unwritable file as a user error', () => {
    const cwd = project({ 'a.ts': MESSY });
    const { status, stderr } = jevlint(cwd, 'architecture', '--ast-only', '--html', 'no/x.html');
    expect(status).toBe(2);
    expect(stderr).toContain('Error: Could not write no/x.html');
    expect(stderr).not.toContain('Unexpected');
  });
});

describe('a gated run with an unanswered environment key', () => {
  const withEnvKey = (home: string, cwd: string, ...args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: home,
        XDG_CACHE_HOME: home,
        OPENAI_API_KEY: 'from-env',
      },
      encoding: 'utf8',
    });

  it('stops, because the gate would quietly lose its model', () => {
    const { status, stderr } = withEnvKey(
      tempDir(),
      project({ 'a.ts': MESSY }),
      'audit',
      '--fail-under',
      '1',
    );
    expect(status).toBe(2);
    expect(stderr).toContain('jevlint auth env on');
  });

  it('runs when the user refused the key, or asked for AST only', () => {
    const cwd = project({ 'a.ts': MESSY });
    expect(withEnvKey(tempDir(), cwd, 'audit', '--ast-only', '--fail-under', '1').status).toBe(0);
    const home = tempDir();
    jevlintAt(home, cwd, 'auth', 'env', 'off');
    expect(withEnvKey(home, cwd, 'audit', '--fail-under', '1').status).toBe(0);
  });

  it('runs with no gate', () => {
    const cwd = project({ 'a.ts': MESSY });
    expect(withEnvKey(tempDir(), cwd, 'audit').status).toBe(0);
  });
});

describe('jevlint commits and pr', () => {
  const git = (cwd: string, ...args: string[]) =>
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd });

  function repository(): string {
    const dir = project({ 'a.ts': 'export const a = 1;\n' });
    git(dir, 'init', '-q');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'first');
    writeFileSync(join(dir, 'a.ts'), MESSY);
    git(dir, 'commit', '-qam', 'second');
    return dir;
  }

  it('prints each commit newest first, as text or as JSON alone on stdout', () => {
    const dir = repository();
    const text = jevlint(dir, 'commits', '--ast-only');
    expect(text.status).toBe(0);
    expect(text.stdout.indexOf('second')).toBeLessThan(text.stdout.indexOf('first'));
    expect(text.stdout).toContain('Line 1:');

    const { stdout } = jevlint(dir, 'commits', '--ast-only', '--json', '--count', '1');
    expect(JSON.parse(stdout).map((review: { files: unknown[] }) => review.files)).toHaveLength(1);
  });

  it('keeps the commit message out of default JSON', () => {
    const { stdout } = jevlint(repository(), 'commits', '--ast-only', '--json', '--count', '1');
    const [review] = JSON.parse(stdout);
    expect(review).not.toHaveProperty('message');
    expect(review).not.toHaveProperty('intent');
  });

  it.each([[['commits']], [['pr', '7']]])('refuses --intent with --ast-only on %j', (args) => {
    const { status, stderr } = jevlint(repository(), ...args, '--intent', '--ast-only');
    expect(status).toBe(2);
    expect(stderr).toContain('--intent');
  });

  it.each([[['commits']], [['pr', '7']]])('refuses --intent with --format sarif on %j', (args) => {
    const { status, stderr } = jevlint(repository(), ...args, '--intent', '--format', 'sarif');
    expect(status).toBe(2);
    expect(stderr).toContain('--intent judges a whole change');
  });

  it('warns about --intent with no key, and carries on', () => {
    const { status, stdout, stderr } = jevlint(repository(), 'commits', '--intent', '--json');
    expect(status).toBe(0);
    expect(stderr).toContain(NO_KEY_NOTICE);
    expect(JSON.parse(stdout)[0]).not.toHaveProperty('intent');
  });

  it('exits 2 for a bad pull request number, before calling gh', () => {
    const { status, stderr } = jevlint(repository(), 'pr', 'main');
    expect(status).toBe(2);
    expect(stderr).toContain('must be a positive integer');
  });
});

describe('jevlint test', () => {
  const FIXTURE = '.jevlint/fixtures/readable-code.naming/good-a.ts';

  it('exits 2 with no key, as nothing can be tested', () => {
    const { status, stderr } = jevlint(project({ [FIXTURE]: 'const a = 1;\n' }), 'test');
    expect(status).toBe(2);
    expect(stderr).toContain(NO_KEY_NOTICE);
  });

  it('exits 2 with no fixtures', () => {
    const { status, stderr } = jevlint(project(), 'test');
    expect(status).toBe(2);
    expect(stderr).toContain('No fixtures to test');
  });

  it('exits 2 for an unknown question or a missing record', () => {
    const cwd = project({ [FIXTURE]: 'const a = 1;\n' });
    expect(jevlint(cwd, 'test', 'nope.nothing').status).toBe(2);
    const { status, stderr } = jevlint(cwd, 'test', '--drift');
    expect(status).toBe(2);
    expect(stderr).toContain('jevlint test --record');
  });

  it('exits 2 for a fixture link that leaves the repository', () => {
    const outside = project({ 'private.ts': 'const a = 1;\n' });
    const cwd = project({ [FIXTURE]: 'const a = 1;\n' });
    symlinkSync(join(outside, 'private.ts'), join(cwd, dirname(FIXTURE), 'bad-link.ts'));
    const { status, stderr } = jevlint(cwd, 'test');
    expect(status).toBe(2);
    expect(stderr).toContain('links outside the repository');
  });

  it('takes precedence over a directory of the same name, as other commands do', () => {
    const { stderr } = jevlint(project({ 'test/a.ts': 'const a = 1;\n' }), 'test');
    expect(stderr).toContain('No fixtures to test');
  });
});

describe('spec', () => {
  const INDEX = 'version: 1\nname: Shop\ndescription: An online shop.\n';
  const LOGIN =
    'id: login\ntitle: Login\nsummary: Signs customers in.\nchecklist:\n  - id: lockout\n    text: Five failed sign-ins lock the account.\n';
  const validSpec = {
    '.jevlint/spec/index.yaml': INDEX,
    '.jevlint/spec/features/login.yaml': LOGIN,
  };

  it('lists a valid spec and exits 0', () => {
    const { status, stdout } = jevlint(project(validSpec), 'spec', 'list');
    expect(status).toBe(0);
    expect(stdout).toContain('login.lockout');
    const json = jevlint(project(validSpec), 'spec', 'list', '--json');
    expect(JSON.parse(json.stdout).features[0].id).toBe('login');
  });

  it('exits 2 for an invalid spec, naming the file', () => {
    const cwd = project({ ...validSpec, '.jevlint/spec/features/login.yaml': 'id: Login\n' });
    const { status, stderr } = jevlint(cwd, 'spec', 'list');
    expect(status).toBe(2);
    expect(stderr).toContain('login.yaml');
  });

  it.each([['list'], ['check'], ['drift']])(
    '%s exits 2 with no spec, and says to compile',
    (sub) => {
      const { status, stderr } = jevlint(project(), 'spec', sub);
      expect(status).toBe(2);
      expect(stderr).toContain('jevlint spec compile');
    },
  );

  it('compiles a prompt naming the documents, never their contents', () => {
    const cwd = project({ 'README.md': 'SECRET README', 'docs/auth.md': 'SECRET AUTH' });
    const { status, stdout } = jevlint(cwd, 'spec', 'compile');
    expect(status).toBe(0);
    expect(stdout).toContain('`README.md`');
    expect(stdout).toContain('`docs/auth.md`');
    expect(stdout).not.toContain('SECRET');
  });

  it('compiles despite an invalid spec, and says why it failed', () => {
    const cwd = project({ 'README.md': '', '.jevlint/spec/index.yaml': 'version: 2\n' });
    const { status, stdout } = jevlint(cwd, 'spec', 'compile');
    expect(status).toBe(0);
    expect(stdout).toContain('failed to load');
  });

  it('exits 2 for a named document that does not exist', () => {
    const { status, stderr } = jevlint(project(), 'spec', 'compile', 'nope.md');
    expect(status).toBe(2);
    expect(stderr).toContain('nope.md');
  });

  it('exits 2 for check with no key, as it needs a model', () => {
    const cwd = project({ ...validSpec, 'a.ts': 'const a = 1;\n' });
    const { status, stderr } = jevlint(cwd, 'spec', 'check');
    expect(status).toBe(2);
    expect(stderr).toContain('needs a decision model');
  });
});

describe('usesProviderKey', () => {
  it.each([
    ['jevlint audit', [], true],
    ['jevlint fix', [], true],
    ['jevlint quickfix', [], true],
    ['jevlint pr', ['7'], true],
    ['jevlint commits', [], true],
    ['jevlint test', [], true],
    ['jevlint spec check', [], true],
    ['jevlint spec drift', [], true],
    ['jevlint spec compile', [], false],
    ['jevlint pr', ['7', '--ast-only'], false],
    ['jevlint audit', ['--ast-only'], false],
    ['jevlint architecture', ['--ast-only'], false],
    ['jevlint cache info', [], false],
    ['jevlint config path', [], false],
    ['jevlint auth env', ['on'], false],
  ])('%s %j gives %s', (name, args, expected) => {
    expect(usesProviderKey(name, args)).toBe(expected);
  });
});

describe('everyProviderCallFailed', () => {
  const failed = { model: null, warnings: ['Provider error: 503'] };
  const report = (files: unknown[], model: string | null = 'm') =>
    ({ model, files }) as unknown as AuditReport;

  it('is true when no file got an answer and one hit an error', () => {
    expect(everyProviderCallFailed(report([failed, { model: null, warnings: [] }]))).toBe(true);
  });

  it('is false when any file got an answer, as from the cache', () => {
    expect(everyProviderCallFailed(report([failed, { model: {}, warnings: [] }]))).toBe(false);
  });

  it('is false when a semantic rule got an answer', () => {
    const ruled = { model: null, ruleUsage: { modelCalls: 1 }, warnings: [] };
    expect(everyProviderCallFailed(report([failed, ruled]))).toBe(false);
  });

  it('is false when no model was in use', () => {
    expect(everyProviderCallFailed(report([{ model: null, warnings: [] }], null))).toBe(false);
  });
});

describe('init --force', () => {
  it('replaces a config too broken to load', () => {
    const cwd = project({ 'jevlint.toml': 'not toml [' });
    const { status } = jevlint(cwd, 'init', '--yes', '--force');
    expect(status).toBe(0);
    expect(readFileSync(join(cwd, 'jevlint.toml'), 'utf8')).toContain('[provider]');
  });

  it('still reports a broken config without --force', () => {
    const cwd = project({ 'jevlint.toml': 'not toml [' });
    expect(jevlint(cwd, 'init', '--yes').stderr).toContain('invalid TOML');
  });

  it('keeps the settings of a valid config', () => {
    const cwd = project({ 'jevlint.toml': '[provider]\nname = "openai"\n' });
    jevlint(cwd, 'init', '--yes', '--force');
    expect(readFileSync(join(cwd, 'jevlint.toml'), 'utf8')).toContain('"openai"');
  });
});

describe('files that never end', () => {
  it.each(['jevlint.toml', 'go.mod'])('refuses a %s linked to a device', (name) => {
    const cwd = project({ 'a.ts': MESSY });
    symlinkSync('/dev/zero', join(cwd, name));
    const { status, stderr } = jevlint(cwd, 'architecture', '--ast-only');
    expect(status).toBe(2);
    expect(stderr).toContain('not a regular file');
  });
});

describe('preset show', () => {
  it('lists semantic rules', () => {
    const cwd = project({
      '.jevlint/presets/m.toml': [
        'name = "m"',
        'description = "d"',
        'source = "s"',
        'questions = []',
        '[[rules]]',
        'id = "hides-failure"',
        'language = "typescript"',
        'pattern = "a()"',
        'question = "Q?"',
        'message = "Hides a failure"',
        'fix = "F"',
      ].join('\n'),
    });
    expect(jevlint(cwd, 'preset', 'show', 'm').stdout).toContain('hides-failure  Hides a failure');
  });
});

describe('choosing presets', () => {
  it('audits with a preset named in place of a path', () => {
    const cwd = project({ 'a.ts': MESSY });
    const { status, stdout } = jevlint(cwd, 'audit', 'security', '--ast-only');
    expect(status).toBe(0);
    expect(stdout).toMatch(/AST only {2}· {2}security\n/);
  });

  it('audits a path that shares a preset name, and says so', () => {
    const cwd = project({ 'solid/a.ts': MESSY });
    const { status, stdout, stderr } = jevlint(cwd, 'audit', 'solid', '--ast-only');
    expect(status).toBe(0);
    expect(stdout).toContain('solid/a.ts');
    expect(stdout).toContain('full');
    expect(stderr).toContain('use --preset solid');
  });

  it('sets, marks and prints the default presets', () => {
    const home = tempDir();
    const cwd = project({ 'a.ts': MESSY });
    expect(jevlintAt(home, cwd, 'preset', 'default', 'security,solid').status).toBe(0);
    expect(readFileSync(join(home, 'jevlint', 'config.toml'), 'utf8')).toContain(
      'presets = ["security","solid"]',
    );
    expect(jevlintAt(home, cwd, 'preset', 'default').stdout).toBe('security\nsolid\n');
    expect(jevlintAt(home, cwd, 'preset', 'list').stdout).toMatch(/^\* security /m);
    expect(jevlintAt(home, cwd, 'audit', '--ast-only').stdout).toContain('security, solid');
  });

  it('refuses an unknown default preset and writes nothing', () => {
    const home = tempDir();
    const { status, stderr } = jevlintAt(home, project(), 'preset', 'default', 'nope');
    expect(status).toBe(2);
    expect(stderr).toContain('Unknown preset "nope"');
    expect(existsSync(join(home, 'jevlint', 'config.toml'))).toBe(false);
  });

  it('lets init choose the default presets', () => {
    const cwd = project();
    expect(jevlint(cwd, 'init', '--yes', '--preset', 'security').status).toBe(0);
    expect(readFileSync(join(cwd, 'jevlint.toml'), 'utf8')).toContain('presets = ["security"]');
  });

  it('creates a preset from another, and edits a built-in through a copy', () => {
    const home = tempDir();
    const cwd = project();
    const created = jevlintAt(home, cwd, 'preset', 'new', 'mine', '--from', 'solid', '--no-edit');
    expect(created.status).toBe(0);
    expect(jevlintAt(home, cwd, 'preset', 'show', 'mine').stdout).toContain('mine.open-closed');
    const edited = jevlintAt(home, cwd, 'preset', 'edit', 'security', '--path');
    expect(edited.stdout.trim()).toBe(join(home, 'jevlint', 'presets', 'security.toml'));
    expect(edited.stderr).toContain('now overrides it');
    expect(jevlintAt(home, cwd, 'preset', 'show', 'security', '--toml').stdout).toMatch(
      /^name = "security"/,
    );
  });

  it('stops on a preset name with a typo instead of auditing nothing', () => {
    const { status, stderr } = jevlint(
      project({ 'a.ts': MESSY }),
      'audit',
      'secruity',
      '--ast-only',
    );
    expect(status).toBe(2);
    expect(stderr).toContain('Did you mean the preset "security"?');
  });

  it('groups presets by the command they serve', () => {
    const { stdout } = jevlint(project(), 'preset', 'list');
    const groups = stdout.split('\n\n');
    expect(groups[0]).toMatch(/^For audits/);
    expect(groups[0]).toContain('documentation');
    expect(groups[0]).not.toContain('architecture-class');
    expect(groups[1]).toMatch(/^For jevlint architecture:\n {2}architecture-class/);
  });

  it('lists the same presets in a pipe when run with no subcommand', () => {
    const cwd = project();
    expect(jevlint(cwd, 'preset').stdout).toBe(jevlint(cwd, 'preset', 'list').stdout);
  });

  it.each([['audit'], ['preset'], ['init'], ['prompt'], ['pr'], ['hook']])(
    'lists presets and examples in %s --help',
    (name) => {
      const { status, stdout } = jevlint(project(), name, '--help');
      expect(status).toBe(0);
      expect(stdout).toContain('* full');
      expect(stdout).toContain('jevlint audit security');
    },
  );

  it('still prints help where the config is broken', () => {
    const { status, stdout } = jevlint(
      project({ 'jevlint.toml': 'presets = [' }),
      'audit',
      '--help',
    );
    expect(status).toBe(0);
    expect(stdout).toContain('Run jevlint preset list to see them.');
  });

  it.each([['show'], ['edit'], ['remove']])('asks for a name to %s in a pipe', (action) => {
    const { status, stderr } = jevlint(project(), 'preset', action);
    expect(status).toBe(2);
    expect(stderr).toContain('Name a preset. Run: jevlint preset list');
  });

  it('refuses to open an editor with no terminal', () => {
    const { status, stderr } = jevlint(project(), 'preset', 'edit', 'solid');
    expect(status).toBe(2);
    expect(stderr).toContain('No terminal to edit in');
  });
});

describe('presets outside audit', () => {
  const HIDES_FAILURE = 'try { f(); } catch (e) { }\n';
  const FINDING = 'An empty catch hides the failure';
  // The default holds every audit preset, so these need a narrower one to compare with.
  const NARROW = { 'jevlint.toml': 'presets = ["readable-code"]\n' };

  it.each([
    ['named', ['prompt', 'bug-hunt']],
    ['flagged', ['prompt', '--preset', 'bug-hunt']],
  ])('builds a prompt from a %s preset', (_, args) => {
    const cwd = project({ ...NARROW, 'a.ts': HIDES_FAILURE });
    expect(jevlint(cwd, ...args).stdout).toContain(FINDING);
    expect(jevlint(cwd, 'prompt').stdout).not.toContain(FINDING);
  });

  it.each([
    ['named', ['explain', 'bug-hunt', 'a.ts']],
    ['flagged', ['explain', 'a.ts', '--preset', 'bug-hunt']],
  ])('explains a file with a %s preset', (_, args) => {
    const cwd = project({ 'a.ts': HIDES_FAILURE });
    expect(jevlint(cwd, ...args).stdout).toContain(FINDING);
  });

  it('keeps a chosen preset in the next-step hints', () => {
    const cwd = project({ 'a.ts': HIDES_FAILURE });
    const { stdout } = jevlint(cwd, 'audit', 'bug-hunt', '--ast-only');
    expect(stdout).toContain('Next: jevlint explain a.ts --preset bug-hunt');
    expect(stdout).toContain('jevlint prompt --top 1 --copy --preset bug-hunt');
    expect(jevlint(cwd, 'audit', '--ast-only').stdout).toContain('Next: jevlint explain a.ts\n');
  });

  it('asks for a file when explain gets only a preset', () => {
    const { status, stderr } = jevlint(project(), 'explain', 'bug-hunt');
    expect(status).toBe(2);
    expect(stderr).toContain('Name a file to explain.');
  });

  it('records a baseline with a preset', () => {
    const cwd = project({ 'a.ts': HIDES_FAILURE });
    expect(jevlint(cwd, 'baseline', 'bug-hunt', '--ast-only').status).toBe(0);
    expect(readFileSync(join(cwd, '.jevlint/baseline.json'), 'utf8')).toContain('empty-catch-ts');
    expect(jevlint(cwd, 'audit', 'bug-hunt', '--new', '--ast-only').status).toBe(0);
  });

  it('fixes what a preset found, and re-scores with the same preset', () => {
    const home = tempDir();
    mkdirSync(join(home, 'jevlint'));
    writeFileSync(join(home, 'jevlint/config.toml'), '[agents.noop]\ncommand = ["true"]\n');
    const cwd = project({ ...NARROW, 'a.ts': HIDES_FAILURE });
    const flags = ['--agent', 'noop', '--yes', '--allow-dirty'];
    expect(jevlintAt(home, cwd, 'fix', ...flags).stderr).toContain('Nothing to fix');
    const { status, stdout } = jevlintAt(home, cwd, 'fix', 'bug-hunt', ...flags);
    expect(status).toBe(0);
    expect(stdout).toMatch(/a\.ts 95 -> 95/);
  });

  it('reviews commits and staged changes with a preset', () => {
    const git = (...args: string[]) =>
      spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd });
    const cwd = project({ ...NARROW, 'a.ts': 'export const a = 1;\n' });
    git('init', '-q');
    git('add', '.');
    git('commit', '-qm', 'first');
    writeFileSync(join(cwd, 'a.ts'), HIDES_FAILURE);
    git('add', '.');
    expect(jevlint(cwd, 'hook', '--staged').status).toBe(0);
    const staged = jevlint(cwd, 'hook', '--staged', '--preset', 'bug-hunt');
    expect(staged.status).toBe(1);
    expect(staged.stdout).toContain(FINDING);
    git('commit', '-qm', 'second');
    const commits = ['commits', '--count', '1', '--ast-only'];
    expect(jevlint(cwd, ...commits).stdout).not.toContain(FINDING);
    expect(jevlint(cwd, ...commits, '--preset', 'bug-hunt').stdout).toContain(FINDING);
  });

  it('stops on an unknown preset', () => {
    const { status, stderr } = jevlint(project(), 'prompt', '--preset', 'bug-hnt');
    expect(status).toBe(2);
    expect(stderr).toContain('Did you mean "bug-hunt"?');
  });

  it('refuses a partial calibration record', () => {
    const { status, stderr } = jevlint(project(), 'test', '--record', '--preset', 'bug-hunt');
    expect(status).toBe(2);
    expect(stderr).toContain('takes no --preset');
  });
});

describe('multi-line text from a preset', () => {
  it('keeps its line breaks, but not its escape sequences', () => {
    const cwd = project({
      '.jevlint/presets/m.toml': [
        'name = "m"',
        'description = "one\\ntwo\\u001b[2J"',
        'source = "s"',
        '[[questions]]',
        'id = "q"',
        'title = "T"',
        'type = "boolean"',
        'instructions = "I"',
        'fix = "F"',
        'good = false',
      ].join('\n'),
    });
    const { stdout } = jevlint(cwd, 'preset', 'show', 'm');
    expect(stdout).toContain('one\ntwo?[2J');
  });
});

describe('symlinks planted in the repository', () => {
  it('replaces a link at the --html path rather than writing through it', () => {
    const cwd = project({ 'a.ts': MESSY });
    const victim = join(tempDir(), 'victim');
    writeFileSync(victim, 'mine');
    symlinkSync(victim, join(cwd, 'architecture.html'));
    jevlint(cwd, 'architecture', '--ast-only', '--html', 'architecture.html');
    expect(readFileSync(victim, 'utf8')).toBe('mine');
    expect(lstatSync(join(cwd, 'architecture.html')).isFile()).toBe(true);
  });

  it('replaces a dangling link at jevlint.toml rather than creating its target', () => {
    const cwd = project({ 'a.ts': MESSY });
    const victim = join(tempDir(), 'created.conf');
    symlinkSync(victim, join(cwd, 'jevlint.toml'));
    jevlint(cwd, 'init', '--yes');
    expect(existsSync(victim)).toBe(false);
    expect(lstatSync(join(cwd, 'jevlint.toml')).isFile()).toBe(true);
  });
});

describe('control characters from the repository', () => {
  it('keeps escape sequences out of prompt output, but not line breaks', () => {
    const cwd = project({ 'a\u001b[2J.ts': MESSY });
    const { stdout } = jevlint(cwd, 'prompt');
    expect(stdout).toContain('a?[2J.ts');
    expect(stdout).not.toContain('\u001b');
    expect(stdout).toContain('\n');
  });

  const HOSTILE = 'a\u001b[2J.ts';
  const SAFE = 'a?[2J.ts';

  const fix = (agent: string) => {
    const home = tempDir();
    mkdirSync(join(home, 'jevlint'));
    const config = `[agents.stub]\ncommand = ["${agent}"]\n`;
    writeFileSync(join(home, 'jevlint/config.toml'), config);
    const cwd = project({ [HOSTILE]: MESSY });
    return jevlintAt(home, cwd, 'fix', '--agent', 'stub', '--yes', '--allow-dirty');
  };

  it('stay out of what fix prints', () => {
    const { status, stdout, stderr } = fix('true');
    expect(status).toBe(0);
    expect(stdout).toContain(SAFE);
    expect(`${stdout}${stderr}`).not.toContain('\u001b');
  });

  it('stay out of error messages', () => {
    const { status, stderr } = fix('false');
    expect(status).toBe(2);
    expect(stderr).toContain(`Agent exited with code 1 on ${SAFE}`);
    expect(stderr).not.toContain('\u001b');
  });

  it.each([[['preset', 'list']], [['preset', 'show', 'hostile']]])('stay out of %j', (args) => {
    const preset = `name = "hostile"\ndescription = "a\\u001b[2Jb"\nsource = "s"\nquestions = []\n`;
    const { status, stdout } = jevlint(
      project({ '.jevlint/presets/hostile.toml': preset }),
      ...args,
    );
    expect(status).toBe(0);
    expect(stdout).toContain('a?[2Jb');
    expect(stdout).not.toContain('\u001b');
  });
});

describe('quickfix', () => {
  const FIXED = 'export const f = 1;\n';
  const writes = (content: string) =>
    `require('node:fs').writeFileSync('a.ts', ${JSON.stringify(content)}); console.log('chatter');`;

  const quickfix = (script: string, files: Record<string, string>, ...flags: string[]) => {
    const home = tempDir();
    mkdirSync(join(home, 'jevlint'));
    const command = JSON.stringify([process.execPath, '-e', script]);
    writeFileSync(
      join(home, 'jevlint/config.toml'),
      `[agents.stub]\nquickfix_command = ${command}\ncommand = ["false"]\n`,
    );
    const cwd = project(files);
    return jevlintAt(home, cwd, 'quickfix', '--agent', 'stub', '--yes', '--allow-dirty', ...flags);
  };

  it('prints a plain patch on stdout, and the agent and the summary on stderr', () => {
    const { status, stdout, stderr } = quickfix(writes(FIXED), { 'a.ts': MESSY });
    expect(status).toBe(0);
    expect(stdout).toMatch(/^diff --git a\/a\.ts b\/a\.ts\n--- a\/a\.ts\n\+\+\+ b\/a\.ts\n@@ /);
    expect(stdout).toContain('+export const f = 1;');
    expect(stdout).not.toContain('chatter');
    expect(stdout).not.toContain('\u001b');
    expect(stderr).toContain('chatter');
    expect(stderr).toContain('1 file changed, 1 insertions(+), 1 deletions(-)');
  });

  it('prints each file and its diffs as JSON', () => {
    const { status, stdout } = quickfix(writes(FIXED), { 'a.ts': MESSY }, '--json');
    expect(status).toBe(0);
    const [file] = JSON.parse(stdout).files;
    expect(file.path).toBe('a.ts');
    expect(file.diffs).toMatchObject([{ path: 'a.ts', status: 'modified', additions: 1 }]);
  });

  it('shows what a failed agent changed, then exits 2', () => {
    const { status, stdout, stderr } = quickfix(`${writes(FIXED)} process.exit(3);`, {
      'a.ts': MESSY,
    });
    expect(status).toBe(2);
    expect(stdout).toContain('+export const f = 1;');
    expect(stderr).toContain('Agent exited with code 3 on a.ts. Its changes so far are shown.');
  });

  it('leaves a key in the environment out with --agent-login, and says so when it fails', () => {
    const home = tempDir();
    mkdirSync(join(home, 'jevlint'));
    // Fails like Claude Code does when the key in the environment is invalid.
    const script = `${writes(FIXED)} process.exit(process.env.JEVLINT_FAKE_KEY ? 1 : 0);`;
    const command = JSON.stringify([process.execPath, '-e', script]);
    const config = `[agents.stub]
command = ${command}
key_env = ["JEVLINT_FAKE_KEY"]
`;
    writeFileSync(join(home, 'jevlint/config.toml'), config);
    const run = (...flags: string[]) => {
      const env = {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: home,
        XDG_CACHE_HOME: home,
      };
      const args = [CLI, 'quickfix', '--agent', 'stub', '--yes', '--allow-dirty', ...flags];
      const cwd = project({ 'a.ts': MESSY });
      return spawnSync(process.execPath, args, {
        cwd,
        env: { ...env, JEVLINT_FAKE_KEY: 'invalid' },
        encoding: 'utf8',
      });
    };
    const failed = run();
    expect(failed.status).toBe(2);
    expect(failed.stderr).toContain(
      'JEVLINT_FAKE_KEY is set, and stub uses it instead of its own login.',
    );
    expect(failed.stderr).toContain('retry with --agent-login');
    const passed = run('--agent-login');
    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain('+export const f = 1;');
  });

  it('says when the agent changed nothing', () => {
    const { status, stderr } = quickfix('', { 'a.ts': MESSY });
    expect(status).toBe(0);
    expect(stderr).toContain('stub changed nothing for a.ts.');
  });

  it('runs no agent when nothing needs fixing', () => {
    const { status, stdout, stderr } = quickfix('process.exit(9)', { 'a.ts': FIXED }, '--json');
    expect(status).toBe(0);
    expect(stderr).toContain('Nothing to fix');
    expect(JSON.parse(stdout)).toEqual({ files: [] });
  });

  it('keeps escape sequences from the repository out of the diff', () => {
    const { status, stdout } = quickfix(writes('y\u001b[2J\n'), { 'a.ts': MESSY });
    expect(status).toBe(0);
    expect(stdout).toContain('+y?[2J');
    expect(stdout).not.toContain('\u001b');
  });
});

describe('selectFiles', () => {
  const file = (path: string, line?: number) =>
    ({
      path,
      ast: line && {
        score: 0.5,
        findings: [{ rule: 'nesting', message: 'deep', line, value: 8, limit: 4 }],
      },
      model: null,
    }) as FileReport;
  const report = { files: [file('clean.ts'), file('a.ts', 1), file('b.ts', 2)] } as AuditReport;
  const pathsOf = (files: FileReport[]) => files.map(({ path }) => path);

  it('counts only files with something to fix', () => {
    expect(pathsOf(selectFiles(report, [], undefined))).toEqual(['a.ts']);
    expect(pathsOf(selectFiles(report, [], 2))).toEqual(['a.ts', 'b.ts']);
  });

  it('uses every named file with issues when no count is given', () => {
    expect(pathsOf(selectFiles(report, ['.'], undefined))).toEqual(['a.ts', 'b.ts']);
  });
});

describe('interactive commands', () => {
  const stdinIsTTY = process.stdin.isTTY;
  const stderrIsTTY = process.stderr.isTTY;

  beforeEach(() => {
    vi.stubEnv('XDG_CONFIG_HOME', tempDir());
    vi.stubEnv('XDG_CACHE_HOME', tempDir());
    vi.stubEnv('TYPESAFE_AI_API_KEY', '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.stdin.isTTY = stdinIsTTY;
    process.stderr.isTTY = stderrIsTTY;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('stops init at the first cancelled prompt', async () => {
    const cwd = project();
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    process.stdin.isTTY = true;
    vi.mocked(select).mockResolvedValue(null);
    const args = { _: [], user: false, yes: false, force: false };

    await expect(initCommand.run?.({ args } as never)).rejects.toThrow('Cancelled.');
    expect(multiselect).not.toHaveBeenCalled();
    expect(existsSync(join(cwd, 'jevlint.toml'))).toBe(false);
  });

  it('keeps control characters out of the progress line', async () => {
    const message = vi.fn();
    vi.mocked(spinner).mockReturnValue({ start: vi.fn(), clear: vi.fn(), message } as never);
    process.stderr.isTTY = true;

    await withSpinner(async (onProgress) => onProgress?.(1, 2, 'a\u001b[2J.ts'));
    expect(message).toHaveBeenCalledWith('1/2 a?[2J.ts');
  });

  it('asks once about environment keys and remembers the answer', async () => {
    vi.stubEnv('TYPESAFE_AI_API_KEY', 'from-env');
    process.stdin.isTTY = true;
    vi.mocked(confirm).mockClear().mockResolvedValue(true);

    await askAboutEnvKeys();
    await askAboutEnvKeys();
    expect(confirm).toHaveBeenCalledOnce();
    expect(await getApiKey('typesafe')).toBe('from-env');
  });

  it('leaves environment keys off without a terminal', async () => {
    vi.stubEnv('TYPESAFE_AI_API_KEY', 'from-env');
    process.stdin.isTTY = false;
    vi.mocked(confirm).mockClear();

    await askAboutEnvKeys();
    expect(confirm).not.toHaveBeenCalled();
    expect(await getApiKey('typesafe')).toBeUndefined();
  });

  it('reports a missing clipboard as a user error', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(project({ 'a.ts': MESSY }));
    vi.mocked(clipboard.write).mockRejectedValue(new Error('no xsel'));

    await expect(promptCommand.run?.({ args: { _: [], copy: true } } as never)).rejects.toThrow(
      'Could not copy the prompt: no xsel',
    );
  });
});
