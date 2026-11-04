/** Renders an architecture report as one HTML file, with no scripts and no network requests. */
import { describeFinding, findingHealth, formatScore, worstIssue } from '../report.ts';
import type { ArchitectureEdge, ArchitectureReport, ArchitectureUnit } from '../types.ts';
import { findingLocation } from './terminal.ts';

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
