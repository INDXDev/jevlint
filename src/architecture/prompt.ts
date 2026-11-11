/**
 * Renders the prompts that hand architecture work to a coding agent: compile or update the SSOT,
 * review the design, fix violations, and write a plan. Paths and line numbers, never file contents.
 */
import { stringify } from 'yaml';
import { withoutControlCharacters } from '../report.ts';
import type {
  ArchitectureCheckReport,
  ArchitectureComponent,
  ArchitectureDriftReport,
  ArchitecturePlan,
  ArchitectureReport,
  ArchitectureSsot,
  ArchitectureViolation,
  DriftItem,
} from '../types.ts';
import type { CompileInput } from './compile.ts';
import { PLACEHOLDER } from './draft.ts';
import { BUDGET } from './load.ts';

const MAX_LISTED = 200;

const yaml = (value: unknown) => stringify(value, { lineWidth: 100 }).trimEnd();

const listed = (lines: string[]) =>
  lines.length > MAX_LISTED
    ? [...lines.slice(0, MAX_LISTED), `- … and ${lines.length - MAX_LISTED} more`]
    : lines;

/** The format, as the agent needs it. docs/architecture-reference.md has the full version. */
const FORMAT = (dir: string) => `## The SSOT format

The SSOT is a set of YAML files in \`${dir}/\`:

\`\`\`
${dir}/
├── index.yaml              the system: description, layers, externals, rules, checklist
├── components/<id>.yaml    one component each, named after its id
└── flows/<id>.yaml         one main workflow each (optional)
\`\`\`

\`index.yaml\`:

\`\`\`yaml
version: 1
name: shop
compiled_at: 1a2b3c4                 # the commit you compiled from (given below)
description: >
  An online shop. The web layer stays thin; services hold the rules; only db/ talks to Postgres.
layers: [interface, services, data, contracts]   # top to bottom
ignore: ["test/**"]                  # files that belong to no component on purpose
externals:
  - { id: postgres, title: PostgreSQL, packages: ["pg"] }
rules:                               # decided exactly from the code, with no model
  - { id: layers-point-down, kind: layers }
  - { id: no-component-cycles, kind: no-cycles }
  - { id: no-console, kind: forbid-call, pattern: "console.$M($$$)", except: [web] }
checklist:                           # prose rules that a model judges per file
  - { id: user-errors, text: "A problem the user can fix is reported as a UserError." }
\`\`\`

\`components/<id>.yaml\`:

\`\`\`yaml
id: db
title: Database access
summary: >                           # one to three sentences: what it does, for whom
  Reads and writes orders and stock in Postgres. Every other part reaches the database through here.
layer: data
paths: ["src/db/**"]                  # globs; a file belongs to the most specific match
key_files:                           # three to five files to start reading from
  - { path: src/db/client.ts, role: "the connection pool and transactions" }
interface: [withTransaction, findOrder]   # names other components use
depends_on: [contracts]              # allowlist: importing any other component is a violation
uses: [postgres]
rules:
  - { id: owns-postgres, kind: only, externals: [postgres] }
  - { id: no-web, kind: forbid, components: [web] }
checklist: []
status: current                      # target marks an intended shape whose violations are known debt
\`\`\`

\`flows/<id>.yaml\`:

\`\`\`yaml
id: checkout
title: Check out a basket
trigger: "POST /checkout"
steps:                               # each step must exist as an import in the code
  - { from: web, to: orders, verb: "places the order" }
  - { from: orders, to: db, verb: "stores it" }
\`\`\`

Rule kinds: \`layers\`, \`no-cycles\`, \`only\` (externals, and components in index.yaml), \`forbid\` (packages and/or components; \`from\` in index.yaml), \`forbid-call\` (an ast-grep \`pattern\`, optional \`language\`, \`from\`, \`except\`). Ids use lowercase letters, digits and \`-\`; external ids may also use \`_\`. The SSOT holds globs, package names, ast-grep patterns and prose only.`;

