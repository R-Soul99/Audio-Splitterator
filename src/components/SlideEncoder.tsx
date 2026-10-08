import React from 'react';
import { slideSamplesPerPixel } from '../utils/waveformDisplay';
import { useKnobDrag } from '../hooks/useKnobDrag';

// An incremental encoder: its only limits are the actual recording boundaries.
// Each new drag continues from the selection, with no spring-return or reset.
export function SlideEncoder({ visibleDuration, waveformWidth, start, max, rate, disabled, onChange }: {
  visibleDuration: number; waveformWidth: number;
  start: number; max: number; rate: number; disabled: boolean; onChange: (sample: number) => void;
}) {
  const { dragging, fineAdjusting, ...handlers } = useKnobDrag({
    value: start, min: 0, max, sensitivity: slideSamplesPerPixel(visibleDuration, waveformWidth, rate), step: 1, fineStep: 1, preserveFractional: true, disabled, onChange,
  });
  return <div role="slider" tabIndex={disabled ? -1 : 0} aria-label="Slide encoder"
    aria-disabled={disabled} aria-valuemin={0} aria-valuemax={max} aria-valuenow={start}
    aria-valuetext={`${(start / rate).toFixed(3)} seconds`}
    title="Slide selection: drag up/down to move by visible waveform pixels; Shift is ten times finer. Sensitivity stays fixed for each drag. Preserve length and relative 1st Beat; stop at recording boundaries."
    {...handlers} data-dragging={dragging} data-fine={fineAdjusting}
    onKeyDown={event => {
      if (disabled || !['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'].includes(event.key)) return;
      event.preventDefault();
      const delta = Math.max(1, Math.round(rate * (event.shiftKey ? .001 : .01)));
      onChange(Math.max(0, Math.min(max, start + (['ArrowUp', 'ArrowRight'].includes(event.key) ? delta : -delta))));
    }}
    className="slide-encoder relative rounded-full bg-slate-800/90 border touch-none select-none cursor-ns-resize">
    <div className="absolute left-1/2 bottom-1/2 w-0.5 rounded-full bg-sky-400"
      style={{ height: 7, transform: `translateX(-50%) rotate(${start / rate * 90}deg)`, transformOrigin: 'bottom center' }} />
    <div className="absolute inset-0 rounded-full pointer-events-none shadow-[inset_0_1px_2px_rgba(0,0,0,0.6)]" />
  </div>;
}
