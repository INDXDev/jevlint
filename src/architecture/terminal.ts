/** Formats an architecture report for the terminal. */
import pc from 'picocolors';
import {
  colorByRatio,
  describeFinding,
  findingHealth,
  formatScore,
  formatUsage,
  plural,
  withoutControlCharacters,
  worstIssue,
} from '../report.ts';
import type {
  ArchitectureCheckReport,
  ArchitectureComponent,
  ArchitectureDriftReport,
  ArchitectureFinding,
  ArchitectureFlow,
  ArchitecturePlan,
  ArchitectureReport,
  ArchitectureSsot,
  ArchitectureUnit,
  ArchitectureView,
  ArchitectureViolation,
  FactModule,
  MapEdge,
  Perspective,
} from '../types.ts';
import type { ShowModel, View } from './show.ts';
import { checkEdges, type EdgeSupport } from './views.ts';

const BAR_WIDTH = 10;
const SEPARATOR = '  ·  ';
const PERSPECTIVE_WIDTH = 'directory'.length;
/** Dependency lines stop here, because the HTML view has the rest. */
const MAX_TARGETS = 4;

function bar(ratio: number): string {
  const filled = Math.round(ratio * BAR_WIDTH);
  return colorByRatio('█'.repeat(filled), ratio) + pc.dim('░'.repeat(BAR_WIDTH - filled));
}

function formatUnit(unit: ArchitectureUnit, width: number, scale: number): string {
  const ratio = unit.score / scale;
  const value = colorByRatio(formatScore(unit.score).padStart(String(scale).length), ratio);
  const perspective = unit.perspective.padEnd(PERSPECTIVE_WIDTH);
  return `  ${bar(ratio)}  ${value}  ${perspective}  ${unit.name.padEnd(width)}  ${pc.dim(worstIssue(unit))}`;
}

/** Lists units from worst to best, up to `top`. */
function formatRanking({ units, scale }: ArchitectureReport, top: number): string[] {
  const shown = units.slice(0, top);
  const width = Math.max(...shown.map(({ name }) => name.length));
  const lines = shown.map((unit) => formatUnit(unit, width, scale));
  const hidden = units.length - shown.length;
  return hidden > 0 ? [...lines, `  ${hidden} more. Show them with --top ${units.length}`] : lines;
}

function formatDependencies({ edges }: ArchitectureReport): string[] {
  const sources = [...new Set(edges.directories.map(({ from }) => from))].sort();
  return sources.map((source) => {
    const links = edges.directories
      .filter(({ from }) => from === source)
      .toSorted((a, b) => b.weight - a.weight);
    const shown = links.slice(0, MAX_TARGETS).map(({ to, weight, cyclic }) => {
      const target = `${to} (${weight})`;
      return cyclic ? pc.red(target) : target;
    });
    const hidden = links.length - shown.length;
    return `  ${source} → ${shown.join(', ')}${hidden > 0 ? `, ${hidden} more` : ''}`;
  });
}

/** Where to look: a directory has no line to point at. */
export const findingLocation = ({ path, line, rule }: ArchitectureFinding) =>
  rule.startsWith('directory-') ? path : `${path}:${line}`;

function formatFinding(finding: ArchitectureFinding): string {
  return `  ${findingLocation(finding)}  ${describeFinding(finding)} ${pc.dim(`(${finding.rule})`)}`;
}

function formatSection(title: string, lines: string[]): string[] {
  return lines.length > 0 ? ['', ` ${pc.bold(title)}`, ...lines] : [];
}

const PERSPECTIVE_LABELS: Record<Perspective, string> = {
  codebase: 'Codebase',
  directory: 'Directories',
  class: 'Classes',
  component: 'Components',
  design: 'Design',
  chapter: 'Chapters',
};

function formatSummary({ score, scale, perspectives, modules, edges }: ArchitectureReport): string {
  const cyclicEdges = edges.modules.filter(({ cyclic }) => cyclic).length;
  const layers = Math.max(0, ...modules.map(({ layer }) => layer + 1));
  const views = Object.entries(perspectives).map(([perspective, value]) => {
    const label = PERSPECTIVE_LABELS[perspective as Perspective];
    return `${label} ${colorByRatio(formatScore(value), value / scale)}`;
  });
  return ` ${[
    `Architecture score ${colorByRatio(formatScore(score), score / scale)}/${scale}`,
    ...views,
    plural(modules.length, 'module'),
    plural(layers, 'layer'),
    plural(cyclicEdges, 'cyclic import'),
  ].join(SEPARATOR)}`;
}

