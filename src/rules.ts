/** Semantic rules: ast-grep picks the code, and one boolean question judges each match. */
import { patternMatches } from './ast/analyze.ts';
import { type Config, UserError } from './config.ts';
import {
  decideFile,
  decisionRequest,
  isDecisionCached,
  PROVIDER_ERROR,
} from './decision/decide.ts';
import type { ModelTarget, ResolvedModel } from './decision/providers.ts';
import { parseDirectives } from './directives.ts';
import { astScoreFrom } from './scoring.ts';
import type {
  AstFinding,
  AstResult,
  AstRule,
  BooleanQuestion,
  Language,
  RuleUsage,
} from './types.ts';

/** What a run needs to judge a file's rules. */
export interface RuleRun {
  config: Config;
  options: { noCache?: boolean };
  resolved: ResolvedModel | null;
  rules: AstRule[];
}

interface RuleRequest {
  rule: AstRule;
  line: number;
  text: string;
}

function ruleQuestion({ id, message, question, fix }: AstRule): BooleanQuestion {
  return {
    id,
    type: 'boolean',
    title: message,
    instructions: question,
    weight: 1,
    fix,
    good: false,
  };
}

/**
 * Matches come from the raw source, so lines stay true, and pins come out of each match, so a
 * comment neither reaches the model nor invalidates the cache.
 */
function ruleRequests(
  source: string,
  language: Language | null,
  rules: AstRule[],
  { max_rule_matches, scoring }: Config,
): { requests: RuleRequest[]; warnings: string[] } {
  const found = language ? patternMatches(source, language, rules) : [];
  const requests: RuleRequest[] = [];
  const warnings: string[] = [];
  for (const { pattern: rule, matches } of found) {
    const sendable = matches
      .map(({ line, text }) => ({ rule, line, text: parseDirectives(text, scoring.scale).code }))
      .filter(({ text }) => text.trim() !== '');
    requests.push(...sendable.slice(0, max_rule_matches));
    if (sendable.length > max_rule_matches) {
      warnings.push(
        `Rule ${rule.id}: judged the first ${max_rule_matches} of ${sendable.length} matches and skipped the rest.`,
      );
    }
  }
  return { requests, warnings };
}

/**
 * Asks about each match in turn, so a file holds one provider call at a time and `concurrency`
 * stays the limit for the whole run. Hits join the AST findings, so everything downstream works.
 */
export async function judgeRules(
  ast: AstResult | null,
  source: string,
  language: Language | null,
  { config, options, resolved, rules }: RuleRun,
): Promise<{ ast: AstResult | null; warnings: string[]; usage?: RuleUsage }> {
  if (!ast || !resolved) return { ast, warnings: [] };
  const { requests, warnings } = ruleRequests(source, language, rules, config);
  const hits: AstFinding[] = [];
  let usage: RuleUsage | undefined;
  for (const { rule, line, text } of requests) {
    try {
      const { noCache } = options;
      const questions = [ruleQuestion(rule)];
      const decision = await decideFile({ resolved, questions, source: text, config, noCache });
      const { cached, inputTokens, truncated } = decision;
      usage = {
        inputTokens: (usage?.inputTokens ?? 0) + (cached ? 0 : inputTokens),
        cacheHits: (usage?.cacheHits ?? 0) + (cached ? 1 : 0),
        modelCalls: (usage?.modelCalls ?? 0) + (cached ? 0 : 1),
      };
      if (truncated) {
        warnings.push(
          `Rule ${rule.id}: the model saw only the first ${config.max_file_chars} characters of a match.`,
        );
      }
      const probability = decision.answers[rule.id]?.value ?? 0;
      if (probability >= rule.threshold) {
        hits.push({ rule: rule.id, message: rule.message, line, probability, fix: rule.fix });
      }
    } catch (error) {
      if (error instanceof UserError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`${PROVIDER_ERROR} ${reason}`);
    }
  }
  const findings = [...ast.findings, ...hits];
  return {
    ast: hits.length > 0 ? { ...ast, score: astScoreFrom(findings), findings } : ast,
    warnings: [...new Set(warnings)],
    usage,
  };
}

/** Says what `judgeRules` would send for a file, with no provider call. */
export async function plannedRuleChars(
  source: string,
  language: Language | null,
  rules: AstRule[],
  target: ModelTarget,
  config: Config,
  noCache?: boolean,
): Promise<{ chars: number; questionChars: number }> {
  const planned = { chars: 0, questionChars: 0 };
  for (const { rule, text } of ruleRequests(source, language, rules, config).requests) {
    const questions = [ruleQuestion(rule)];
    if (!noCache && (await isDecisionCached(target, questions, text, config))) continue;
    planned.chars += Math.min(text.length, config.max_file_chars);
    planned.questionChars += JSON.stringify(decisionRequest(questions)).length;
  }
  return planned;
}
