import { SampleSelection } from './loopSelection';
export type SelectionEdit = 'new' | 'move' | 'edge';
export function adjustStartBeat(previous: SampleSelection | null, next: SampleSelection | null, beat: number | null, edit: SelectionEdit): number | null {
  if (!next) return null;
  if (!previous || beat === null || edit === 'new') return next.start;
  const candidate = edit === 'move' ? beat + next.start - previous.start : beat;
  return Number.isInteger(candidate) && candidate >= next.start && candidate < next.end ? candidate : next.start;
}
export function placementSample(time: number, rate: number, selection: SampleSelection | null): number | null {
  const sample = Math.round(time * rate);
  return selection && Number.isInteger(sample) && sample >= selection.start && sample < selection.end ? sample : null;
}
export function adjustStartBeatState(previous: SampleSelection | null, next: SampleSelection | null, beat: number | null, custom: boolean, edit: SelectionEdit): { sample: number | null; custom: boolean } {
  if (!custom) return { sample: next?.start ?? null, custom: false };
  const sample = adjustStartBeat(previous, next, beat, edit);
  const candidate = beat !== null && previous && next ? beat + (edit === 'move' ? next.start - previous.start : 0) : null;
  return { sample, custom: custom && edit !== 'new' && candidate !== null && candidate === sample };
}