/** Renders the ranked units, the directory dependencies and every structural problem. */
export function formatArchitecture(untrusted: ArchitectureReport, opts: { top: number }): string {
  const report = withoutControlCharacters(untrusted);
  const { root, provider, model, modules, findings, units } = report;
  const engine = model ? `${provider}/${model}` : 'AST only';
  const header = ` ${pc.bold('jevlint architecture')}  ${[root, engine].join(SEPARATOR)}`;
  if (modules.length === 0) {
    return `${header}\n\n No source files with AST support.\n Next: jevlint config show   # check include and exclude`;
  }
  const problems = findings.toSorted((a, b) => findingHealth(a) - findingHealth(b));
  return [
    header,
    formatSummary(report),
    ...formatUsage(report.usage),
    ...formatSection('Worst to best, each with its weakest point', formatRanking(report, opts.top)),
    ...formatSection('Dependencies between directories', formatDependencies(report)),
    ...formatSection('Structural problems, worst first', problems.map(formatFinding)),
    ...formatSection('Warnings', [
      ...report.warnings.map((warning) => `  ${warning}`),
      ...units.flatMap(({ name, warnings }) => warnings.map((warning) => `  ${name}: ${warning}`)),
    ]),
    '',
    ' Next: jevlint architecture --html architecture.html',
  ].join('\n');
}

const STATUS_MARKS: Record<MapEdge['status'], (text: string) => string> = {
  declared: (text) => text,
  actual: (text) => text,
  violation: (text) => pc.red(`${text} ✗`),
  unused: (text) => pc.dim(`(${text}, unused)`),
};

/** Lists the SSOT's components, one line each, with its size warnings. */
export function formatSsotList(untrusted: ArchitectureSsot, warnings: string[]): string {
  const ssot = withoutControlCharacters(untrusted);
  const { index, components, flows } = ssot;
  const width = Math.max(...components.map(({ id }) => id.length));
  const layerWidth = Math.max(1, ...components.map(({ layer }) => layer?.length ?? 1));
  const lines = components.map(
    ({ id, title, layer, paths, status }) =>
      `  ${id.padEnd(width)}  ${pc.dim((layer ?? '-').padEnd(layerWidth))}  ${title}${status === 'target' ? pc.dim(' (target)') : ''}  ${pc.dim(paths.join(' '))}`,
  );
  return [
    ` ${pc.bold(index.name)}  ${pc.dim(ssot.dir)}${index.compiled_at ? pc.dim(`  compiled at ${index.compiled_at}`) : ''}`,
    ` ${[plural(components.length, 'component'), plural(index.layers.length, 'layer'), plural(flows.length, 'flow'), plural(index.rules.length + components.reduce((n, c) => n + c.rules.length, 0), 'rule'), plural(index.checklist.length + components.reduce((n, c) => n + c.checklist.length, 0), 'checklist item')].join(SEPARATOR)}`,
    '',
    ...lines,
    ...formatSection(
      'Views',
      ssot.views.map(
        ({ id, kind, title }) =>
          `  ${id.padEnd(width)}  ${pc.dim(kind.padEnd(layerWidth))}  ${title}`,
      ),
    ),
    ...formatSection(
      'Chapters',
      ssot.chapters.map(
        ({ id, title, evidence }) =>
          `  ${id.padEnd(width)}  ${title}  ${pc.dim(plural(evidence.length, 'citation'))}`,
      ),
    ),
    ...formatSection(
      'Over the size budget',
      withoutControlCharacters(warnings).map((w) => `  ${w}`),
    ),
  ].join('\n');
}

function formatMap({ ssot, edges }: ShowModel): string[] {
  return ssot.index.layers.length > 0
    ? formatLayers({ ssot, edges })
    : formatComponents(ssot.components, edges);
}

function formatComponents(components: ArchitectureComponent[], edges: MapEdge[]): string[] {
  return components.map(({ id }) => {
    const out = edges
      .filter(({ from }) => from === id)
      .map(({ to, weight, status }) => STATUS_MARKS[status](`${to} (${weight})`));
    return `  ${pc.bold(id)} → ${out.join(', ') || pc.dim('nothing')}`;
  });
}

function formatLayers({ ssot, edges }: Pick<ShowModel, 'ssot' | 'edges'>): string[] {
  const unplaced = ssot.components.filter(
    ({ layer }) => !layer || !ssot.index.layers.includes(layer),
  );
  return [
    ...ssot.index.layers.flatMap((layer) => {
      const members = ssot.components.filter((component) => component.layer === layer);
      return members.length > 0 ? [` ${pc.cyan(layer)}`, ...formatComponents(members, edges)] : [];
    }),
    ...(unplaced.length > 0
      ? [` ${pc.cyan('no layer')}`, ...formatComponents(unplaced, edges)]
      : []),
  ];
}

