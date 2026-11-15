/**
 * Renders the SSOT as an ARCHITECTURE.md, with Mermaid diagrams. Markdown output only: the HTML
 * report stays free of scripts.
 */
import { posix } from 'node:path';
import { withoutControlCharacters, withoutEscapes } from '../report.ts';
import type {
  ArchitectureComponent,
  ArchitectureDecision,
  ArchitectureFlow,
  ArchitectureView,
  DataView,
  FactModule,
  GraphView,
  MapEdge,
  ViewNode,
} from '../types.ts';
import { assign } from './conformance.ts';
import { DIAGRAM_DIRECTIVE, orderDecisions } from './load.ts';
import type { ShowModel, View } from './show.ts';
import { checkEdges } from './views.ts';

/** Repository text goes into Mermaid labels, where quotes and brackets would end them. */
const label = (text: string) =>
  text.replace(
    /["<>#]/g,
    (char) => ({ '"': '#quot;', '<': '#lt;', '>': '#gt;', '#': '#35;' })[char] as string,
  );

/** In prose, HTML tags in repository text would render on a forge, so they are escaped. */
const prose = (text: string) =>
  text.trim().replace(/[<>]/g, (char) => (char === '<' ? '&lt;' : '&gt;'));

const node = (id: string) => `c_${id.replace(/-/g, '_')}`;

const ARROWS: Record<MapEdge['status'], string> = {
  declared: '-->',
  actual: '-->',
  violation: '-->',
  unused: '-.->',
};

function edgeLines(edges: MapEdge[], keep: (edge: MapEdge) => boolean = () => true): string[] {
  const shown = edges.filter(keep);
  const lines = shown.map(({ from, to, weight, status }) => {
    const text =
      status === 'unused'
        ? '|declared, unused|'
        : status === 'violation'
          ? `|${weight}, violation|`
          : `|${weight}|`;
    return `  ${node(from)} ${ARROWS[status]}${text} ${node(to)}`;
  });
  const styles = shown.flatMap(({ status }, index) =>
    status === 'violation'
      ? [`  linkStyle ${index} stroke:#d03b3b,stroke-width:2px`]
      : status === 'unused'
        ? [`  linkStyle ${index} stroke:#999`]
        : [],
  );
  return [...lines, ...styles];
}

/** Components and their dependencies, with violations in red and unused declarations dashed. */
export function mapDiagram({ ssot, edges }: ShowModel): string {
  const nodes = ssot.components.map(({ id, title }) => `  ${node(id)}["${label(title)}"]`);
  return ['```mermaid', 'flowchart LR', ...nodes, ...edgeLines(edges), '```'].join('\n');
}

/** One box per layer, top layer first, with the components in it. */
export function layersDiagram({ ssot, edges }: ShowModel): string {
  const placed = new Set<string>();
  const layers = ssot.index.layers.flatMap((layer) => {
    const members = ssot.components.filter((component) => component.layer === layer);
    for (const { id } of members) placed.add(id);
    if (members.length === 0) return [];
    return [
      `  subgraph layer_${layer.replace(/-/g, '_')}["${label(layer)}"]`,
      ...members.map(({ id, title }) => `    ${node(id)}["${label(title)}"]`),
      '  end',
    ];
  });
  const rest = ssot.components
    .filter(({ id }) => !placed.has(id))
    .map(({ id, title }) => `  ${node(id)}["${label(title)}"]`);
  return [
    '```mermaid',
    'flowchart TB',
    ...layers,
    ...rest,
    ...edgeLines(edges, ({ status }) => status !== 'unused'),
    '```',
  ].join('\n');
}

/** A flow as a sequence diagram. A step with no import behind it is dashed and noted. */
export function flowDiagram(flow: ArchitectureFlow, { edges, ssot }: ShowModel): string {
  const real = new Set(
    edges.filter(({ status }) => status !== 'unused').map(({ from, to }) => `${from}\0${to}`),
  );
  const titleOf = (id: string) => ssot.components.find((c) => c.id === id)?.title ?? id;
  const participants = [...new Set(flow.steps.flatMap(({ from, to }) => [from, to]))];
  const steps = flow.steps.flatMap(({ from, to, verb, returns, optional }) => {
    const exists = from === to || real.has(`${from}\0${to}`);
    const arrow = exists && !optional ? '->>' : '-->>';
    const lines = [`  ${node(from)}${arrow}${node(to)}: ${label(verb)}`];
    if (returns) lines.push(`  ${node(to)}-->>${node(from)}: ${label(returns)}`);
    if (!exists) lines.push(`  Note over ${node(from)},${node(to)}: no import in the code`);
    return lines;
  });
  return [
    '```mermaid',
    'sequenceDiagram',
    ...participants.map((id) => `  participant ${node(id)} as ${label(titleOf(id))}`),
    ...steps,
    '```',
  ].join('\n');
}

function componentModules(model: ShowModel, component: ArchitectureComponent): FactModule[] {
  const { componentOf } = assign(model.ssot);
  return model.facts.modules.filter(({ path }) => componentOf(path) === component.id);
}

/** One component: its summary, key files, interface, modules and dependencies. */
export function componentSection(
  model: ShowModel,
  component: ArchitectureComponent,
  depth = 3,
): string {
  const heading = '#'.repeat(depth);
  const out = model.edges.filter(
    ({ from, status }) => from === component.id && status !== 'unused',
  );
  const users = model.edges.filter(({ to, status }) => to === component.id && status !== 'unused');
  const keyFiles = component.key_files.map(({ path, role }) => `- \`${path}\`: ${prose(role)}`);
  return [
    `${heading} ${prose(component.title)} (\`${component.id}\`)`,
    prose(component.summary),
    [
      `- Layer: ${component.layer ?? 'none'}`,
      `- Paths: ${component.paths.map((path) => `\`${path}\``).join(', ')}`,
      `- Depends on: ${out.map(({ to, status }) => (status === 'violation' ? `${to} (violation)` : to)).join(', ') || 'nothing'}`,
      `- Used by: ${users.map(({ from }) => from).join(', ') || 'nothing'}`,
      component.interface.length > 0
        ? `- Interface: ${component.interface.map((name) => `\`${name}\``).join(', ')}`
        : '',
      component.uses.length > 0 ? `- Uses: ${component.uses.join(', ')}` : '',
      component.status === 'target' ? '- Status: target (the intended shape)' : '',
    ]
      .filter(Boolean)
      .join('\n'),
    keyFiles.length > 0 ? `Key files:\n\n${keyFiles.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The modules inside one component, for `--view component:<id>`. */
export function componentDetail(model: ShowModel, component: ArchitectureComponent): string {
  const modules = componentModules(model, component).map(
    ({ path, lines, symbols }) =>
      `- \`${path}\` (${lines} lines): ${symbols.map((s) => `\`${s}\``).join(', ') || 'no top-level names'}`,
  );
  return [
    componentSection(model, component, 2),
    `Modules:\n\n${modules.join('\n') || 'None.'}`,
  ].join('\n\n');
}

/** Six tones, one per group in order, as GitDiagram colours its subsystems. */
const TONES = [
  ['toneBlue', '#dbeafe', '#2563eb', '#172554'],
  ['toneAmber', '#fef3c7', '#d97706', '#78350f'],
  ['toneMint', '#dcfce7', '#16a34a', '#14532d'],
  ['toneRose', '#ffe4e6', '#e11d48', '#881337'],
  ['toneIndigo', '#e0e7ff', '#4f46e5', '#312e81'],
  ['toneTeal', '#ccfbf1', '#0f766e', '#134e4a'],
] as const;
const NEUTRAL = ['toneNeutral', '#f8fafc', '#334155', '#0f172a'] as const;

const viewNode = (id: string) => `n_${id.replace(/-/g, '_')}`;

/** Ungrouped nodes still get a colour that says what they are. */
function toneOf(node: ViewNode, groupOrder: Map<string, number>): string {
  const index = node.group === undefined ? undefined : groupOrder.get(node.group);
  if (index !== undefined) return (TONES[index % TONES.length] as readonly string[])[0] as string;
  if (node.kind === 'store' || node.kind === 'queue') return 'toneAmber';
  if (node.kind === 'external') return 'toneIndigo';
  if (node.kind === 'actor') return 'toneBlue';
  return NEUTRAL[0];
}

/** The file a node points at, shown under its label as GitDiagram does: `[decide.ts]`. */
function nodeCaption(node: ViewNode): string {
  if (!node.path) return '';
  const name = node.path.includes('*')
    ? node.path.replace(/\/\*\*$/, '/')
    : posix.basename(node.path);
  return `<br/>[${label(name)}]`;
}

function shapeOf(node: ViewNode): string {
  const text = `"${label(node.label)}${nodeCaption(node)}"`;
  const id = viewNode(node.id);
  if (node.kind === 'actor') return `${id}((${text}))`;
  if (node.kind === 'store') return `${id}[(${text})]`;
  if (node.kind === 'queue') return `${id}[[${text}]]`;
  if (node.kind === 'external') return `${id}{{${text}}}`;
  if (node.kind === 'document') return `${id}[/${text}/]`;
  return `${id}[${text}]`;
}

/**
 * A graph view as a Mermaid flowchart: groups as subgraphs with one tone each, shapes by kind,
 * verbs on the arrows. A solid arrow with no import behind it is drawn dashed.
 */
export function graphViewDiagram(view: GraphView, model: ShowModel): string {
  const checks = checkEdges(view, model.ssot, model.facts.modules);
  const groupOrder = new Map(view.groups.map(({ id }, index) => [id, index]));
  const lines = ['```mermaid', 'flowchart TD'];
  for (const group of view.groups) {
    const members = view.nodes.filter((node) => node.group === group.id);
    if (members.length === 0) continue;
    lines.push(`  subgraph g_${group.id.replace(/-/g, '_')}["${label(group.label)}"]`);
    lines.push(...members.map((node) => `    ${shapeOf(node)}`));
    lines.push('  end');
  }
  const grouped = new Set(view.groups.map(({ id }) => id));
  lines.push(
    ...view.nodes
      .filter((node) => !node.group || !grouped.has(node.group))
      .map((node) => `  ${shapeOf(node)}`),
  );
  view.edges.forEach(({ from, to, verb, style }, index) => {
    const support = checks[index]?.support;
    const dashed = style === 'dashed' || support === 'unsupported' || support === 'reversed';
    lines.push(`  ${viewNode(from)} ${dashed ? '-.->' : '-->'}|"${label(verb)}"| ${viewNode(to)}`);
  });
  const used = new Map<string, string[]>();
  for (const node of view.nodes) {
    const tone = toneOf(node, groupOrder);
    used.set(tone, [...(used.get(tone) ?? []), viewNode(node.id)]);
  }
  for (const [name, fill, stroke, color] of [...TONES, NEUTRAL]) {
    if (!used.has(name)) continue;
    lines.push(
      `  classDef ${name} fill:${fill},stroke:${stroke},stroke-width:1.5px,color:${color}`,
    );
    lines.push(`  class ${(used.get(name) as string[]).join(',')} ${name}`);
  }
  lines.push('```');
  return lines.join('\n');
}

const erName = (text: string) => text.replace(/[^A-Za-z0-9_]/g, '_');
/** Mermaid takes one word as an attribute type, so `string | null` is `string` and `A[]` stays. */
const erType = (text: string) => {
  const word =
    text.replace(/^readonly\s+/, '').match(/^[A-Za-z_][A-Za-z0-9_.]*(\[\])?/)?.[0] ?? 'value';
  return word.replace(/\./g, '_');
};
const CARDINALITY: Record<DataView['relations'][number]['cardinality'], string> = {
  'one-to-one': '||--||',
  'one-to-many': '||--o{',
  'many-to-one': '}o--||',
  'many-to-many': '}o--o{',
};

/** A data view as a Mermaid ER diagram. */
export function dataViewDiagram(view: DataView): string {
  const names = new Map(view.entities.map(({ id, name }) => [id, erName(name)]));
  const relations = view.relations.map(
    ({ from, to, cardinality, label: text }) =>
      `  ${names.get(from)} ${CARDINALITY[cardinality]} ${names.get(to)} : "${label(text)}"`,
  );
  const entities = view.entities.flatMap(({ id, fields }) => [
    `  ${names.get(id)} {`,
    ...fields.map(
      ({ name, type, note }) =>
        `    ${erType(type)} ${erName(name)}${note ? ` "${label(note).replace(/"/g, '')}"` : ''}`,
    ),
    '  }',
  ]);
  return ['```mermaid', 'erDiagram', ...relations, ...entities, '```'].join('\n');
}

