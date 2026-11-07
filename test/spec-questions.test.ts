import { describe, expect, it } from 'vitest';
import {
  checkRequest,
  driftRequest,
  driftState,
  itemRefs,
  routeQuestion,
} from '../src/spec/questions.ts';
import type { Spec } from '../src/types.ts';

const login = {
  id: 'login',
  title: 'Login',
  summary: 'Signs customers in.',
  checklist: [{ id: 'lockout', text: 'Five failures lock the account.' }],
};
const spec: Spec = {
  dir: '.jevlint/spec',
  index: {
    version: 1,
    name: 'Shop',
    description: 'An online shop.\n',
    checklist: [{ id: 'no-secrets', text: 'Logs hold no secrets.' }],
  },
  features: [login],
};

describe('spec questions', () => {
  it('routes files and documents with their own wording, global last', () => {
    expect(routeQuestion(spec, 'file')).toEqual({
      type: 'choice',
      instructions:
        'This file is part of Shop: An online shop. Which one feature of it does this file implement? Choose global if it is shared code, tooling, configuration or tests that implement no single feature.',
      criteria: {
        login: 'Login: Signs customers in.',
        global: 'No single feature: shared code, tooling, configuration or tests.',
      },
    });
    const document = routeQuestion(spec, 'document');
    expect(document.instructions).toBe(
      'This document is part of Shop: An online shop. Which one feature does this document describe? Choose global if it describes the project as a whole, or no single feature.',
    );
    expect(Object.entries(document.type === 'choice' ? document.criteria : {}).at(-1)).toEqual([
      'global',
      'The project as a whole, or no single feature.',
    ]);
  });

  it('asks check items by full id, scoped to the project or the feature', () => {
    expect(checkRequest(null, itemRefs(null, spec.index.checklist))).toEqual({
      'global.no-secrets': {
        type: 'choice',
        instructions:
          'Judge this file against one requirement of the whole project: "Logs hold no secrets."',
        criteria: {
          satisfies: 'The file implements or follows this requirement',
          violates: 'The file contradicts this requirement, or implements it wrongly',
          'not-applicable': 'The file does not deal with what this requirement is about',
        },
      },
    });
    const request = checkRequest(login, itemRefs(login, login.checklist));
    expect(request['login.lockout']?.instructions).toBe(
      'Judge this file against one requirement of the Login feature: "Five failures lock the account."',
    );
  });

  it('asks drift items and uncovered', () => {
    const request = driftRequest(itemRefs(login, login.checklist));
    expect(request).toEqual({
      'login.lockout': {
        type: 'choice',
        instructions:
          'Compare the document with checklist item login.lockout: "Five failures lock the account."',
        criteria: {
          agrees: 'The document states this requirement, or something that means the same',
          contradicts: 'The document states something that conflicts with this requirement',
          absent: 'The document does not mention what this requirement is about',
        },
      },
      uncovered: {
        type: 'boolean',
        instructions:
          'Does the document state a specific, checkable requirement that no item in the checklist covers?',
      },
    });
  });

  it('puts the checklist before the document', () => {
    expect(driftState(login, itemRefs(login, login.checklist), 'docs/auth.md', 'Body')).toBe(
      '===== Checklist: the Login feature =====\n- login.lockout: Five failures lock the account.\n\n===== Document: docs/auth.md =====\nBody',
    );
  });
});
