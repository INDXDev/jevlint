/**
 * `jevlint architecture plan`: ranks what is wrong with the structure by severity, churn and
 * fan-in, and computes a move for each, such as the import to cut. A person or agent writes the plan.
 */
import { basename } from 'node:path';
import type { Config } from '../config.ts';
import { commitCounts } from '../git.ts';
import type {
  ArchitecturePlan,
  ArchitectureSsot,
  ArchitectureViolation,
  ComponentDependency,
  Evidence,
  PlanStep,
  ViolationRule,
} from '../types.ts';
import { violationsOf } from './check.ts';
import { collect } from './collect.ts';
import { assign } from './conformance.ts';
import { draftSsot } from './draft.ts';
import { componentDependencies } from './facts.ts';
import { ssotDir } from './load.ts';
import { buildStructure } from './structure.ts';

/** How much each kind of problem weighs before churn and fan-in. */
const SEVERITY: Record<ViolationRule | 'hub', number> = {
  'component-cycle': 5,
  'layer-violation': 4,
  'restricted-external': 3,
  'forbidden-dependency': 3,
  'forbidden-call': 2,
  'undeclared-dependency': 2,
  hub: 2,
  'missing-flow-step': 1,
  'stale-reference': 1,
  'unmapped-file': 1,
};

const MAX_EVIDENCE = 5;

/** A step before ranking. */
interface Candidate extends Omit<PlanStep, 'rank' | 'priority'> {
  severity: number;
  /** The component whose churn and fan-in weigh it. */
  weighs: string | null;
}

/** What ranking needs to know about each component. */
export interface PlanContext {
  dependencies: ComponentDependency[];
  churn: Map<string, number>;
  hubs: { path: string; component: string | null; users: Map<string, number> }[];
}

const evidenceOf = (items: ArchitectureViolation[]): Evidence[] =>
  items
    .slice(0, MAX_EVIDENCE)
    .map(({ path, line, target }) => ({ path, line, target: target ?? '' }));

/** For a cycle, cut the edge with the fewest imports: the cheapest way out of it. */
function cutCycle(
  violation: ArchitectureViolation,
  dependencies: ComponentDependency[],
): Candidate {
  const members = new Set(violation.message.replace(/^components in a cycle: /, '').split(', '));
  const inside = dependencies.filter(({ from, to }) => members.has(from) && members.has(to));
  const [cheapest] = inside.toSorted(
    (a, b) => a.weight - b.weight || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
  const move = cheapest
    ? `Cut ${cheapest.from} → ${cheapest.to} (${cheapest.weight} import${cheapest.weight === 1 ? '' : 's'}): move what ${cheapest.from} needs from ${cheapest.to} into ${cheapest.from} or a lower component, or pass it in.`
    : 'Break the cycle by moving shared code to a lower component.';
  return {
    severity: SEVERITY['component-cycle'],
    weighs: cheapest?.to ?? violation.component,
    problem: violation.message,
    move,
    component: cheapest?.from ?? violation.component,
    evidence: cheapest?.evidence ?? [],
  };
}

const MOVES: Partial<Record<ViolationRule, (from: string | null, target: string) => string>> = {
  'layer-violation': (from, to) =>
    `Move what ${from} uses from ${to} down to ${from}'s layer or below, or invert the dependency with a callback or an interface ${from} owns.`,
  'undeclared-dependency': (from, to) =>
    `Declare ${to} in ${from}'s depends_on if the dependency is intended. Otherwise remove these imports.`,
  'restricted-external': (from, target) =>
    `Move the use of ${target} out of ${from} into the component that owns it, and call that instead.`,
  'forbidden-dependency': (from, target) =>
    `Remove ${from}'s imports of ${target}, or move the code that needs it.`,
  'forbidden-call': (from, target) =>
    `Remove ${target} from ${from}, or move it to a component the rule allows.`,
};

/** One step per kind of violation and pair of ends, so ten imports of one module are one move. */
function groupedSteps(violations: ArchitectureViolation[], ssot: ArchitectureSsot): Candidate[] {
  const { componentOf } = assign(ssot);
  const endOf = (item: ArchitectureViolation) =>
    item.rule === 'layer-violation' || item.rule === 'undeclared-dependency'
      ? (componentOf(item.target ?? '') ?? item.target ?? '')
      : item.rule === 'forbidden-call'
        ? item.ruleId
        : (item.target ?? '');
  const groups = Map.groupBy(
    violations.filter(({ rule }) => rule !== 'component-cycle'),
    (item) =>
      JSON.stringify([
        item.rule,
        item.component,
        ['stale-reference', 'unmapped-file', 'missing-flow-step'].includes(item.rule)
          ? ''
          : endOf(item),
      ]),
  );
  return [...groups.values()].map((items): Candidate => {
    const [first] = items as [ArchitectureViolation];
    const target = endOf(first);
    const move = MOVES[first.rule];
    const count = items.length;
    const problems: Partial<Record<ViolationRule, string>> = {
      'unmapped-file': `${count} file${count === 1 ? '' : 's'} in no component`,
      'stale-reference': `${count} stale reference${count === 1 ? '' : 's'} in ${first.component}`,
      'missing-flow-step': `${count} flow step${count === 1 ? '' : 's'} with no dependency in code`,
    };
    return {
      severity: SEVERITY[first.rule],
      weighs: first.rule === 'layer-violation' ? target : first.component,
      problem:
        problems[first.rule] ??
        `${first.rule}: ${first.message}${count > 1 ? ` (${count} places)` : ''}`,
      move: move
        ? move(first.component, target)
        : first.rule === 'unmapped-file'
          ? 'Add each file to the component it serves, or list it in ignore.'
          : first.rule === 'missing-flow-step'
            ? 'Fix the flow to match the code, or add the missing call if the flow is the intended design.'
            : 'Update the SSOT entries to what the code has now.',
      component: first.component,
      evidence: evidenceOf(items),
    };
  });
}

function hubSteps(context: PlanContext): Candidate[] {
  return context.hubs.map(({ path, component, users }) => {
    const clusters = [...users]
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => `${id} (${count})`);
    return {
      severity: SEVERITY.hub,
      weighs: component,
      problem: `${path} is a hub: it uses and serves many modules`,
      // Users from one component give nothing to split by, so the split follows concerns instead.
      move:
        users.size > 1
          ? `Split ${path} by its users, one part each for: ${clusters.join(', ')}.`
          : `Split ${path} by concern: only ${clusters.join(', ')} uses it, so group what each caller needs.`,
      component,
      evidence: [{ path, line: 1, target: path }],
    };
  });
}

