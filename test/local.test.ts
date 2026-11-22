import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { experimental_decide as decide, Experimental_DecisionRefusalError } from 'ai';
import { describe, expect, it } from 'vitest';
import { answerable, decisionRequest } from '../src/decision/decide.ts';
import { identifierWords, loadLocalModel, murmur3 } from '../src/decision/local/model.ts';
import { localDecisionModel } from '../src/decision/local.ts';
import { activeQuestions, loadPresets } from '../src/presets.ts';
import type { Question } from '../src/types.ts';

const ROOT = join(import.meta.dirname, '..');
const TRAINED_PRESETS = ['readable-code', 'clean-code', 'security'];

/** Files with the values the model gave them where it was trained, by trained question id. */
const GOLDEN = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/local-model.json'), 'utf8'),
) as Record<string, { text: string; values: Record<string, number> }>;

async function questionsOf(presets: string[]): Promise<Question[]> {
  return activeQuestions(await loadPresets(presets, ROOT), {});
}

describe('the built-in model', () => {
  it('answers every question it was trained on, as the presets word them now', async () => {
    const { meta } = await loadLocalModel(join(ROOT, 'models'));
    const local = await localDecisionModel();
    const answered = answerable(local, await questionsOf(TRAINED_PRESETS));
    // A preset whose wording changed loses its question here until the model is retrained.
    expect(answered.map(({ id }) => id.split('.')[1]).sort()).toEqual(
      Object.keys(meta.questions).sort(),
    );
  });

  it('answers no question of solid, which CLI tests use to stay AST-only', async () => {
    const local = await localDecisionModel();
    expect(answerable(local, await questionsOf(['solid']))).toEqual([]);
  });

  it.each(Object.keys(GOLDEN))('gives %s code the values it gave in training', async (name) => {
    const { text, values } = GOLDEN[name]!;
    const local = await localDecisionModel();
    const questions = answerable(local, await questionsOf(TRAINED_PRESETS));
    const { answers } = await decide({
      model: local.model,
      state: text,
      questions: decisionRequest(questions),
    });
    for (const question of questions) {
      const want = values[question.id.split('.')[1]!]!;
      const got = answers[question.id]!;
      if (got.type === 'score' && question.type === 'score') {
        const top = question.levels.length - 1;
        expect(got.score).toBeCloseTo(Math.min(top, Math.max(0, want)), 9);
      } else if (got.type === 'boolean') {
        expect(got.probability).toBeCloseTo(Math.min(1, Math.max(0, want)), 9);
      } else throw new Error(`Unexpected answer to ${question.id}: ${got.type}`);
    }
  });

  it('refuses a question it was not trained on', async () => {
    const local = await localDecisionModel();
    const questions = { other: { type: 'boolean' as const, instructions: 'Is this code new?' } };
    expect(local.answers(questions.other)).toBe(false);
    await expect(decide({ model: local.model, state: 'x = 1', questions })).rejects.toBeInstanceOf(
      Experimental_DecisionRefusalError,
    );
  });

  it('hashes words as scikit-learn does', () => {
    expect([murmur3(''), murmur3('hello'), murmur3('abc')]).toEqual([0, 613153351, -1277324294]);
    expect(identifierWords('parseHTTPRequest x2y')).toEqual([
      'parse',
      'http',
      'request',
      'x',
      '2',
      'y',
    ]);
  });
});
