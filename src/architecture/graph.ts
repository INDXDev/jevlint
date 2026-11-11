/** Pure graph algorithms over dependency maps. */

/** Each node's dependencies. */
export type Dependencies = Map<string, Set<string>>;

/** Tarjan's algorithm. Components come out dependencies first, each one sorted. */
export function stronglyConnected(nodes: string[], dependencies: Dependencies): string[][] {
  const order = new Map<string, number>();
  const lowest = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  const enter = (node: string) => {
    order.set(node, order.size);
    lowest.set(node, order.get(node) as number);
    stack.push(node);
    onStack.add(node);
    return { node, pending: (dependencies.get(node) ?? new Set<string>()).values() };
  };
  const lower = (node: string, value: number) =>
    lowest.set(node, Math.min(lowest.get(node) as number, value));

  const leave = (node: string) => {
    if (lowest.get(node) !== order.get(node)) return;
    const component = stack.splice(stack.lastIndexOf(node));
    for (const member of component) onStack.delete(member);
    components.push(component.sort());
  };

  for (const root of nodes) {
    if (order.has(root)) continue;
    // An explicit path, because a long chain of imports would overflow the call stack.
    const path = [enter(root)];
    for (let top = path.at(-1); top; top = path.at(-1)) {
      const { node, pending } = top;
      const next = pending.next();
      if (next.done) {
        path.pop();
        const parent = path.at(-1)?.node;
        if (parent !== undefined) lower(parent, lowest.get(node) as number);
        leave(node);
      } else if (!order.has(next.value)) {
        path.push(enter(next.value));
      } else if (onStack.has(next.value)) {
        lower(node, order.get(next.value) as number);
      }
    }
  }
  return components;
}

/** Layer 0 depends on nothing, and every other node sits one above its highest dependency. */
export function layersOf(components: string[][], dependencies: Dependencies): Map<string, number> {
  const layers = new Map<string, number>();
  for (const component of components) {
    const inside = new Set(component);
    let layer = 0;
    for (const node of component) {
      for (const next of dependencies.get(node) ?? []) {
        if (!inside.has(next)) layer = Math.max(layer, (layers.get(next) ?? -1) + 1);
      }
    }
    for (const node of component) layers.set(node, layer);
  }
  return layers;
}

/** The nodes that take part in a cycle. */
export function cyclicNodes(components: string[][]): Map<string, string[]> {
  const cycles = components.filter((component) => component.length > 1);
  return new Map(cycles.flatMap((cycle) => cycle.map((node) => [node, cycle])));
}

const DAMPING = 0.85;
const RANK_ROUNDS = 50;

/** PageRank, where each node passes its rank to what it depends on. Ranks sum to 1. */
export function pageRank(nodes: string[], dependencies: Dependencies): Map<string, number> {
  const count = nodes.length;
  let ranks = new Map(nodes.map((node) => [node, 1 / count]));
  for (let round = 0; round < RANK_ROUNDS; round++) {
    const next = new Map(nodes.map((node) => [node, (1 - DAMPING) / count]));
    let dangling = 0;
    for (const node of nodes) {
      const targets = [...(dependencies.get(node) ?? [])].filter((target) => next.has(target));
      const rank = ranks.get(node) as number;
      if (targets.length === 0) dangling += rank;
      for (const target of targets) {
        next.set(target, (next.get(target) as number) + (DAMPING * rank) / targets.length);
      }
    }
    for (const node of nodes)
      next.set(node, (next.get(node) as number) + (DAMPING * dangling) / count);
    ranks = next;
  }
  return ranks;
}

/** An undirected weighted edge between two nodes. */
export type WeightedEdge = [string, string, number];

interface Grouping {
  members: Map<number, string[]>;
  /** Sum of edge weights at each group's members. */
  degree: Map<number, number>;
  /** Weight between each pair of groups, both ways. */
  between: Map<number, Map<number, number>>;
  total: number;
}

