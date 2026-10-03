import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';

interface KnobDragOptions {
  value: number;
  min: number;
  max: number;
  sensitivity: number;
  step?: number;
  fineStep?: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}

export function useKnobDrag({ value, min, max, sensitivity, step, fineStep, disabled, onChange }: KnobDragOptions) {
  const [dragging, setDragging] = useState(false);
  const [fineAdjusting, setFineAdjusting] = useState(false);
  const drag = useRef<{ y: number; raw: number; output: number; fine: boolean } | null>(null);
  useEffect(() => {
    if (!dragging) return;
    const updateModifier = (event: KeyboardEvent) => {
      if (event.key === 'Shift') setFineAdjusting(event.type === 'keydown');
    };
    const cancel = () => {
      drag.current = null;
      setDragging(false);
      setFineAdjusting(false);
    };
    window.addEventListener('keydown', updateModifier);
    window.addEventListener('keyup', updateModifier);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('keydown', updateModifier);
      window.removeEventListener('keyup', updateModifier);
      window.removeEventListener('blur', cancel);
    };
  }, [dragging]);
  const finish = (event: PointerEvent<HTMLElement>) => {
    drag.current = null;
    setDragging(false);
    setFineAdjusting(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return {
    dragging,
    fineAdjusting,
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (disabled || event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { y: event.clientY, raw: value, output: value, fine: event.shiftKey };
      setDragging(true);
      setFineAdjusting(event.shiftKey);
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const state = drag.current;
      if (!state || disabled) return;
      setFineAdjusting(event.shiftKey);
      if (state.fine !== event.shiftKey) {
        // Rebase at the last emitted value; toggling Shift alone never changes it.
        state.fine = event.shiftKey;
        state.raw = state.output;
        state.y = event.clientY;
        return;
      }
      const delta = state.y - event.clientY;
      state.y = event.clientY;
      if (delta === 0) return;
      state.raw = Math.max(min, Math.min(max, state.raw + delta * sensitivity * (state.fine ? 0.1 : 1)));
      const increment = state.fine ? fineStep : step;
      const next = Math.max(min, Math.min(max, increment ? min + Math.round((state.raw - min) / increment) * increment : state.raw));
      if (next !== state.output) {
        state.output = next;
        onChange(next);
      }
    },
    onPointerUp: finish,
    onPointerCancel: finish,
    onLostPointerCapture: () => { drag.current = null; setDragging(false); setFineAdjusting(false); },
  };
}
