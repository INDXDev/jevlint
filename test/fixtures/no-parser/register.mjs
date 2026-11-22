// Breaks ast-grep the ways a real install can, while napi-rs's own loader still runs. The query
// picks how: `missing` (the default), as when Windows npm installed jevlint and WSL runs it;
// `broken`, a binary that is there but does not load; `gone`, no @ast-grep/napi at all;
// `unregistered`, grammars that fail to register; and `taken`, a program that registered its own
// languages first.
import { createRequire, registerHooks } from 'node:module';

const mode = new URL(import.meta.url).search.slice(1) || 'missing';
const here = (file) => new URL(file, import.meta.url).href;
const ownBinary = `@ast-grep/napi-${process.platform}-${process.arch}`;

const notFound = (specifier) =>
  Object.assign(new Error(`Cannot find module '${specifier}'`), { code: 'MODULE_NOT_FOUND' });

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@ast-grep/napi') {
      if (mode === 'gone') throw notFound(specifier);
      // Only jevlint's own load, so that the stand-in still reaches the real package.
      if (mode === 'unregistered' && !context.parentURL?.endsWith('/unregistered.cjs')) {
        return { url: here('./unregistered.cjs'), shortCircuit: true };
      }
    }
    const binary =
      specifier.startsWith('./ast-grep-napi.') || specifier.startsWith('@ast-grep/napi-');
    if (binary && (mode === 'missing' || mode === 'broken')) {
      if (mode === 'broken' && specifier.startsWith(ownBinary)) {
        return { url: here('./broken-binary.cjs'), shortCircuit: true };
      }
      throw notFound(specifier);
    }
    return next(specifier, context);
  },
});

if (mode === 'taken') createRequire(import.meta.url)('@ast-grep/napi').registerDynamicLanguage({});
