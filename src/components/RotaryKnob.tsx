import React from 'react';
import { useKnobDrag } from '../hooks/useKnobDrag';

// Draggable rotary knob (vertical drag: up increases, down decreases), 270-degree sweep
interface RotaryKnobProps {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  size?: number;
  step?: number;
  fineStep?: number;
  disabled?: boolean;
  showDragValue?: boolean;
  title: string;
  formatValue?: (value: number) => string;
}

export const RotaryKnob: React.FC<RotaryKnobProps> = ({
  value,
  min,
  max,
  onChange,
  size = 26,
  step,
  fineStep,
  disabled = false,
  showDragValue = true,
  title,
  formatValue = (v) => v.toFixed(2),
}) => {
  const { dragging, fineAdjusting, ...dragHandlers } = useKnobDrag({ value, min, max, onChange, sensitivity: (max - min) / 120, step, fineStep, disabled });
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const angle = -135 + pct * 270;

  return (
    <div className="relative flex items-center justify-center">
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        aria-label={title}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={formatValue(value)}
        onKeyDown={(e) => {
          if (disabled) return;
          const increment = e.shiftKey ? (fineStep ?? (step ? step / 10 : (max - min) / 1000)) : (step ?? (max - min) / 100);
          if (['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'Home', 'End'].includes(e.key)) {
            e.preventDefault();
            onChange(e.key === 'Home' ? min : e.key === 'End' ? max : Math.max(min, Math.min(max, value + (e.key === 'ArrowUp' || e.key === 'ArrowRight' ? increment : -increment))));
          }
        }}
        {...dragHandlers}
        style={{ width: size, height: size }}
        className={`relative rounded-full bg-slate-800/90 border touch-none select-none cursor-ns-resize outline-none focus-visible:outline-1 focus-visible:outline-sky-400 ${
          fineAdjusting ? 'border-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.5)]' : dragging ? 'border-sky-500' : pct > 0 ? 'border-sky-600/60 hover:border-slate-600' : 'border-slate-700 hover:border-slate-600'
        }`}
        title={`${title}: ${formatValue(value)} (drag up/down to adjust)`}
      >
        <div
          className="absolute left-1/2 bottom-1/2 w-0.5 rounded-full bg-sky-400"
          style={{
            height: `${size * 0.38}px`,
            transform: `translateX(-50%) rotate(${angle}deg)`,
            transformOrigin: 'bottom center',
          }}
        />
        <div className="absolute inset-0 rounded-full pointer-events-none shadow-[inset_0_1px_2px_rgba(0,0,0,0.6)]" />
      </div>
      {dragging && showDragValue && (
        <div className="absolute -top-6 left-1/2 -translate-x-1/2 px-1.5 py-0.5 bg-slate-950 border border-slate-800 rounded text-[9px] font-mono text-sky-400 whitespace-nowrap z-50 pointer-events-none">
          {formatValue(value)}
        </div>
      )}
    </div>
  );
};

