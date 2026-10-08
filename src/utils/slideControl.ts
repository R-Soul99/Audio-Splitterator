export const SLIDE_DEAD_ZONE = .08;
export const KEYBOARD_SLIDE = .4;

// Full deflection moves a quarter of the visible waveform per second.
export function slideVelocity(displacement: number, visibleSeconds: number, rate: number, fine: boolean): number {
  const amount = Math.max(-1, Math.min(1, displacement));
  const travel = Math.max(0, Math.abs(amount) - SLIDE_DEAD_ZONE) / (1 - SLIDE_DEAD_ZONE);
  return Math.sign(amount) * travel * Math.max(0, visibleSeconds) * rate * .25 * (fine ? .1 : 1);
}
export interface SlidePosition { position: number; remainder: number }
// Keep sub-sample motion, but discard boundary overshoot before reversing.
export function advanceSlide(state: SlidePosition, samplesPerSecond: number, elapsedSeconds: number, max: number): SlidePosition {
  if (elapsedSeconds <= 0 || samplesPerSecond === 0) return state;
  const raw = Math.max(0, Math.min(max, state.position + state.remainder + samplesPerSecond * Math.max(0, elapsedSeconds)));
  const position = Math.max(0, Math.min(max, Math.round(raw)));
  return { position, remainder: raw - position };
}
