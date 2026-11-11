import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { Experimental_DecisionMockModelV4 as MockModel } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractModule } from '../src/architecture/extract.ts';
import { layersOf, stronglyConnected } from '../src/architecture/graph.ts';
import { renderArchitectureHtml } from '../src/architecture/html.ts';
import { resolveImport } from '../src/architecture/resolve.ts';
import { reviewArchitecture } from '../src/architecture/review.ts';
import { buildStructure } from '../src/architecture/structure.ts';
import { formatArchitecture } from '../src/architecture/terminal.ts';
import { type Config, loadConfig } from '../src/config.ts';
import { createDecisionModel, type ResolvedModel } from '../src/decision/providers.ts';
import type { Language } from '../src/types.ts';

vi.mock('../src/decision/providers.ts', () => ({ createDecisionModel: vi.fn() }));

const LIMITS = {
  max_fan_out: 2,
  max_hub_links: 1,
  max_directory_files: 3,
  max_class_methods: 2,
  max_class_lines: 10,
  max_inheritance_depth: 1,
};

const outline = (path: string, source: string, language: Language = 'typescript') =>
  extractModule(path, source, language);

const specifiers = (path: string, source: string, language: Language = 'typescript') =>
  outline(path, source, language).imports.map(({ specifier }) => specifier);

/** An outline with its imports already resolved, as `buildStructure` takes it. */
const resolvedOutline = (path: string, source: string) => ({
  ...outline(path, source),
  imports: [],
});

const moduleAt = (path: string, imports: string[] = []) => ({
  path,
  language: 'typescript' as const,
  lines: 10,
  imports,
  symbols: [],
  classes: [],
});

