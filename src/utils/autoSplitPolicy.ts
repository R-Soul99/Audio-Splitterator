import { Marker } from '../types';

export const AUTO_SPLIT_EDGE_EXCLUSION_SECONDS = 5.0;

export function filterAutoSplitCandidates(times: number[], duration: number): number[] {
  return times.filter(time => time >= AUTO_SPLIT_EDGE_EXCLUSION_SECONDS &&
    time <= duration - AUTO_SPLIT_EDGE_EXCLUSION_SECONDS);
}

export function mergeAutoSplitMarkers(existing: Marker[], detected: Marker[]): Marker[] {
  if (detected.length === 0) return existing;
  const manual = existing.filter(marker => !marker.id.startsWith('marker-auto-'));
  return [...manual, ...detected.filter(marker => !manual.some(kept => Math.abs(kept.time - marker.time) < 0.01))]
    .sort((a, b) => a.time - b.time);
}
