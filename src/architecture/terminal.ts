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
  ArchitectureFinding,
  ArchitectureReport,
  ArchitectureUnit,
  Perspective,
} from '../types.ts';

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