function viewSection(view: ArchitectureView, model: ShowModel): string {
  const diagram = view.kind === 'data' ? dataViewDiagram(view) : graphViewDiagram(view, model);
  const entities =
    view.kind === 'data'
      ? view.entities
          .filter(({ description }) => description)
          .map(
            ({ name, path, description }) =>
              `- \`${name}\` (\`${path}\`): ${prose(description as string)}`,
          )
          .join('\n')
      : '';
  return [view.description ? prose(view.description) : '', diagram, entities]
    .filter(Boolean)
    .join('\n\n');
}

/** The Markdown a diagram directive stands for, by name. */
function diagramFor(name: string, model: ShowModel): string {
  const { ssot } = model;
  if (name === 'map') return mapDiagram(model);
  if (name === 'layers') return layersDiagram(model);
  if (name === 'components')
    return ssot.components.map((c) => componentSection(model, c, 4)).join('\n\n');
  if (name === 'decisions') return decisionsSection(model);
  if (name.startsWith('flow:')) {
    const flow = ssot.flows.find(({ id }) => id === name.slice('flow:'.length));
    return flow ? flowDiagram(flow, model) : '';
  }
  if (name.startsWith('component:')) {
    const component = ssot.components.find(({ id }) => id === name.slice('component:'.length));
    return component ? componentSection(model, component, 4) : '';
  }
  const view = ssot.views.find(({ id }) => id === name);
  return view ? viewSection(view, model) : '';
}

