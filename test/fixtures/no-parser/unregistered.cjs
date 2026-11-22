// Stands in for @ast-grep/napi when registering grammars fails, as it does once the working
// directory has been removed.
const napi = require('@ast-grep/napi');

module.exports = {
  ...napi,
  registerDynamicLanguage() {
    throw new Error('No such file or directory (os error 2)');
  },
};
