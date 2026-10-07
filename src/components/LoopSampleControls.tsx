import React, { useRef, useState } from 'react';
import { SampleSaveControls } from './SampleSaveControls';
import { SelectionEdit } from '../utils/startBeat';
import { TimeSelection } from '../types';
import { editSamples, resizeSamples, sampleSelection, sampleTimes, parseLoopTime, LoopAnchor, LoopTarget, SampleSelection } from '../utils/loopSelection';

function TimeReadout({ label, value, disabled, commit }: { label: string; value: number | null; disabled: boolean; commit: (seconds: number) => boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const cancelBlur = useRef(false);
  const save = () => {
    if (cancelBlur.current) { cancelBlur.current = false; return; }
    if (draft === null) return;
    const seconds = parseLoopTime(draft);
    if (seconds === null || !commit(seconds)) { setInvalid(true); return; }
    setInvalid(false); setDraft(null);
  };
  return <label className="loop-readout">{label}<input aria-label={`Loop ${label}`} aria-invalid={invalid} title="Seconds or minutes:seconds. Enter/blur commits; Escape cancels." disabled={disabled} value={draft ?? (value === null ? '--' : value.toFixed(6))}
    onFocus={() => { setDraft(value?.toFixed(6) ?? ''); setInvalid(false); }} onChange={e => setDraft(e.target.value)} onBlur={save}
    onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); save(); } if (e.key === 'Escape') { cancelBlur.current = true; setDraft(null); setInvalid(false); e.currentTarget.blur(); } }} /></label>;
}
export function LoopSampleControls({ audioBuffer, selection, isLooping, onSelectionChange, onLoopChange, startBeat, placingStartBeat, onPlacementChange, onStartBeatChange }: {
  audioBuffer: AudioBuffer | null; selection: TimeSelection | null; isLooping: boolean;
  startBeat: number | null; placingStartBeat: boolean;
  onPlacementChange?: (active: boolean) => void; onStartBeatChange?: (sample: number | null) => void;
  onSelectionChange?: (selection: TimeSelection | null, edit?: SelectionEdit) => void; onLoopChange?: (enabled: boolean) => void;
}) {
  const [section, setSection] = useState<'controls' | 'save'>('controls');
  const [anchor, setAnchor] = useState<LoopAnchor>('start');
  const [target, setTarget] = useState<LoopTarget>('whole');
  const [amount, setAmount] = useState(10);
  const drag = useRef<{ y: number; remainder: number } | null>(null);
  const rate = audioBuffer?.sampleRate ?? 1, frames = audioBuffer?.length ?? 0;
  const samples = sampleSelection(selection, rate, frames);
  const latest = useRef(samples); latest.current = samples;
  const apply = (next: SampleSelection | null, edit: SelectionEdit = 'edge') => { if (!next) return false; latest.current = next; onSelectionChange?.(sampleTimes(next, rate), edit); return true; };
  const step = Math.max(1, Math.round(rate * amount / 1000));
  const nudge = (direction: number) => latest.current && apply(editSamples(latest.current, target, direction * step, frames), target === 'whole' ? 'move' : 'edge');
  const action = (label: string, next: SampleSelection | null, text = label) => <button type="button" aria-label={label} title={label === 'Halve selection' ? 'Halve selection (requires an even number of samples)' : label} disabled={!next} onClick={() => apply(next, label === 'Previous selection' || label === 'Next selection' || (label.startsWith('Nudge') && target === 'whole') ? 'move' : 'edge')}>{text}</button>;
  return <div className="loop-sample-controls" aria-label="Loop / Sample controls" onKeyDown={e => e.stopPropagation()}>
    <div hidden={section !== 'controls'}>
    <div className="loop-time-row">
      <button type="button" role="switch" aria-label="Selection loop" aria-checked={isLooping} disabled={!samples} onClick={() => onLoopChange?.(!isLooping)} className="loop-switch"><span className={isLooping ? 'loop-led lit' : 'loop-led'} />Loop {isLooping ? 'On' : 'Off'}</button>
      <TimeReadout label="Start" disabled={!samples} value={samples ? samples.start / rate : null} commit={seconds => !!samples && seconds >= 0 && seconds <= frames / rate && apply(editSamples(samples, 'start', Math.round(seconds * rate) - samples.start, frames))} />
      <TimeReadout label="End" disabled={!samples} value={samples ? samples.end / rate : null} commit={seconds => !!samples && seconds >= 0 && seconds <= frames / rate && apply(editSamples(samples, 'end', Math.round(seconds * rate) - samples.end, frames))} />
      <label className="loop-readout">Length<output aria-label="Loop length">{samples ? ((samples.end - samples.start) / rate * 1000).toFixed(3) : '--'} ms</output></label>
    </div>
    <div className="loop-adjust-row">
      {action('Halve selection', samples && resizeSamples(samples, 0.5, anchor, frames), '\u00bd')}
      {action('Double selection', samples && resizeSamples(samples, 2, anchor, frames), '\u00d72')}
      <select aria-label="Fixed selection edge" disabled={!samples} value={anchor} onChange={e => setAnchor(e.target.value as LoopAnchor)}><option value="start">Keep Start</option><option value="end">Keep End</option></select>
      {action('Previous selection', samples && editSamples(samples, 'whole', -(samples.end - samples.start), frames), 'Prev')}
      {action('Next selection', samples && editSamples(samples, 'whole', samples.end - samples.start, frames), 'Next')}
      <select aria-label="Nudge target" disabled={!samples} value={target} onChange={e => setTarget(e.target.value as LoopTarget)}><option value="whole">Whole</option><option value="start">Start</option><option value="end">End</option></select>
      {action('Nudge left', samples && editSamples(samples, target, -step, frames), '\u2039')}
      <div role="slider" aria-label="Nudge" aria-valuemin={-1} aria-valuemax={1} aria-valuenow={0} aria-valuetext={`Bidirectional, ${amount} ms per step`} aria-disabled={!samples} tabIndex={samples ? 0 : -1} className="loop-nudge-knob" title={`Nudge ${target}: drag up/down; ${amount} ms per step`}
        onKeyDown={e => { if (['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp'].includes(e.key)) { e.preventDefault(); nudge(['ArrowLeft', 'ArrowDown'].includes(e.key) ? -1 : 1); } }}
        onPointerDown={e => { if (!samples) return; e.currentTarget.setPointerCapture(e.pointerId); drag.current = { y: e.clientY, remainder: 0 }; }}
        onPointerMove={e => { if (!drag.current) return; const d = drag.current; d.remainder += d.y - e.clientY; d.y = e.clientY; const steps = Math.trunc(d.remainder / 8); d.remainder -= steps * 8; for (let i = 0; i < Math.abs(steps); i++) nudge(Math.sign(steps)); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}><span /></div>
      {action('Nudge right', samples && editSamples(samples, target, step, frames), '\u203a')}
      <select aria-label="Nudge amount" disabled={!samples} value={amount} onChange={e => setAmount(Number(e.target.value))}>{[1, 10, 100].map(ms => <option key={ms} value={ms}>{ms} ms</option>)}</select>
    </div>
    <div className="start-beat-row">
      <button type="button" aria-label="Set Start Beat" aria-pressed={placingStartBeat} disabled={!samples} onClick={() => onPlacementChange?.(!placingStartBeat)}>Set Start Beat</button>
      <button type="button" aria-label="Reset Start Beat" disabled={!samples} onClick={() => onStartBeatChange?.(samples?.start ?? null)}>Reset</button>
      <span className="start-beat-readout">{!samples ? 'Select a waveform region.' : <>{placingStartBeat ? 'Click inside the loop' : 'Start Beat'} <output aria-label="Start Beat time">{startBeat === null ? '--' : (startBeat / rate).toFixed(6)}</output></>}</span>
      <button type="button" aria-label="Show sample save" onClick={() => setSection('save')}>Save</button>
    </div>
    </div>
    <div hidden={section !== 'save'}><SampleSaveControls audioBuffer={audioBuffer} selection={samples} startBeat={startBeat} onControls={() => setSection('controls')} /></div>
  </div>;
}
