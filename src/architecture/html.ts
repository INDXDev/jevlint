/** Renders an architecture report as one HTML file, with no scripts and no network requests. */
import { describeFinding, findingHealth, formatScore, worstIssue } from '../report.ts';
import type {
  ArchitectureEdge,
  ArchitectureReport,
  ArchitectureUnit,
  ArchitectureView,
  DataView,
  GraphView,
  MapEdge,
} from '../types.ts';
import { layersOf, stronglyConnected } from './graph.ts';
import { DIAGRAM_DIRECTIVE, orderDecisions } from './load.ts';
import type { ShowModel } from './show.ts';
import { findingLocation } from './terminal.ts';
import { checkEdges } from './views.ts';

const NODE_WIDTH = 220;
const NODE_HEIGHT = 24;
const ROW_HEIGHT = 32;
const COLUMN_GAP = 110;
const MARGIN = 16;
const LABEL_CHARS = 28;
const CURVE = 50;
const BACK_ARC = 36;

type Status = 'good' | 'warning' | 'critical';

interface DiagramNode {
  id: string;
  label: string;
  layer: number;
  status: Status;
  detail: string;
}

interface Point {
  x: number;
  y: number;
  layer: number;
}

const ICONS: Record<Status, string> = { good: '', warning: '! ', critical: '✕ ' };

/** Repository paths and names are untrusted, so everything printed goes through this. */
const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string,
  );

const shorten = (text: string) =>
  text.length <= LABEL_CHARS ? text : `…${text.slice(text.length - LABEL_CHARS + 1)}`;

const statusOfRatio = (ratio: number): Status =>
  ratio < 0.5 ? 'critical' : ratio < 0.8 ? 'warning' : 'good';

/** Entry points go on the left and foundations on the right, one column per layer. */
function placeNodes(nodes: DiagramNode[]) {
  const top = nodes.reduce((highest, { layer }) => Math.max(highest, layer), 0);
  const columns = Map.groupBy(nodes, ({ layer }) => layer);
  const tallest = [...columns.values()].reduce((most, { length }) => Math.max(most, length), 0);
  const points = new Map<string, Point>();
  for (const [layer, column] of columns) {
    const offset = ((tallest - column.length) * ROW_HEIGHT) / 2;
    column.forEach(({ id }, row) => {
      const x = MARGIN + (top - layer) * (NODE_WIDTH + COLUMN_GAP);
      points.set(id, { x, y: MARGIN + offset + row * ROW_HEIGHT, layer });
    });
  }
  return {
    points,
    width: 2 * MARGIN + (top + 1) * NODE_WIDTH + top * COLUMN_GAP + BACK_ARC,
    height: 2 * MARGIN + tallest * ROW_HEIGHT,
  };
}

function edgePath(from: Point, to: Point): string {
  const fromY = from.y + NODE_HEIGHT / 2;
  const toY = to.y + NODE_HEIGHT / 2;
  const fromX = from.x + NODE_WIDTH;
  if (to.x > from.x) {
    return `M${fromX} ${fromY}C${fromX + CURVE} ${fromY} ${to.x - CURVE} ${toY} ${to.x} ${toY}`;
  }
  // Same layer or pointing back: only cycles and folder-to-subfolder links do this.
  const toX = to.x + NODE_WIDTH;
  return `M${fromX} ${fromY}C${fromX + BACK_ARC} ${fromY} ${toX + BACK_ARC} ${toY} ${toX} ${toY}`;
}

function renderDiagram(nodes: DiagramNode[], edges: ArchitectureEdge[]): string {
  if (nodes.length === 0) return '';
  const sorted = nodes.toSorted((a, b) => a.id.localeCompare(b.id));
  const { points, width, height } = placeNodes(sorted);
  const index = new Map(sorted.map(({ id }, position) => [id, position]));
  const paths = edges.flatMap((edge) => {
    const from = points.get(edge.from);
    const to = points.get(edge.to);
    if (!from || !to) return [];
    const kinds = [edge.cyclic ? 'cyclic' : '', edge.kind === 'uses' ? 'uses' : ''].join(' ');
    return `<path class="edge ${kinds} n${index.get(edge.from)} n${index.get(edge.to)}" d="${edgePath(from, to)}"/>`;
  });
  const boxes = sorted.map(({ id, label, status, detail }, position) => {
    const { x, y } = points.get(id) as Point;
    return `<g class="node ${status} h${position}"><title>${escapeHtml(detail)}</title>
<rect x="${x}" y="${y}" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="4"/>
<rect class="stripe" x="${x}" y="${y}" width="4" height="${NODE_HEIGHT}" rx="2"/>
<text x="${x + 12}" y="${y + 16}">${ICONS[status]}${escapeHtml(shorten(label))}</text></g>`;
  });
  // Hovering a node lights up its edges, with CSS alone.
  const hover = sorted.map(
    (_, position) =>
      `svg:has(.h${position}:hover) .n${position}{stroke:var(--ink);stroke-opacity:1;stroke-width:2}`,
  );
  return `<style>${hover.join('')}</style><div class="scroll"><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">${paths.join('')}${boxes.join('')}</svg></div>`;
}

