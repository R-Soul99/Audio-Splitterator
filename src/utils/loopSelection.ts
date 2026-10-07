import { TimeSelection } from '../types';

export type LoopTarget = 'whole' | 'start' | 'end';
export type LoopAnchor = 'start' | 'end';
export interface SampleSelection { start: number; end: number }
export function adjustmentSamples(rate: number, fine: boolean): number {
  return Math.max(1, Math.round(rate * (fine ? 1 : 10) / 1000));
}
export function adjustBeatSample(beat: number, selection: SampleSelection, delta: number): number | null {
  const next = beat + delta;
  return Number.isInteger(next) && next >= selection.start && next < selection.end ? next : null;
}
// Discrete actions preserve their requested spans; halving rounds odd counts down.
export function sampleSelection(selection: TimeSelection | null, rate: number, frames: number): SampleSelection | null {
  if (!selection || !Number.isFinite(rate) || rate <= 0 || Math.min(selection.start, selection.end) < 0 || Math.max(selection.start, selection.end) > frames / rate) return null;
  const start = Math.round(Math.min(selection.start, selection.end) * rate);
  const end = Math.round(Math.max(selection.start, selection.end) * rate);
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end <= frames && end > start ? { start, end } : null;
}
export function editSamples(selection: SampleSelection, target: LoopTarget, delta: number, frames: number): SampleSelection | null {
  const start = selection.start + (target === 'end' ? 0 : delta);
  const end = selection.end + (target === 'start' ? 0 : delta);
  return Number.isInteger(delta) && start >= 0 && end <= frames && end > start ? { start, end } : null;
}
export function resizeSamples(selection: SampleSelection, factor: number, anchor: LoopAnchor, frames: number): SampleSelection | null {
  const scaled = (selection.end - selection.start) * factor;
  const length = factor === 0.5 ? Math.floor(scaled) : scaled;
  if (!Number.isInteger(length) || length < 1 || (factor < 1 && length >= selection.end - selection.start)) return null;
  return editSamples(selection, anchor === 'start' ? 'end' : 'start', anchor === 'start' ? length - (selection.end - selection.start) : (selection.end - selection.start) - length, frames);
}
export function sampleTimes(selection: SampleSelection, rate: number): TimeSelection {
  return { start: selection.start / rate, end: selection.end / rate };
}
export function parseLoopTime(text: string): number | null {
  if (!/^\d+(?::[0-5]?\d)?(?:\.\d+)?$/.test(text.trim())) return null;
  const parts = text.trim().split(':').map(Number);
  const seconds = parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0];
  return Number.isFinite(seconds) ? seconds : null;
}
// Reset the playback clock to its current position when native loop bounds change.
export function loopEditPosition(position: number, selection: TimeSelection): { position: number; restart: boolean } {
  const restart = position < selection.start || position >= selection.end;
  return { position: restart ? selection.start : position, restart };
}
