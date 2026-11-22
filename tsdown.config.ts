import { defineConfig } from 'tsdown';

// Copying the prebuilt parsers lets the grammar packages stay devDependencies, so installing
// jevlint runs no install script. See src/ast/languages.ts.
const grammars = ['go', 'python', 'rust'].map((grammar) => ({
  from: [
    `node_modules/@ast-grep/lang-${grammar}/prebuilds`,
    `node_modules/@ast-grep/lang-${grammar}/LICENSE`,
  ],
  to: `dist/parsers/${grammar}`,
}));

// The built-in model parses with these grammars' WebAssembly builds, at the versions it was trained
// with. See src/decision/local/parse.ts.
const wasmGrammars = [
  ['tree-sitter-go', 'tree-sitter-go.wasm'],
  ['tree-sitter-javascript', 'tree-sitter-javascript.wasm'],
  ['tree-sitter-python', 'tree-sitter-python.wasm'],
  ['tree-sitter-rust', 'tree-sitter-rust.wasm'],
  ['tree-sitter-typescript', 'tree-sitter-tsx.wasm'],
].map(([name, wasm]) => ({
  from: [`node_modules/${name}/${wasm}`, `node_modules/${name}/LICENSE`],
  to: `dist/grammars/${name}`,
}));

export default defineConfig({
  entry: ['src/cli.ts', 'src/index.ts'],
  format: 'esm',
  dts: true,
  copy: [...grammars, ...wasmGrammars],
});
