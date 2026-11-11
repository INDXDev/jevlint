/**
 * Compares the code with the SSOT: structural violations for `check`, the component map for
 * `show`, and static drift for `drift`. Pure: every input is data the pipeline collected.
 */
import { dirname, posix } from 'node:path';
import type {
  ArchitectureComponent,
  ArchitectureRule,
  ArchitectureSsot,
  ArchitectureViolation,
  ComponentDependency,
  DriftItem,
  FactModule,
  Language,
  MapEdge,
} from '../types.ts';
import { classifyPackage, matchesPackage } from './externals.ts';
import { componentDependencies, dependencyMap } from './facts.ts';
import { cyclicNodes, stronglyConnected } from './graph.ts';

/** A match of a `forbid-call` pattern, found by the pipeline with ast-grep. */
export interface CallMatch {
  ruleId: string;
  path: string;
  line: number;
  text: string;
}

/** A `forbid-call` rule with the files it applies to, for the pipeline to search. */
export interface CallSearch {
  ruleId: string;
  pattern: string;
  language?: Language;
  files: string[];
}

/** Which component, if any, owns each file, and which files the SSOT ignores. */
export interface Assignment {
  componentOf: (path: string) => string | null;
  ignored: (path: string) => boolean;
}

const specificity = (pattern: string) =>
  pattern.includes('*') ? pattern.replace(/\*+.*$/, '').length : Number.MAX_SAFE_INTEGER;

/** Assigns files to components by `paths`. When two match, the more specific glob wins. */
export function assign(ssot: ArchitectureSsot): Assignment {
  const cache = new Map<string, string | null>();
  const componentOf = (path: string) => {
    const known = cache.get(path);
    if (known !== undefined) return known;
    let best: { id: string; score: number } | null = null;
    for (const { id, paths } of ssot.components) {
      for (const pattern of paths) {
        if (pattern !== path && !posix.matchesGlob(path, pattern)) continue;
        const score = specificity(pattern);
        if (!best || score > best.score) best = { id, score };
      }
    }
    cache.set(path, best?.id ?? null);
    return best?.id ?? null;
  };
  const ignored = (path: string) =>
    ssot.index.ignore.some((pattern) => pattern === path || posix.matchesGlob(path, pattern));
  return { componentOf, ignored };
}

/** The modules the SSOT governs: every file but the ignored ones, with ignored imports dropped. */
function governed(modules: FactModule[], { ignored }: Assignment): FactModule[] {
  return modules
    .filter(({ path }) => !ignored(path))
    .map((module) => ({ ...module, imports: module.imports.filter(({ path }) => !ignored(path)) }));
}

/** Each rule with its full id and the component it is declared in, if any. */
function rulesOf(
  ssot: ArchitectureSsot,
): { rule: ArchitectureRule; ruleId: string; owner?: ArchitectureComponent }[] {
  return [
    ...ssot.index.rules.map((rule) => ({ rule, ruleId: rule.id })),
    ...ssot.components.flatMap((owner) =>
      owner.rules.map((rule) => ({ rule, ruleId: `${owner.id}.${rule.id}`, owner })),
    ),
  ];
}

/** Every `forbid-call` rule with the files it covers, for the pipeline to search with ast-grep. */
export function callSearches(ssot: ArchitectureSsot, modules: FactModule[]): CallSearch[] {
  const assignment = assign(ssot);
  const code = governed(modules, assignment);
  return rulesOf(ssot).flatMap(({ rule, ruleId, owner }) => {
    if (rule.kind !== 'forbid-call') return [];
    const from = owner ? [owner.id] : rule.from;
    const except = new Set(rule.except ?? []);
    const files = code
      .filter(({ path, language }) => {
        const component = assignment.componentOf(path);
        if (component !== null && except.has(component)) return false;
        if (from && (component === null || !from.includes(component))) return false;
        return !rule.language || rule.language === language;
      })
      .map(({ path }) => path);
    return [{ ruleId, pattern: rule.pattern, language: rule.language, files }];
  });
}

/** What conformance needs besides the SSOT. */
export interface ConformanceInput {
  modules: FactModule[];
  /** Whether a root-relative path exists, for `key_files`. */
  exists: (path: string) => boolean;
  calls: CallMatch[];
}

