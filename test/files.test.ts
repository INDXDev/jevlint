import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Config, loadConfig, UserError } from '../src/config.ts';
import { discoverDocs, discoverFiles } from '../src/files.ts';

let home: string;
let root: string;

const write = async (files: Record<string, string>) => {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
};
const configWith = (overrides: Partial<Config> = {}) => loadConfig({ cwd: root, overrides });

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'jevlint-files-'));
  root = join(home, 'repo');
  await mkdir(root);
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', join(home, 'config'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('a config below the top of the git repository', () => {
  it('still applies the .gitignore files above it', async () => {
    await write({
      '.git/HEAD': 'ref: refs/heads/main',
      '.gitignore': 'private.ts\npkg/app/local.ts\n',
      'pkg/.gitignore': 'app/generated.ts\n',
      'pkg/app/jevlint.toml': '',
      'pkg/app/kept.ts': '',
      'pkg/app/private.ts': '',
      'pkg/app/local.ts': '',
      'pkg/app/generated.ts': '',
    });
    const config = await loadConfig({ cwd: join(root, 'pkg/app') });
    expect(await discoverFiles(config)).toEqual(['kept.ts']);
  });
});

describe('discoverFiles', () => {
  it('returns sorted root-relative paths, including dot directories', async () => {
    await write({ 'b.ts': '', 'src/a.ts': '', '.github/x.sh': '', '.git/config': '' });
    expect(await discoverFiles(await configWith())).toEqual(['.github/x.sh', 'b.ts', 'src/a.ts']);
  });

  it.each([
    '.env',
    '.env.local',
    'config/server.pem',
    'a.key',
    'a.p12',
    'a.pfx',
    'id_rsa.pub',
    'aws-credentials.json',
    'my_secret.txt',
    'node_modules/x/index.js',
    'packages/a/node_modules/x/index.js',
    'dist/a.js',
    'build/a.js',
    'vendor/a.go',
    'target/a.rs',
    'coverage/a.js',
    'a.min.js',
    'a.js.map',
    'yarn.lock',
    'pnpm-lock.yaml',
    'README.md',
    'config.toml',
    'LICENSE',
    'go.sum',
    'logo.png',
    'font.woff2',
    '.node-version',
    '.nvmrc',
    '.DS_Store',
    '.editorconfig',
    'docs/demo.tape',
    'src/.python-version',
    'bin/tool',
  ])('always excludes %s', async (file) => {
    await write({ [file]: 'x', 'keep.ts': '' });
    expect(await discoverFiles(await configWith())).toEqual(['keep.ts']);
  });

  it('never returns secrets that are passed explicitly', async () => {
    await write({ '.env': 'x', 'certs/a.pem': 'x', 'a.ts': '' });
    const config = await configWith();
    expect(await discoverFiles(config, ['.env', 'certs/a.pem', 'certs'])).toEqual([]);
  });

  it('does not let ignore lists re-include secrets', async () => {
    await write({ '.env': 'x', '.gitignore': '!.env\n' });
    const config = await configWith({ exclude: ['!.env', '!*.pem'] });
    expect(await discoverFiles(config)).toEqual([]);
  });

  it('skips binary files', async () => {
    await write({ 'a.ts': 'a\0b', 'b.ts': '' });
    expect(await discoverFiles(await configWith())).toEqual(['b.ts']);
  });

  it('keeps source files whatever the case of the extension', async () => {
    await write({ 'a.PY': '', 'b.rb': '', 'c.sh': '' });
    expect(await discoverFiles(await configWith())).toEqual(['a.PY', 'b.rb', 'c.sh']);
  });

  it('audits source files in less common languages', async () => {
    await write({ 'a.sol': '', 'b.f90': '', 'c.nix': '', 'd.txt': '' });
    expect(await discoverFiles(await configWith())).toEqual(['a.sol', 'b.f90', 'c.nix']);
  });

  it('does not let include or paths bring in files that are not source', async () => {
    await write({ 'src/.node-version': '24', 'src/a.ts': '' });
    const config = await configWith({ include: ['src/**', 'src/.node-version'] });
    expect(await discoverFiles(config)).toEqual(['src/a.ts']);
    expect(await discoverFiles(config, ['src/.node-version'])).toEqual([]);
  });

  it('respects root and nested .gitignore files', async () => {
    await write({
      '.gitignore': 'ignored.ts\n',
      'pkg/.gitignore': '/local.ts\n',
      'ignored.ts': '',
      'pkg/ignored.ts': '',
      'pkg/local.ts': '',
      'local.ts': '',
    });
    expect(await discoverFiles(await configWith())).toEqual(['local.ts']);
  });

  it('applies include and exclude', async () => {
    await write({ 'src/a.ts': '', 'src/a.test.ts': '', 'b.ts': '' });
    const config = await configWith({ include: ['src/**'], exclude: ['*.test.ts'] });
    expect(await discoverFiles(config)).toEqual(['src/a.ts']);
  });

  it('narrows to files and directories', async () => {
    await write({ 'src/a.ts': '', 'src/b/c.ts': '', 'srcs/d.ts': '', 'e.ts': '' });
    const config = await configWith();
    expect(await discoverFiles(config, ['src/b', 'e.ts'])).toEqual(['e.ts', 'src/b/c.ts']);
    expect(await discoverFiles(config, ['src'])).toEqual(['src/a.ts', 'src/b/c.ts']);
    expect(await discoverFiles(config, [join(root, 'e.ts')])).toEqual(['e.ts']);
    expect(await discoverFiles(config, ['.'])).toHaveLength(4);
  });

  it('rejects paths outside the root', async () => {
    await writeFile(join(home, 'outside.ts'), '');
    const config = await configWith();
    for (const path of ['../outside.ts', join(home, 'outside.ts'), 'a/../../outside.ts']) {
      await expect(discoverFiles(config, [path])).rejects.toThrow(UserError);
    }
  });

  it('rejects a path that does not exist', async () => {
    await expect(discoverFiles(await configWith(), ['nope.ts'])).rejects.toThrow(/not found/);
  });

  it('does not let include reach above the root', async () => {
    await write({ 'a.ts': '' });
    await writeFile(join(home, 'outside.ts'), '');
    const config = await configWith({ include: ['../*.ts', join(home, '*.ts'), '**/*'] });
    expect(await discoverFiles(config)).toEqual(['a.ts']);
  });

  it('does not follow symlinks out of the root', async () => {
    await mkdir(join(home, 'out'));
    await writeFile(join(home, 'out', 'o.ts'), '');
    await write({ 'a.ts': '' });
    await symlink(join(home, 'out'), join(root, 'dirlink'));
    await symlink(join(home, 'out', 'o.ts'), join(root, 'filelink.ts'));
    const config = await configWith();
    expect(await discoverFiles(config)).toEqual(['a.ts']);
    expect(await discoverFiles(config, ['filelink.ts', 'dirlink'])).toEqual([]);
  });

  it.each(['dirlink/o.ts', 'dirlink/*.ts', './dirlink/*', 'real/dirlink/*.ts'])(
    'does not let include %s pass through a symlinked directory',
    async (pattern) => {
      await mkdir(join(home, 'out'));
      await writeFile(join(home, 'out', 'o.ts'), '');
      await write({ 'real/a.ts': '' });
      await symlink(join(home, 'out'), join(root, 'dirlink'));
      await symlink(join(home, 'out'), join(root, 'real', 'dirlink'));
      expect(await discoverFiles(await configWith({ include: [pattern] }))).toEqual([]);
    },
  );

  // Root ignores file modes, so nothing would be unreadable.
  it.skipIf(process.getuid?.() === 0)(
    'keeps an unreadable file for audit to warn about',
    async () => {
      await write({ 'a.ts': '', 'locked.ts': '' });
      await chmod(join(root, 'locked.ts'), 0);
      expect(await discoverFiles(await configWith())).toEqual(['a.ts', 'locked.ts']);
    },
  );
});

