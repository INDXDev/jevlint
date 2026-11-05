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

export default defineConfig({
  entry: ['src/cli.ts', 'src/index.ts'],
  format: 'esm',
  dts: true,
  copy: grammars,
});