interface Context {
  ssot: ArchitectureSsot;
  assignment: Assignment;
  code: FactModule[];
  byId: Map<string, ArchitectureComponent>;
  dependencies: ComponentDependency[];
}

function contextOf(ssot: ArchitectureSsot, modules: FactModule[]): Context {
  const assignment = assign(ssot);
  const code = governed(modules, assignment);
  return {
    ssot,
    assignment,
    code,
    byId: new Map(ssot.components.map((component) => [component.id, component])),
    dependencies: componentDependencies(code, assignment.componentOf),
  };
}

const componentFile = (ssot: ArchitectureSsot, id: string) =>
  posix.join(ssot.dir, 'components', `${id}.yaml`);

function violation(
  context: Context,
  fields: Omit<ArchitectureViolation, 'status'>,
): ArchitectureViolation {
  const owner = fields.component === null ? undefined : context.byId.get(fields.component);
  return { ...fields, status: owner?.status === 'target' ? 'target' : 'current' };
}

/** Each import from one component's file to another's, with its line. */
function crossingImports({ code, assignment }: Context) {
  return code.flatMap(({ path, imports }) => {
    const from = assignment.componentOf(path);
    if (from === null) return [];
    return imports.flatMap((target) => {
      const to = assignment.componentOf(target.path);
      return to === null || to === from
        ? []
        : [{ path, line: target.line, from, to, target: target.path }];
    });
  });
}

function externalImports({ code, assignment }: Context) {
  return code.flatMap(({ path, externals }) => {
    const from = assignment.componentOf(path);
    return from === null ? [] : externals.map((external) => ({ ...external, path, from }));
  });
}

function layerViolations(context: Context, ruleId: string): ArchitectureViolation[] {
  const order = new Map(context.ssot.index.layers.map((layer, index) => [layer, index]));
  const levelOf = (id: string) => {
    const layer = context.byId.get(id)?.layer;
    return layer === undefined ? undefined : order.get(layer);
  };
  return crossingImports(context).flatMap(({ path, line, from, to, target }) => {
    const [own, other] = [levelOf(from), levelOf(to)];
    if (own === undefined || other === undefined || other >= own) return [];
    const [fromLayer, toLayer] = [context.byId.get(from)?.layer, context.byId.get(to)?.layer];
    return [
      violation(context, {
        rule: 'layer-violation',
        ruleId,
        component: from,
        path,
        line,
        target,
        message: `${from} (${fromLayer}) imports ${to} (${toLayer}), a layer above it`,
      }),
    ];
  });
}

function undeclared(context: Context): ArchitectureViolation[] {
  return crossingImports(context).flatMap(({ path, line, from, to, target }) => {
    const allowed = context.byId.get(from)?.depends_on;
    if (!allowed || allowed.includes(to)) return [];
    return [
      violation(context, {
        rule: 'undeclared-dependency',
        ruleId: `${from}.depends_on`,
        component: from,
        path,
        line,
        target,
        message: `${from} does not declare ${to} in depends_on`,
      }),
    ];
  });
}

function packagesOf(ssot: ArchitectureSsot, externals: string[]): string[] {
  return ssot.index.externals
    .filter(({ id }) => externals.includes(id))
    .flatMap(({ packages }) => packages);
}

function onlyViolations(
  context: Context,
  rule: Extract<ArchitectureRule, { kind: 'only' }>,
  ruleId: string,
  owner?: ArchitectureComponent,
): ArchitectureViolation[] {
  const allowed = new Set([...(owner ? [owner.id] : []), ...(rule.components ?? [])]);
  const patterns = packagesOf(context.ssot, rule.externals);
  const owners = [...allowed].join(', ') || 'no component';
  return externalImports(context).flatMap(({ package: name, line, path, from }) => {
    if (allowed.has(from) || !patterns.some((pattern) => matchesPackage(pattern, name))) return [];
    return [
      violation(context, {
        rule: 'restricted-external',
        ruleId,
        component: from,
        path,
        line,
        target: name,
        message: `only ${owners} may import ${name}`,
      }),
    ];
  });
}