function startGrouping(groups: string[][], edges: WeightedEdge[]): Grouping {
  const groupOf = new Map<string, number>();
  groups.forEach((members, index) => {
    for (const member of members) groupOf.set(member, index);
  });
  const grouping: Grouping = {
    members: new Map(groups.map((members, index) => [index, members])),
    degree: new Map(groups.map((_, index) => [index, 0])),
    between: new Map(groups.map((_, index) => [index, new Map()])),
    total: 0,
  };
  for (const [a, b, weight] of edges) {
    const [i, j] = [groupOf.get(a), groupOf.get(b)];
    if (i === undefined || j === undefined) continue;
    grouping.total += weight;
    grouping.degree.set(i, (grouping.degree.get(i) as number) + weight);
    grouping.degree.set(j, (grouping.degree.get(j) as number) + weight);
    if (i === j) continue;
    const add = (x: number, y: number) => {
      const row = grouping.between.get(x) as Map<number, number>;
      row.set(y, (row.get(y) ?? 0) + weight);
    };
    add(i, j);
    add(j, i);
  }
  return grouping;
}

/** The change in modularity from merging groups `i` and `j`. */
function gain({ degree, between, total }: Grouping, i: number, j: number): number {
  const twice = 2 * total;
  const joint = (between.get(i)?.get(j) ?? 0) / twice;
  return 2 * (joint - ((degree.get(i) as number) / twice) * ((degree.get(j) as number) / twice));
}

function merge(grouping: Grouping, i: number, j: number): void {
  const { members, degree, between } = grouping;
  members.set(i, [...(members.get(i) as string[]), ...(members.get(j) as string[])]);
  degree.set(i, (degree.get(i) as number) + (degree.get(j) as number));
  const row = between.get(i) as Map<number, number>;
  for (const [k, weight] of between.get(j) as Map<number, number>) {
    if (k === i) continue;
    row.set(k, (row.get(k) ?? 0) + weight);
    const other = between.get(k) as Map<number, number>;
    other.set(i, (other.get(i) ?? 0) + weight);
    other.delete(j);
  }
  row.delete(j);
  members.delete(j);
  degree.delete(j);
  between.delete(j);
}

/** The best pair to merge next, ties going to the lowest indexes so the result is stable. */
function bestPair(
  grouping: Grouping,
  allowed: (a: string[], b: string[]) => boolean,
): { i: number; j: number; gain: number } | null {
  let best: { i: number; j: number; gain: number } | null = null;
  for (const [i, row] of grouping.between) {
    for (const j of row.keys()) {
      if (j <= i) continue;
      const pairGain = gain(grouping, i, j);
      if (best && pairGain <= best.gain) continue;
      if (!allowed(grouping.members.get(i) as string[], grouping.members.get(j) as string[])) {
        continue;
      }
      best = { i, j, gain: pairGain };
    }
  }
  return best;
}

/**
 * Greedy modularity clustering (Clauset, Newman and Moore). Starts from `groups`, merges pairs
 * while modularity rises and `allowed` agrees, then keeps merging the best connected pairs until
 * at most `max` groups remain. Groups come back in the order of their first member.
 */
export function communities(
  groups: string[][],
  edges: WeightedEdge[],
  allowed: (a: string[], b: string[]) => boolean,
  max: number,
): string[][] {
  const grouping = startGrouping(groups, edges);
  if (grouping.total > 0) {
    for (let pair = bestPair(grouping, allowed); pair && pair.gain > 0; ) {
      merge(grouping, pair.i, pair.j);
      pair = bestPair(grouping, allowed);
    }
    while (grouping.members.size > max) {
      const pair = bestPair(grouping, () => true);
      if (!pair) break;
      merge(grouping, pair.i, pair.j);
    }
  }
  return [...grouping.members.values()].map((members) => members.toSorted());
}

/**
 * The longest chain of dependencies from `start`, with each cycle counted once. Ties go to the
 * alphabetically first next node.
 */
export function longestPath(start: string, nodes: string[], dependencies: Dependencies): string[] {
  const components = stronglyConnected(nodes, dependencies);
  const componentOf = new Map<string, number>();
  components.forEach((members, index) => {
    for (const member of members) componentOf.set(member, index);
  });
  // Tarjan's order puts every component after those it depends on, so one pass suffices.
  const best = new Map<number, string[]>();
  components.forEach((members, index) => {
    let chain: string[] = [];
    for (const member of members) {
      for (const next of [...(dependencies.get(member) ?? [])].sort()) {
        const target = componentOf.get(next);
        if (target === undefined || target === index) continue;
        const candidate = best.get(target) as string[];
        if (candidate.length > chain.length) chain = candidate;
      }
    }
    best.set(index, [members[0] as string, ...chain]);
  });
  const own = componentOf.get(start);
  if (own === undefined) return [start];
  const path = best.get(own) as string[];
  return [start, ...path.slice(1)];
}
