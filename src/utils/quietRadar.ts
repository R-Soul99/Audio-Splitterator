import { LevelWindow } from './silenceAnalysis';

export interface QuietRun { start: number; end: number; candidate: number }
export interface QuietTarget { time: number; runStart: number }

// Manual radar intentionally has no Gap minimum or Auto-Split interruption policy.
export function buildQuietRuns(windows: LevelWindow[], thresholdDb: number): QuietRun[] {
  const threshold = 10 ** (thresholdDb / 20);
  const runs: QuietRun[] = [];
  for (const window of windows) {
    if (window.rms > threshold) continue;
    const previous = runs.at(-1);
    if (previous && Math.abs(previous.end - window.start) < 1e-9) {
      previous.end = window.end;
      previous.candidate = (previous.start + previous.end) / 2;
    } else runs.push({ start: window.start, end: window.end, candidate: (window.start + window.end) / 2 });
  }
  return runs;
}

export function acquireQuietTarget(time: number, runs: QuietRun[], radius: number): QuietTarget | null {
  if (radius <= 0) return null;
  const left = time - radius, right = time + radius;
  // Binary search skips runs outside the local search radius.
  let low = 0, high = runs.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (runs[middle].end < left) low = middle + 1; else high = middle;
  }
  let target: QuietTarget | null = null;
  let nearest = Infinity;
  for (let index = low; index < runs.length && runs[index].start <= right; index++) {
    const run = runs[index];
    const start = Math.max(left, run.start), end = Math.min(right, run.end);
    if (end <= start) continue;
    const distance = Math.max(run.start - time, time - run.end, 0);
    // Use the whole run's stable centre when reachable; otherwise the centre of
    // the locally available quiet portion. The acquired point never exceeds ±Snap.
    const candidate = run.candidate >= start && run.candidate <= end ? run.candidate : (start + end) / 2;
    if (distance < nearest || (distance === nearest && Math.abs(candidate - time) < Math.abs((target?.time ?? Infinity) - time))) {
      target = { time: candidate, runStart: run.start }; nearest = distance;
    }
  }
  return target;
}
