import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { advanceSlide, KEYBOARD_SLIDE, SLIDE_DEAD_ZONE, slideVelocity } from '../utils/slideControl';

interface SlideProps {
  visibleDuration: number; start: number; max: number; rate: number;
  disabled: boolean; recording: AudioBuffer | null; onChange: (sample: number) => void;
}
interface Gesture {
  type: 'pointer' | 'keyboard'; pointerId?: number; centre: number; travel: number;
  span: number; rate: number; last: number; displacement: number; fine: boolean;
}
const neutral = { displacement: 0, fine: false, holding: false };

export function SlideControl(props: SlideProps) {
  const element = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  const gesture = useRef<Gesture | null>(null);
  const motion = useRef({ position: props.start, remainder: 0 });
  const frame = useRef<number | null>(null);
  const heldKeys = useRef(new Set<string>());
  const [display, setDisplay] = useState(neutral);

  const stop = useCallback((showNeutral = true) => {
    const pointerId = gesture.current?.pointerId;
    gesture.current = null;
    heldKeys.current.clear();
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (pointerId !== undefined && element.current?.hasPointerCapture(pointerId)) element.current.releasePointerCapture(pointerId);
    if (showNeutral) setDisplay(neutral);
  }, []);
  const advance = useCallback((now: number) => {
    const state = gesture.current;
    if (!state || latest.current.disabled) return;
    const elapsed = Math.max(0, now - state.last) / 1000;
    state.last = Math.max(now, state.last);
    const previous = motion.current.position;
    motion.current = advanceSlide(motion.current, slideVelocity(state.displacement, state.span, state.rate, state.fine), elapsed, latest.current.max);
    if (motion.current.position !== previous) latest.current.onChange(motion.current.position);
  }, []);
  const animate = useCallback(function tick(now: number) {
    frame.current = null;
    if (!gesture.current || latest.current.disabled) return;
    advance(now);
    if (gesture.current) frame.current = requestAnimationFrame(tick);
  }, [advance]);
  const update = useCallback((displacement: number, fine: boolean) => {
    const state = gesture.current;
    if (!state) return;
    // Finish elapsed motion at the old rate before changing direction / Shift.
    advance(performance.now());
    state.displacement = Math.max(-1, Math.min(1, displacement));
    state.fine = fine;
    setDisplay({ displacement: state.displacement, fine, holding: true });
  }, [advance]);
  const begin = (type: Gesture['type'], fine: boolean, pointerId?: number) => {
    const bounds = element.current!.getBoundingClientRect();
    gesture.current = { type, pointerId, centre: bounds.left + bounds.width / 2, travel: Math.max(1, (bounds.width - 14) / 2), span: latest.current.visibleDuration, rate: latest.current.rate, last: performance.now(), displacement: 0, fine };
    if (frame.current === null) frame.current = requestAnimationFrame(animate);
  };
  useLayoutEffect(() => {
    const previous = latest.current;
    // External edits / recalled presets / replacement recordings end the gesture.
    if (props.start !== motion.current.position || props.max !== previous.max || props.rate !== previous.rate || props.recording !== previous.recording) {
      stop(); motion.current = { position: props.start, remainder: 0 };
    }
    latest.current = props;
    if (props.disabled) stop();
  });
  useEffect(() => {
    const modifier = (event: KeyboardEvent) => {
      const state = gesture.current;
      if (!state) return;
      if (event.key === 'Shift') update(state.displacement, event.type === 'keydown');
      if (event.type === 'keyup' && state.type === 'keyboard' && heldKeys.current.has(event.key)) {
        event.preventDefault(); heldKeys.current.delete(event.key);
        if (!heldKeys.current.size) stop();
        else update((Number(heldKeys.current.has('ArrowRight')) - Number(heldKeys.current.has('ArrowLeft'))) * KEYBOARD_SLIDE, event.shiftKey);
      }
    };
    const blur = () => stop();
    window.addEventListener('keydown', modifier, true); window.addEventListener('keyup', modifier, true); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', modifier, true); window.removeEventListener('keyup', modifier, true); window.removeEventListener('blur', blur); stop(false); };
  }, [stop, update]);
  const moving = display.holding && Math.abs(display.displacement) > SLIDE_DEAD_ZONE;
  return <div ref={element} role="slider" tabIndex={props.disabled ? -1 : 0} aria-label="Slide selection"
    aria-orientation="horizontal" aria-disabled={props.disabled} aria-valuemin={-100} aria-valuemax={100} aria-valuenow={Math.round(display.displacement * 100)}
    aria-valuetext={moving ? `${display.displacement < 0 ? 'Left' : 'Right'}, ${Math.round(Math.abs(display.displacement) * 100)} percent${display.fine ? ', fine' : ''}` : 'Centre, stopped'}
    title="Pull left/right: farther is faster; hold to slide. Centre stops; release springs back. Shift is ten times finer. Hold Left/Right keys to move; release to stop. Speed follows the visible waveform span."
    className="slide-control" data-holding={display.holding} data-moving={moving} data-fine={moving && display.fine}
    onPointerDown={event => {
      if (props.disabled || event.button !== 0 || gesture.current) return;
      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
      begin('pointer', event.shiftKey, event.pointerId);
      const state = gesture.current!; update((event.clientX - state.centre) / state.travel, event.shiftKey);
    }}
    onPointerMove={event => { const state = gesture.current; if (state?.type === 'pointer' && state.pointerId === event.pointerId) update((event.clientX - state.centre) / state.travel, event.shiftKey); }}
    onPointerUp={event => { if (gesture.current?.pointerId === event.pointerId) stop(); }}
    onPointerCancel={event => { if (gesture.current?.pointerId === event.pointerId) stop(); }}
    onLostPointerCapture={event => { if (gesture.current?.pointerId === event.pointerId) stop(); }}
    onBlur={() => { if (gesture.current?.type === 'keyboard') stop(); }}
    onKeyDown={event => {
      if (props.disabled || !['ArrowLeft', 'ArrowRight'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      if (gesture.current?.type === 'pointer') return;
      if (!gesture.current) begin('keyboard', event.shiftKey);
      if (heldKeys.current.has(event.key)) return;
      heldKeys.current.add(event.key);
      update((Number(heldKeys.current.has('ArrowRight')) - Number(heldKeys.current.has('ArrowLeft'))) * KEYBOARD_SLIDE, event.shiftKey);
    }}>
    <span className="slide-centre" aria-hidden="true" />
    <span className="slide-thumb-rail" aria-hidden="true"><span className="slide-thumb" style={{ left: `${(display.displacement + 1) * 50}%` }} /></span>
  </div>;
}
