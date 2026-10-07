import React, { useEffect, useRef, useState } from 'react';
import { SampleSaveControls } from './SampleSaveControls';
import { SelectionEdit } from '../utils/startBeat';
import { TimeSelection } from '../types';
import { editSamples, resizeSamples, sampleSelection, sampleTimes, parseLoopTime, adjustmentSamples, adjustBeatSample, SampleSelection } from '../utils/loopSelection';

function TimeReadout({ label, value, disabled, commit, arrows }: { label: string; value: number | null; disabled: boolean; commit: (seconds: number) => boolean; arrows: (direction: number) => React.ReactNode }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const edited = useRef(false), cancelBlur = useRef(false);
  const save = () => {
    if (cancelBlur.current) { cancelBlur.current = false; return; }
    // A rounded display is presentation only. Focus, Enter or blur without edits
    // must never write it back over a full-precision sample boundary.
    if (draft === null || !edited.current) { setDraft(null); setInvalid(false); return; }
    const seconds = parseLoopTime(draft);
    if (seconds === null || !commit(seconds)) { setInvalid(true); return; }
    edited.current = false; setInvalid(false); setDraft(null);
  };
  return <div className="loop-readout"><span>{label}</span><div className="loop-readout-frame">
    {arrows(-1)}
    <input aria-label={`Loop ${label}`} aria-invalid={invalid} title={`Seconds or minutes:seconds. Enter/blur commits edits; Escape cancels. Exact position: ${value ?? '--'} seconds.`} disabled={disabled} value={draft ?? (value === null ? '--' : value.toFixed(3))}
      onFocus={() => { edited.current = false; setDraft(value?.toFixed(3) ?? ''); setInvalid(false); }} onChange={e => { edited.current = true; setDraft(e.target.value); }} onBlur={save}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); save(); } if (e.key === 'Escape') { e.preventDefault(); cancelBlur.current = true; edited.current = false; setDraft(null); setInvalid(false); e.currentTarget.blur(); } }} />
    {arrows(1)}
  </div></div>;
}
export function SelectionLoopSwitch({ audioBuffer, selection, isLooping, onLoopChange }: { audioBuffer: AudioBuffer | null; selection: TimeSelection | null; isLooping: boolean; onLoopChange?: (enabled: boolean) => void }) {
  const valid = audioBuffer && sampleSelection(selection, audioBuffer.sampleRate, audioBuffer.length);
  return <button type="button" onKeyDown={e => e.stopPropagation()} role="switch" aria-label="Selection loop" title="Enable selection looping without starting stopped playback." aria-checked={isLooping} disabled={!valid} onClick={() => onLoopChange?.(!isLooping)} className="loop-switch"><span className={isLooping ? 'loop-led lit' : 'loop-led'} />Loop {isLooping ? 'On' : 'Off'}</button>;
}
export function LoopSampleControls({ active, audioBuffer, selection, startBeat, placingStartBeat, onPlacementChange, onStartBeatChange, onSelectionChange }: {
  active: boolean; audioBuffer: AudioBuffer | null; selection: TimeSelection | null;
  startBeat: number | null; placingStartBeat: boolean;
  onPlacementChange?: (active: boolean) => void; onStartBeatChange?: (sample: number | null) => void;
  onSelectionChange?: (selection: TimeSelection | null, edit?: SelectionEdit) => void;
}) {
  const [section, setSection] = useState<'controls' | 'save'>('controls');
  const [fine, setFine] = useState(false);
  useEffect(() => setFine(false), [active, section]);
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
  const action = (label: string, next: SampleSelection | null, text: string, edit: SelectionEdit = 'edge') => <button type="button" className="loop-adjust-button" aria-label={label} title={edit === 'move' ? `${label}: move exactly one selection length, preserving Start Beat's relative position.` : `${label}: keep Start fixed; adjust End by the exact requested length.`} disabled={!next} onClick={() => apply(next, edit)}>{text}</button>;
  const adjust = (target: 'start' | 'end' | 'beat' | 'whole', direction: number) => {
    const next = (fine: boolean) => {
      if (!samples) return null;
      const delta = direction * adjustmentSamples(rate, fine);
      return target === 'beat' ? adjustBeatSample(startBeat ?? samples.start, samples, delta) : editSamples(samples, target, delta, frames);
    };
    const label = target === 'whole' ? `Slide ${direction < 0 ? 'left' : 'right'}` : `${direction < 0 ? 'Decrease' : 'Increase'} ${target === 'beat' ? 'Start Beat' : target === 'start' ? 'Start' : 'End'}`;
    return <button type="button" className="loop-adjust-button" data-fine={fine && active && section === 'controls'} aria-label={label} title={`${label}: click for 10 ms; Shift-click for 1 ms (nearest audio sample).${target === 'whole' ? ' Preserve length and relative Start Beat; never shorten at a boundary.' : ''}`} disabled={next(fine) === null} onClick={e => {
      const value = next(e.shiftKey);
      if (typeof value === 'number') onStartBeatChange?.(value);
      else if (value) apply(value, target === 'whole' ? 'move' : 'edge');
    }}>{direction < 0 ? '\u25c0' : '\u25b6'}</button>;
  };
  const timeCommit = (target: 'start' | 'end', seconds: number) => !!samples && seconds >= 0 && seconds <= frames / rate && apply(editSamples(samples, target, Math.round(seconds * rate) - samples[target], frames));
  return <div className="loop-sample-controls" aria-label="Loop / Sample controls" onKeyDown={e => e.stopPropagation()}>
    <div hidden={section !== 'controls'} className="loop-controls-rows">
      <div className="loop-time-row">
        <TimeReadout label="Start" disabled={!samples} value={samples ? samples.start / rate : null} commit={seconds => timeCommit('start', seconds)} arrows={direction => adjust('start', direction)} />
        <TimeReadout label="End" disabled={!samples} value={samples ? samples.end / rate : null} commit={seconds => timeCommit('end', seconds)} arrows={direction => adjust('end', direction)} />
        <div className="loop-readout loop-length">Length<output aria-label="Loop length" title="Selection length in seconds">{samples ? ((samples.end - samples.start) / rate).toFixed(3) : '--'}</output></div>
        {action('Halve selection', samples && resizeSamples(samples, 0.5, 'start', frames), '\u00bd')}
        {action('Double selection', samples && resizeSamples(samples, 2, 'start', frames), '\u00d72')}
      </div>
      <div className="loop-adjust-row">
        <TimeReadout label="Start Beat" disabled={!samples} value={samples && startBeat !== null ? startBeat / rate : null} arrows={direction => adjust('beat', direction)} commit={seconds => {
          if (!samples) return false;
          const sample = Math.round(seconds * rate);
          if (seconds < samples.start / rate || seconds >= samples.end / rate || sample < samples.start || sample >= samples.end) return false;
          onStartBeatChange?.(sample); return true;
        }} />
        <button type="button" aria-label="Set Start Beat" title="Place Start Beat once inside the selection; Escape cancels." aria-pressed={placingStartBeat} disabled={!samples} onClick={() => onPlacementChange?.(!placingStartBeat)}>Set</button>
        <button type="button" aria-label="Clear Start Beat" title="Remove the custom Start Beat marker and use the selection's left boundary." disabled={!samples} onClick={() => { onPlacementChange?.(false); onStartBeatChange?.(null); }}>Clear</button>
        <div className="loop-move-group"><span>Slide</span>{adjust('whole', -1)}{adjust('whole', 1)}</div>
        <div className="loop-move-group"><span>Jump</span>
          {action('Previous selection', samples && editSamples(samples, 'whole', -(samples.end - samples.start), frames), '\u25c0\u25c0', 'move')}
          {action('Next selection', samples && editSamples(samples, 'whole', samples.end - samples.start, frames), '\u25b6\u25b6', 'move')}
        </div>
        <button type="button" aria-label="Show sample save" onClick={() => setSection('save')}>Save</button>
      </div>
      <span className="loop-control-status" role="status" title={status}>{status || (!samples ? 'Select a waveform region.' : placingStartBeat ? 'Click inside the selection to place Start Beat.' : '')}</span>
    </div>
    <div hidden={section !== 'save'}><SampleSaveControls audioBuffer={audioBuffer} selection={samples} startBeat={startBeat} onControls={() => setSection('controls')} onSaved={path => { setStatus(`Saved: ${path}`); setSection('controls'); }} /></div>
  </div>;
}