const GUIDANCE = `## What makes a good SSOT

- It is for people and coding agents who have not read the code. Keep it within about ${BUDGET.tokens} tokens: ${BUDGET.components} components at most, summaries of ${BUDGET.summarySentences} sentences at most, ${BUDGET.keyFiles} key files at most.
- Name a component after what it does in the domain, never \`utils\`, \`common\` or \`core\`.
- The candidates below come from directories and import cohesion. Merge candidates that serve one purpose, and split one that mixes purposes, when the code says so. Do not keep a candidate only because a directory exists.
- Declare \`depends_on\` from the dependencies the facts list, and leave out a dependency only if it is a mistake in the code; then add a rule or checklist item that says so.
- Put rules that have an exact answer (layers, who may import a package, calls that are not allowed) in \`rules\`. Use \`checklist\` only for rules the code's structure cannot show.
- If something important is not in the facts, such as a call over HTTP or a dependency injected at runtime, add it with the evidence (file and line) in the summary.`;

const FINISH = (dir: string) => `## When you are done

1. Run \`jevlint architecture list\` and fix every error it reports in \`${dir}/\`.
2. Run \`jevlint architecture check --static\` and fix only mistakes in the SSOT, such as a wrong glob or a missing \`depends_on\`. Do not change any code. A violation that the code really has stays, and you mention it.
3. Finish with a short list of questions for a person: places where the code and the documents disagree, and decisions you could not make from the code.`;

