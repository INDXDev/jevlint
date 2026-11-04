/** Turns a structure into the units a review scores, each with the outline a model reads. */
import type {
  ArchitectureEdge,
  ArchitectureFinding,
  ClassNode,
  DirectoryNode,
  Perspective,
} from '../types.ts';
import type { Structure } from './structure.ts';

/** A unit before scoring. A null outline means there is nothing for a model to judge. */
export interface Subject {
  perspective: Perspective;
  name: string;
  path: string;
  line: number;
  lines: number;
  findings: ArchitectureFinding[];
  outline: string | null;
}

const NOTHING = 'nothing in this repository';

const listOf = (names: string[]) => names.join(', ') || NOTHING;

function codebaseOutline({ directories, modules, classes, edges }: Structure): string {
  return [
    `Codebase: ${directories.length} directories, ${modules.length} modules, ${classes.length} classes`,
    'Directories, with layer 0 depending on nothing:',
    ...directories.map(
      ({ path, files, lines, layer }) =>
        `- ${path}: ${files} files, ${lines} lines, layer ${layer}`,
    ),
    'Dependencies between directories, with the number of imports:',
    ...edges.directories.map(({ from, to, weight }) => `- ${from} -> ${to} (${weight})`),
  ].join('\n');
}

function directoryOutline(directory: DirectoryNode, { modules, edges }: Structure): string {
  const members = modules.filter((module) => module.directory === directory.path);
  const paths = new Set(members.map(({ path }) => path));
  const linksOut = (near: 'from' | 'to', far: 'from' | 'to') => {
    const crossing = edges.modules.filter((edge) => paths.has(edge[near]) && !paths.has(edge[far]));
    return listOf([...new Set(crossing.map((edge) => edge[far]))]);
  };
  return [
    `Directory: ${directory.path}`,
    'Modules:',
    ...members.map(
      ({ path, lines, symbols }) => `- ${path} (${lines} lines): ${symbols.join(', ') || 'none'}`,
    ),
    `Depends on: ${linksOut('from', 'to')}`,
    `Used by: ${linksOut('to', 'from')}`,
  ].join('\n');
}

function classOutline(
  { id, name, path, lines, methods }: ClassNode,
  { classes, edges }: Structure,
) {
  const nameOf = (classId: string) => classes.find((node) => node.id === classId)?.name ?? classId;
  const linked = (matches: (edge: ArchitectureEdge) => boolean, end: 'from' | 'to') =>
    listOf(edges.classes.filter(matches).map((edge) => nameOf(edge[end])));
  return [
    `Class: ${name} in ${path} (${lines} lines)`,
    `Methods: ${methods.join(', ')}`,
    `Inherits from: ${linked((edge) => edge.from === id && edge.kind === 'inherits', 'to')}`,
    `Uses: ${linked((edge) => edge.from === id && edge.kind === 'uses', 'to')}`,
    `Used by: ${linked((edge) => edge.to === id, 'from')}`,
  ].join('\n');
}

/** Lists what can be reviewed. A class with no methods and no findings has nothing to judge. */
export function subjectsOf(structure: Structure): Subject[] {
  const { directories, modules, classes, findings } = structure;
  if (modules.length === 0) return [];
  const codebase: Subject = {
    perspective: 'codebase',
    name: 'codebase',
    path: '.',
    line: 1,
    lines: modules.reduce((sum, { lines }) => sum + lines, 0),
    findings,
    outline: codebaseOutline(structure),
  };
  const ofDirectories = directories.map(
    (directory): Subject => ({
      perspective: 'directory',
      name: directory.path,
      path: directory.path,
      line: 1,
      lines: directory.lines,
      findings: findings.filter((finding) => finding.directories.includes(directory.path)),
      outline: directoryOutline(directory, structure),
    }),
  );
  const ofClasses = classes.flatMap((node): Subject[] => {
    const own = findings.filter(({ path, symbol }) => path === node.path && symbol === node.name);
    const hasMethods = node.methods.length > 0;
    if (!hasMethods && own.length === 0) return [];
    const { id: name, path, line, lines } = node;
    const outline = hasMethods ? classOutline(node, structure) : null;
    return [{ perspective: 'class', name, path, line, lines, findings: own, outline }];
  });
  return [codebase, ...ofDirectories, ...ofClasses];
}