const unitNamed = ({ units }: ArchitectureReport, name: string) =>
  units.find((unit) => unit.name === name);

const cyclicNodes = (edges: ArchitectureEdge[]) =>
  new Set(edges.filter(({ cyclic }) => cyclic).map(({ from }) => from));

/** A cycle always shows, and a finding shows even if the score is fine or `--perspective` left it out. */
function statusOf(ratio: number, inCycle: boolean, hasFinding: boolean): Status {
  if (inCycle) return 'critical';
  const status = statusOfRatio(ratio);
  return status === 'good' && hasFinding ? 'warning' : status;
}

const ratioOf = ({ scale }: ArchitectureReport, unit: ArchitectureUnit | undefined) =>
  unit ? unit.score / scale : 1;

function directoryNodes(report: ArchitectureReport): DiagramNode[] {
  const cyclic = cyclicNodes(report.edges.directories);
  const flagged = new Set(report.findings.flatMap(({ directories }) => directories));
  return report.directories.map(({ path, files, lines, layer }) => {
    const unit = unitNamed(report, path);
    return {
      id: path,
      label: unit ? `${path}  ${formatScore(unit.score)}` : path,
      layer,
      status: statusOf(ratioOf(report, unit), cyclic.has(path), flagged.has(path)),
      detail: `${path}: ${files} files, ${lines} lines. ${unit ? worstIssue(unit) : ''}`,
    };
  });
}

function moduleNodes({ modules, edges, findings }: ArchitectureReport): DiagramNode[] {
  const cyclic = cyclicNodes(edges.modules);
  const flagged = new Set(findings.map(({ path }) => path));
  return modules.map(({ path, layer, fanIn, fanOut, lines }) => ({
    id: path,
    label: path,
    layer,
    status: statusOf(1, cyclic.has(path), flagged.has(path)),
    detail: `${path}: ${lines} lines, used by ${fanIn}, uses ${fanOut}`,
  }));
}

function classNodes(report: ArchitectureReport): DiagramNode[] {
  const cyclic = cyclicNodes(report.edges.classes);
  const flagged = new Set(report.findings.map(({ path, symbol }) => `${path}#${symbol}`));
  return report.classes.map(({ id, name, path, layer, lines, methods }) => {
    const unit = unitNamed(report, id);
    return {
      id,
      label: unit ? `${name}  ${formatScore(unit.score)}` : name,
      layer,
      status: statusOf(ratioOf(report, unit), cyclic.has(id), flagged.has(id)),
      detail: `${name} in ${path}: ${methods.length} methods, ${lines} lines`,
    };
  });
}

