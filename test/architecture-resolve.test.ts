import { describe, expect, it } from 'vitest';
import { extractModule } from '../src/architecture/extract.ts';
import { packageOf, type ResolveContext, resolveImport } from '../src/architecture/resolve.ts';

const imports = (source: string) => extractModule('x.ts', source, 'typescript').imports;

describe('extractModule imports', () => {
  it('keeps the line of each import', () => {
    const source = `const a = 1;\nimport b from './b.ts';\n\nexport { c } from './c.ts';\nconst d = require('./d.js');\n`;
    expect(imports(source).map(({ specifier, line }) => [specifier, line])).toEqual([
      ['./b.ts', 2],
      ['./c.ts', 4],
      ['./d.js', 5],
    ]);
  });

  it('reads named, default and re-exported names, and none for a namespace', () => {
    const source = [
      "import { a, b as c } from './named.ts';",
      "import d, { e } from './mixed.ts';",
      "import * as all from './all.ts';",
      "export { f } from './again.ts';",
      "import './side.ts';",
    ].join('\n');
    const byName = Object.fromEntries(imports(source).map((ref) => [ref.specifier, ref.names]));
    expect(byName).toEqual({
      './named.ts': ['a', 'b'],
      './mixed.ts': ['default', 'e'],
      './all.ts': undefined,
      './again.ts': ['f'],
      './side.ts': undefined,
    });
  });

  it('merges two imports of one module, and a whole-module import wins', () => {
    const merged = imports("import { a } from './m.ts';\nimport { b } from './m.ts';\n");
    expect(merged).toEqual([{ specifier: './m.ts', line: 1, names: ['a', 'b'] }]);
    const whole = imports("import { a } from './m.ts';\nimport * as m from './m.ts';\n");
    expect(whole).toEqual([{ specifier: './m.ts', line: 1 }]);
  });

  it('keeps lines for Python, Go and Rust', () => {
    expect(extractModule('a.py', 'x = 1\nimport os\n', 'python').imports).toEqual([
      { specifier: 'os', line: 2 },
    ]);
    const go = extractModule('a.go', 'package a\n\nimport "fmt"\n', 'go').imports;
    expect(go).toEqual([{ specifier: 'fmt', line: 3 }]);
    const rust = extractModule('src/a.rs', 'fn x() {}\nuse crate::b;\n', 'rust').imports;
    expect(rust).toEqual([{ specifier: 'crate::b', line: 2 }]);
  });
});

describe('resolveImport with aliases and workspaces', () => {
  const context: ResolveContext = {
    files: new Set([
      'src/lib/util.ts',
      'src/app.ts',
      'packages/core/src/index.ts',
      'packages/core/src/deep/x.ts',
      'packages/ui/main.ts',
    ]),
    aliases: [
      { pattern: '@/*', targets: ['src/*'] },
      { pattern: '~app', targets: ['src/app.ts'] },
    ],
    packages: [
      { name: '@acme/core', dir: 'packages/core', entries: [] },
      { name: 'ui', dir: 'packages/ui', entries: ['packages/ui/main.js'] },
    ],
  };
  const resolve = (specifier: string) =>
    resolveImport(specifier, 'src/app.ts', 'typescript', context);

  it('follows tsconfig paths', () => {
    expect(resolve('@/lib/util')).toBe('src/lib/util.ts');
    expect(resolveImport('~app', 'src/lib/util.ts', 'typescript', context)).toBe('src/app.ts');
  });

  it('follows workspace packages to their entries, src/index, or a subpath', () => {
    expect(resolve('@acme/core')).toBe('packages/core/src/index.ts');
    expect(resolve('@acme/core/deep/x')).toBe('packages/core/src/deep/x.ts');
    expect(resolve('ui')).toBe('packages/ui/main.ts');
  });

  it('leaves packages outside the repository unresolved', () => {
    expect(resolve('zod')).toBeNull();
  });

  it('drops an alias target that climbs out of the root', () => {
    const escaping = { ...context, aliases: [{ pattern: 'x', targets: ['../outside.ts'] }] };
    expect(resolveImport('x', 'src/app.ts', 'typescript', escaping)).toBeNull();
  });
});

describe('packageOf', () => {
  it.each([
    ['@ai-sdk/openai/sub', '@ai-sdk/openai'],
    ['zod/v4', 'zod'],
    ['node:fs/promises', 'node:fs'],
    ['fs', 'node:fs'],
    ['path/posix', 'node:path'],
    ['#internal', null],
    ['./a.ts', null],
    ['virtual:thing', null],
  ])('names the TypeScript package of %s', (specifier, expected) => {
    expect(packageOf(specifier, 'typescript')).toBe(expected);
  });

  it('names Python, Go and Rust packages', () => {
    expect(packageOf('requests.adapters', 'python')).toBe('requests');
    expect(packageOf('.sibling', 'python')).toBeNull();
    expect(packageOf('fmt', 'go')).toBe('go:fmt');
    expect(packageOf('github.com/a/b/c/d', 'go')).toBe('github.com/a/b');
    expect(packageOf('example.com/app/x', 'go', { goModule: 'example.com/app' })).toBeNull();
    expect(packageOf('serde::Deserialize', 'rust')).toBe('serde');
    expect(packageOf('std::fs', 'rust')).toBe('rust:std');
    expect(packageOf('crate::a', 'rust')).toBeNull();
  });
});
