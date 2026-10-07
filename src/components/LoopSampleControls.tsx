import React, { useEffect, useRef, useState } from 'react';
import { SampleSaveControls } from './SampleSaveControls';
import { SelectionEdit } from '../utils/startBeat';
import { TimeSelection } from '../types';
import { editSamples, resizeSamples, sampleSelection, sampleTimes, parseLoopTime, adjustmentSamples, adjustBeatSample, SampleSelection } from '../utils/loopSelection';

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
  const [fine, setFine] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => setFine(e.shiftKey);
    const clear = () => setFine(false);
    window.addEventListener('keydown', key, true); window.addEventListener('keyup', key, true); window.addEventListener('blur', clear);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('keyup', key, true); window.removeEventListener('blur', clear); };
  }, []);
  const [status, setStatus] = useState('');
  useEffect(() => { if (!status) return; const timer = setTimeout(() => setStatus(''), 5000); return () => clearTimeout(timer); }, [status]);
  const rate = audioBuffer?.sampleRate ?? 1, frames = audioBuffer?.length ?? 0;
  const samples = sampleSelection(selection, rate, frames);
  const apply = (next: SampleSelection | null, edit: SelectionEdit = 'edge') => { if (!next) return false; onSelectionChange?.(sampleTimes(next, rate), edit); return true; };
  const action = (label: string, next: SampleSelection | null, text: string, edit: SelectionEdit = 'edge') => <button type="button" aria-label={label} title={edit === 'move' ? `${label}: move exactly one selection length, preserving Start Beat's relative position.` : `${label}: keep Start fixed; adjust End by the exact requested length.`} disabled={!next} onClick={() => apply(next, edit)}>{text}</button>;
  const adjust = (target: 'start' | 'end' | 'beat', direction: number) => {
    const next = (fine: boolean) => {
      if (!samples) return null;
      const delta = direction * adjustmentSamples(rate, fine);
      if (target !== 'beat') return editSamples(samples, target, delta, frames);
      return adjustBeatSample(startBeat ?? samples.start, samples, delta);
    };
    const label = `${direction < 0 ? 'Decrease' : 'Increase'} ${target === 'beat' ? 'Start Beat' : target === 'start' ? 'Start' : 'End'}`;
    return <button type="button" aria-label={label} title={`${label}: click for 10 ms; Shift-click for 1 ms (nearest audio sample).`} disabled={next(fine) === null} onClick={e => {
      const value = next(e.shiftKey);
      if (typeof value === 'number') onStartBeatChange?.(value);
      else if (value) apply(value);
    }}>{direction < 0 ? '\u2212' : '+'}</button>;
  };
  return <div className="loop-sample-controls" aria-label="Loop / Sample controls" onKeyDown={e => e.stopPropagation()}>
    <div hidden={section !== 'controls'}>
    <div className="loop-time-row">
      <TimeReadout label="Start" disabled={!samples} value={samples ? samples.start / rate : null} commit={seconds => !!samples && seconds >= 0 && seconds <= frames / rate && apply(editSamples(samples, 'start', Math.round(seconds * rate) - samples.start, frames))} />
      {adjust('start', -1)}{adjust('start', 1)}
      <TimeReadout label="End" disabled={!samples} value={samples ? samples.end / rate : null} commit={seconds => !!samples && seconds >= 0 && seconds <= frames / rate && apply(editSamples(samples, 'end', Math.round(seconds * rate) - samples.end, frames))} />
      {adjust('end', -1)}{adjust('end', 1)}
    </div>
    <div className="loop-adjust-row">
      <button type="button" role="switch" aria-label="Selection loop" aria-checked={isLooping} disabled={!samples} onClick={() => onLoopChange?.(!isLooping)} className="loop-switch"><span className={isLooping ? 'loop-led lit' : 'loop-led'} />Loop {isLooping ? 'On' : 'Off'}</button>
      <label className="loop-length">Length <output aria-label="Loop length">{samples ? ((samples.end - samples.start) / rate * 1000).toFixed(3) : '--'} ms</output></label>
      {action('Halve selection', samples && resizeSamples(samples, 0.5, 'start', frames), '\u00bd')}
      {action('Double selection', samples && resizeSamples(samples, 2, 'start', frames), '\u00d72')}
      <span>Jump</span>
      {action('Previous selection', samples && editSamples(samples, 'whole', -(samples.end - samples.start), frames), '<<', 'move')}
      {action('Next selection', samples && editSamples(samples, 'whole', samples.end - samples.start, frames), '>>', 'move')}
      <span className="loop-control-status" role="status" title={status}>{status}</span>
    </div>
    <div className="start-beat-row">
      <button type="button" aria-label="Set Start Beat" aria-pressed={placingStartBeat} disabled={!samples} onClick={() => onPlacementChange?.(!placingStartBeat)}>Set Start Beat</button>
      <button type="button" aria-label="Reset Start Beat" disabled={!samples} onClick={() => onStartBeatChange?.(samples?.start ?? null)}>Reset</button>
      <span className="start-beat-readout">{!samples ? 'Select a waveform region.' : <>{placingStartBeat ? 'Click inside the loop' : 'Start Beat'} <output aria-label="Start Beat time">{startBeat === null ? '--' : (startBeat / rate).toFixed(6)}</output></>}</span>
      {adjust('beat', -1)}{adjust('beat', 1)}
      <button type="button" aria-label="Show sample save" onClick={() => setSection('save')}>Save</button>
    </div>
    </div>
    <div hidden={section !== 'save'}><SampleSaveControls audioBuffer={audioBuffer} selection={samples} startBeat={startBeat} onControls={() => setSection('controls')} onSaved={path => { setStatus(`Saved: ${path}`); setSection('controls'); }} /></div>
  </div>;
}
