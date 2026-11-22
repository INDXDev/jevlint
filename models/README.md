# The built-in model

`model.json` and `model.bin` are jevlint's built-in decision model, the `local` provider. It answers
the 20 questions of the `readable-code`, `clean-code` and `security` presets on your machine, with no
API key and no network. See [Providers](../docs/providers.md#the-built-in-model) for how jevlint uses
it.

## What it is

Gradient-boosted trees, one set of 300 per question, trained with LightGBM to predict the answers
of a large decision model. Each file is described by:

- 129 code features from its syntax tree and text: function sizes and nesting, names, comments,
  error handling, literals, string building, imports and similar, computed by
  `src/decision/local/features.ts`.
- 20 scores from a linear model over the words in its identifiers, hashed into 262,144 columns.
- Its language: Python, JavaScript, TypeScript, Go or Rust, detected from the content.

For a score question the trees predict the expected level, and for a yes-or-no question the
probability of yes. jevlint reports these as the model's answers, so scoring, weights and pins work
as with any provider.

## How it was made

- **Teacher.** [Perplexity Decider v1.3](https://huggingface.co/perplexity-ai/pplx-decider-v1.3)
  (Apache-2.0) answered every question about each file, given the file as jevlint sends it.
- **Data.** 20,499 source files from 55 open-source repositories, split by repository: 15,791 files
  to train on, 2,421 to choose settings and 2,287 to test.
- **Features.** The trees were trained on features computed in Python. `features.ts` is a port that
  gives the same numbers: on 20,512 files from those repositories, every feature matched.
  `test/local.test.ts` checks the answers to a few files against the values from training.

## How good it is

On the 2,287 test files, from repositories it never saw, the Spearman rank correlation with the
teacher's answers averages 0.83. It ranks files well on structure and less well on rare problems.

| Questions | Spearman |
| --- | --- |
| abstraction-level, focused-blocks, function-focus, control-flow | 0.90 to 0.95 |
| named-subexpressions, safe-failure, error-path-separation, side-effects, unambiguous-names | 0.86 to 0.89 |
| error-handling, no-injection, magic-values, access-control, input-validation | 0.80 to 0.83 |
| time-to-understand, naming, comments, no-embedded-secrets, sound-crypto | 0.72 to 0.79 |
| dead-code | 0.68 |

It is a cheap stand-in for the teacher, not a replacement: use a provider when the answers matter.
Files in languages other than the five above get answers too, but nothing like them was in its
training data.

## Updating it

The model only knows questions by their wording. If a preset changes the wording of one of these
questions, the model stops answering it, and `test/local.test.ts` fails until the model is
retrained on the new wording. A new model must come with features that match `features.ts`, or a
new `FEATURE_VERSION` and a port of the new features.

| File | Contents |
| --- | --- |
| `model.json` | The questions, feature names and where each array starts in `model.bin` |
| `model.bin` | The trees, the word model's weights and idf, little-endian |

The model is released under the same [MIT License](../LICENSE) as jevlint.
