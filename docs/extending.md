# Extending jevlint

Most extensions need no code. Start at the top of this list.

| Goal | How | Code? |
| --- | --- | --- |
| New principles | [Write a preset](presets.md#writing-a-preset) | No |
| Ban a code pattern | Add a `[[patterns]]` entry | No |
| Judge a code pattern with a sentence | Add a [`[[rules]]` entry](presets.md#semantic-rules) | No |
| Add a coding agent | [Add an `[agents.*]` entry](agents.md#adding-an-agent) | No |
| Use a Jev-compatible endpoint | [Use `compatible`](providers.md#jev-compatible-endpoints) | No |
| Use the results elsewhere | [JSON](json-output.md) or the library API | Little |
| Add a language | Add its extension, or a grammar for exact metrics | Little |
| Add a provider | Add a row to `src/decision/providers.ts` | Little |

## AST patterns

Patterns use [ast-grep syntax](https://ast-grep.github.io/guide/pattern-syntax.html), where `$X`
matches one node and `$$$` matches many. Each match appears as a finding with a line number and
lowers the AST score.

```toml
[[patterns]]
id = "no-debugger"
language = "javascript"
pattern = "debugger"
message = "Remove debugger statements"
```

Patterns can go in `jevlint.toml` or in a preset.

## Library API

```ts
import { audit, loadConfig } from '@indxjp/jevlint';

const config = await loadConfig({ cwd: process.cwd() });
const report = await audit(config);

for (const file of report.files.slice(0, 5)) {
  console.log(file.score, file.path);
}
```

`audit` returns the same object as [`--json`](json-output.md).

## Adding a language

Every source file already gets [approximate metrics](scoring.md#languages-without-a-grammar) and the
model, so a language needs only its extension in `SOURCE_EXTENSIONS` in `src/files.ts`. A grammar
adds exact metrics, `[[patterns]]`, `[[rules]]` and the architecture review, at about 11 MB of install size each:

1. Add the `@ast-grep/lang-*` package.
2. Add its extensions and node kinds to `src/ast/languages.ts`, including its `classes`.
   For the architecture review, add an import reader to `src/architecture/extract.ts` and its
   candidates to `src/architecture/resolve.ts`.
3. Add a fixture to the AST tests with known metric values.

## Adding a provider

Add an entry to the table in `src/decision/providers.ts` with its default model, key variable and
factory. If the provider has an AI SDK package with `decisionModel`, this is a few lines. If it
speaks the Jev protocol, reuse the TypeSafe provider with a different base URL.