function formatFlow(flow: ArchitectureFlow, edges: MapEdge[]): string[] {
  const real = new Set(
    edges.filter(({ status }) => status !== 'unused').map(({ from, to }) => `${from}\0${to}`),
  );
  return [
    ` ${pc.bold(flow.title)}${flow.trigger ? pc.dim(`  ${flow.trigger}`) : ''}`,
    ...flow.steps.map(({ from, to, verb }) => {
      const step = `  ${from} → ${to}  ${verb}`;
      return from === to || real.has(`${from}\0${to}`)
        ? step
        : pc.red(`${step}  ✗ no import in the code`);
    }),
  ];
}

function formatComponentView(
  model: ShowModel,
  component: ArchitectureComponent,
  modules: FactModule[],
): string[] {
  return [
    ` ${pc.bold(component.title)} ${pc.dim(`(${component.id}, ${component.layer ?? 'no layer'})`)}`,
    `  ${component.summary.trim()}`,
    ...formatSection(
      'Key files',
      component.key_files.map(({ path, role }) => `  ${path}  ${pc.dim(role)}`),
    ),
    ...formatSection(
      'Interface',
      component.interface.length > 0 ? [`  ${component.interface.join(', ')}`] : [],
    ),
    ...formatSection(
      'Modules',
      modules.map(
        ({ path, lines, symbols }) =>
          `  ${path} ${pc.dim(`(${lines} lines)`)} ${pc.dim(symbols.slice(0, 8).join(', '))}`,
      ),
    ),
    ...formatSection('Depends on', formatComponents([component], model.edges)),
  ];
}

const SUPPORT_MARKS: Record<EdgeSupport, string> = {
  supported: '',
  unchecked: '',
  reversed: ' ✗ the import runs the other way',
  unsupported: ' ✗ no import in the code',
};

function formatViewBody(view: ArchitectureView, model: ShowModel): string[] {
  if (view.kind === 'data') {
    return [
      ...view.entities.map(
        ({ name, path, fields }) =>
          `  ${pc.bold(name)} ${pc.dim(path)}  ${pc.dim(fields.map((f) => f.name).join(', '))}`,
      ),
      ...view.relations.map(
        ({ from, to, cardinality, label }) => `  ${from} ${pc.dim(cardinality)} ${to}  ${label}`,
      ),
    ];
  }
  const checks = checkEdges(view, model.ssot, model.facts.modules);
  const labelOf = new Map(view.nodes.map(({ id, label }) => [id, label]));
  const groups = [...view.groups, { id: '', label: 'Ungrouped' }];
  const nodes = groups.flatMap(({ id, label }) => {
    const members = view.nodes.filter((node) => (node.group ?? '') === id);
    return members.length > 0
      ? [
          ` ${pc.cyan(label)}`,
          ...members.map(
            (node) =>
              `  ${node.label} ${pc.dim(`${node.kind}${node.path ? ` ${node.path}` : ''}`)}`,
          ),
        ]
      : [];
  });
  const edges = view.edges.map(({ from, to, verb, style }, index) => {
    const check = checks[index] ?? { support: 'unchecked' as const };
    const evidence = check.evidence ? pc.dim(` ${check.evidence.path}:${check.evidence.line}`) : '';
    const line = `  ${labelOf.get(from)} ${style === 'dashed' ? '⇢' : '→'} ${labelOf.get(to)}  ${verb}${evidence}`;
    return style === 'solid' && SUPPORT_MARKS[check.support]
      ? pc.red(line + SUPPORT_MARKS[check.support])
      : line;
  });
  return [...nodes, ...formatSection('Arrows', edges)];
}

/** Draws one view of the SSOT, or of the draft, for the terminal. */
export function formatShow(untrusted: ShowModel, view: View, modules: FactModule[] = []): string {
  const model = withoutControlCharacters(untrusted);
  const { ssot } = model;
  const header = ` ${pc.bold('jevlint architecture show')}  ${[model.root, model.draft ? 'draft from the facts' : ssot.dir].join(SEPARATOR)}`;
  const legend = pc.dim(
    ' Arrows point to what a component depends on. ✗ breaks the SSOT; (unused) is declared but not imported.',
  );
  let body: string[];
  if (view.kind === 'view') {
    const found = ssot.views.find(({ id }) => id === view.id) as ArchitectureView;
    body = [` ${pc.bold(found.title)}`, ...formatViewBody(found, model)];
  } else if (view.kind === 'flow')
    body = formatFlow(ssot.flows.find(({ id }) => id === view.id) as ArchitectureFlow, model.edges);
  else if (view.kind === 'component') {
    const component = ssot.components.find(({ id }) => id === view.id) as ArchitectureComponent;
    body = formatComponentView(model, component, modules);
  } else body = view.kind === 'layers' ? formatLayers(model) : formatMap(model);
  return [header, legend, '', ...body].join('\n');
}

