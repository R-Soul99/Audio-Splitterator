/** Keep selection endpoints inside the recording, with exact boundaries winning over snapping. */
export function selectionEndpoint(time: number, duration: number, snap: (time: number) => number = (value) => value): number {
  if (time <= 0) return 0;
  if (time >= duration) return duration;
  return Math.max(0, Math.min(duration, snap(time)));
}
