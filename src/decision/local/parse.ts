/** Parses code for the built-in model with web-tree-sitter and the grammars it was trained with. */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Language, Parser } from 'web-tree-sitter';
import type { LanguageName, Parse, SyntaxNode } from './features.ts';

// TypeScript is parsed with the TSX grammar, which also parses plain TypeScript, as in training.
const GRAMMARS: Record<LanguageName, string> = {
  go: 'tree-sitter-go/tree-sitter-go.wasm',
  javascript: 'tree-sitter-javascript/tree-sitter-javascript.wasm',
  python: 'tree-sitter-python/tree-sitter-python.wasm',
  rust: 'tree-sitter-rust/tree-sitter-rust.wasm',
  typescript: 'tree-sitter-typescript/tree-sitter-tsx.wasm',
};

/** Real files parse in well under 0.1 s, but error recovery can run away on text in another language. */
export const PARSE_TIMEOUT_MS = 3000;

/**
 * The build copies each grammar's `.wasm` next to the bundle, so an install needs no
 * `tree-sitter-*` package, whose install script would build a native parser. From source, they
 * are devDependencies.
 */
function grammarPath(path: string): string {
  const bundled = fileURLToPath(new URL(`./grammars/${path}`, import.meta.url));
  return existsSync(bundled) ? bundled : createRequire(import.meta.url).resolve(path);
}

/** Loads the grammars and returns a `Parse` that gives up, returning null, after the time limit. */
export async function createParse(): Promise<Parse> {
  await Parser.init();
  const entries = await Promise.all(
    Object.entries(GRAMMARS).map(async ([language, path]) => {
      const parser = new Parser();
      parser.setLanguage(await Language.load(await readFile(grammarPath(path))));
      return [language, parser] as const;
    }),
  );
  const parsers = Object.fromEntries(entries) as Record<LanguageName, Parser>;
  return (language, text) => {
    const parser = parsers[language];
    const started = performance.now();
    const tree = parser.parse(text, null, {
      progressCallback: () => performance.now() - started > PARSE_TIMEOUT_MS,
    });
    if (tree === null) {
      // Otherwise the next parse would resume this one.
      parser.reset();
      return null;
    }
    return { rootNode: tree.rootNode as unknown as SyntaxNode, delete: () => tree.delete() };
  };
}
