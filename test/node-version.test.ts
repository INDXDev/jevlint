import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { isPatchedNode } from '../src/node-version.ts';

describe('isPatchedNode', () => {
  it.each([
    ['v22.23.4', true],
    ['v22.24.0', true],
    ['v24.22.1', true],
    ['v24.22.2', true],
    ['v26.12.1', true],
    ['v26.13.0', true],
    ['v27.0.0-alpha.0', true],
    ['v22.23.3', false],
    ['v22.18.0', false],
    ['v24.22.0', false],
    ['v24.9.9', false],
    ['v26.12.0', false],
    ['v25.9.0', false],
    ['v23.11.1', false],
    ['v20.19.0', false],
  ])('%s gives %s', (version, expected) => {
    expect(isPatchedNode(version)).toBe(expected);
  });

  it('accepts the Node.js this project runs on', () => {
    expect(isPatchedNode(process.version)).toBe(true);
  });

  it('agrees with engines in package.json', () => {
    expect(pkg.engines.node).toBe('^22.23.4 || ^24.22.1 || >=26.12.1');
  });
});
