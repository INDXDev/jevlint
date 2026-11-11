/** Where execution starts, as data: file patterns and source patterns per framework. */
import { posix } from 'node:path';
import type { Language } from '../types.ts';

/** One way to recognise an entry point, by its path, its source, or both. */
export interface EntryPattern {
  kind: string;
  /** A glob the root-relative path must match. */
  path?: string;
  /** A pattern the source must contain somewhere. */
  source?: RegExp;
  languages?: Language[];
}

const ECMASCRIPT: Language[] = ['javascript', 'typescript', 'tsx'];

/** Every recognised entry point. A file can match several, and the first kind wins. */
export const ENTRY_PATTERNS: EntryPattern[] = [
  { kind: 'next-route', path: '**/app/**/{page,route,layout}.{ts,tsx,js,jsx}' },
  { kind: 'next-page', path: '**/pages/**/*.{ts,tsx,js,jsx}' },
  { kind: 'go-main', path: '**/main.go', source: /^package main\b/m },
  { kind: 'rust-main', path: '**/src/{main.rs,bin/*.rs}' },
  { kind: 'python-main', path: '**/{__main__,manage}.py' },
  { kind: 'python-main', source: /^if __name__ == ['"]__main__['"]:/m, languages: ['python'] },
  {
    kind: 'fastapi-handler',
    source: /^@\w+\.(get|post|put|patch|delete|route)\(/m,
    languages: ['python'],
  },
  {
    kind: 'express-handler',
    source: /\b(app|router)\.(get|post|put|patch|delete|use)\(\s*['"`]\//,
    languages: ECMASCRIPT,
  },
  { kind: 'cli', source: /^#!.*\bnode\b/, languages: ECMASCRIPT },
];

/** The kind of entry point a file is, or null. `manifest` lists files package.json names. */
export function entryKind(
  path: string,
  language: Language,
  source: string,
  manifest: Map<string, string>,
): string | null {
  const named = manifest.get(path);
  if (named) return named;
  const found = ENTRY_PATTERNS.find(
    (pattern) =>
      (!pattern.path || posix.matchesGlob(path, pattern.path)) &&
      (!pattern.languages || pattern.languages.includes(language)) &&
      (!pattern.source || pattern.source.test(source)),
  );
  return found?.kind ?? null;
}
