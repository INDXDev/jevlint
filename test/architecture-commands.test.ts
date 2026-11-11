import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Each case starts a real process, which is slow while the whole suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 });

const CLI = join(import.meta.dirname, '../src/cli.ts');
const DIR = '.jevlint/architecture';

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), 'jevlint-arch-cli-')));

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

const CODE = {
  'src/web/page.ts':
    "import { query } from '../db/client.ts';\nexport const page = () => query();\n",
  'src/db/client.ts': 'export function query() { return 1; }\n',
};

const SSOT = {
  [`${DIR}/index.yaml`]:
    'version: 1\nname: shop\ndescription: A shop.\nlayers: [web, data]\nrules:\n  - { id: down, kind: layers }\n',
  [`${DIR}/components/web.yaml`]:
    'id: web\ntitle: Web\nsummary: Pages.\nlayer: web\npaths: ["src/web/**"]\ndepends_on: [db]\n',
  [`${DIR}/components/db.yaml`]:
    'id: db\ntitle: Database\nsummary: Orders.\nlayer: data\npaths: ["src/db/**"]\ndepends_on: []\n',
};

const REVERSED = "import '../web/page.ts';\nexport function query() { return 1; }\n";

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

describe('jevlint architecture routing', () => {
  it('reviews with no subcommand, as before, and with paths', () => {
    const cwd = project(CODE);
    const plain = jevlint(cwd, 'architecture', '--ast-only');
    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain('jevlint architecture');
    expect(plain.stdout).toContain('Architecture score');
    const withPath = jevlint(cwd, 'architecture', 'src', '--ast-only');
    expect(withPath.status).toBe(0);
    expect(withPath.stdout).toContain('Architecture score');
    expect(jevlint(cwd, 'architecture', 'review', '--ast-only', '--json').status).toBe(0);
  });

  it('lists the subcommands in its help', () => {
    const { stdout, status } = jevlint(project(), 'architecture', '--help');
    expect(status).toBe(0);
    for (const name of ['review', 'compile', 'list', 'show', 'check', 'drift', 'plan']) {
      expect(stdout).toContain(name);
    }
  });

  it('rejects an unknown flag for a subcommand', () => {
    const { status, stderr } = jevlint(project(CODE), 'architecture', 'show', '--nope');
    expect(status).toBe(2);
    expect(stderr).toContain('Unknown flag --nope for jevlint architecture show');
  });
});

describe('jevlint architecture list', () => {
  it('exits 0 with an SSOT, and 2 without one or with a broken one', () => {
    const cwd = project({ ...CODE, ...SSOT });
    const ok = jevlint(cwd, 'architecture', 'list');
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('2 components');
    expect(
      JSON.parse(jevlint(cwd, 'architecture', 'list', '--json').stdout).components,
    ).toHaveLength(2);
    const missing = jevlint(project(CODE), 'architecture', 'list');
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('jevlint architecture compile');
    writeFileSync(join(cwd, DIR, 'components/web.yaml'), 'id: web\n');
    expect(jevlint(cwd, 'architecture', 'list').status).toBe(2);
  });

  it('warns on stderr over the size budget', () => {
    const long = 'One. Two. Three. Four.';
    const cwd = project({
      ...SSOT,
      [`${DIR}/components/db.yaml`]: SSOT[`${DIR}/components/db.yaml`].replace('Orders.', long),
    });
    const { status, stderr } = jevlint(cwd, 'architecture', 'list');
    expect(status).toBe(0);
    expect(stderr).toContain('Warning: db: the summary has more than 3 sentences');
  });
});

describe('jevlint architecture show', () => {
  it('draws a draft with no SSOT, in every format', () => {
    const cwd = project(CODE);
    const text = jevlint(cwd, 'architecture', 'show');
    expect(text.status).toBe(0);
    expect(text.stderr).toContain('This is a draft');
    expect(JSON.parse(jevlint(cwd, 'architecture', 'show', '--json').stdout).draft).toBe(true);
    expect(jevlint(cwd, 'architecture', 'show', '--markdown').stdout).toContain('```mermaid');
    const html = join(cwd, 'out.html');
    expect(jevlint(cwd, 'architecture', 'show', '--html', html).status).toBe(0);
    expect(readFileSync(html, 'utf8')).not.toMatch(/<script/i);
  });

  it('draws views of the SSOT, and refuses an unknown one', () => {
    const cwd = project({ ...CODE, ...SSOT });
    const layers = jevlint(cwd, 'architecture', 'show', '--view', 'layers');
    expect(layers.status).toBe(0);
    expect(layers.stderr).not.toContain('draft');
    expect(jevlint(cwd, 'architecture', 'show', '--view', 'component:db').stdout).toContain(
      'src/db/client.ts',
    );
    const unknown = jevlint(cwd, 'architecture', 'show', '--view', 'component:ghost');
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('No component "ghost"');
    expect(jevlint(cwd, 'architecture', 'show', '--view', 'sideways').status).toBe(2);
  });
});