function renderProblems({ findings }: ArchitectureReport): string {
  if (findings.length === 0) return '<p>No structural problems found.</p>';
  const rows = findings
    .toSorted((a, b) => findingHealth(a) - findingHealth(b))
    .map(
      (finding) =>
        `<tr><td><code>${escapeHtml(findingLocation(finding))}</code></td><td>${escapeHtml(describeFinding(finding))}</td><td><code>${escapeHtml(finding.rule)}</code></td></tr>`,
    );
  return `<table><thead><tr><th>Where</th><th>Problem</th><th>Rule</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function renderRanking({ units }: ArchitectureReport): string {
  const rows = units.map(
    (unit) =>
      `<tr><td class="number">${formatScore(unit.score)}</td><td>${unit.perspective}</td><td><code>${escapeHtml(unit.name)}</code></td><td>${escapeHtml(worstIssue(unit))}</td></tr>`,
  );
  return `<table><thead><tr><th class="number">Score</th><th>Perspective</th><th>Unit</th><th>Weakest point</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function renderWarnings({ units, warnings: general }: ArchitectureReport): string {
  const rows = [
    ...general.map((warning) => `<tr><td></td><td>${escapeHtml(warning)}</td></tr>`),
    ...units.flatMap(({ name, warnings }) =>
      warnings.map(
        (warning) =>
          `<tr><td><code>${escapeHtml(name)}</code></td><td>${escapeHtml(warning)}</td></tr>`,
      ),
    ),
  ];
  if (rows.length === 0) return '';
  const table = `<table>${rows.join('')}</table>`;
  return section('Warnings', 'Parts of the review may be missing or have no model score.', table);
}

const STYLES = `
:root{color-scheme:light dark;--surface:#fcfcfb;--panel:#f3f2ee;--ink:#0b0b0b;--muted:#5f5e58;--line:#c3c2b7;--hair:#e1e0d9;--good:#0ca30c;--warning:#fab219;--critical:#d03b3b}
@media (prefers-color-scheme:dark){:root{--surface:#1a1a19;--panel:#262624;--ink:#f4f3ee;--muted:#a8a79f;--line:#383835;--hair:#2c2c2a}}
body{margin:0 auto;max-width:1200px;padding:32px 24px;background:var(--surface);color:var(--ink);font:15px/1.5 system-ui,sans-serif}
h1{font-size:20px;margin:0}h2{font-size:16px;margin:40px 0 4px}p{margin:4px 0 12px;color:var(--muted)}
.hero{font-size:44px;font-weight:600;line-height:1.2;margin-top:12px}.hero small{font-size:16px;font-weight:400;color:var(--muted)}
.scroll{overflow:auto;border:1px solid var(--hair);border-radius:8px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 12px 6px 0;border-bottom:1px solid var(--hair);vertical-align:top}th{color:var(--muted);font-weight:500}
.number{text-align:right;font-variant-numeric:tabular-nums}
code{font:13px ui-monospace,monospace}
.edge{fill:none;stroke:var(--muted);stroke-opacity:.35;stroke-width:1}.edge.uses{stroke-dasharray:4 3}.edge.cyclic{stroke:var(--critical);stroke-opacity:1;stroke-width:2}
.node rect{fill:var(--panel)}.node .stripe{fill:var(--line)}.node text{fill:var(--ink);font:12px ui-monospace,monospace}
.good .stripe{fill:var(--good)}.warning .stripe{fill:var(--warning)}.critical .stripe{fill:var(--critical)}
.legend{display:flex;flex-wrap:wrap;gap:16px;color:var(--muted);font-size:13px;margin:8px 0}.swatch{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px}
`;

const LEGEND = `<div class="legend"><span><i class="swatch" style="background:var(--good)"></i>Healthy</span><span><i class="swatch" style="background:var(--warning)"></i>! Needs attention</span><span><i class="swatch" style="background:var(--critical)"></i>✕ Serious, or part of a cycle</span><span>Red line: dependency cycle</span><span>Entry points on the left, foundations on the right. Hover a box to trace its links.</span></div>`;

function section(title: string, intro: string, body: string): string {
  return `<h2>${title}</h2><p>${intro}</p>${body}`;
}

/** Renders the whole report as a standalone page. */
export function renderArchitectureHtml(report: ArchitectureReport): string {
  const { root, score, scale, edges } = report;
  const classes =
    report.classes.length > 0
      ? section(
          'Classes',
          'Each box shows its score. Solid lines inherit, and dashed lines use.',
          renderDiagram(classNodes(report), edges.classes),
        )
      : '';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Architecture of ${escapeHtml(root)}</title><style>${STYLES}</style></head><body>
<h1>Architecture review</h1><p><code>${escapeHtml(root)}</code></p>
<div class="hero">${formatScore(score)}<small> / ${scale}</small></div>
${section('Worst to best', 'The codebase, each directory and each class, in one ranking.', renderRanking(report))}
${section('Structural problems', 'Measured from the AST, worst first.', renderProblems(report))}
${renderWarnings(report)}
${LEGEND}
${section('Directories', 'Each box shows its score.', renderDiagram(directoryNodes(report), edges.directories))}
${section('Modules', 'Every file with AST support.', renderDiagram(moduleNodes(report), edges.modules))}
${classes}
</body></html>
`;
}

/** Unused declarations are dashed and violations red, reusing the review's edge styles. */
function mapEdgesAsEdges(edges: MapEdge[]): ArchitectureEdge[] {
  return edges.map(({ from, to, weight, status }) => ({
    from,
    to,
    weight,
    cyclic: status === 'violation',
    ...(status === 'unused' ? { kind: 'uses' as const } : {}),
  }));
}

/** Components sit in columns by layer, foundations on the right, as in the review report. */
function componentNodes({ ssot, edges }: ShowModel): DiagramNode[] {
  const { layers } = ssot.index;
  const levelOf = (layer: string | undefined) => {
    const index = layer === undefined ? -1 : layers.indexOf(layer);
    return index === -1 ? layers.length : layers.length - 1 - index;
  };
  const broken = new Set(
    edges.filter(({ status }) => status === 'violation').map(({ from }) => from),
  );
  return ssot.components.map(({ id, title, layer, summary }) => ({
    id,
    label: title,
    layer: levelOf(layer),
    status: broken.has(id) ? 'critical' : 'good',
    detail: `${id} (${layer ?? 'no layer'}): ${summary.trim()}`,
  }));
}

function componentTable({ ssot, edges }: ShowModel, only?: string): string {
  const shown = ssot.components.filter(({ id }) => only === undefined || id === only);
  const rows = shown.map((component) => {
    const out = edges
      .filter(({ from, status }) => from === component.id && status !== 'unused')
      .map(({ to, status }) =>
        status === 'violation' ? `<b class="bad">${escapeHtml(to)} ✕</b>` : escapeHtml(to),
      );
    const keyFiles = component.key_files.map(
      ({ path, role }) => `<code>${escapeHtml(path)}</code> ${escapeHtml(role)}`,
    );
    return `<tr><td><code>${escapeHtml(component.id)}</code><br>${escapeHtml(component.title)}</td><td>${escapeHtml(component.layer ?? '')}</td><td>${escapeHtml(component.summary)}${keyFiles.length > 0 ? `<br><small>${keyFiles.join('<br>')}</small>` : ''}</td><td>${out.join(', ')}</td></tr>`;
  });
  return `<table><thead><tr><th>Component</th><th>Layer</th><th>Summary and key files</th><th>Depends on</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function flowTables({ ssot, edges }: ShowModel): string {
  const real = new Set(
    edges.filter(({ status }) => status !== 'unused').map(({ from, to }) => `${from}\0${to}`),
  );
  return ssot.flows
    .map(({ title, trigger, steps }) => {
      const rows = steps.map(({ from, to, verb }) => {
        const exists = from === to || real.has(`${from}\0${to}`);
        return `<tr><td><code>${escapeHtml(from)}</code> → <code>${escapeHtml(to)}</code></td><td>${escapeHtml(verb)}</td><td>${exists ? '' : '<b class="bad">no import in the code</b>'}</td></tr>`;
      });
      return `<h3>${escapeHtml(title)}</h3><p>${escapeHtml(trigger ?? '')}</p><table>${rows.join('')}</table>`;
    })
    .join('');
}

const SHOW_LEGEND = `<div class="legend"><span>Solid line: a real dependency, as declared</span><span><i class="swatch" style="background:var(--critical)"></i>Red: breaks the SSOT</span><span>Dashed: declared but not imported</span><span>Top layer on the left, foundations on the right.</span></div>`;

/** A graph view drawn like the component map: actors on the left, what they reach to the right. */
function graphViewHtml(view: GraphView, model: ShowModel): string {
  const checks = checkEdges(view, model.ssot, model.facts.modules);
  const dependencies = new Map<string, Set<string>>();
  for (const { from, to } of view.edges)
    dependencies.set(from, (dependencies.get(from) ?? new Set()).add(to));
  const ids = view.nodes.map(({ id }) => id);
  const layers = layersOf(stronglyConnected(ids, dependencies), dependencies);
  const groupLabel = new Map(view.groups.map(({ id, label }) => [id, label]));
  const nodes: DiagramNode[] = view.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    layer: layers.get(node.id) ?? 0,
    status: 'good',
    detail: [
      node.kind,
      node.group ? groupLabel.get(node.group) : '',
      node.path ?? node.component ?? '',
      node.description ?? '',
    ]
      .filter(Boolean)
      .join(' · '),
  }));
  const edges: ArchitectureEdge[] = view.edges.map(({ from, to, style }, index) => {
    const support = checks[index]?.support;
    const dashed = style === 'dashed' || support === 'unsupported' || support === 'reversed';
    return { from, to, weight: 1, cyclic: false, ...(dashed ? { kind: 'uses' as const } : {}) };
  });
  const arrows = view.edges.map(
    ({ from, to, verb }) =>
      `<li>${escapeHtml(view.nodes.find((n) => n.id === from)?.label ?? from)} → ${escapeHtml(view.nodes.find((n) => n.id === to)?.label ?? to)}: ${escapeHtml(verb)}</li>`,
  );
  return `${renderDiagram(nodes, edges)}<details><summary>Arrows</summary><ul>${arrows.join('')}</ul></details>`;
}

