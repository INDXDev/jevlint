/** The questions `spec check` and `spec drift` ask, worded as in docs/spec-reference.md. Pure. */
import type { DecisionQuestion } from '../decision/decide.ts';
import type { Spec, SpecFeature, SpecItem, SpecItemRef } from '../types.ts';
import { fullId, GLOBAL } from './load.ts';

/** The id of the routing question in a request. */
export const ROUTE = 'route';
/** The id of the drift question about requirements no item covers. */
export const UNCOVERED = 'uncovered';

/** What is being routed: a code file for `check`, a document for `drift`. */
export type Subject = 'file' | 'document';

const ROUTE_WORDING: Record<Subject, { ask: string; global: string }> = {
  file: {
    ask: 'Which one feature of it does this file implement? Choose global if it is shared code, tooling, configuration or tests that implement no single feature.',
    global: 'No single feature: shared code, tooling, configuration or tests.',
  },
  document: {
    ask: 'Which one feature does this document describe? Choose global if it describes the project as a whole, or no single feature.',
    global: 'The project as a whole, or no single feature.',
  },
};

const CHECK_OPTIONS = {
  satisfies: 'The file implements or follows this requirement',
  violates: 'The file contradicts this requirement, or implements it wrongly',
  'not-applicable': 'The file does not deal with what this requirement is about',
};

const DRIFT_OPTIONS = {
  agrees: 'The document states this requirement, or something that means the same',
  contradicts: 'The document states something that conflicts with this requirement',
  absent: 'The document does not mention what this requirement is about',
};

/** Asks which feature a file or document belongs to, with `global` as the last option. */
export function routeQuestion({ index, features }: Spec, subject: Subject): DecisionQuestion {
  const { ask, global } = ROUTE_WORDING[subject];
  const options = features.map(({ id, title, summary }) => [id, `${title}: ${summary}`]);
  return {
    type: 'choice',
    instructions: `This ${subject} is part of ${index.name}: ${index.description.trim()} ${ask}`,
    criteria: Object.fromEntries([...options, [GLOBAL, global]]),
  };
}

/** How the questions name a checklist: `the whole project` or `the <title> feature`. */
export function scopeOf(feature: SpecFeature | null): string {
  return feature ? `the ${feature.title} feature` : 'the whole project';
}

/** A checklist's items named by their full ids. */
export function itemRefs(feature: SpecFeature | null, checklist: SpecItem[]): SpecItemRef[] {
  const scope = feature?.id ?? GLOBAL;
  return checklist.map((item) => ({ id: fullId(scope, item), text: item.text }));
}

/** One `check` question per item, keyed by full id. */
export function checkRequest(
  feature: SpecFeature | null,
  items: SpecItemRef[],
): Record<string, DecisionQuestion> {
  const scope = scopeOf(feature);
  return Object.fromEntries(
    items.map(({ id, text }) => [
      id,
      {
        type: 'choice',
        instructions: `Judge this file against one requirement of ${scope}: "${text}"`,
        criteria: CHECK_OPTIONS,
      },
    ]),
  );
}

/** One `drift` question per item, keyed by full id, then `uncovered`. */
export function driftRequest(items: SpecItemRef[]): Record<string, DecisionQuestion> {
  const questions = items.map(({ id, text }): [string, DecisionQuestion] => [
    id,
    {
      type: 'choice',
      instructions: `Compare the document with checklist item ${id}: "${text}"`,
      criteria: DRIFT_OPTIONS,
    },
  ]);
  const uncovered: DecisionQuestion = {
    type: 'boolean',
    instructions:
      'Does the document state a specific, checkable requirement that no item in the checklist, and no item listed as covered elsewhere, covers?',
  };
  return Object.fromEntries([...questions, [UNCOVERED, uncovered]]);
}

const lines = (items: SpecItemRef[]) => items.map(({ id, text }) => `- ${id}: ${text}`).join('\n');

/**
 * The checklists come first, so truncation cuts the document, never them. Items of the other
 * checklists are context, so a document that also restates other features is not uncovered.
 */
export function driftState(
  feature: SpecFeature | null,
  items: SpecItemRef[],
  others: SpecItemRef[],
  path: string,
  document: string,
): string {
  const elsewhere = others.length > 0 ? `===== Covered elsewhere =====\n${lines(others)}\n\n` : '';
  return `===== Checklist: ${scopeOf(feature)} =====\n${lines(items)}\n\n${elsewhere}===== Document: ${path} =====\n${document}`;
}
