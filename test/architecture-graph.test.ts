import { describe, expect, it } from 'vitest';
import {
  communities,
  type Dependencies,
  longestPath,
  pageRank,
} from '../src/architecture/graph.ts';

const deps = (entries: [string, string[]][]): Dependencies =>
  new Map(entries.map(([node, targets]) => [node, new Set(targets)]));

describe('pageRank', () => {
  it('sums to 1 and ranks what everything depends on first', () => {
    const graph = deps([
      ['a', ['c']],
      ['b', ['c']],
      ['c', []],
    ]);
    const ranks = pageRank(['a', 'b', 'c'], graph);
    const total = [...ranks.values()].reduce((sum, rank) => sum + rank, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(ranks.get('c')).toBeGreaterThan(ranks.get('a') as number);
  });
});

describe('communities', () => {
  const edges: [string, string, number][] = [
    ['a1', 'a2', 3],
    ['a2', 'a3', 3],
    ['b1', 'b2', 3],
    ['a3', 'b1', 1],
  ];
  const singles = ['a1', 'a2', 'a3', 'b1', 'b2'].map((node) => [node]);

  it('groups densely linked nodes', () => {
    expect(communities(singles, edges, () => true, 25)).toEqual([
      ['a1', 'a2', 'a3'],
      ['b1', 'b2'],
    ]);
  });

  it('merges nothing that allowed refuses, up to the maximum', () => {
    expect(communities(singles, edges, () => false, 25)).toHaveLength(5);
    expect(communities(singles, edges, () => false, 2)).toHaveLength(2);
  });
});

describe('longestPath', () => {
  it('follows the longest chain, counting a cycle once', () => {
    const graph = deps([
      ['entry', ['a', 'z']],
      ['a', ['b']],
      ['b', ['a', 'c']],
      ['c', []],
      ['z', []],
    ]);
    const path = longestPath('entry', ['entry', 'a', 'b', 'c', 'z'], graph);
    expect(path[0]).toBe('entry');
    expect(path.at(-1)).toBe('c');
    expect(path).toHaveLength(3);
  });
});