function dataViewHtml(view: DataView): string {
  const rows = view.entities.map(
    ({ name, path, description, fields }) =>
      `<tr><td><code>${escapeHtml(name)}</code><br><small>${escapeHtml(path)}</small></td><td>${escapeHtml(description ?? '')}</td><td>${fields.map(({ name: field, type }) => `<code>${escapeHtml(field)}: ${escapeHtml(type)}</code>`).join('<br>')}</td></tr>`,
  );
  const relations = view.relations.map(
    ({ from, to, cardinality, label }) =>
      `<li>${escapeHtml(from)} ${escapeHtml(cardinality)} ${escapeHtml(to)}: ${escapeHtml(label)}</li>`,
  );
  return `<table><thead><tr><th>Entity</th><th>Meaning</th><th>Fields</th></tr></thead><tbody>${rows.join('')}</tbody></table><ul>${relations.join('')}</ul>`;
}

function viewHtml(view: ArchitectureView, model: ShowModel): string {
  const intro = view.description ? `<p>${escapeHtml(view.description)}</p>` : '';
  return intro + (view.kind === 'data' ? dataViewHtml(view) : graphViewHtml(view, model));
}

/** The HTML a diagram directive stands for in a chapter. */
function diagramHtml(name: string, model: ShowModel): string {
  const view = model.ssot.views.find(({ id }) => id === name);
  if (view) return viewHtml(view, model);
  if (name === 'map' || name === 'layers') {
    return renderDiagram(componentNodes(model), mapEdgesAsEdges(model.edges));
  }
  if (name === 'components') return componentTable(model);
  if (name === 'decisions') return decisionsHtml(model);
  if (name.startsWith('component:')) {
    const id = name.slice('component:'.length);
    return model.ssot.components.some((c) => c.id === id) ? componentTable(model, id) : '';
  }
  if (name.startsWith('flow:')) {
    return flowTables({
      ...model,
      ssot: { ...model.ssot, flows: model.ssot.flows.filter(({ id }) => `flow:${id}` === name) },
    });
  }
  return '';
}

