/**
 * Renders the SSOT as an ARCHITECTURE.md, with Mermaid diagrams. Markdown output only: the HTML
 * report stays free of scripts.
 */
import { posix } from 'node:path';
import { withoutControlCharacters } from '../report.ts';
import type { ArchitectureComponent, ArchitectureFlow, FactModule, MapEdge } from '../types.ts';
import { assign } from './conformance.ts';
import type { ShowModel, View } from './show.ts';

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
export function flowDiagram(flow: ArchitectureFlow, { edges }: ShowModel): string {
  const real = new Set(
    edges.filter(({ status }) => status !== 'unused').map(({ from, to }) => `${from}\0${to}`),
  );
  const participants = [...new Set(flow.steps.flatMap(({ from, to }) => [from, to]))];
  const steps = flow.steps.flatMap(({ from, to, verb }) => {
    const exists = from === to || real.has(`${from}\0${to}`);
    const arrow = exists ? '->>' : '-->>';
    const step = `  ${node(from)}${arrow}${node(to)}: ${label(verb)}`;
    return exists ? [step] : [step, `  Note over ${node(from)},${node(to)}: no import in the code`];
  });
  return [
    '```mermaid',
    'sequenceDiagram',
    ...participants.map((id) => `  participant ${node(id)} as ${label(id)}`),
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

/** One view as Markdown. */
export function renderView(untrusted: ShowModel, view: View): string {
  const model = withoutControlCharacters(untrusted);
  if (view.kind === 'map') return mapDiagram(model);
  if (view.kind === 'layers') return layersDiagram(model);
  if (view.kind === 'flow') {
    const flow = model.ssot.flows.find(({ id }) => id === view.id) as ArchitectureFlow;
    return `## ${prose(flow.title)}\n\n${flowDiagram(flow, model)}`;
  }
  const component = model.ssot.components.find(({ id }) => id === view.id) as ArchitectureComponent;
  return componentDetail(model, component);
}

/** The whole SSOT as an ARCHITECTURE.md: overview, layers, map, components, flows, externals. */
export function renderMarkdown(untrusted: ShowModel): string {
  const model = withoutControlCharacters(untrusted);
  const { ssot } = model;
  const { index } = ssot;
  const externals = index.externals.map(
    ({ id, title, packages, summary }) =>
      `| ${id} | ${prose(title)} | ${packages.map((p) => `\`${p}\``).join(', ')} | ${summary ? prose(summary) : ''} |`,
  );
  const rules = index.rules.map((rule) => `- \`${rule.id}\` (${rule.kind})`);
  const source = model.draft
    ? `> A draft from static analysis. Run \`jevlint architecture compile\` to turn it into an SSOT.`
    : `> Generated by \`jevlint architecture show --markdown\` from \`${posix.join(ssot.dir, 'index.yaml')}\`${index.compiled_at ? `, compiled at ${index.compiled_at}` : ''}. Edit the SSOT, not this file.`;
  return [
    `# ${prose(index.name)} architecture`,
    source,
    prose(index.description),
    index.layers.length > 0
      ? `## Layers\n\nTop to bottom. A component depends only on its own layer or lower ones.\n\n${index.layers
          .map(
            (layer, i) =>
              `${i + 1}. ${layer}: ${
                ssot.components
                  .filter((c) => c.layer === layer)
                  .map(({ id }) => id)
                  .join(', ') || 'none'
              }`,
          )
          .join('\n')}`
      : '',
    `## Map\n\n${mapDiagram(model)}`,
    `## Components\n\n${ssot.components.map((component) => componentSection(model, component)).join('\n\n')}`,
    ssot.flows.length > 0
      ? `## Flows\n\n${ssot.flows.map((flow) => `### ${prose(flow.title)}\n\n${flow.trigger ? `Starts with ${prose(flow.trigger)}.\n\n` : ''}${flowDiagram(flow, model)}`).join('\n\n')}`
      : '',
    externals.length > 0
      ? `## External systems\n\n| Id | System | Packages | Notes |\n| --- | --- | --- | --- |\n${externals.join('\n')}`
      : '',
    rules.length > 0 ? `## Rules\n\n${rules.join('\n')}` : '',
    index.checklist.length > 0
      ? `## Checklist\n\n${index.checklist.map(({ id, text }) => `- \`${id}\`: ${prose(text)}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
    .concat('\n');
}