const violationRow = ({ path, line, rule, message, ruleId }: ArchitectureViolation) => [
  `  ${path}:${line}`,
  `    ${pc.red('✗')} ${rule.padEnd(22)} ${message} ${pc.dim(`(${ruleId})`)}`,
];

/** The check report: structural violations, checklist violations and unimplemented items. */
export function formatArchitectureCheck(
  untrusted: ArchitectureCheckReport,
  verbose = false,
): string {
  const report = withoutControlCharacters(untrusted);
  const scope = report.base ? `since ${report.base.slice(0, 7)}` : report.dir;
  const header = ` ${pc.bold('Architecture check')}: ${plural(report.violations.length, 'structural violation')}, ${plural(report.checklistViolations, 'checklist violation')} (${scope})`;
  const checklist = report.files.flatMap(({ path, component, items }) => {
    const shown = items.filter(({ verdict }) => verbose || verdict === 'violates');
    if (shown.length === 0) return [];
    return [
      `  ${path}  ${pc.dim(component ?? 'no component')}`,
      ...shown.map(({ id, text, verdict, confidence }) => {
        const mark =
          verdict === 'violates'
            ? pc.red('✗')
            : verdict === 'satisfies'
              ? pc.green('✓')
              : pc.dim('-');
        return `    ${mark} ${id} ${pc.dim(`(${confidence.toFixed(2)})`)} ${text}`;
      }),
    ];
  });
  const warnings = [
    ...report.warnings,
    ...report.files.flatMap(({ path, warnings: w }) => w.map((x) => `${path}: ${x}`)),
  ];
  return [
    header,
    ...(report.baselined > 0
      ? [pc.dim(` ${plural(report.baselined, 'violation')} in the baseline left out.`)]
      : []),
    ...formatUsage(report.usage),
    ...formatSection('Structural', report.violations.flatMap(violationRow)),
    ...formatSection('Checklist', checklist),
    ...formatSection(
      'Unimplemented: no file satisfies these',
      report.unimplemented.map(({ id, text }) => `  ${id}  ${text}`),
    ),
    ...formatSection(
      'Distance from the target (does not fail the check)',
      report.targetGaps.flatMap(violationRow),
    ),
    ...formatSection(
      'Warnings',
      warnings.map((w) => `  ${w}`),
    ),
  ].join('\n');
}

/** The drift report, grouped by kind. */
export function formatArchitectureDrift(untrusted: ArchitectureDriftReport): string {
  const report = withoutControlCharacters(untrusted);
  const since = report.compiledAt ? `since ${report.compiledAt}` : 'no compiled_at';
  const header = ` ${pc.bold('Architecture drift')}: ${plural(report.items.length, 'item')} (${report.dir}, ${since})`;
  const kinds = Map.groupBy(report.items, ({ kind }) => kind);
  const sections = [...kinds].flatMap(([kind, items]) =>
    formatSection(
      kind,
      items.map(
        ({ path, line, message, since: isNew }) =>
          `  ${path}${line ? `:${line}` : ''}  ${message}${isNew ? pc.yellow(' (new)') : ''}`,
      ),
    ),
  );
  return [
    header,
    ...formatUsage(report.usage),
    ...sections,
    ...formatSection(
      'Warnings',
      report.warnings.map((w) => `  ${w}`),
    ),
    ...(report.items.length > 0
      ? ['', ' Next: jevlint architecture drift --copy, then hand the prompt to an agent']
      : []),
  ].join('\n');
}

/** The ranked plan. */
export function formatArchitecturePlan(untrusted: ArchitecturePlan): string {
  const plan = withoutControlCharacters(untrusted);
  const steps = plan.steps.flatMap(({ rank, priority, problem, move, evidence }) => [
    `  ${String(rank).padStart(2)}. ${problem} ${pc.dim(`(priority ${priority})`)}`,
    `      ${move}`,
    ...(evidence.length > 0
      ? [pc.dim(`      ${evidence.map(({ path, line }) => `${path}:${line}`).join(', ')}`)]
      : []),
  ]);
  return [
    ` ${pc.bold('Architecture plan')}: ${plural(plan.steps.length, 'step')}`,
    ...(steps.length > 0 ? ['', ...steps] : ['', '  Nothing to do.']),
    ...formatSection(
      'Warnings',
      plan.warnings.map((w) => `  ${w}`),
    ),
  ].join('\n');
}

/** The SSOT violations a change added, as `pr --architecture` shows them under a review. */
export function formatAddedViolations(untrusted: ArchitectureViolation[]): string {
  const violations = withoutControlCharacters(untrusted);
  if (violations.length === 0) return ` ${pc.green('✓')} Architecture: no new violations`;
  return [
    ` ${pc.bold('Architecture')}: ${plural(violations.length, 'new violation')}`,
    ...violations.flatMap(violationRow),
  ].join('\n');
}
