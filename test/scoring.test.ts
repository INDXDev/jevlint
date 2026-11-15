import { describe, expect, it } from 'vitest';
import {
  acceptanceScore,
  astScoreFrom,
  compliance,
  fileScore,
  modelResult,
  rank,
  repoScore,
  scaleScore,
} from '../src/scoring.ts';
import type { BooleanQuestion, FileReport, ScoreQuestion } from '../src/types.ts';

const base = { title: 'T', instructions: 'I', weight: 1, fix: 'F' };
const score: ScoreQuestion = {
  ...base,
  id: 'p.s',
  type: 'score',
  levels: ['a', 'b', 'c', 'd', 'e'],
};
const good: BooleanQuestion = { ...base, id: 'p.g', type: 'boolean', good: true };
const bad: BooleanQuestion = { ...base, id: 'q.b', type: 'boolean', good: false, weight: 3 };
const scoring = { scale: 100, precision: 0, ast_weight: 1, model_weight: 3, fail_under: 0 };

function file(overrides: Partial<FileReport>): FileReport {
  return {
    path: 'a.ts',
    language: 'typescript',
    lines: 10,
    score: 1,
    priority: 0,
    commits: 0,
    ast: { score: 1, findings: [] },
    model: null,
    warnings: [],
    ...overrides,
  };
}

describe('compliance', () => {
  it('maps each question type', () => {
    expect(compliance(score, { value: 3 })).toBe(0.75);
    expect(compliance(good, { value: 0.8 })).toBe(0.8);
    expect(compliance(bad, { value: 0.75 })).toBe(0.25);
  });
});

describe('astScoreFrom', () => {
  const metric = (value: number, limit: number) => ({
    rule: 'm',
    message: '',
    line: 1,
    value,
    limit,
  });
  const match = { rule: 'p', message: '', line: 1 };

  it('is 1 without findings', () => {
    expect(astScoreFrom([])).toBe(1);
  });

  it('takes the worst sub-score', () => {
    expect(astScoreFrom([metric(20, 10), metric(40, 10)])).toBe(0.25);
  });

  it('reduces by 5% per pattern match', () => {
    expect(astScoreFrom([metric(20, 10), match, match])).toBeCloseTo(0.5 * 0.95 ** 2);
  });
});

describe('modelResult', () => {
  const decision = {
    answers: { 'p.s': { value: 4 }, 'p.g': { value: 0 }, 'q.b': { value: 0.5 } },
    cached: true,
    truncated: false,
    inputTokens: 7,
  };

  it('weights the mean and groups by preset', () => {
    const result = modelResult([score, good, bad], decision);
    expect(result.score).toBeCloseTo((1 + 0 + 0.5 * 3) / 5);
    expect(result.presets).toEqual({ p: 0.5, q: 0.5 });
    expect(result).toMatchObject({ cached: true, truncated: false, inputTokens: 7 });
    expect(result.answers[0]).toEqual({
      id: 'p.s',
      title: 'T',
      compliance: 1,
      weight: 1,
      fix: 'F',
    });
  });

  it('keeps dotted preset names whole', () => {
    const dotted = { ...good, id: 'my.preset.g' };
    const answers = { 'my.preset.g': { value: 1 } };
    expect(modelResult([dotted], { ...decision, answers }).presets).toEqual({ 'my.preset': 1 });
  });
});

describe('fileScore', () => {
  it('blends both engines by weight', () => {
    expect(fileScore(0.2, 0.6, scoring)).toBeCloseTo(0.5);
  });

  it('uses the only engine that ran', () => {
    expect(fileScore(0.2, null, scoring)).toBe(0.2);
    expect(fileScore(null, 0.6, scoring)).toBe(0.6);
  });

  it('is null when neither ran', () => {
    expect(fileScore(null, null, scoring)).toBeNull();
  });
});

describe('rank', () => {
  it('applies the priority formula', () => {
    const [top] = rank(
      [
        file({ path: 'a', score: 0.5, commits: 3, lines: 100 }),
        file({ path: 'b', score: 1, commits: 1, lines: 10 }),
      ],
      { churn: 1, size: 0.5, churn_days: 90 },
    );
    expect(top?.path).toBe('a');
    expect(top?.priority).toBeCloseTo(0.5 * (1 + 1 + 0.5));
  });

  it('scales churn and size logarithmically', () => {
    const [top] = rank(
      [
        file({ path: 'a', score: 0, commits: 1, lines: 0 }),
        file({ path: 'b', score: 1, commits: 3, lines: 0 }),
      ],
      { churn: 1, size: 0, churn_days: 90 },
    );
    expect(top?.priority).toBeCloseTo(1 + Math.log(2) / Math.log(4));
  });

  it('handles more files than a call can take arguments', () => {
    const files = Array.from({ length: 200_000 }, (_, index) => file({ path: String(index) }));
    expect(rank(files, { churn: 1, size: 1, churn_days: 90 })).toHaveLength(200_000);
  });

  it('survives no commits or lines, and breaks ties by path', () => {
    const files = [
      file({ path: 'b', score: 0, lines: 0 }),
      file({ path: 'a', score: 0, lines: 0 }),
    ];
    const ranked = rank(files, { churn: 1, size: 1, churn_days: 90 });
    expect(ranked.map((f) => [f.path, f.priority])).toEqual([
      ['a', 1],
      ['b', 1],
    ]);
  });
});

describe('repoScore', () => {
  it('weights by lines', () => {
    expect(repoScore([file({ score: 0, lines: 30 }), file({ score: 1, lines: 10 })])).toBe(0.25);
  });

  it('ignores files no engine scored', () => {
    const unscored = file({ score: 1, lines: 90, ast: null, model: null });
    expect(repoScore([unscored, file({ score: 0.5 })])).toBe(0.5);
  });

  it('counts a whole-file pin in a language no engine reads', () => {
    const pin = { value: 0, reason: 'Accepted', line: 1 };
    const pinned = file({ score: 0, lines: 30, ast: null, model: null, pin });
    expect(repoScore([pinned, file({ score: 1, lines: 10 })])).toBe(0.25);
  });

  it('is full marks with nothing to score', () => {
    expect(repoScore([])).toBe(1);
    expect(repoScore([file({ score: 0, lines: 0 })])).toBe(1);
  });
});

describe('scaleScore', () => {
  it('scales and rounds to the configured precision', () => {
    expect(scaleScore(0.456, scoring)).toBe(46);
    expect(scaleScore(0.456, { ...scoring, scale: 1, precision: 2 })).toBe(0.46);
  });
});

describe('acceptanceScore', () => {
  it('counts met as 1 and partly as half, over the criteria a diff can show', () => {
    expect(acceptanceScore(['met', 'partly', 'not-met', 'cannot-tell'], scoring)).toBe(50);
    expect(acceptanceScore(['met', 'met', 'partly'], scoring)).toBe(83);
    expect(acceptanceScore(['not-met'], { ...scoring, scale: 1, precision: 2 })).toBe(0);
  });

  it('leaves out cannot-tell and unjudged criteria, and is null when none count', () => {
    expect(acceptanceScore(['met', 'cannot-tell', null], scoring)).toBe(100);
    expect(acceptanceScore(['cannot-tell', null], scoring)).toBeNull();
    expect(acceptanceScore([], scoring)).toBeNull();
  });
});