function forbidViolations(
  context: Context,
  rule: Extract<ArchitectureRule, { kind: 'forbid' }>,
  ruleId: string,
  owner?: ArchitectureComponent,
): ArchitectureViolation[] {
  const from = owner ? [owner.id] : rule.from;
  const applies = (component: string) => !from || from.includes(component);
  const packages = externalImports(context).flatMap(
    ({ package: name, line, path, from: source }) =>
      applies(source) && (rule.packages ?? []).some((pattern) => matchesPackage(pattern, name))
        ? [{ path, line, source, target: name }]
        : [],
  );
  const components = crossingImports(context).flatMap(({ path, line, from: source, to }) =>
    applies(source) && (rule.components ?? []).includes(to)
      ? [{ path, line, source, target: to }]
      : [],
  );
  return [...packages, ...components].map(({ path, line, source, target }) =>
    violation(context, {
      rule: 'forbidden-dependency',
      ruleId,
      component: source,
      path,
      line,
      target,
      message: `${source} may not import ${target}`,
    }),
  );
}

function cycleViolations(context: Context, ruleId: string): ArchitectureViolation[] {
  const graph = dependencyMap(context.dependencies);
  const cycles = [
    ...new Set(cyclicNodes(stronglyConnected([...context.byId.keys()], graph)).values()),
  ];
  return cycles.map((cycle) => {
    const inside = new Set(cycle);
    const edge = context.dependencies.find(({ from, to }) => inside.has(from) && inside.has(to));
    const evidence = edge?.evidence[0];
    return violation(context, {
      rule: 'component-cycle',
      ruleId,
      component: edge?.from ?? (cycle[0] as string),
      path: evidence?.path ?? componentFile(context.ssot, cycle[0] as string),
      line: evidence?.line ?? 1,
      target: edge?.to,
      message: `components in a cycle: ${cycle.join(', ')}`,
    });
  });
}

function callViolations(context: Context, calls: CallMatch[]): ArchitectureViolation[] {
  return calls.map(({ ruleId, path, line, text }) => {
    const component = context.assignment.componentOf(path);
    return violation(context, {
      rule: 'forbidden-call',
      ruleId,
      component,
      path,
      line,
      target: text,
      message: `${component ?? path} may not call ${text}`,
    });
  });
}

function flowViolations(context: Context): ArchitectureViolation[] {
  const graph = dependencyMap(context.dependencies);
  return context.ssot.flows.flatMap(({ id, steps }) =>
    steps.flatMap(({ from, to, verb }) =>
      from === to || graph.get(from)?.has(to)
        ? []
        : [
            violation(context, {
              rule: 'missing-flow-step',
              ruleId: `flows.${id}`,
              component: from,
              path: posix.join(context.ssot.dir, 'flows', `${id}.yaml`),
              line: 1,
              target: to,
              message: `flow ${id}: ${from} ${verb}, but no code in ${from} imports ${to}`,
            }),
          ],
    ),
  );
}

function symbolsByComponent(context: Context): Map<string, Set<string>> {
  const symbols = new Map<string, Set<string>>();
  for (const { path, symbols: names } of context.code) {
    const id = context.assignment.componentOf(path);
    if (id === null) continue;
    const known = symbols.get(id) ?? new Set();
    for (const name of names) known.add(name);
    symbols.set(id, known);
  }
  return symbols;
}

function staleReferences(
  context: Context,
  exists: (path: string) => boolean,
): ArchitectureViolation[] {
  const symbols = symbolsByComponent(context);
  return context.ssot.components.flatMap((component) => {
    const path = componentFile(context.ssot, component.id);
    const stale = (target: string, message: string) =>
      violation(context, {
        rule: 'stale-reference',
        ruleId: `${component.id}.references`,
        component: component.id,
        path,
        line: 1,
        target,
        message,
      });
    const files = component.key_files
      .filter((file) => !exists(file.path))
      .map((file) => stale(file.path, `key file ${file.path} does not exist`));
    const names = component.interface
      .filter((name) => !symbols.get(component.id)?.has(name))
      .map((name) => stale(name, `interface ${name} is declared by no file in ${component.id}`));
    return [...files, ...names];
  });
}

function unmapped(context: Context): ArchitectureViolation[] {
  return context.code
    .filter(({ path }) => context.assignment.componentOf(path) === null)
    .map(({ path }) =>
      violation(context, {
        rule: 'unmapped-file',
        ruleId: 'unmapped',
        component: null,
        path,
        line: 1,
        message: 'belongs to no component. Add it to one, or to ignore',
      }),
    );
}

const byLocation = (a: ArchitectureViolation, b: ArchitectureViolation) =>
  a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule);

