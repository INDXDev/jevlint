import { describe, expect, it } from 'vitest';
import { extractModule } from '../src/architecture/extract.ts';
import type { Language } from '../src/types.ts';

const outline = (path: string, source: string, language: Language) =>
  extractModule(path, source, language);

describe('extractModule data types', () => {
  it('reads TypeScript interfaces, object type aliases and classes with fields', () => {
    const source = `export interface Order {
  id: string;
  lines: Line[];
  meta: {
    /** Set by the server. */
    created: Date; // when
  };
}
type Line = { sku: string };
type Id = string;
class Repo { db: Db = null as never; save() {} }
class Empty { run() {} }
`;
    const { types } = outline('a.ts', source, 'typescript');
    expect(types?.map(({ name }) => name)).toEqual(['Order', 'Line', 'Repo']);
    expect(types?.[0]).toEqual({
      name: 'Order',
      line: 1,
      fields: [
        { name: 'id', type: 'string' },
        { name: 'lines', type: 'Line[]' },
        { name: 'meta', type: '{ created: Date; }' },
      ],
    });
    expect(types?.[2]?.fields).toEqual([{ name: 'db', type: 'Db' }]);
  });

  it('does not let a nested type leak its fields into the outer one', () => {
    const source = `class Outer {
  a: number = 1;
  inner() { class Inner { b: string = ''; } return Inner; }
}`;
    const types = outline('a.ts', source, 'typescript').types ?? [];
    expect(types.find(({ name }) => name === 'Outer')?.fields).toEqual([
      { name: 'a', type: 'number' },
    ]);
    expect(types.find(({ name }) => name === 'Inner')?.fields).toEqual([
      { name: 'b', type: 'string' },
    ]);
  });

  it('reads JavaScript class fields', () => {
    expect(outline('a.js', 'class K { y = 1; }', 'javascript').types).toEqual([
      { name: 'K', line: 1, fields: [{ name: 'y', type: '' }] },
    ]);
  });

  it('reads annotated Python fields only', () => {
    const source = 'class A:\n    b: list[B]\n    c: str = ""\n    d = 3\n';
    expect(outline('a.py', source, 'python').types?.[0]?.fields).toEqual([
      { name: 'b', type: 'list[B]' },
      { name: 'c', type: 'str' },
    ]);
  });

  it('reads Go structs, not other type specs', () => {
    const source = 'package x\ntype A struct {\n B []B\n C string\n}\ntype N int\n';
    expect(outline('a.go', source, 'go').types).toEqual([
      {
        name: 'A',
        line: 2,
        fields: [
          { name: 'B', type: '[]B' },
          { name: 'C', type: 'string' },
        ],
      },
    ]);
  });

  it('reads Rust structs', () => {
    expect(
      outline('src/a.rs', 'struct A { b: Vec<B>, c: String }', 'rust').types?.[0]?.fields,
    ).toEqual([
      { name: 'b', type: 'Vec<B>' },
      { name: 'c', type: 'String' },
    ]);
  });
});

describe('extractModule comments', () => {
  it('keeps comments that explain, merging adjacent lines, and drops doc comments and directives', () => {
    const source = `/** Doc comment that says what the function does at length. */
// A repository may plant a symlink here, so the file is
// replaced rather than written through.
const a = 1;
// biome-ignore lint/suspicious/noExplicitAny: the type comes from a third party library
const b = 2;
// short
const c = 3;
/* A block comment that explains why the cache key holds the model. */
`;
    expect(outline('a.ts', source, 'typescript').comments).toEqual([
      {
        line: 2,
        text: 'A repository may plant a symlink here, so the file is replaced rather than written through.',
      },
      { line: 9, text: 'A block comment that explains why the cache key holds the model.' },
    ]);
  });

  it.each([
    ['a.py', '# Python needs this because the parser drops blank lines.\nx = 1\n', 'python'],
    ['a.go', 'package x\n// Go keeps this because the standard library has no domain.\n', 'go'],
    ['src/a.rs', '// Rust keeps this to avoid a second borrow of the map.\nfn f() {}\n', 'rust'],
  ] as const)('reads comments in %s', (path, source, language) => {
    expect(outline(path, source, language).comments).toHaveLength(1);
  });

  it('skips Python type and lint directives', () => {
    const source =
      'x = 1  # type: ignore[assignment] because of the old stubs\n# noqa: E501 this line is long\n';
    expect(outline('a.py', source, 'python').comments).toEqual([]);
  });
});
