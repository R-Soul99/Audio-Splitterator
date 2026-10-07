// Source timing segments are independent of animation frames and editable markers.
export interface PlaybackSegment {
  when: number;
  offset: number;
  start: number;
  end: number;
  loop: boolean;
}
export function playbackPosition(segment: PlaybackSegment, clock: number): number {
  const position = segment.offset + Math.max(0, clock - segment.when);
  if (!segment.loop) return Math.min(segment.end, position);
  // The first pass starts at the audition offset; subsequent passes start at Loop Start.
  return position < segment.end ? position : segment.start + (position - segment.end) % (segment.end - segment.start);
}
export function timelinePosition(segments: PlaybackSegment[], clock: number): number | null {
  if (!segments.length) return null;
  const segment = [...segments].reverse().find(s => s.when <= clock) ?? segments[0];
  return playbackPosition(segment, clock);
}
export function outputClock(ctx: Pick<AudioContext, 'currentTime' | 'state' | 'baseLatency' | 'outputLatency' | 'getOutputTimestamp'>, now: number): number {
  if (ctx.state !== 'running') return ctx.currentTime;
  const timestamp = ctx.getOutputTimestamp?.();
  if (timestamp && (timestamp.contextTime ?? 0) > 0 && (timestamp.performanceTime ?? 0) > 0) {
    return Math.max(0, Math.min(ctx.currentTime, timestamp.contextTime! + Math.max(0, now - timestamp.performanceTime!) / 1000));
  }
  return Math.max(0, ctx.currentTime - (ctx.baseLatency || 0) - (ctx.outputLatency || 0));
}
