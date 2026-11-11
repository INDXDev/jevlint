/** Judges a change against what it claims and against the repository's own instructions. */

import { type Config, UserError } from './config.ts';
import { decideFile, PROVIDER_ERROR } from './decision/decide.ts';
import { estimateCostUsd } from './decision/pricing.ts';
import { createDecisionModel } from './decision/providers.ts';
import { excludedPaths } from './files.ts';
import { changeDiff, fileAt, touchedFiles } from './git.ts';
import { activeQuestions, loadPresets } from './presets.ts';
import { modelResult } from './scoring.ts';
import type { AuditReport, Change, ModelAnswer, Question } from './types.ts';

const PRESET = 'change-intent';
const INSTRUCTIONS_QUESTION = `${PRESET}.follows-instructions`;
const NO_USAGE = { inputTokens: 0, estimatedCostUsd: null, cacheHits: 0, modelCalls: 0 };

/** A judged change: the answers, and what went wrong on the way to them. */
export interface IntentResult {
  answers: ModelAnswer[];
  warnings: string[];
  usage: AuditReport['usage'];
}

/** From the base commit, so that a change cannot rewrite the rules it is judged by. */
async function instructionsAt(root: string, base: string | null): Promise<string> {
  if (!base) return '';
  const agents = await fileAt(root, base, 'AGENTS.md');
  return (agents?.trim() ? agents : await fileAt(root, base, 'CLAUDE.md'))?.trim() ?? '';
}

/** The diff comes last, as the longest section: truncation must not remove the message. */
function intentState(message: string, instructions: string, diff: string): string {
  const base = "Repository instructions, from the change's base commit";
  const sections = [
    ['Message', message],
    ...(instructions ? [[base, instructions]] : []),
    ['Unified diff', diff],
  ];
  return sections.map(([label, text]) => `===== ${label} =====\n${text}`).join('\n\n');
}

async function sendableDiff(config: Config, change: Change): Promise<string> {
  // A change can touch a file audit would never send, such as a committed `.env`.
  const excluded = await excludedPaths(config, await touchedFiles(config.root, change));
  return changeDiff(config.root, change, excluded);
}

async function intentQuestions(config: Config, instructions: string): Promise<Question[]> {
  const questions = activeQuestions(await loadPresets([PRESET], config.root), config.weights);
  return instructions ? questions : questions.filter(({ id }) => id !== INSTRUCTIONS_QUESTION);
}

/** Asks the model about one change. Returns null with no usable key, so a review can carry on. */
export async function judgeIntent(
  config: Config,
  change: Change,
  noCache?: boolean,
): Promise<IntentResult | null> {
  const resolved = await createDecisionModel(config);
  if (!resolved) return null;
  const instructions = await instructionsAt(config.root, change.base);
  const diff = await sendableDiff(config, change);
  const questions = await intentQuestions(config, instructions);
  if (diff.trim() === '' || questions.length === 0) {
    return { answers: [], warnings: ['not judged, as there is no diff to read.'], usage: NO_USAGE };
  }
  const source = intentState(change.message ?? change.title, instructions, diff);
  try {
    const decision = await decideFile({ resolved, questions, source, config, noCache });
    const { cached, truncated } = decision;
    const inputTokens = cached ? 0 : decision.inputTokens;
    return {
      answers: modelResult(questions, decision).answers,
      warnings: truncated
        ? [`truncated: the model saw only the first ${config.max_file_chars} characters.`]
        : [],
      usage: {
        inputTokens,
        estimatedCostUsd: estimateCostUsd(inputTokens, resolved),
        cacheHits: cached ? 1 : 0,
        modelCalls: cached ? 0 : 1,
      },
    };
  } catch (error) {
    if (error instanceof UserError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    return { answers: [], warnings: [`${PROVIDER_ERROR} ${reason}`], usage: NO_USAGE };
  }
}
