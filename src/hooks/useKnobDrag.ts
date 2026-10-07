import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';

interface KnobDragOptions {
  value: number;
  min: number;
  max: number;
  sensitivity: number;
  step?: number;
  fineStep?: number;
  preserveFractional?: boolean;
  disabled?: boolean;
  onChange: (value: number) => void;
}

export function useKnobDrag({ value, min, max, sensitivity, step, fineStep, preserveFractional = false, disabled, onChange }: KnobDragOptions) {
  const [dragging, setDragging] = useState(false);
  const [fineAdjusting, setFineAdjusting] = useState(false);
  const fractional = useRef<{ output: number; remainder: number } | null>(null);
  const drag = useRef<{ y: number; raw: number; output: number; fine: boolean; sensitivity: number; preserveFractional: boolean } | null>(null);
  useEffect(() => {
    if (!dragging) return;
    const updateModifier = (event: KeyboardEvent) => {
      if (event.key === 'Shift') {
        const fine = event.type === 'keydown';
        if (drag.current) { drag.current.fine = fine; if (!drag.current.preserveFractional) drag.current.raw = drag.current.output; }
        setFineAdjusting(fine);
      }
    };
    const cancel = () => {
      drag.current = null;
      fractional.current = null;
      setDragging(false);
      setFineAdjusting(false);
    };
    window.addEventListener('keydown', updateModifier, true);
    window.addEventListener('keyup', updateModifier, true);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('keydown', updateModifier, true);
      window.removeEventListener('keyup', updateModifier, true);
      window.removeEventListener('blur', cancel);
    };
  }, [dragging]);
  useEffect(() => {
    if (disabled) { drag.current = null; fractional.current = null; setDragging(false); setFineAdjusting(false); }
  }, [disabled]);
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
      const remainder = preserveFractional && fractional.current?.output === value ? fractional.current.remainder : 0;
      drag.current = { y: event.clientY, raw: Math.max(min, Math.min(max, value + remainder)), output: value, fine: event.shiftKey, sensitivity, preserveFractional };
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
        if (!state.preserveFractional) state.raw = state.output;
      }
      const delta = state.y - event.clientY;
      state.y = event.clientY;
      if (delta === 0) return;
      state.raw = Math.max(min, Math.min(max, state.raw + delta * state.sensitivity * (state.fine ? 0.1 : 1)));
      const increment = state.fine ? fineStep : step;
      const next = Math.max(min, Math.min(max, increment ? min + Math.round((state.raw - min) / increment) * increment : state.raw));
      if (state.preserveFractional) fractional.current = { output: next, remainder: state.raw - next };
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
