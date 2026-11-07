import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { formatSpecCheck, formatSpecDrift, formatSpecList } from '../src/spec/terminal.ts';
import type { Spec, SpecCheckReport, SpecDriftReport } from '../src/types.ts';

const usage = { inputTokens: 0, estimatedCostUsd: 0, cacheHits: 0, modelCalls: 0 };
const lockout = { id: 'login.lockout', text: 'Five failed sign-ins lock the account.' };

const check = (overrides: Partial<SpecCheckReport> = {}): SpecCheckReport => ({
  root: '/repo',
  specDir: '.jevlint/spec',
  provider: 'typesafe',
  model: 'jev-latest',
  scale: 100,
  complete: true,
  files: [
    {
      path: 'src/auth/session.ts',
      feature: 'login',
      featureConfidence: 0.91,
      score: 50,
      items: [
        { ...lockout, verdict: 'violates', confidence: 0.84 },
        { id: 'login.hashing', text: 'Argon2id.', verdict: 'satisfies', confidence: 0.9 },
      ],
      warnings: [],
    },
    {
      path: 'src/ok.ts',
      feature: 'global',
      featureConfidence: 0.7,
      score: 100,
      items: [],
      warnings: ['Provider error: timeout'],
    },
  ],
  violations: 1,
  unimplemented: [{ id: 'checkout.receipt', text: 'A receipt is sent.' }],
  usage,
  warnings: [],
  ...overrides,
});

const drift = (overrides: Partial<SpecDriftReport> = {}): SpecDriftReport => ({
  root: '/repo',
  specDir: '.jevlint/spec',
  provider: 'typesafe',
  model: 'jev-latest',
  complete: true,
  docs: [
    {
      path: 'docs/auth.md',
      feature: 'login',
      featureConfidence: 0.95,
      items: [{ ...lockout, verdict: 'contradicts', confidence: 0.8 }],
      uncovered: 0.7,
      warnings: [],
    },
    {
      path: 'README.md',
      feature: 'global',
      featureConfidence: 0.9,
      items: [],
      uncovered: 0.1,
      warnings: [],
    },
  ],
  contradictions: 1,
  uncovered: ['docs/auth.md'],
  unbacked: [{ id: 'login.hashing', text: 'Argon2id.' }],
  undocumented: ['admin'],
  usage,
  warnings: [],
  ...overrides,
});

const plain = (text: string) => stripVTControlCharacters(text);

describe('formatSpecCheck', () => {
  it('shows only violated items, then unimplemented ones and file warnings', () => {
    const text = plain(formatSpecCheck(check()));
    expect(text).toContain(
      'Spec check: 1 violation in 1 file, 1 unimplemented item (.jevlint/spec)',
    );
    expect(text).toMatch(
      /src\/auth\/session\.ts {2}login {3}\(0\.91\) {2}1 satisfy, 1 violate, 0 n\/a {2}score 50/,
    );
    expect(text).toContain('✗ login.lockout  Five failed');
    expect(text).not.toContain('login.hashing');
    expect(text).toMatch(/src\/ok\.ts .*0 satisfy, 0 violate, 0 n\/a {2}score 100/);
    expect(text).toContain('checkout.receipt  A receipt is sent.');
    expect(text).toContain('src/ok.ts: Provider error: timeout');
  });

  it('prints one line for a clean run', () => {
    const report = check({ files: [], violations: 0, unimplemented: [] });
    expect(plain(formatSpecCheck(report))).toBe(
      'Spec check: no problems in 0 files (.jevlint/spec)',
    );
  });

  it('lists every item with its confidence when verbose', () => {
    const text = plain(formatSpecCheck(check(), true));
    expect(text).toContain('✗ login.lockout  (0.84)  Five failed');
    expect(text).toContain('✓ login.hashing  (0.90)  Argon2id.');
  });

  it('says a narrowed run skipped unimplemented items', () => {
    const text = plain(formatSpecCheck(check({ complete: false, unimplemented: [] })));
    expect(text).toContain('1 violation in 1 file (.jevlint/spec)');
    expect(text).toContain('were not worked out');
  });

  it('strips control characters from repository text', () => {
    const report = check({ unimplemented: [{ id: 'a.b', text: 'evil\u001b[2J' }] });
    expect(formatSpecCheck(report)).not.toContain('\u001b[2J');
  });
});

describe('formatSpecDrift', () => {
  it('shows contradictions per document, then the repository-wide drift', () => {
    const text = plain(formatSpecDrift(drift()));
    expect(text).toContain(
      'Spec drift: 1 contradiction, 1 uncovered, 1 unbacked item, 1 undocumented feature',
    );
    expect(text).toContain(
      'docs/auth.md  login   (0.95)  0 agree, 0 absent, 1 contradict  uncovered 0.70',
    );
    expect(text).toContain('✗ login.lockout  Five failed');
    expect(text).toContain(
      'README.md     global  (0.90)  0 agree, 0 absent, 0 contradict  uncovered 0.10',
    );
    expect(text).toContain('login.hashing  Argon2id.');
    expect(text).toMatch(/Undocumented.*\n {2}admin/);
  });

  it('marks an accepted document', () => {
    const report = drift({
      docs: [
        {
          path: 'docs/README.md',
          feature: 'global',
          featureConfidence: 0.9,
          items: [],
          uncovered: 0.6,
          uncoveredAccepted: 'Links only.',
          warnings: [],
        },
      ],
      contradictions: 0,
      uncovered: [],
      unbacked: [],
      undocumented: [],
    });
    expect(plain(formatSpecDrift(report))).toContain('uncovered 0.60  accepted');
  });

  it('lists every item with its confidence when verbose', () => {
    const report = drift({
      docs: [
        {
          path: 'docs/auth.md',
          feature: 'login',
          featureConfidence: 0.95,
          items: [
            { ...lockout, verdict: 'agrees', confidence: 0.61 },
            { id: 'login.hashing', text: 'Argon2id.', verdict: 'absent', confidence: 0.9 },
          ],
          uncovered: 0.1,
          warnings: [],
        },
      ],
    });
    const text = plain(formatSpecDrift(report, true));
    expect(text).toContain('✓ login.lockout  (0.61)  Five failed');
    expect(text).toContain('· login.hashing  (0.90)  Argon2id.');
    expect(plain(formatSpecDrift(report))).not.toContain('login.lockout  (0.61)');
  });

  it('prints only the header for a clean run with no documents', () => {
    const report = drift({
      docs: [],
      contradictions: 0,
      uncovered: [],
      unbacked: [],
      undocumented: [],
    });
    expect(plain(formatSpecDrift(report))).toBe(
      'Spec drift: no drift in 0 documents (.jevlint/spec)',
    );
  });
});

describe('formatSpecList', () => {
  it('prints the project and every checklist with full ids', () => {
    const spec: Spec = {
      dir: '.jevlint/spec',
      index: {
        version: 1,
        name: 'Shop',
        description: 'A shop.',
        checklist: [{ id: 'no-secrets', text: 'No secrets in logs.' }],
        accept_uncovered: [],
      },
      features: [
        {
          id: 'login',
          title: 'Login',
          summary: 'Signs in.',
          checklist: [{ id: 'lockout', text: lockout.text }],
        },
      ],
    };
    const text = plain(formatSpecList(spec));
    expect(text).toContain('Shop (.jevlint/spec): 1 feature, 2 items');
    expect(text).toContain('global.no-secrets  No secrets in logs.');
    expect(text).toContain('login  Login: Signs in.');
    expect(text).toContain('login.lockout      Five failed');
  });
});