describe('discoverDocs', () => {
  const docsConfig = (docs: string[]) =>
    configWith({ spec: { dir: '.jevlint/spec', docs } } as Partial<Config>);

  it('finds the README and docs, ignoring include and the extension filter', async () => {
    await write({ 'README.md': '', 'docs/a.md': '', 'docs/deep/b.md': '', 'src/a.ts': '' });
    const config = await configWith({ include: ['src/**'] });
    expect(await discoverDocs(config)).toEqual(['README.md', 'docs/a.md', 'docs/deep/b.md']);
  });

  it('keeps the built-in exclusions even for every file', async () => {
    await write({
      'README.md': '',
      '.env': 'x',
      id_rsa: 'x',
      'my-secret.md': 'x',
      '.gitignore': '!.env\n',
    });
    expect(await discoverDocs(await docsConfig(['**/*']))).toEqual(['.gitignore', 'README.md']);
  });

  it('respects .gitignore and narrows by paths', async () => {
    await write({
      '.gitignore': 'docs/private.md\n',
      'README.md': '',
      'docs/a.md': '',
      'docs/private.md': '',
    });
    const config = await configWith();
    expect(await discoverDocs(config)).toEqual(['README.md', 'docs/a.md']);
    expect(await discoverDocs(config, ['docs'])).toEqual(['docs/a.md']);
  });

  it('drops patterns that point above the root', async () => {
    await writeFile(join(home, 'outside.md'), '');
    await write({ 'README.md': '' });
    expect(await discoverDocs(await docsConfig(['../*.md', 'README.md']))).toEqual(['README.md']);
  });
});