/** Ranks the steps: severity, times one plus the log of churn, times one plus fan-in. */
export function rankSteps(
  violations: ArchitectureViolation[],
  ssot: ArchitectureSsot,
  context: PlanContext,
): PlanStep[] {
  const cycles = violations
    .filter(({ rule }) => rule === 'component-cycle')
    .map((v) => cutCycle(v, context.dependencies));
  const candidates = [...cycles, ...groupedSteps(violations, ssot), ...hubSteps(context)];
  const fanIn = (id: string | null) => context.dependencies.filter(({ to }) => to === id).length;
  const weighed = candidates.map(({ severity, weighs, ...step }) => ({
    ...step,
    raw: severity * (1 + Math.log1p(context.churn.get(weighs ?? '') ?? 0)) * (1 + fanIn(weighs)),
  }));
  const top = Math.max(1, ...weighed.map(({ raw }) => raw));
  return weighed
    .toSorted((a, b) => b.raw - a.raw || a.problem.localeCompare(b.problem))
    .map(({ raw, ...step }, index) => ({
      rank: index + 1,
      priority: Number((raw / top).toFixed(3)),
      ...step,
    }));
}

/** Builds the plan from the SSOT, or from the draft the facts give when there is none. */
export async function planArchitecture(
  config: Config,
  existing: ArchitectureSsot | null,
): Promise<ArchitecturePlan> {
  const collected = await collect(config, { keepSources: true });
  const ssot = existing ?? draftSsot(collected.facts, basename(config.root), ssotDir(config));
  const violations = violationsOf(ssot, collected).filter(({ status }) => status === 'current');
  const { componentOf } = assign(ssot);
  const counts = await commitCounts(config.root, config.priority.churn_days);
  const churn = new Map<string, number>();
  for (const [path, count] of counts) {
    const id = componentOf(path);
    if (id !== null) churn.set(id, (churn.get(id) ?? 0) + count);
  }
  const structure = buildStructure(collected.resolved, config.architecture);
  const importers = (path: string) =>
    collected.modules.filter(({ imports }) => imports.some((target) => target.path === path));
  const hubs = structure.findings
    .filter(({ rule }) => rule === 'hub')
    .map(({ path }) => {
      const users = new Map<string, number>();
      for (const { path: user } of importers(path)) {
        const id = componentOf(user) ?? 'unmapped';
        users.set(id, (users.get(id) ?? 0) + 1);
      }
      return { path, component: componentOf(path), users };
    });
  const dependencies = componentDependencies(collected.modules, componentOf);
  return {
    root: config.root,
    dir: existing ? existing.dir : null,
    steps: rankSteps(violations, ssot, { dependencies, churn, hubs }),
    warnings: [
      ...collected.warnings,
      ...(existing ? [] : ['No SSOT, so the plan uses the draft components from the facts.']),
    ],
  };
}
