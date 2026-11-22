/** The built-in model as a decision provider. It runs on this machine, with no key or network. */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  Experimental_DecisionModel as DecisionModel,
  Experimental_DecisionQuestion as DecisionModelV4Question,
} from 'ai';
import type { Parse } from './local/features.ts';
import { type AskedQuestion, type LocalModel, loadLocalModel } from './local/model.ts';
import { createParse } from './local/parse.ts';

// The AI SDK exports the decision model contract only as part of a union.
type DecisionModelV4 = Extract<DecisionModel, { doDecide: unknown }>;
type DecisionAnswer = Awaited<ReturnType<DecisionModelV4['doDecide']>>['answers'][string];

/** The provider name of the built-in model, in reports and cache keys. */
export const LOCAL_PROVIDER = 'local';

/** `models/` ships beside `dist/`, and sits at the repository root when running from source. */
function modelsDir(): string {
  const candidates = ['../models/', '../../models/'].map((path) =>
    fileURLToPath(new URL(path, import.meta.url)),
  );
  const found = candidates.find((dir) => existsSync(`${dir}model.json`));
  if (!found) throw new Error(`The built-in model is missing: looked in ${candidates.join(', ')}`);
  return found;
}

let loading: Promise<{ model: LocalModel; parse: Parse }> | undefined;

/** Loads the model and grammars once per process, and only when a run uses them. */
function loaded(): Promise<{ model: LocalModel; parse: Parse }> {
  loading ??= Promise.all([loadLocalModel(modelsDir()), createParse()]).then(([model, parse]) => ({
    model,
    parse,
  }));
  return loading;
}

const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));

function answer(question: DecisionModelV4Question, value: number | undefined): DecisionAnswer {
  if (value === undefined) return { type: 'refusal' };
  if (question.type === 'boolean') return { type: 'boolean', probability: clamp(value, 1) };
  if (question.type === 'score') {
    return { type: 'score', score: clamp(value, question.criteria.length - 1) };
  }
  return { type: 'refusal' };
}

/** The ids the model was trained on, by question id of the request. Unknown questions are left out. */
function trainedIds(
  model: LocalModel,
  questions: Readonly<Record<string, DecisionModelV4Question>>,
): Map<string, string> {
  const ids = new Map<string, string>();
  for (const [key, question] of Object.entries(questions)) {
    const id = model.match(question);
    if (id !== undefined) ids.set(key, id);
  }
  return ids;
}

/** A decision model that answers the questions it was trained on and refuses the rest. */
function decisionModel(modelId: string): DecisionModelV4 {
  return {
    specificationVersion: 'v4',
    provider: LOCAL_PROVIDER,
    modelId,
    supportedQuestionTypes: ['score', 'boolean'],
    async doDecide({ state, questions }) {
      const { model, parse } = await loaded();
      const text = state.map((part) => (part.type === 'text' ? part.text : '')).join('');
      const ids = trainedIds(model, questions);
      const values = model.values(text, [...new Set(ids.values())], parse);
      const answers = Object.fromEntries(
        Object.entries(questions).map(([key, question]) => {
          const id = ids.get(key);
          return [key, answer(question, id === undefined ? undefined : values[id])];
        }),
      );
      return { answers, usage: { inputTokens: 0, outputTokens: 0 }, warnings: [] };
    },
  };
}

/** The built-in model, ready to use, with a test for the questions it can answer. */
export async function localDecisionModel(): Promise<{
  model: DecisionModelV4;
  modelId: string;
  answers: (question: AskedQuestion) => boolean;
}> {
  const { model } = await loaded();
  const modelId = `${model.meta.name}-${model.meta.version}`;
  return {
    model: decisionModel(modelId),
    modelId,
    answers: (question) => model.match(question) !== undefined,
  };
}