const inline = (text: string) =>
  escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    // Links show their text only, so the page requests nothing and leads nowhere unexpected.
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

function tableHtml(rows: string[]): string {
  const cells = (row: string) =>
    row
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim());
  const [head = '', , ...body] = rows;
  return `<table><thead><tr>${cells(head)
    .map((c) => `<th>${inline(c)}</th>`)
    .join('')}</tr></thead><tbody>${body
    .map(
      (row) =>
        `<tr>${cells(row)
          .map((c) => `<td>${inline(c)}</td>`)
          .join('')}</tr>`,
    )
    .join('')}</tbody></table>`;
}

/**
 * A chapter's Markdown as HTML: headings, paragraphs, lists, tables, code and the diagram
 * directives. Everything is escaped first, so repository text cannot add markup or scripts.
 */
export function chapterHtml(body: string, model: ShowModel): string {
  const out: string[] = [];
  const blocks = body.split(/\n```[^\n]*\n([\s\S]*?)\n```/);
  blocks.forEach((block, index) => {
    if (index % 2 === 1) return void out.push(`<pre><code>${escapeHtml(block)}</code></pre>`);
    for (const chunk of block.split(/\n\s*\n/)) {
      const text = chunk.trim();
      if (!text) continue;
      const directive = text.match(/^<!--\s*jevlint:diagram\s+([a-z0-9_:-]+)\s*-->$/);
      const lines = text.split('\n');
      if (directive) out.push(diagramHtml(directive[1] as string, model));
      else if (/^#{1,6}\s/.test(text) && lines.length === 1) {
        const level = Math.min(6, Math.max(3, (text.match(/^#+/)?.[0].length ?? 3) + 1));
        out.push(`<h${level}>${inline(text.replace(/^#+\s*/, ''))}</h${level}>`);
      } else if (lines.every((line) => line.trim().startsWith('|'))) out.push(tableHtml(lines));
      else if (lines.every((line) => /^\s*([-*]|\d+\.)\s/.test(line) || /^\s{2,}/.test(line))) {
        const ordered = /^\s*\d+\./.test(lines[0] as string);
        const items = text
          .split(/\n(?=\s*(?:[-*]|\d+\.)\s)/)
          .map((item) => `<li>${inline(item.replace(/^\s*([-*]|\d+\.)\s/, ''))}</li>`);
        out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      } else if (lines.every((line) => line.startsWith('>'))) {
        out.push(
          `<blockquote>${inline(lines.map((line) => line.replace(/^>\s?/, '')).join(' '))}</blockquote>`,
        );
      } else out.push(`<p>${inline(text)}</p>`);
    }
  });
  return out.join('\n');
}

/** The decision records: accepted and proposed ones in full, then the older ones by date. */
function decisionsHtml(model: ShowModel): string {
  const decisions = model.ssot.decisions ?? [];
  const byId = new Map(decisions.map((decision) => [decision.id, decision]));
  const { live, past } = orderDecisions(decisions);
  const codes = (ids: string[]) => ids.map((id) => `<code>${escapeHtml(id)}</code>`).join(', ');
  const records = live.map((decision) => {
    const facts = [
      `${decision.status === 'accepted' ? 'Accepted' : 'Proposed'} ${escapeHtml(decision.date)}`,
      decision.components.length > 0 ? `about ${codes(decision.components)}` : '',
      decision.enforced_by.length > 0 ? `enforced by ${codes(decision.enforced_by)}` : '',
      decision.supersedes.length > 0 ? `supersedes ${codes(decision.supersedes)}` : '',
    ].filter(Boolean);
    return `<h3>${escapeHtml(decision.title)}</h3><p>${facts.join(' · ')}</p>${chapterHtml(decision.body, model)}`;
  });
  const history = past.map(({ id, title, date, status, superseded_by }) => {
    const successor = superseded_by ? byId.get(superseded_by) : undefined;
    const fate =
      status === 'deprecated'
        ? 'deprecated'
        : `superseded by ${successor ? `${escapeHtml(successor.title)} on ${escapeHtml(successor.date)}` : `<code>${escapeHtml(superseded_by ?? '')}</code>`}`;
    return `<li>${escapeHtml(date)}: ${escapeHtml(title)} (<code>${escapeHtml(id)}</code>), ${fate}</li>`;
  });
  return [
    ...records,
    history.length > 0 ? `<h3>History</h3><ul>${history.join('')}</ul>` : '',
  ].join('\n');
}

/** True when a chapter places the named diagram, so the page need not add it again. */
const placedByChapter = ({ ssot }: ShowModel, name: string) =>
  ssot.chapters.some(({ body }) =>
    [...body.matchAll(DIAGRAM_DIRECTIVE)].some((match) => match[1] === name),
  );

/** Renders `show` as one standalone page, with no scripts and no network requests. */
export function renderShowHtml(model: ShowModel): string {
  const { ssot, root } = model;
  const intro = model.draft
    ? 'A draft from static analysis. Run jevlint architecture compile to turn it into an SSOT.'
    : `From ${ssot.dir}${ssot.index.compiled_at ? `, compiled at ${ssot.index.compiled_at}` : ''}${ssot.index.compiled_on ? ` on ${ssot.index.compiled_on}` : ''}.`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Architecture of ${escapeHtml(ssot.index.name)}</title><style>${STYLES}.bad{color:var(--critical)}blockquote{color:var(--muted);border-left:3px solid var(--hair);margin:8px 0;padding-left:12px}pre{background:var(--panel);padding:12px;overflow:auto}h3{font-size:15px;margin:24px 0 4px}</style></head><body>
<h1>${escapeHtml(ssot.index.name)} architecture</h1><p><code>${escapeHtml(root)}</code></p>
<p>${escapeHtml(intro)}</p><p>${escapeHtml(ssot.index.description)}</p>
${SHOW_LEGEND}
${ssot.chapters.map(({ title, body }) => `<h2>${escapeHtml(title)}</h2>${chapterHtml(body, model)}`).join('\n')}
${ssot.decisions && !placedByChapter(model, 'decisions') ? `<h2>Decisions</h2>${decisionsHtml(model)}` : ''}
${ssot.views.map((view) => section(escapeHtml(view.title), '', viewHtml(view, model))).join('\n')}
${section('Components', 'Hover a box to trace its links.', renderDiagram(componentNodes(model), mapEdgesAsEdges(model.edges)))}
${section('Each component', 'What it does, where to start reading, and what it depends on.', componentTable(model))}
${ssot.flows.length > 0 ? section('Flows', 'The main workflows, step by step.', flowTables(model)) : ''}
</body></html>
`;
}