describe('extractModule', () => {
  it('reads static, re-exported and dynamic imports', () => {
    const source = `import a from './a.ts';
export { b } from './b.ts';
const c = require('./c.js');
const d = await import('./d.ts');
`;
    expect(specifiers('x.ts', source)).toEqual(['./a.ts', './b.ts', './c.js', './d.ts']);
  });

  it('reads TypeScript import-require', () => {
    expect(specifiers('x.ts', `import a = require('./a');\n`)).toEqual(['./a']);
  });

  it('reads Python imports, keeping relative dots', () => {
    const source = `import os, pkg.mod as m
from . import sibling
from ..core import a as b, c
from .models import *
`;
    expect(specifiers('x.py', source, 'python')).toEqual([
      'os',
      'pkg.mod',
      '.sibling',
      '..core.a',
      '..core.c',
      '.models',
    ]);
  });

  it('reads Go imports', () => {
    const source = `package main
import (
  "fmt"
  store "example.com/app/store"
)
`;
    expect(specifiers('x.go', source, 'go')).toEqual(['fmt', 'example.com/app/store']);
  });

  it('reads Rust use groups and file modules, but not inline modules', () => {
    const source = `use crate::a::{b, c as d};
use super::e;
mod f;
mod inline { }
`;
    expect(specifiers('src/x.rs', source, 'rust')).toEqual([
      'crate::a::b',
      'crate::a::c',
      'super::e',
      'self::f',
    ]);
  });

  it.each<[Language, string, string[]]>([
    [
      'javascript',
      'export function a() {}\nconst b = 1;\nclass C {}\nimport x from "y";',
      ['a', 'b', 'C'],
    ],
    ['typescript', 'export interface A {}\nexport const b = 1;', ['A', 'b']],
    ['python', 'def a(): pass\n@dec\ndef b(): pass\nclass C: pass\nimport d', ['a', 'b', 'C']],
    ['go', 'package p\nimport "x"\nfunc A() {}\ntype B struct{}', ['A', 'B']],
    ['rust', 'use a::b;\nfn c() {}\nstruct D;', ['c', 'D']],
    ['javascript', 'const a = 1, b = 2;', ['a', 'b']],
    ['typescript', 'namespace n.m {}', ['n.m']],
    ['typescript', 'declare module "foo" {}', ['"foo"']],
    ['go', 'package p\ntype (\n  A struct{}\n  B struct{}\n)', ['A', 'B']],
  ])('lists top-level symbols in %s', (language, source, symbols) => {
    expect(outline('x', source, language).symbols).toEqual(symbols);
  });

  it('keeps literals out of symbols, because an outline never holds file contents', () => {
    const source = `const { token = 'hunter2' } = config;\nexport const safe = 1;\n`;
    expect(outline('x.ts', source).symbols).toEqual(['safe']);
  });

  it.each<[Language, string, string, number, string[]]>([
    ['javascript', 'class A extends B { m() {} n() {} }', 'A', 2, ['B']],
    [
      'typescript',
      'abstract class A<T> extends B<T> implements C { m(): void {} }',
      'A',
      1,
      ['B', 'C'],
    ],
    ['typescript', 'class 商品 extends Größe { m() {} }', '商品', 1, ['Größe']],
    ['javascript', 'class $Store extends $Base { m() {} }', '$Store', 1, ['$Base']],
    ['tsx', 'class A extends B { m() {} }', 'A', 1, ['B']],
    [
      'python',
      'class A(B):\n    def m(self): pass\n    @dec\n    def n(self): pass\n',
      'A',
      2,
      ['B'],
    ],
    ['rust', 'impl Show for A { fn m(&self) {} }\nimpl A { fn n(&self) {} }', 'A', 2, ['Show']],
  ])('outlines a class in %s', (language, source, name, methods, bases) => {
    const [found] = outline('x', source, language).classes;
    expect(found?.name).toBe(name);
    expect(found?.methods).toHaveLength(methods);
    expect(found?.bases).toEqual(expect.arrayContaining(bases));
  });

  it.each<[Language, string, string]>([
    ['typescript', 'class A extends Repo<User> {}', 'Repo'],
    ['rust', 'impl From<Bar> for A {}', 'From'],
    ['python', 'class A(Base, metaclass=Meta):\n    pass\n', 'Base'],
    ['python', 'class A(Base[User]):\n    pass\n', 'Base'],
  ])('counts only real parents as bases in %s', (language, source, parent) => {
    const bases = outline('x', source, language).classes[0]?.bases;
    expect(bases).toContain(parent);
    expect(bases).not.toEqual(expect.arrayContaining(['User']));
    expect(bases).not.toEqual(expect.arrayContaining(['Bar']));
    expect(bases).not.toEqual(expect.arrayContaining(['Meta']));
  });

  it('merges a Go type with methods declared outside it', () => {
    const source = `package p
type Store struct{}
func (s *Store) Get() {}
func (s Store) Put() {}
`;
    expect(outline('x.go', source, 'go').classes).toMatchObject([
      { name: 'Store', methods: ['Get', 'Put'] },
    ]);
  });
});