function factsSection(input: CompileInput): string {
  const { facts } = input;
  const components = facts.components.map(
    (c) =>
      `- ${c.id} (layer ${c.layer}, ${c.files.length} files, ${c.lines} lines, rank ${c.rank}, used by ${c.fanIn}, uses ${c.fanOut}, churn ${c.churn}): paths ${c.paths.join(' ')}; central ${c.central.join(' ') || 'none'}; interface ${c.interface.join(', ') || 'none'}; externals ${c.externals.join(', ') || 'none'}`,
  );
  const dependencies = facts.dependencies.map(
    ({ from, to, weight, evidence }) =>
      `- ${from} → ${to} (${weight}): ${evidence.map(({ path, line }) => `${path}:${line}`).join(', ')}`,
  );
  const externals = facts.externals
    .filter(({ kind }) => kind !== 'runtime')
    .map(
      ({ id, kind, packages, users }) =>
        `- ${id} (${kind}): ${packages.join(', ')}; used by ${users.join(', ') || 'none'}`,
    );
  const entries = facts.entrypoints.map(
    ({ path, kind, component }) => `- ${path}: ${kind}${component ? ` in ${component}` : ''}`,
  );
  const flows = facts.flows.map(
    ({ entry, components: chain }) => `- from ${entry}: ${chain.join(' → ')}`,
  );
  const coChanges = facts.coChanges.map(
    ({ a, b, commits }) => `- ${a} and ${b}: ${commits} commits, with no import between them`,
  );
  return [
    `## The facts\n\nFrom static analysis of ${facts.files} files and ${facts.lines} lines at ${facts.commit ?? 'the working tree'}. Layer 0 depends on no other candidate.`,
    `### Component candidates\n\n${listed(components).join('\n')}`,
    `### Dependencies, with the imports behind them\n\n${listed(dependencies).join('\n') || 'None.'}`,
    `### Externals\n\n${listed(externals).join('\n') || 'None.'}`,
    `### Entry points\n\n${entries.join('\n') || 'None found.'}`,
    `### Candidate flows (the longest dependency chain from each entry point)\n\n${flows.join('\n') || 'None.'}`,
    facts.cycles.length > 0
      ? `### Cycles between candidates\n\n${facts.cycles.map((c) => `- ${c.join(', ')}`).join('\n')}`
      : '',
    coChanges.length > 0 ? `### Changed together\n\n${coChanges.join('\n')}` : '',
    facts.tests.length > 0
      ? `### Tests, left out of components\n\n${facts.tests.map((g) => `- ${g}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function draftSection(input: CompileInput): string {
  const { draft } = input;
  const files = [
    `# ${draft.dir}/index.yaml\n${yaml(draft.index)}`,
    ...draft.components.map(
      (component) => `# ${draft.dir}/components/${component.id}.yaml\n${yaml(component)}`,
    ),
  ];
  return `## The draft\n\nThe facts as SSOT files. Replace every ${PLACEHOLDER}, rename ids and layers, merge or split components, and write flows for the main workflows.\n\n\`\`\`yaml\n${files.join('\n\n')}\n\`\`\``;
}

function documentsSection(docs: string[]): string {
  if (docs.length === 0) return '';
  return `## Documents\n\nRead these for names, intent and rules. The code decides what is true: where a document disagrees with the code, follow the code and list the disagreement as a question at the end.\n\n${docs.map((path) => `- ${path}`).join('\n')}`;
}

const driftLine = ({ kind, path, line, message, since }: DriftItem) =>
  `- ${kind}: ${path}${line ? `:${line}` : ''}: ${message}${since ? ' (new since compiled_at)' : ''}`;

function updateSection(input: CompileInput): string {
  const { delta, ssotFiles, dir } = input;
  if (!delta) {
    return `## Update the SSOT\n\nAn SSOT already exists in \`${dir}/\`, with no \`compiled_at\` to compare with. Read it, compare it with the facts below, and update it in place. Keep every component's id unless the component is gone.\n\nIts files:\n${ssotFiles.map((path) => `- ${path}`).join('\n')}`;
  }
  return [
    `## Update the SSOT\n\nThe SSOT in \`${dir}/\` was compiled from ${delta.base}. Update it in place for what changed since then, and leave the rest alone. Keep every component's id unless the component is gone, and set \`compiled_at\` to ${input.facts.commit ?? 'the current commit'}.`,
    `Its files:\n${ssotFiles.map((path) => `- ${path}`).join('\n')}`,
    `### Drift\n\n${listed(delta.items.map(driftLine)).join('\n') || 'None found by static analysis.'}`,
    `### Files added since ${delta.base}\n\n${listed(delta.added.map((path) => `- ${path}`)).join('\n') || 'None.'}`,
    `### Files removed since ${delta.base}\n\n${listed(delta.removed.map((path) => `- ${path}`)).join('\n') || 'None.'}`,
  ].join('\n\n');
}

/** The prompt that asks an agent to write the SSOT from the facts, or to update it. */
export function renderCompilePrompt(untrusted: CompileInput): string {
  const input = withoutControlCharacters(untrusted);
  const { dir, ssot, loadError, facts } = input;
  const intro = ssot
    ? `You are updating the architecture document of this repository: a small set of YAML files in \`${dir}/\` that is the single source of truth (SSOT) for its structure. jevlint checks the code against it, and people and coding agents read it first. Do not change any code.`
    : `You are writing the architecture document of this repository: a small set of YAML files in \`${dir}/\` that will be the single source of truth (SSOT) for its structure. jevlint checks the code against it, and people and coding agents read it first. Read the key files of each candidate below, then write the SSOT. Do not change any code. Set \`compiled_at\` to ${facts.commit ?? 'the current commit hash'}.`;
  const broken = loadError
    ? `## The current SSOT does not load\n\n${loadError}\n\nFix these errors as part of your work.`
    : '';
  return [
    `# ${ssot ? 'Update' : 'Write'} the architecture SSOT`,
    intro,
    broken,
    ssot ? updateSection(input) : '',
    FORMAT(dir),
    GUIDANCE,
    documentsSection(input.docs),
    factsSection(input),
    ssot ? '' : draftSection(input),
    FINISH(dir),
  ]
    .filter(Boolean)
    .join('\n\n')
    .concat('\n');
}

/** The update prompt `drift --copy` gives: the compile prompt's update, from the drift report. */
export function renderDriftPrompt(untrusted: ArchitectureDriftReport, ssotFiles: string[]): string {
  const report = withoutControlCharacters(untrusted);
  return [
    '# Update the architecture SSOT',
    `The SSOT in \`${report.dir}/\` no longer describes all of the code. Update it in place for the drift below, and leave the rest alone. Keep every component's id unless the component is gone, and set \`compiled_at\` to ${report.head ?? 'the current commit'}. Do not change any code.`,
    `Its files:\n${ssotFiles.map((path) => `- ${path}`).join('\n')}`,
    `## Drift\n\n${listed(report.items.map(driftLine)).join('\n') || 'None.'}`,
    report.added.length > 0
      ? `## Files added since ${report.compiledAt}\n\n${listed(report.added.map((p) => `- ${p}`)).join('\n')}`
      : '',
    report.removed.length > 0
      ? `## Files removed since ${report.compiledAt}\n\n${listed(report.removed.map((p) => `- ${p}`)).join('\n')}`
      : '',
    FORMAT(report.dir),
    FINISH(report.dir),
  ]
    .filter(Boolean)
    .join('\n\n')
    .concat('\n');
}

const violationLine = ({ path, line, rule, ruleId, message }: ArchitectureViolation) =>
  `- ${path}:${line} ${rule} (${ruleId}): ${message}`;

/** The prompt `check --copy` gives: fix the code so it follows the SSOT. */
export function renderCheckPrompt(untrusted: ArchitectureCheckReport): string {
  const report = withoutControlCharacters(untrusted);
  const checklist = report.files.flatMap(({ path, items }) =>
    items
      .filter(({ verdict }) => verdict === 'violates')
      .map(({ id, text }) => `- ${path}: ${id}: ${text}`),
  );
  return [
    '# Make the code follow the architecture',
    `The architecture SSOT in \`${report.dir}/\` says how the code is meant to be structured. The code below does not follow it. Change the code, not the SSOT, unless the SSOT is plainly wrong; then say so and stop. Keep each change small, and run the tests after.`,
    report.violations.length > 0
      ? `## Structural violations\n\n${listed(report.violations.map(violationLine)).join('\n')}`
      : '',
    checklist.length > 0 ? `## Checklist violations\n\n${listed(checklist).join('\n')}` : '',
    report.unimplemented.length > 0
      ? `## Items no file satisfies\n\n${report.unimplemented.map(({ id, text }) => `- ${id}: ${text}`).join('\n')}`
      : '',
    'When you are done, run `jevlint architecture check --static` and confirm the structural violations are gone.',
  ]
    .filter(Boolean)
    .join('\n\n')
    .concat('\n');
}

const componentLine = ({ id, title, layer, depends_on }: ArchitectureComponent) =>
  `- ${id} (${title}, ${layer ?? 'no layer'}): depends on ${depends_on?.join(', ') || 'nothing declared'}`;

/** The prompt `review --copy` gives: review the design in prose, with the scores to explain. */
export function renderReviewPrompt(
  untrusted: ArchitectureReport,
  ssot: ArchitectureSsot | null,
): string {
  const report = withoutControlCharacters(untrusted);
  const units = report.units
    .slice(0, 20)
    .map(({ perspective, name, score }) => `- ${perspective} ${name}: ${score}/${report.scale}`);
  const findings = report.findings
    .slice(0, 40)
    .map(({ path, line, rule, message }) => `- ${path}:${line} ${rule}: ${message}`);
  return [
    '# Review the architecture',
    `Review the design of this repository in prose: its main weaknesses, why each matters, and what to change first. The scores below rank the parts; your job is to explain them. Read the code where you need to. Do not change any code.`,
    ssot
      ? `## The architecture SSOT\n\nIn \`${ssot.dir}/\`. Its components:\n\n${withoutControlCharacters(ssot.components).map(componentLine).join('\n')}`
      : 'There is no architecture SSOT yet. `jevlint architecture compile` would write one.',
    `## Scores, worst first\n\nOverall ${report.score}/${report.scale}.\n\n${units.join('\n')}`,
    findings.length > 0 ? `## Structural findings\n\n${findings.join('\n')}` : '',
    'Answer with at most five weaknesses, worst first, each with the evidence (file and line) and a concrete change.',
  ]
    .filter(Boolean)
    .join('\n\n')
    .concat('\n');
}

/** The prompt `plan --copy` gives: write a staged plan from the computed steps. */
export function renderPlanPrompt(untrusted: ArchitecturePlan, dir: string): string {
  const plan = withoutControlCharacters(untrusted);
  const steps = plan.steps.map(
    ({ rank, priority, problem, move, evidence }) =>
      `${rank}. ${problem} (priority ${priority})\n   Move: ${move}\n   Evidence: ${evidence.map(({ path, line }) => `${path}:${line}`).join(', ') || 'none'}`,
  );
  return [
    '# Write a refactoring plan',
    `Write \`${dir}/plan.md\`: a staged plan to fix the structure of this repository, from the ranked steps below. jevlint computed each move from the import graph; check it against the code, and change a move if the code shows a better one. Group the steps into stages that can each be merged on their own, with the expected effect and the risk of each. Do not change any code.`,
    `## Ranked steps\n\n${steps.join('\n') || 'No problems found.'}`,
  ]
    .join('\n\n')
    .concat('\n');
}
