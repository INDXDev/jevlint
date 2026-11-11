/**
 * `jevlint architecture show`: the SSOT, or the draft the facts give, with the real dependencies
 * laid over the declared ones. No model and no network.
 */
import { basename } from 'node:path';
import type { Config } from '../config.ts';
import type { ArchitectureFacts, ArchitectureSsot, MapEdge } from '../types.ts';
import { collect } from './collect.ts';
import { mapEdges } from './conformance.ts';
import { draftSsot } from './draft.ts';
import { ssotDir } from './load.ts';

/** What every view draws from. */
export interface ShowModel {
  root: string;
  /** True when there is no SSOT, so the components are the facts' candidates. */
  draft: boolean;
  ssot: ArchitectureSsot;
  edges: MapEdge[];
  facts: ArchitectureFacts;
}

/** A view `show` can draw. */
export type View =
  | { kind: 'map' }
  | { kind: 'layers' }
  | { kind: 'flow'; id: string }
  | { kind: 'component'; id: string };

/** Collects the facts and lays them over the SSOT, or over the draft when there is none. */
export async function showArchitecture(
  config: Config,
  existing: ArchitectureSsot | null,
  options: { noCache?: boolean } = {},
): Promise<ShowModel> {
  const { facts, modules } = await collect(config, { skipHistory: true, noCache: options.noCache });
  const ssot = existing ?? draftSsot(facts, basename(config.root), ssotDir(config));
  return {
    root: config.root,
    draft: existing === null,
    ssot,
    edges: mapEdges(ssot, modules),
    facts,
  };
}