describe('resolveImport', () => {
  const files = new Set([
    'index.ts',
    'src/a.ts',
    'src/lib/index.ts',
    'pkg/__init__.py',
    'pkg/core.py',
    'pkg/sub/leaf.py',
    'src/app.py',
    'store/0.ts',
    'store/a.go',
    'store/a_test.go',
    'mysrc/src/main.rs',
    'mysrc/src/util.rs',
    'src/main.rs',
    'src/net/mod.rs',
    'src/net/tcp.rs',
  ]);
  const context = { files, goModule: 'example.com/app' };

  it.each<[string, string, Language, string | null]>([
    ['./a.js', 'src/b.ts', 'typescript', 'src/a.ts'],
    ['./a', 'src/b.ts', 'typescript', 'src/a.ts'],
    ['./lib', 'src/b.ts', 'typescript', 'src/lib/index.ts'],
    ['../src/a.ts', 'test/b.ts', 'typescript', 'src/a.ts'],
    ['./', 'src/lib/b.ts', 'typescript', 'src/lib/index.ts'],
    ['./lib/', 'src/b.ts', 'typescript', 'src/lib/index.ts'],
    ['.', 'b.ts', 'typescript', 'index.ts'],
    ['../..', 'src/lib/b.ts', 'typescript', 'index.ts'],
    ['../../../outside.ts', 'src/b.ts', 'typescript', null],
    ['react', 'src/b.ts', 'typescript', null],
    ['pkg.core', 'main.py', 'python', 'pkg/core.py'],
    ['pkg.core.helper', 'main.py', 'python', 'pkg/core.py'],
    ['app', 'main.py', 'python', 'src/app.py'],
    ['.core', 'pkg/x.py', 'python', 'pkg/core.py'],
    ['..core', 'pkg/sub/leaf.py', 'python', 'pkg/core.py'],
    ['.missing', 'pkg/x.py', 'python', 'pkg/__init__.py'],
    ['os', 'main.py', 'python', null],
    ['example.com/app/store', 'main.go', 'go', 'store/a.go'],
    ['fmt', 'main.go', 'go', null],
    ['crate::net::tcp::Stream', 'src/main.rs', 'rust', 'src/net/tcp.rs'],
    ['crate::net', 'src/main.rs', 'rust', 'src/net/mod.rs'],
    ['self::tcp', 'src/net/mod.rs', 'rust', 'src/net/tcp.rs'],
    ['super::tcp', 'src/net/udp.rs', 'rust', 'src/net/tcp.rs'],
    ['crate::util', 'mysrc/src/main.rs', 'rust', 'mysrc/src/util.rs'],
    ['std::fs', 'src/main.rs', 'rust', null],
  ])('resolves %s from %s', (specifier, from, language, expected) => {
    expect(resolveImport(specifier, from, language, context)).toBe(expected);
  });

  it('never links a file to itself', () => {
    expect(resolveImport('./a.ts', 'src/a.ts', 'typescript', context)).toBeNull();
  });
});

describe('graph', () => {
  const dependencies = new Map([
    ['a', new Set(['b'])],
    ['b', new Set(['c'])],
    ['c', new Set(['b', 'd'])],
  ]);

  it('finds cycles, with dependencies first', () => {
    expect(stronglyConnected(['a', 'b', 'c', 'd'], dependencies)).toEqual([
      ['d'],
      ['b', 'c'],
      ['a'],
    ]);
  });

  it('keeps a cycle in one layer', () => {
    const components = stronglyConnected(['a', 'b', 'c', 'd'], dependencies);
    expect(Object.fromEntries(layersOf(components, dependencies))).toEqual({
      d: 0,
      b: 1,
      c: 1,
      a: 2,
    });
  });
});

describe('graph at scale', () => {
  it('walks a chain deeper than the call stack', () => {
    const size = 20_000;
    const nodes = Array.from({ length: size }, (_, index) => `n${index}`);
    const chain = new Map(
      nodes.map((node, index) => [node, new Set(nodes.slice(index + 1, index + 2))]),
    );
    const components = stronglyConnected(nodes, chain);
    expect(components[0]).toEqual([`n${size - 1}`]);
    expect(layersOf(components, chain).get('n0')).toBe(size - 1);
  });

  it('takes more dependencies than a call has arguments', () => {
    const leaves = Array.from({ length: 200_000 }, (_, index) => `n${index}`);
    const wide = new Map([['top', new Set(leaves)]]);
    const components = stronglyConnected(['top'], wide);
    expect(layersOf(components, wide).get('top')).toBe(1);
  });
});

