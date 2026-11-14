/**
 * What `architecture check`, `drift` and `review` ask the decision model, and the outlines they
 * send. Pure data, like src/spec/questions.ts. Outlines name files and symbols, never code.
 */
import { stringify } from 'yaml';
import type { DecisionQuestion } from '../decision/decide.ts';
import type {
  ArchitectureChapter,
  ArchitectureComponent,
  ArchitectureDecision,
  ArchitectureSsot,
  FactModule,
  MapEdge,
  SpecItemRef,
} from '../types.ts';

/** The scope of the SSOT's own checklist in item ids, as `global.<id>`. */
export const GLOBAL = 'global';
/** The routing question's id in a `drift --docs` request. */
export const ROUTE = 'route';
/** The id of the drift question about statements the SSOT leaves out. */
export const UNCOVERED = 'uncovered';
/** The preset of the stale-summary question. */
export const DRIFT_PRESET = 'architecture-drift';
/** The preset that reviews decision records, and asks whether a stale one still holds. */
export const DECISION_PRESET = 'architecture-decision';
/** The question `drift` asks of a stale decision, which `review` leaves out. */
export const STILL_HOLDS = `${DECISION_PRESET}.still-holds`;
/** Built-in presets only the architecture verbs ask, which `jevlint test` also knows. */
export const ARCHITECTURE_PRESETS = [
  'architecture-codebase',
  'architecture-directory',
  'architecture-class',
  'architecture-component',
  'architecture-design',
  'architecture-chapter',
  DECISION_PRESET,
  DRIFT_PRESET,
];

const CHECK_OPTIONS = {
  satisfies: 'The file implements or follows this rule',
  violates: 'The file contradicts this rule, or implements it wrongly',
  'not-applicable': 'The file does not deal with what this rule is about',
};

const DRIFT_OPTIONS = {
  agrees: 'The document states this, or something that means the same',
  contradicts: 'The document states something that conflicts with this',
  absent: 'The document does not mention what this is about',
};

/** The checklist items of a component, or of the whole system with null, by full id. */
export function checklistRefs(
  ssot: ArchitectureSsot,
  component: ArchitectureComponent | null,
): SpecItemRef[] {
  const scope = component?.id ?? GLOBAL;
  const checklist = component?.checklist ?? ssot.index.checklist;
  return checklist.map(({ id, text }) => ({ id: `${scope}.${id}`, text }));
}

/** Every checklist item: the system's, then each component's. */
export function allChecklistRefs(ssot: ArchitectureSsot): SpecItemRef[] {
  return [checklistRefs(ssot, null), ...ssot.components.map((c) => checklistRefs(ssot, c))].flat();
}

/** One question per item a file is judged against, keyed by full id. */
export function checkRequest(
  ssot: ArchitectureSsot,
  component: ArchitectureComponent | null,
  items: SpecItemRef[],
): Record<string, DecisionQuestion> {
  const where = component
    ? `the ${component.title} component of ${ssot.index.name} (${component.summary.trim()})`
    : ssot.index.name;
  return Object.fromEntries(
    items.map(({ id, text }) => [
      id,
      {
        type: 'choice',
        instructions: `This file is part of ${where}. Judge it against one architecture rule: "${text}"`,
        criteria: CHECK_OPTIONS,
      },
    ]),
  );
}

/** Asks which component a document is about, with `global` as the last option. */
export function routeQuestion({ index, components }: ArchitectureSsot): DecisionQuestion {
  const options = components.map(({ id, title, summary }) => [id, `${title}: ${summary.trim()}`]);
  return {
    type: 'choice',
    instructions: `This document is about ${index.name}: ${index.description.trim()} Which one component of it does the document describe? Choose global if it describes the system as a whole, or no single component.`,
    criteria: Object.fromEntries([
      ...options,
      [GLOBAL, 'The system as a whole, or no single component.'],
    ]),
  };
}

/** How `drift --docs` names a decision among its statements. `_` keeps it apart from any component. */
export const DECISION_SCOPE = 'decision_record';

/**
 * What a document is compared with: the summary or description, then the checklist, then every
 * accepted decision by its title, since a document about any part can contradict one.
 */
