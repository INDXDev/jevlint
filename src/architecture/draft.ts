/**
 * Turns facts into a draft SSOT: the component candidates with their paths, layers, dependencies
 * and externals, and placeholders where only a person or an agent can name and explain. Pure.
 */
import type {
  ArchitectureComponent,
  ArchitectureExternal,
  ArchitectureFacts,
  ArchitectureSsot,
  ComponentCandidate,
} from '../types.ts';

/** Marks text that the draft leaves for the agent to write. */
export const PLACEHOLDER = 'TODO';

/** Layer names for inferred layer numbers, top first: `layer-2`, `layer-1`, `layer-0`. */
export const layerNames = (count: number) =>
  Array.from({ length: count }, (_, index) => `layer-${count - 1 - index}`);

function draftComponent(
  candidate: ComponentCandidate,
  facts: ArchitectureFacts,
): ArchitectureComponent {
  const depends = facts.dependencies
    .filter(({ from }) => from === candidate.id)
    .map(({ to }) => to);
  return {
    id: candidate.id,
    title: candidate.id,
    summary: `${PLACEHOLDER}: ${candidate.files.length} files, ${candidate.lines} lines.`,
    layer: `layer-${candidate.layer}`,
    paths: candidate.paths,
    key_files: candidate.central.map((path) => ({ path, role: PLACEHOLDER })),
    interface: candidate.interface,
    depends_on: depends.sort(),
    uses: candidate.externals,
    rules: [],
    checklist: [],
    status: 'current',
  };
}

function draftExternals(facts: ArchitectureFacts): ArchitectureExternal[] {
  return facts.externals
    .filter(({ kind }) => kind === 'system' || kind === 'library')
    .map(({ id, title, packages }) => ({ id, title, packages }));
}

/** The facts as an SSOT, for `show` before one exists and for the compile prompt's draft. */
export function draftSsot(facts: ArchitectureFacts, name: string, dir: string): ArchitectureSsot {
  const components = facts.components.map((candidate) => draftComponent(candidate, facts));
  return {
    dir,
    index: {
      version: 1,
      name,
      ...(facts.commit ? { compiled_at: facts.commit } : {}),
      description: `${PLACEHOLDER}: what the system does, in a paragraph.`,
      layers: layerNames(facts.layers),
      ignore: facts.tests,
      externals: draftExternals(facts),
      rules: [
        { id: 'layers-point-down', kind: 'layers' },
        { id: 'no-component-cycles', kind: 'no-cycles' },
      ],
      checklist: [],
    },
    components,
    flows: facts.flows.map(({ entry, components: chain }, index) => ({
      id: `flow-${index + 1}`,
      title: `From ${entry}`,
      trigger: entry,
      steps: chain.slice(1).map((to, step) => ({ from: chain[step] as string, to, verb: 'uses' })),
    })),
  };
}