/** One view as Markdown. */
export function renderView(untrusted: ShowModel, view: View): string {
  const model = sanitized(untrusted);
  if (view.kind === 'map') return mapDiagram(model);
  if (view.kind === 'layers') return layersDiagram(model);
  if (view.kind === 'flow') {
    const flow = model.ssot.flows.find(({ id }) => id === view.id) as ArchitectureFlow;
    return `## ${prose(flow.title)}\n\n${flowDiagram(flow, model)}`;
  }
  if (view.kind === 'view') {
    const found = model.ssot.views.find(({ id }) => id === view.id) as ArchitectureView;
    return `## ${prose(found.title)}\n\n${viewSection(found, model)}`;
  }
  const component = model.ssot.components.find(({ id }) => id === view.id) as ArchitectureComponent;
  return componentDetail(model, component);
}

/**
 * Repository text, made safe: every string loses control characters, except the bodies of chapters
 * and decision records, which keep their line breaks because they are Markdown.
 */
function sanitized(untrusted: ShowModel): ShowModel {
  const model = withoutControlCharacters({
    ...untrusted,
    ssot: { ...untrusted.ssot, chapters: [], decisions: undefined },
  });
  const keepLines = <T extends { body: string }>(item: T): T => ({
    ...withoutControlCharacters(item),
    body: withoutEscapes(item.body),
  });
  const chapters = untrusted.ssot.chapters.map(keepLines);
  const decisions = untrusted.ssot.decisions?.map(keepLines);
  return { ...model, ssot: { ...model.ssot, chapters, ...(decisions ? { decisions } : {}) } };
}

