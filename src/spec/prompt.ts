/** Renders the `jevlint spec compile` prompt, which asks a coding agent to write the spec. */
import { withoutControlCharacters } from '../report.ts';
import type { Spec } from '../types.ts';

/** What the compile prompt is built from: paths only, never document contents. */
export interface CompilePromptInput {
  /** Root-relative spec directory. */
  dir: string;
  /** Root-relative document paths. */
  docs: string[];
  spec: Spec | null;
  /** Root-relative paths of the current spec's files. */
  specFiles: string[];
  /** Why the current spec failed to load, when it did. */
  loadError?: string;
}

const FORMAT = (dir: string) => `## The spec format

The spec is a set of YAML files in \`${dir}/\`:

\`\`\`
${dir}/
├── index.yaml          the project: description and project checklist
└── features/
    ├── login.yaml      one feature each, named after its id
    └── admin.yaml
\`\`\`

\`index.yaml\` describes the project and holds the checklist every file and document is judged against:

\`\`\`yaml
version: 1
name: Shop
description: >
  An online shop: customers browse a catalogue, pay by card and get their order by post.
  Staff manage stock and refunds in an admin panel.
checklist:
  - id: no-secrets-in-logs
    text: Logs never contain passwords, session tokens or card numbers.
    source: docs/security.md
\`\`\`

| Key | Type | Required | Meaning |
| --- | --- | --- | --- |
| \`version\` | \`1\` | Yes | The format version. Only \`1\` exists |
| \`name\` | string | Yes | The project's name |
| \`description\` | string | Yes | What the project is, in a paragraph |
| \`checklist\` | list of items | No | Items every file and document is judged against |

Each \`features/<id>.yaml\` describes one feature:

\`\`\`yaml
id: login
title: Login
summary: Signs customers in with email and password, and keeps them signed in.
checklist:
  - id: lockout
    text: Five failed sign-ins in a row lock the account for 15 minutes.
    source: docs/auth.md
  - id: hashing
    text: Passwords are stored only as Argon2id hashes.
    source: docs/auth.md
\`\`\`

| Key | Type | Required | Meaning |
| --- | --- | --- | --- |
| \`id\` | id | Yes | Must equal the file name without \`.yaml\` |
| \`title\` | string | Yes | A short name for people |
| \`summary\` | string | Yes | One or two sentences that tell this feature apart from the others |
| \`checklist\` | list of items | Yes | At least one item |

Each checklist item has these keys:

| Key | Type | Required | Meaning |
| --- | --- | --- | --- |
| \`id\` | id | Yes | Unique within its file |
| \`text\` | string | Yes | One checkable statement, in the present tense |
| \`source\` | string | No | Where the item came from, such as \`docs/auth.md\` or \`docs/auth.md#lockout\` |

Validation rules:

- An id uses only lowercase letters, digits and \`-\`, and starts with a letter or digit.
- \`global\` is reserved and cannot be a feature id.
- Unknown keys are errors.
- Only \`index.yaml\` and \`features/*.yaml\` are read. Any other file is ignored.
- There must be at least one feature, and at most 255.
- Do not use YAML anchors or aliases.`;

const RULES = `## Rules for good items

- One item, one fact. "Passwords are hashed with Argon2id" is checkable. "Authentication is secure" is not.
- Write items about behaviour a reader can see in code: a value, a limit, a call, an order of steps.
- Write only what the documents state. Do not invent requirements, and do not copy whole paragraphs.
- Give each feature a summary that tells it apart from the others. Files are routed to a feature by its summary alone, so two features that sound alike will be confused.
- Keep features coarse. Five to twenty features suit most projects. A file can belong to only one.
- Keep cross-cutting rules in the project checklist in \`index.yaml\`, not copied into every feature.
- Record where each item came from in \`source\`, so a reviewer can follow it back to the document.`;

const FINISH = (dir: string) => `## How to finish

1. Run \`jevlint spec list\`. If it fails, fix the file it names and run it again, until it succeeds.
2. Change nothing outside \`${dir}/\`.
3. Do not commit. Leave your changes in the working tree for review.
4. Finish with a short summary: the features, and the number of items in each checklist.`;

const list = (paths: string[]) => paths.map((path) => `- \`${path}\``).join('\n');

function renderDocs(docs: string[]): string {
  if (docs.length === 0) {
    return `## Documents

No documents matched. Ask the user which documents describe the project, and to set \`spec.docs\` in \`jevlint.toml\`, then stop.`;
  }
  return `## Documents

Read each of these yourself. Each item in the spec must come from one of them.

${list(docs)}`;
}

function renderCurrent({ dir, spec, specFiles, loadError }: CompilePromptInput): string {
  if (loadError !== undefined) {
    return `## The current spec

The spec in \`${dir}/\` failed to load. Repair it, keeping what is still valid. The error was:

${loadError}`;
  }
  if (!spec)
    return `## The current spec\n\nThere is no spec yet. Create \`${dir}/index.yaml\` first.`;
  return `## The current spec

Update these files in place. Keep the id of every item whose meaning did not change, and delete items the documents no longer state.

${list(specFiles)}`;
}

/** Renders a Markdown prompt naming documents and spec files, never their contents. */
export function renderCompilePrompt(untrusted: CompilePromptInput): string {
  // Each path sits on its own line, so a crafted name cannot add headings for the agent to obey.
  const input = withoutControlCharacters({ ...untrusted, loadError: undefined });
  // An indented code block, one line each, so no line of the error can end it early.
  const loadError = untrusted.loadError
    ?.split('\n')
    .map((line) => `    ${withoutControlCharacters(line)}`)
    .join('\n');
  return [
    `# Compile the spec

Write or update the spec in \`${input.dir}/\` from the documents below. The spec is a checklist of short, checkable requirements that jevlint, a model-based linter, judges code and documents against.`,
    renderDocs(input.docs),
    renderCurrent({ ...input, loadError }),
    FORMAT(input.dir),
    RULES,
    FINISH(input.dir),
  ].join('\n\n');
}
