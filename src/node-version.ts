/** Refuses Node.js releases with known holes, since `engines` only warns under npm. */

/** The first release of each line with the fixes of October 2026, such as CVE-2026-111497. */
const PATCHED: Record<number, [minor: number, patch: number]> = {
  22: [23, 4],
  24: [22, 1],
  26: [12, 1],
};
const NEWEST_LINE = 26;

/** Says whether a version has the fixes. A line missing here is end-of-life, so it never will. */
export function isPatchedNode(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.slice(1).split('.').map(Number.parseFloat);
  const floor = PATCHED[major];
  if (!floor) return major > NEWEST_LINE;
  return minor > floor[0] || (minor === floor[0] && patch >= floor[1]);
}
