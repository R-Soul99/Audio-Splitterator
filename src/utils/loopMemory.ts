import { SampleSelection } from './loopSelection';

export interface LoopPreset extends SampleSelection { beat: number; custom: boolean; used: number }
export type MemoryAction = 'activate' | 'replace' | 'clear';
export const emptyLoopMemory = (): (LoopPreset | null)[] => Array(10).fill(null);
export function loopSnapshot(selection: SampleSelection | null, beat: number | null, custom: boolean, frames: number): Omit<LoopPreset, 'used'> | null {
  if (!selection || !Number.isInteger(selection.start) || !Number.isInteger(selection.end) || selection.start < 0 || selection.end > frames || selection.end <= selection.start) return null;
  const first = custom ? beat : selection.start;
  if (first === null || !Number.isInteger(first) || first < selection.start || first >= selection.end) return null;
  return { ...selection, beat: first, custom };
}
export function matchingLoopSlot(slots: (LoopPreset | null)[], current: Omit<LoopPreset, 'used'> | null): number | null {
  if (!current) return null;
  let match: number | null = null;
  slots.forEach((slot, index) => {
    if (slot && slot.start === current.start && slot.end === current.end && slot.beat === current.beat && slot.custom === current.custom && (match === null || slot.used > slots[match]!.used)) match = index;
  });
  return match;
}
// key reflects Num Lock: a disabled number pad reports navigation keys instead.
export function memoryDigit(event: Pick<KeyboardEvent, 'key' | 'repeat' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>): number | null {
  return !event.repeat && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && /^[0-9]$/.test(event.key) ? Number(event.key) : null;
}
export function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"]');
}