/** Every structural violation, in path and line order. */
export function conformance(
  ssot: ArchitectureSsot,
  input: ConformanceInput,
): ArchitectureViolation[] {
  const context = contextOf(ssot, input.modules);
  const fromRules = rulesOf(ssot).flatMap(({ rule, ruleId, owner }) => {
    if (rule.kind === 'layers') return layerViolations(context, ruleId);
    if (rule.kind === 'no-cycles') return cycleViolations(context, ruleId);
    if (rule.kind === 'only') return onlyViolations(context, rule, ruleId, owner);
    if (rule.kind === 'forbid') return forbidViolations(context, rule, ruleId, owner);
    return [];
  });
  return [
    ...fromRules,
    ...undeclared(context),
    ...callViolations(context, input.calls),
    ...flowViolations(context),
    ...staleReferences(context, input.exists),
    ...unmapped(context),
  ].sort(byLocation);
}

/** The fields that identify a violation, as a check reports it or a baseline records it. */
export interface ViolationIdentity {
  rule: string;
  ruleId: string;
  path: string;
  target?: string;
}

/** What makes two violations the same across commits: not the line, which edits move. */
export const violationKey = ({ rule, ruleId, path, target }: ViolationIdentity) =>
  JSON.stringify([rule, ruleId, path, target ?? null]);

/** The violations in `after` that `before` does not have. */
export function addedViolations<T extends ViolationIdentity>(
  before: ViolationIdentity[],
  after: T[],
): T[] {
  const known = new Map<string, number>();
  for (const item of before)
    known.set(violationKey(item), (known.get(violationKey(item)) ?? 0) + 1);
  return after.filter((item) => {
    const left = known.get(violationKey(item)) ?? 0;
    if (left > 0) known.set(violationKey(item), left - 1);
    return left === 0;
  });
}

/** The component map: real dependencies laid over the declared ones. */
export function mapEdges(ssot: ArchitectureSsot, modules: FactModule[]): MapEdge[] {
  const context = contextOf(ssot, modules);
  const layered = ssot.index.rules.some(({ kind }) => kind === 'layers');
  const badLayer = new Set(
    layered
      ? layerViolations(context, 'layers').map(
          ({ component, target }) =>
            `${component}\0${context.assignment.componentOf(target as string)}`,
        )
      : [],
  );
  const actual: MapEdge[] = context.dependencies.map(({ from, to, weight }) => {
    const declared = context.byId.get(from)?.depends_on;
    const wrong =
      badLayer.has(`${from}\0${to}`) || (declared !== undefined && !declared.includes(to));
    return { from, to, weight, status: wrong ? 'violation' : declared ? 'declared' : 'actual' };
  });
  const unused: MapEdge[] = ssot.components.flatMap(({ id, depends_on }) =>
    (depends_on ?? [])
      .filter((to) => !actual.some((edge) => edge.from === id && edge.to === to))
      .map((to): MapEdge => ({ from: id, to, weight: 0, status: 'unused' })),
  );
  return [...actual, ...unused];
}

/** What static drift needs besides the SSOT. */
export interface DriftInput {
  modules: FactModule[];
  exists: (path: string) => boolean;
  /** Files added since `compiled_at`. Empty without it. */
  added: Set<string>;
}

function unmappedCode(context: Context, added: Set<string>): DriftItem[] {
  const files = context.code.filter(({ path }) => context.assignment.componentOf(path) === null);
  const byDirectory = Map.groupBy(files, ({ path }) => dirname(path));
  return [...byDirectory].flatMap(([directory, members]): DriftItem[] => {
    const since = members.every(({ path }) => added.has(path));
    if (members.length === 1) {
      const { path } = members[0] as FactModule;
      return [
        {
          kind: 'unmapped-code',
          component: null,
          path,
          since: added.has(path),
          message: 'a file in no component',
        },
      ];
    }
    return [
      {
        kind: 'unmapped-code',
        component: null,
        path: `${directory}/`,
        since,
        message: `${members.length} files in no component`,
      },
    ];
  });
}

function undocumentedDependencies(context: Context): DriftItem[] {
  return context.dependencies.flatMap(({ from, to, evidence }) => {
    if (context.byId.get(from)?.depends_on?.includes(to)) return [];
    const first = evidence[0];
    return [
      {
        kind: 'undocumented-dependency',
        component: from,
        path: first?.path ?? '',
        line: first?.line,
        target: to,
        message: `${from} depends on ${to}, which its depends_on does not list`,
      },
    ];
  });
}