/** A record's body uses `###` as a chapter does, but sits one level lower, under its title. */
function deeperHeadings(body: string): string {
  let fenced = false;
  return body
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      return !fenced && /^#{1,5}\s/.test(line) ? `#${line}` : line;
    })
    .join('\n');
}

const STATUS_WORDS: Record<ArchitectureDecision['status'], string> = {
  proposed: 'Proposed',
  accepted: 'Accepted',
  deprecated: 'Deprecated',
  superseded: 'Superseded',
};

const codeList = (ids: string[]) => ids.map((id) => `\`${id}\``).join(', ');

function decisionRecord(decision: ArchitectureDecision): string {
  const { status, date, components, enforced_by, supersedes } = decision;
  const facts = [
    `${STATUS_WORDS[status]} ${date}`,
    components.length > 0 ? `about ${codeList(components)}` : '',
    enforced_by.length > 0 ? `enforced by ${codeList(enforced_by)}` : '',
    supersedes.length > 0 ? `supersedes ${codeList(supersedes)}` : '',
  ].filter(Boolean);
  const body = decision.body ? `\n\n${deeperHeadings(decision.body)}` : '';
  return `### ${prose(decision.title)}\n\n*${facts.join(' · ')}*${body}`;
}

/**
 * The decisions chapter, built from the records: accepted and proposed ones in full, in file
 * order, then a dated history of those superseded or deprecated.
 */
