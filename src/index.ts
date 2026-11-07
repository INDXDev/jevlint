/** Public library API. Must stay silent: no terminal output. */
export { reviewArchitecture } from './architecture/review.ts';
export { audit } from './audit.ts';
export { loadConfig } from './config.ts';
export { checkSpec } from './spec/check.ts';
export { driftSpec } from './spec/drift.ts';
export { loadSpec } from './spec/load.ts';
export type * from './types.ts';
