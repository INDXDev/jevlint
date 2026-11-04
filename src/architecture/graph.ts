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
