import { TimeSelection } from '../types';

export interface SampleSelection { start: number; end: number }

export function sampleSelection(selection: TimeSelection | null, rate: number, frames: number): SampleSelection | null {
  if (!selection || !Number.isFinite(rate) || rate <= 0 || Math.min(selection.start, selection.end) < 0 || Math.max(selection.start, selection.end) > frames / rate) return null;
  const start = Math.round(Math.min(selection.start, selection.end) * rate);
  const end = Math.round(Math.max(selection.start, selection.end) * rate);
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end <= frames && end > start ? { start, end } : null;
}
