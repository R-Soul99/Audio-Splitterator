// Combine channel energy for display only; never sum samples (anti-phase audio
// must remain visible). This does not participate in capture or export.
export function combinedStereoLevelDb(leftDb: number, rightDb: number): number {
  return 10 * Math.log10((10 ** (leftDb / 10) + 10 ** (rightDb / 10)) / 2);
}