describe('buildStructure', () => {
  const rules = (files: Parameters<typeof buildStructure>[0]) =>
    buildStructure(files, LIMITS).findings.map(({ rule, path }) => `${rule}:${path}`);

  it('reports a module cycle and marks its edges', () => {
    const structure = buildStructure(
      [
        moduleAt('x/a.ts', ['x/b.ts']),
        moduleAt('x/b.ts', ['x/a.ts']),
        moduleAt('x/c.ts', ['x/a.ts']),
      ],
      LIMITS,
    );
    expect(structure.findings[0]).toMatchObject({
      rule: 'dependency-cycle',
      value: 2,
      symbol: 'x/a.ts, x/b.ts',
      directories: ['x'],
    });
    expect(structure.edges.modules.filter(({ cyclic }) => cyclic)).toHaveLength(2);
  });

  it('reports sibling directories that depend on each other', () => {
    const found = rules([
      moduleAt('a/x.ts', ['b/y.ts']),
      moduleAt('b/y.ts'),
      moduleAt('b/z.ts', ['a/w.ts']),
      moduleAt('a/w.ts'),
    ]);
    expect(found).toEqual(['directory-cycle:a']);
  });

  it('does not treat a folder and its subfolder as a cycle', () => {
    const found = rules([
      moduleAt('src/a.ts', ['src/ast/b.ts']),
      moduleAt('src/ast/b.ts'),
      moduleAt('src/ast/c.ts', ['src/d.ts']),
      moduleAt('src/d.ts'),
    ]);
    expect(found).toEqual([]);
  });

  it('reports fan-out, hubs and oversized directories', () => {
    const found = rules([
      moduleAt('d/a.ts', ['d/hub.ts']),
      moduleAt('d/b.ts', ['d/hub.ts']),
      moduleAt('d/hub.ts', ['d/x.ts', 'd/y.ts', 'd/z.ts']),
      moduleAt('d/x.ts'),
      moduleAt('d/y.ts'),
      moduleAt('d/z.ts'),
    ]);
    expect(found).toEqual(['fan-out:d/hub.ts', 'hub:d/hub.ts', 'directory-files:d']);
  });

  it('links classes and reports big classes and deep inheritance', () => {
    const source = `class A {}
class B extends A {}
class C extends B { m() {} n() {} o() { return new D(); } }
class D {}
`;
    const structure = buildStructure([resolvedOutline('a.ts', source)], LIMITS);
    expect(structure.edges.classes).toContainEqual(
      expect.objectContaining({ from: 'a.ts#C', to: 'a.ts#B', kind: 'inherits' }),
    );
    expect(structure.edges.classes).toContainEqual(
      expect.objectContaining({ from: 'a.ts#C', to: 'a.ts#D', kind: 'uses' }),
    );
    expect(structure.findings.map(({ rule }) => rule)).toEqual([
      'class-methods',
      'inheritance-depth',
    ]);
  });

  it('does not count a type argument towards inheritance depth', () => {
    const source = `class Entity {}
class Model extends Entity {}
class User extends Model {}
class Repo<T> {}
class UserRepo extends Repo<User> {}
`;
    const structure = buildStructure([resolvedOutline('a.ts', source)], LIMITS);
    expect(structure.findings.map(({ symbol }) => symbol)).toEqual(['User']);
    expect(structure.edges.classes).toContainEqual(
      expect.objectContaining({ from: 'a.ts#UserRepo', to: 'a.ts#User', kind: 'uses' }),
    );
  });

  it('leaves a class name declared twice unlinked', () => {
    const files = [
      resolvedOutline('a.ts', 'class Same {}\nclass A extends Same {}'),
      resolvedOutline('b.ts', 'class Same {}'),
    ];
    expect(buildStructure(files, LIMITS).edges.classes).toEqual([]);
  });
});