function undocumentedExternals(context: Context): DriftItem[] {
  const { externals } = context.ssot.index;
  const declaredOf = (name: string) =>
    externals.find(({ packages }) => packages.some((p) => matchesPackage(p, name)));
  const seen = new Set<string>();
  return externalImports(context).flatMap(({ package: name, line, path, from }): DriftItem[] => {
    const declared = declaredOf(name);
    if (declared) {
      const key = `${from}\0${declared.id}`;
      if (context.byId.get(from)?.uses.includes(declared.id) || seen.has(key)) return [];
      seen.add(key);
      return [
        {
          kind: 'undocumented-external',
          component: from,
          path,
          line,
          target: declared.id,
          message: `${from} imports ${name} (${declared.id}), which its uses does not list`,
        },
      ];
    }
    if (classifyPackage(name).kind !== 'system' || seen.has(name)) return [];
    seen.add(name);
    return [
      {
        kind: 'undocumented-external',
        component: from,
        path,
        line,
        target: name,
        message: `${name} reaches ${classifyPackage(name).title}, which no entry in externals names`,
      },
    ];
  });
}

function staleDrift(context: Context, exists: (path: string) => boolean): DriftItem[] {
  const owned = new Map<string, number>();
  for (const { path } of context.code) {
    const id = context.assignment.componentOf(path);
    if (id !== null) owned.set(id, (owned.get(id) ?? 0) + 1);
  }
  const paths = context.code.map(({ path }) => path);
  const imported = new Map<string, Set<string>>();
  for (const { package: name, from } of externalImports(context)) {
    imported.set(from, (imported.get(from) ?? new Set()).add(name));
  }
  return context.ssot.components.flatMap((component): DriftItem[] => {
    const path = componentFile(context.ssot, component.id);
    const item = (target: string, message: string): DriftItem => ({
      kind: 'stale-reference',
      component: component.id,
      path,
      target,
      message,
    });
    const items: DriftItem[] = [];
    if (!owned.has(component.id)) items.push(item(component.id, `${component.id} owns no file`));
    for (const pattern of component.paths) {
      if (
        !paths.some((file) => file === pattern || posix.matchesGlob(file, pattern)) &&
        !exists(pattern)
      ) {
        items.push(item(pattern, `paths entry ${pattern} matches no file`));
      }
    }
    for (const file of component.key_files.filter(({ path: key }) => !exists(key))) {
      items.push(item(file.path, `key file ${file.path} does not exist`));
    }
    for (const to of component.depends_on ?? []) {
      if (!context.dependencies.some((edge) => edge.from === component.id && edge.to === to)) {
        items.push(item(to, `depends_on lists ${to}, but no code in ${component.id} imports it`));
      }
    }
    for (const external of component.uses) {
      const patterns = packagesOf(context.ssot, [external]);
      const names = [...(imported.get(component.id) ?? [])];
      if (!names.some((name) => patterns.some((pattern) => matchesPackage(pattern, name)))) {
        items.push(
          item(external, `uses lists ${external}, but no code in ${component.id} imports it`),
        );
      }
    }
    return items;
  });
}

/** Static drift: unmapped code, undocumented dependencies and externals, stale references. */
export function staticDrift(ssot: ArchitectureSsot, input: DriftInput): DriftItem[] {
  const context = contextOf(ssot, input.modules);
  const symbols = symbolsByComponent(context);
  const interfaces = ssot.components.flatMap((component): DriftItem[] =>
    component.interface
      .filter((name) => !symbols.get(component.id)?.has(name))
      .map((name) => ({
        kind: 'stale-reference',
        component: component.id,
        path: componentFile(ssot, component.id),
        target: name,
        message: `interface ${name} is declared by no file in ${component.id}`,
      })),
  );
  return [
    ...unmappedCode(context, input.added),
    ...undocumentedDependencies(context),
    ...undocumentedExternals(context),
    ...staleDrift(context, input.exists),
    ...interfaces,
  ];
}

/** Components that own at least one of `paths`. */
export function componentsTouching(ssot: ArchitectureSsot, paths: string[]): string[] {
  const { componentOf } = assign(ssot);
  return [...new Set(paths.flatMap((path) => componentOf(path) ?? []))].sort();
}