function decisionsSection({ ssot }: ShowModel): string {
  const decisions = ssot.decisions ?? [];
  const byId = new Map(decisions.map((decision) => [decision.id, decision]));
  const { live, past } = orderDecisions(decisions);
  const history = past.map(({ id, title, date, status, superseded_by }) => {
    const successor = superseded_by ? byId.get(superseded_by) : undefined;
    const fate =
      status === 'deprecated'
        ? 'deprecated'
        : `superseded by ${successor ? `"${prose(successor.title)}" on ${successor.date}` : `\`${superseded_by}\``}`;
    return `- ${date}: ${prose(title)} (\`${id}\`), ${fate}`;
  });
  return [
    ...live.map(decisionRecord),
    history.length > 0 ? `### History\n\nOlder decisions, by date.\n\n${history.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function sourceNote(model: ShowModel): string {
  const { ssot } = model;
  if (model.draft) {
    return '> A draft from static analysis. Run `jevlint architecture compile` to turn it into an SSOT.';
  }
  const { compiled_at, compiled_on } = ssot.index;
  const at = `${compiled_at ? `, compiled at ${compiled_at}` : ''}${compiled_on ? ` on ${compiled_on}` : ''}`;
  if (model.asOf) {
    return `> Generated by \`jevlint architecture show --markdown --as-of\` from \`${ssot.dir}/\` as it was at commit ${model.asOf.slice(0, 7)}${at}. A record of the past: edit the SSOT, not this file.`;
  }
  return `> Generated by \`jevlint architecture show --markdown\` from \`${ssot.dir}/\`${at}. Edit the SSOT, not this file.`;
}

function layersSection({ ssot }: ShowModel): string {
  if (ssot.index.layers.length === 0) return '';
  const rows = ssot.index.layers.map((layer, i) => {
    const members = ssot.components.filter((c) => c.layer === layer).map(({ id }) => id);
    return `${i + 1}. ${layer}: ${members.join(', ') || 'none'}`;
  });
  return `Top to bottom. A component depends only on its own layer or lower ones.\n\n${rows.join('\n')}`;
}