describe('reviewArchitecture', () => {
  let root: string;
  let config: Config;

  const write = async (files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'jevlint-architecture-'));
    vi.mocked(createDecisionModel).mockResolvedValue(null);
    config = await loadConfig({ cwd: root });
    config = {
      ...config,
      root,
      cache: { dir: join(root, '.cache-dir') },
      exclude: ['.cache-dir/**'],
    };
    await write({
      'a/x.ts': `import '../b/y.ts';\n`,
      'b/y.ts': `import '../a/x.ts';\nexport function secretLogic() { return 'hunter2'; }\n`,
      'c/z.ts': 'export const z = 1;\n',
    });
  });

  afterEach(() => rm(root, { recursive: true, force: true }));

  // Root ignores file modes, so nothing would be unreadable.
  it.skipIf(process.getuid?.() === 0)('leaves out a file it cannot read', async () => {
    await chmod(join(root, 'c/z.ts'), 0);
    const report = await reviewArchitecture(config, { astOnly: true });
    expect(report.modules.map(({ path }) => path)).toEqual(['a/x.ts', 'b/y.ts']);
    expect(report.warnings).toEqual([expect.stringContaining('c/z.ts')]);
    expect(formatArchitecture(report, { top: 5 })).toContain('c/z.ts');
    expect(renderArchitectureHtml(report)).toContain('c/z.ts');
  });

  it('scores tangled directories below clean ones, worst first', async () => {
    const report = await reviewArchitecture(config, { astOnly: true });
    expect(report.units.map(({ name, score }) => [name, score])).toEqual([
      ['a', 50],
      ['b', 50],
      ['codebase', 50],
      ['c', 100],
    ]);
    expect(report.perspectives).toEqual({ codebase: 50, directory: 63 });
    expect(report.model).toBeNull();
    expect(report.score).toBeLessThan(100);
  });

  it('sends an outline to the model, never file contents, and caches it', async () => {
    const seen: string[] = [];
    const model = new MockModel({
      doDecide: async ({ state, questions }) => {
        seen.push(JSON.stringify(state));
        return {
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [id, { type: 'score', score: 3 }]),
          ),
          usage: { inputTokens: 5 },
          warnings: [],
        } as never;
      },
    });
    vi.mocked(createDecisionModel).mockResolvedValue({
      model,
      provider: 'typesafe',
      modelId: 'm',
    } as unknown as ResolvedModel);

    const report = await reviewArchitecture(config);
    expect(report.usage.modelCalls).toBe(4);
    expect(report.units.find(({ name }) => name === 'c')?.model?.score).toBe(1);
    const outlineOfB = seen.find((state) => state.includes('Directory: b'));
    expect(outlineOfB).toContain('secretLogic');
    expect(outlineOfB).toContain('Depends on: a/x.ts');
    expect(seen.join()).not.toContain('hunter2');

    const again = await reviewArchitecture(config);
    expect(again.usage).toMatchObject({ modelCalls: 0, cacheHits: 4 });
  });

  it('asks each perspective its own questions, and leaves out classes with nothing to judge', async () => {
    await write({ 'c/k.ts': `export class Busy { run() {} }\nexport class Empty {}\n` });
    const asked: Record<string, string[]> = {};
    const model = new MockModel({
      doDecide: async ({ state, questions }) => {
        const [kind = ''] = JSON.stringify(state).match(/Codebase|Directory|Class/) ?? [];
        asked[kind] = Object.keys(questions);
        return {
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [id, { type: 'score', score: 0 }]),
          ),
          usage: { inputTokens: 1 },
          warnings: [],
        } as never;
      },
    });
    vi.mocked(createDecisionModel).mockResolvedValue({
      model,
      provider: 'typesafe',
      modelId: 'm',
    } as unknown as ResolvedModel);

    const report = await reviewArchitecture(config, { noCache: true });
    expect(asked.Class).toContain('architecture-class.responsibility');
    expect(asked.Directory).toContain('architecture-directory.cohesion');
    expect(asked.Codebase).toContain('architecture-codebase.layering');
    expect(report.units.find(({ name }) => name === 'c/k.ts#Empty')).toBeUndefined();
    expect(report.units.find(({ name }) => name === 'c/k.ts#Busy')?.model).not.toBeNull();

    const classesOnly = await reviewArchitecture(config, {
      noCache: true,
      perspectives: ['class'],
    });
    expect(new Set(classesOnly.units.map(({ perspective }) => perspective))).toEqual(
      new Set(['class']),
    );
    expect(classesOnly.usage.modelCalls).toBe(1);
    expect(renderArchitectureHtml(classesOnly)).toContain('Busy');
  });

  it('renders the problems for the terminal', async () => {
    const text = stripVTControlCharacters(
      formatArchitecture(await reviewArchitecture(config, { astOnly: true }), { top: 2 }),
    );
    expect(text).toContain('Directories 63');
    expect(text).toContain('2 more. Show them with --top 4');
    expect(text).toContain('a/x.ts:1  modules in a cycle 2 (max 1) in a/x.ts, b/y.ts');
  });

  it('keeps control characters from the repository away from the terminal', async () => {
    const hostile = 'c/\x1b]0;pwned\x07\x1b[2J.ts';
    await write({ [hostile]: `import './z.ts';\n` });
    const report = await reviewArchitecture(
      { ...config, architecture: { ...config.architecture, max_fan_out: 0 } },
      { astOnly: true },
    );
    const text = stripVTControlCharacters(formatArchitecture(report, { top: 20 }));
    expect(text).toContain('fan-out');
    expect(text).not.toMatch(/\x1b|\x07/);
    const raw = formatArchitecture(report, { top: 20 });
    expect(raw).not.toContain('\x1b]');
    expect(raw).not.toContain('\x1b[2J');
  });

  it('shows why a unit has no model score', async () => {
    const model = new MockModel({
      doDecide: async () => {
        throw new Error('provider down <b>');
      },
    });
    vi.mocked(createDecisionModel).mockResolvedValue({
      model,
      provider: 'typesafe',
      modelId: 'm',
    } as unknown as ResolvedModel);
    const report = await reviewArchitecture(config, { perspectives: ['codebase'], noCache: true });
    expect(formatArchitecture(report, { top: 5 })).toContain('codebase: Provider error');
    expect(renderArchitectureHtml(report)).toContain('provider down &lt;b&gt;');
  });

  it('explains an empty report', async () => {
    const empty = await reviewArchitecture(
      { ...config, include: ['nothing/**'] },
      { astOnly: true },
    );
    expect(empty.units).toEqual([]);
    expect(formatArchitecture(empty, { top: 5 })).toContain('No source files');
    expect(renderArchitectureHtml(empty)).toContain('No structural problems');
  });

  it('escapes repository names in the HTML, and needs no scripts', async () => {
    await write({ 'c/<img src=x onerror=alert(1)>.ts': `import './z.ts';\n` });
    const html = renderArchitectureHtml(await reviewArchitecture(config, { astOnly: true }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).not.toMatch(/<script|https?:\/\//);
    expect(html).toContain('class="edge cyclic');
  });

  it('marks every box in a cycle, even when its score looks fine or was not asked for', async () => {
    const boxes = (html: string, status: string) => html.split(`class="node ${status} `).length - 1;
    const scored = await reviewArchitecture(config, { astOnly: true });
    const unscored = await reviewArchitecture(config, { astOnly: true, perspectives: ['class'] });
    // Two modules and two directories.
    expect(boxes(renderArchitectureHtml(scored), 'critical')).toBe(4);
    expect(boxes(renderArchitectureHtml(unscored), 'critical')).toBe(4);
  });

  it('marks a box with a finding when its unit was not asked for', async () => {
    await write({ 'c/k.ts': 'export class Big { a() {} b() {} }\n' });
    const limits = { ...config.architecture, max_class_methods: 1 };
    const report = await reviewArchitecture(
      { ...config, architecture: limits },
      { astOnly: true, perspectives: ['codebase'] },
    );
    const box = renderArchitectureHtml(report).match(/class="node (\w+) h\d+"><title>Big in/);
    expect(box?.[1]).toBe('warning');
  });
});
