// Simulates a parser built for another platform, as when Windows npm installs and WSL runs it.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@ast-grep/napi') {
      throw new Error('Cannot find native binding. npm has a bug related to optional dependencies');
    }
    return next(specifier, context);
  },
});
