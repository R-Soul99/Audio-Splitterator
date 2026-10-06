import { LevelWindow } from './silenceAnalysis';

export interface QuietRun { start: number; end: number; candidate: number }
interface QuietZone { start: number; end: number }
export interface QuietTarget { time: number; runStart: number; zone: QuietZone }

// Runs are immutable analysis results. Cache the connected Snap envelopes so
// pointer moves retain the binary-search path rather than rescanning all runs.
const zoneCache = new WeakMap<QuietRun[], { radius: number; zones: QuietZone[] }>();
function acquisitionZones(runs: QuietRun[], radius: number): QuietZone[] {
  const cached = zoneCache.get(runs);
  if (cached?.radius === radius) return cached.zones;
  const zones: QuietZone[] = [];
  let zone: QuietZone | undefined;
  for (const run of runs) {
    const start = run.start - radius, end = run.end + radius;
    if (zone && start <= zone.end + 1e-9) zone.end = Math.max(zone.end, end);
    else zone = { start, end };
    zones.push(zone);
  }
  zoneCache.set(runs, { radius, zones });
  return zones;
}

// A target's local snap time can move while its quiet region stays acquired.
// Only region acquisition/loss determines ping events; no timer is involved.
export class QuietRadarAcquisition {
  private zone: QuietZone | null = null;

  update(target: QuietTarget | null): boolean {
    const nextZone = target?.zone ?? null;
    const acquired = nextZone !== null && (this.zone === null ||
      nextZone.start !== this.zone.start || nextZone.end !== this.zone.end);
    this.zone = nextZone;
    return acquired;
  }

  reset(): void {
    this.zone = null;
  }
}

// Sensitivity filters audio evidence, independently of the pointer capture radius.
// 100 preserves the original manual radar; lower settings require longer, deeper gaps.
export function quietCandidatePolicy(thresholdDb: number, sensitivity: number) {
  const selectivity = 1 - Math.max(0, Math.min(100, sensitivity)) / 100;
  return { thresholdDb: thresholdDb - 6 * selectivity, minimumSec: 0.5 * selectivity ** 2 };
}

// Manual radar retains fine-grained runs and does not borrow Auto-Split's spike policy.
export function buildQuietRuns(windows: LevelWindow[], thresholdDb: number, sensitivity = 100): QuietRun[] {
  const threshold = 10 ** (thresholdDb / 20);
  const runs: QuietRun[] = [];
  const peaks: number[] = [];
  for (const window of windows) {
    if (window.rms > threshold) continue;
    const previous = runs.at(-1);
    if (previous && Math.abs(previous.end - window.start) < 1e-9) {
      previous.end = window.end;
      previous.candidate = (previous.start + previous.end) / 2;
      peaks[peaks.length - 1] = Math.max(peaks.at(-1)!, window.rms);
    } else {
      runs.push({ start: window.start, end: window.end, candidate: (window.start + window.end) / 2 });
      peaks.push(window.rms);
    }
  }
  const policy = quietCandidatePolicy(thresholdDb, sensitivity);
  const maximumRms = 10 ** (policy.thresholdDb / 20);
  return runs.filter((run, index) => run.end - run.start + 1e-9 >= policy.minimumSec && peaks[index] <= maximumRms);
}

export function acquireQuietTarget(time: number, runs: QuietRun[], radius: number): QuietTarget | null {
  if (radius <= 0) return null;
  const zones = acquisitionZones(runs, radius);
  const left = time - radius, right = time + radius;
  // Binary search skips runs outside the local search radius.
  let low = 0, high = runs.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (runs[middle].end < left - 1e-9) low = middle + 1; else high = middle;
  }
  let target: QuietTarget | null = null;
  let nearest = Infinity;
  for (let index = low; index < runs.length && runs[index].start <= right + 1e-9; index++) {
    const run = runs[index];
    const start = Math.max(left, run.start), end = Math.min(right, run.end);
    // A touching envelope is still acquired, even if only its boundary is
    // reachable. Tolerance covers floating-point arithmetic at that boundary.
    if (end < start - 1e-9) continue;
    const distance = Math.max(run.start - time, time - run.end, 0);
    // Dots, pings, and manual snapping share the detected candidate position.
    const candidate = run.candidate;
    if (distance < nearest || (distance === nearest && Math.abs(candidate - time) < Math.abs((target?.time ?? Infinity) - time))) {
      target = { time: candidate, runStart: run.start, zone: zones[index] }; nearest = distance;
    }
  }
  return target;
}