describe('jevlint architecture check and drift', () => {
  it('exits 0 when the code follows the SSOT, and 1 when it does not', () => {
    const cwd = project({ ...CODE, ...SSOT });
    expect(jevlint(cwd, 'architecture', 'check', '--static').status).toBe(0);
    writeFileSync(join(cwd, 'src/db/client.ts'), REVERSED);
    const failing = jevlint(cwd, 'architecture', 'check', '--static');
    expect(failing.status).toBe(1);
    expect(failing.stdout).toContain('layer-violation');
    expect(
      JSON.parse(jevlint(cwd, 'architecture', 'check', '--static', '--json').stdout).violations,
    ).toHaveLength(2);
    expect(jevlint(cwd, 'architecture', 'check', '--static', '--prompt').stdout).toContain(
      '# Make the code follow the architecture',
    );
  });

  it('needs a model for checklists without --static', () => {
    const cwd = project({
      ...CODE,
      ...SSOT,
      [`${DIR}/index.yaml`]: `${SSOT[`${DIR}/index.yaml`]}checklist:\n  - { id: x, text: "X." }\n`,
    });
    const { status, stderr } = jevlint(cwd, 'architecture', 'check');
    expect(status).toBe(2);
    expect(stderr).toContain('or pass --static');
  });

  it('exits 1 on drift, and refuses --docs with --static', () => {
    const cwd = project({ ...CODE, ...SSOT });
    expect(jevlint(cwd, 'architecture', 'drift', '--static').status).toBe(0);
    writeFileSync(join(cwd, 'src/stray.ts'), 'export const s = 1;\n');
    const drift = jevlint(cwd, 'architecture', 'drift', '--static');
    expect(drift.status).toBe(1);
    expect(drift.stdout).toContain('unmapped-code');
    expect(jevlint(cwd, 'architecture', 'drift', '--static', '--prompt').stdout).toContain(
      '# Update the architecture SSOT',
    );
    const both = jevlint(cwd, 'architecture', 'drift', '--static', '--docs');
    expect(both.status).toBe(2);
    expect(both.stderr).toContain('--docs asks a model');
  });
});

describe('jevlint architecture compile and plan', () => {
  it('prints a prompt, even when the SSOT does not load', () => {
    const cwd = project({ ...CODE, 'README.md': '# Shop\n' });
    const fresh = jevlint(cwd, 'architecture', 'compile');
    expect(fresh.status).toBe(0);
    expect(fresh.stdout).toContain('# Write the architecture SSOT');
    expect(fresh.stdout).toContain('jevlint architecture list');
    const withDocs = jevlint(cwd, 'architecture', 'compile', '--docs');
    expect(withDocs.status).toBe(0);
    expect(withDocs.stdout).toContain('- README.md');
    mkdirSync(join(cwd, DIR), { recursive: true });
    writeFileSync(join(cwd, DIR, 'index.yaml'), 'version: 2\n');
    const broken = jevlint(cwd, 'architecture', 'compile');
    expect(broken.status).toBe(0);
    expect(broken.stdout).toContain('The current SSOT does not load');
  });

  it('prints the plan as JSON, and the plan prompt', () => {
    const cwd = project({ ...CODE, ...SSOT, 'src/db/client.ts': REVERSED });
    const plan = JSON.parse(jevlint(cwd, 'architecture', 'plan', '--json').stdout);
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(jevlint(cwd, 'architecture', 'plan', '--prompt').stdout).toContain('plan.md');
  });
});

describe('the SSOT in other commands', () => {
  it('commits --architecture shows the violation a commit added, and exits 1', () => {
    const cwd = project({ ...CODE, ...SSOT });
    git(cwd, 'init', '-q');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-qm', 'base');
    writeFileSync(join(cwd, 'src/db/client.ts'), REVERSED);
    git(cwd, 'commit', '-qam', 'reverse');
    const { status, stdout } = jevlint(
      cwd,
      'commits',
      '--count',
      '1',
      '--architecture',
      '--ast-only',
    );
    expect(status).toBe(1);
    expect(stdout).toContain('Architecture');
    expect(stdout).toContain('layer-violation');
    const json = JSON.parse(
      jevlint(cwd, 'commits', '--count', '2', '--architecture', '--ast-only', '--json').stdout,
    );
    expect(json.map((review: { architecture: unknown[] }) => review.architecture.length)).toEqual([
      2, 0,
    ]);
    expect(jevlint(cwd, 'commits', '--architecture', '--format', 'sarif').status).toBe(2);
  });

  it('baseline records SSOT violations, which check --new then leaves out', () => {
    const cwd = project({ ...CODE, ...SSOT, 'src/db/client.ts': REVERSED });
    const home = tempDir();
    const baseline = jevlintAt(home, cwd, 'baseline', '--ast-only');
    expect(baseline.status).toBe(0);
    expect(baseline.stderr).toContain('2 architecture violations');
    const written = JSON.parse(readFileSync(join(cwd, '.jevlint/baseline.json'), 'utf8'));
    expect(written.architecture).toHaveLength(2);
    expect(jevlintAt(home, cwd, 'architecture', 'check', '--static', '--new').status).toBe(0);
  });

  it('baseline writes no architecture entries without an SSOT', () => {
    const cwd = project(CODE);
    expect(jevlint(cwd, 'baseline', '--ast-only').status).toBe(0);
    expect(existsSync(join(cwd, '.jevlint/baseline.json'))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(cwd, '.jevlint/baseline.json'), 'utf8')).architecture,
    ).toBeUndefined();
  });
});