export function documentItems(
  ssot: ArchitectureSsot,
  component: ArchitectureComponent | null,
): SpecItemRef[] {
  const scope = component?.id ?? GLOBAL;
  const statement = component?.summary ?? ssot.index.description;
  const decisions = (ssot.decisions ?? [])
    .filter(({ status }) => status === 'accepted')
    .map(({ id, title }) => ({ id: `${DECISION_SCOPE}.${id}`, text: title }));
  return [
    { id: `${scope}.summary`, text: statement.trim() },
    ...checklistRefs(ssot, component),
    ...decisions,
  ];
}

/** One drift question per item, then `uncovered`. */
export function documentRequest(items: SpecItemRef[]): Record<string, DecisionQuestion> {
  const questions = items.map(({ id, text }): [string, DecisionQuestion] => [
    id,
    {
      type: 'choice',
      instructions: `Compare the document with this statement of the architecture document (${id}): "${text}"`,
      criteria: DRIFT_OPTIONS,
    },
  ]);
  const uncovered: DecisionQuestion = {
    type: 'boolean',
    instructions:
      'Does the document state a specific fact about the structure, such as a component, a dependency or a rule, that none of the statements above covers?',
  };
  return Object.fromEntries([...questions, [UNCOVERED, uncovered]]);
}

/** The statements come first, so truncation cuts the document, never them. */
export function documentState(items: SpecItemRef[], path: string, document: string): string {
  const lines = items.map(({ id, text }) => `- ${id}: ${text}`).join('\n');
  return `===== Architecture statements =====\n${lines}\n\n===== Document: ${path} =====\n${document}`;
}

const listOf = (names: string[]) => names.join(', ') || 'none';

/** What a model reads about one component: its summary, its modules and their dependencies. */
export function componentOutline(
  component: ArchitectureComponent,
  modules: FactModule[],
  edges: MapEdge[],
): string {
  const out = edges.filter(({ from, status }) => from === component.id && status !== 'unused');
  const users = edges.filter(({ to, status }) => to === component.id && status !== 'unused');
  return [
    `Component: ${component.id} (${component.title})`,
    `Layer: ${component.layer ?? 'none'}`,
    `Summary: ${component.summary.trim()}`,
    'Modules:',
    ...modules.map(({ path, lines, symbols }) => `- ${path} (${lines} lines): ${listOf(symbols)}`),
    `Depends on: ${listOf(out.map(({ to, weight }) => `${to} (${weight})`))}`,
    `Declared dependencies: ${component.depends_on ? listOf(component.depends_on) : 'not declared'}`,
    `Used by: ${listOf(users.map(({ from, weight }) => `${from} (${weight})`))}`,
    `Externals: ${listOf(component.uses)}`,
  ].join('\n');
}

/** The SSOT as one YAML document for the `design` review, without what only tracks history. */
export function designState(ssot: ArchitectureSsot): string {
  // compiled_on changes on every compile, as compiled_at does, and would ask again for nothing.
  const { compiled_at: _, compiled_on: __, ...index } = ssot.index;
  return stringify({ ...index, components: ssot.components, flows: ssot.flows }, { lineWidth: 0 });
}

/** What a model reads about one decision record: its facts, its evidence list and its text. */
export function decisionState(decision: ArchitectureDecision): string {
  const { title, date, status, enforced_by, unenforceable, evidence, body } = decision;
  const enforcement = enforced_by.length > 0 ? enforced_by.join(', ') : 'nothing';
  return [
    `Decision: ${title}`,
    `Date: ${date}`,
    `Status: ${status}`,
    `Enforced by: ${enforcement}${unenforceable ? ` (unenforceable: ${unenforceable})` : ''}`,
    `Evidence: ${evidence.join(', ') || 'none'}`,
    '',
    body,
  ].join('\n');
}

/** The record, then the outline of each component it names as the code has it now. */
export function stillHoldsState(decision: ArchitectureDecision, outlines: string[]): string {
  return `===== Decision record =====\n${decisionState(decision)}\n\n===== Components it is about, now =====\n${outlines.join('\n\n')}`;
}

/** What a model reads about one chapter: its title, its evidence list and its text. */
export function chapterState({ title, evidence, body }: ArchitectureChapter): string {
  return `Chapter: ${title}\nEvidence: ${evidence.join(', ') || 'none'}\n\n${body}`;
}