function referenceSections(model: ShowModel, depth: number): string[] {
  const { index } = model.ssot;
  const heading = '#'.repeat(depth);
  const externals = index.externals.map(
    ({ id, title, packages, summary }) =>
      `| ${id} | ${prose(title)} | ${packages.map((p) => `\`${p}\``).join(', ')} | ${summary ? prose(summary) : ''} |`,
  );
  const rules = index.rules.map((rule) => `- \`${rule.id}\` (${rule.kind})`);
  return [
    externals.length > 0
      ? `${heading} External systems\n\n| Id | System | Packages | Notes |\n| --- | --- | --- | --- |\n${externals.join('\n')}`
      : '',
    rules.length > 0 ? `${heading} Rules\n\n${rules.join('\n')}` : '',
    index.checklist.length > 0
      ? `${heading} Checklist\n\n${index.checklist.map(({ id, text }) => `- \`${id}\`: ${prose(text)}`).join('\n')}`
      : '',
  ];
}

/** The document with no chapters: the structure, the views and the flows, in a fixed order. */
function structuralDocument(model: ShowModel): string[] {
  const { ssot } = model;
  const layers = layersSection(model);
  return [
    prose(ssot.index.description),
    layers ? `## Layers\n\n${layers}` : '',
    ...ssot.views.map((view) => `## ${prose(view.title)}\n\n${viewSection(view, model)}`),
    `## Map\n\n${mapDiagram(model)}`,
    `## Components\n\n${ssot.components.map((component) => componentSection(model, component)).join('\n\n')}`,
    ssot.flows.length > 0
      ? `## Flows\n\n${ssot.flows.map((flow) => `### ${prose(flow.title)}\n\n${flow.trigger ? `Starts with ${prose(flow.trigger)}.\n\n` : ''}${flowDiagram(flow, model)}`).join('\n\n')}`
      : '',
    ssot.decisions ? `## Decisions\n\n${decisionsSection(model)}` : '',
    ...referenceSections(model, 2),
  ];
}

/**
 * The document with chapters: each chapter in order, with its diagram directives replaced, then
 * the diagrams no chapter placed, then the reference.
 */
function chapteredDocument(model: ShowModel): string[] {
  const { ssot } = model;
  const placed = new Set<string>();
  const chapters = ssot.chapters.map(({ title, body }) => {
    const filled = body.replace(DIAGRAM_DIRECTIVE, (_, name: string) => {
      placed.add(name);
      return diagramFor(name, model);
    });
    return `## ${prose(title)}\n\n${filled}`;
  });
  if (ssot.decisions && !placed.has('decisions')) {
    chapters.push(`## Decisions\n\n${decisionsSection(model)}`);
  }
  const unplaced = [
    ...ssot.views
      .filter(({ id }) => !placed.has(id))
      .map((view) => `### ${prose(view.title)}\n\n${viewSection(view, model)}`),
    ...ssot.flows
      .filter(({ id }) => !placed.has(`flow:${id}`))
      .map((flow) => `### ${prose(flow.title)}\n\n${flowDiagram(flow, model)}`),
  ];
  const reference = [
    placed.has('components')
      ? ''
      : `### Components\n\n${ssot.components.map((c) => componentSection(model, c, 4)).join('\n\n')}`,
    ...referenceSections(model, 3),
  ].filter(Boolean);
  return [
    prose(ssot.index.description),
    ...chapters,
    unplaced.length > 0 ? `## More diagrams\n\n${unplaced.join('\n\n')}` : '',
    `## Reference\n\n${reference.join('\n\n')}`,
  ];
}

/** The whole SSOT as an ARCHITECTURE.md, built around its chapters when it has them. */
export function renderMarkdown(untrusted: ShowModel): string {
  const model = sanitized(untrusted);
  const body =
    model.ssot.chapters.length > 0 ? chapteredDocument(model) : structuralDocument(model);
  return [`# ${prose(model.ssot.index.name)} architecture`, sourceNote(model), ...body]
    .filter(Boolean)
    .join('\n\n')
    .concat('\n');
}
