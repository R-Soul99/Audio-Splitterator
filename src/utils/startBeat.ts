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
