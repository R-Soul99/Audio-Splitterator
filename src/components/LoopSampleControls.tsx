import React, { useEffect, useRef, useState } from 'react';
import { SlideControl } from './SlideControl';
import { SampleSaveControls } from './SampleSaveControls';
import { SelectionEdit } from '../utils/startBeat';
import { LoopPreset, MemoryAction, loopSnapshot, matchingLoopSlot, memoryDigit, isTextEntry } from '../utils/loopMemory';
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
    if (draft === null || !edited.current || draft === value?.toFixed(3)) { setDraft(null); setInvalid(false); return; }
    const seconds = parseLoopTime(draft);
    if (seconds === null || !commit(seconds)) { setInvalid(true); return; }
    edited.current = false; setInvalid(false); setDraft(null);
  };
  return <div className="loop-readout"><span>{label}</span><div className="loop-readout-frame">
    {arrows(-1)}
    <input aria-label={`Loop ${label}`} aria-invalid={invalid} title={`Seconds or minutes:seconds. Enter/blur commits edits; Escape cancels. Exact position: ${value ?? '--'} seconds.`} disabled={disabled} value={draft ?? (value === null ? '--' : value.toFixed(3))}
      onFocus={() => { edited.current = false; setDraft(value?.toFixed(3) ?? ''); setInvalid(false); }} onChange={e => { edited.current = true; setDraft(e.target.value); }} onBlur={save}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); save(); } if (e.key === 'Escape') { e.preventDefault(); cancelBlur.current = true; edited.current = false; setDraft(null); setInvalid(false); e.currentTarget.blur(); } }} />
    <span className="loop-time-unit" aria-hidden="true">s</span>{arrows(1)}
  </div></div>;
}
export function SelectionLoopSwitch({ audioBuffer, selection, isLooping, onLoopChange }: { audioBuffer: AudioBuffer | null; selection: TimeSelection | null; isLooping: boolean; onLoopChange?: (enabled: boolean) => void }) {
  const valid = audioBuffer && sampleSelection(selection, audioBuffer.sampleRate, audioBuffer.length);
  return <button type="button" onKeyDown={e => e.stopPropagation()} role="switch" aria-label="Selection loop" title="Enable selection looping without starting stopped playback." aria-checked={isLooping} disabled={!valid} onClick={() => onLoopChange?.(!isLooping)} className="loop-switch"><span className={isLooping ? 'loop-led lit' : 'loop-led'} />Loop {isLooping ? 'On' : 'Off'}</button>;
}
export function LoopSampleControls({ visibleDuration, waveformWidth, active, onControlsActiveChange, audioBuffer, selection, startBeat, customStartBeat, loopMemory, onMemoryAction, placingStartBeat, onPlacementChange, onStartBeatChange, onSelectionChange }: {
  visibleDuration: number; waveformWidth: number;
  onControlsActiveChange?: (active: boolean) => void;
  active: boolean; audioBuffer: AudioBuffer | null; selection: TimeSelection | null;
  startBeat: number | null; customStartBeat: boolean; loopMemory: (LoopPreset | null)[];
  onMemoryAction: (index: number, action: MemoryAction) => void; placingStartBeat: boolean;
  onPlacementChange?: (active: boolean) => void; onStartBeatChange?: (sample: number | null) => void;
  onSelectionChange?: (selection: TimeSelection | null, edit?: SelectionEdit) => void;
}) {
  const [section, setSection] = useState<'controls' | 'save'>('controls');
  useEffect(() => { const visible = active && section === 'controls'; onControlsActiveChange?.(visible); if (!visible) onPlacementChange?.(false); }, [active, section, onPlacementChange, onControlsActiveChange]);
  useEffect(() => () => onPlacementChange?.(false), [onPlacementChange]);
  const [fine, setFine] = useState(false);
  const [pressed, setPressed] = useState<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setFine(false); setPressed(null); }, [active, section]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { setFine(e.shiftKey); if (e.type === 'keyup') setPressed(null); };
    const clear = () => { setFine(false); setPressed(null); };
    window.addEventListener('keydown', key, true); window.addEventListener('keyup', key, true); window.addEventListener('blur', clear); window.addEventListener('pointerup', clear, true); window.addEventListener('pointercancel', clear, true);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('keyup', key, true); window.removeEventListener('blur', clear); window.removeEventListener('pointerup', clear, true); window.removeEventListener('pointercancel', clear, true); };
  }, []);
  const [status, setStatus] = useState('');
  useEffect(() => { if (!status) return; const timer = setTimeout(() => setStatus(''), 5000); return () => clearTimeout(timer); }, [status]);
  const rate = audioBuffer?.sampleRate ?? 1, frames = audioBuffer?.length ?? 0;
  const samples = sampleSelection(selection, rate, frames);
  const snapshot = loopSnapshot(samples, startBeat, customStartBeat, frames);
  const matching = matchingLoopSlot(loopMemory, snapshot);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const digit = memoryDigit(event);
      // Portaled controls can still be mounted while their workspace is hidden.
      if (digit === null || !active || section !== 'controls' || !panelRef.current?.getClientRects().length || panelRef.current.closest('[inert]') || isTextEntry(event.target)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (loopMemory[digit] || snapshot) { setPressed(digit); onMemoryAction(digit, 'activate'); }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [active, section, loopMemory, snapshot?.start, snapshot?.end, snapshot?.beat, snapshot?.custom, onMemoryAction]);
  const apply = (next: SampleSelection | null, edit: SelectionEdit = 'edge') => { if (!next) return false; onSelectionChange?.(sampleTimes(next, rate), edit); return true; };
  const action = (label: string, next: SampleSelection | null, text: string, edit: SelectionEdit = 'edge') => <button type="button" className="loop-adjust-button" aria-label={label} title={edit === 'move' ? `${label}: move exactly one selection length, preserving 1st Beat's relative position.` : `${label}: keep Start fixed; adjust End by the exact requested length.`} disabled={!next} onClick={() => apply(next, edit)}>{text}</button>;
  const adjust = (target: 'start' | 'end' | 'beat', direction: number) => {
    const next = (fine: boolean) => {
      if (!samples) return null;
      const delta = direction * adjustmentSamples(rate, fine);
      return target === 'beat' ? adjustBeatSample(startBeat ?? samples.start, samples, delta) : editSamples(samples, target, delta, frames);
    };
    const label = `${direction < 0 ? 'Decrease' : 'Increase'} ${target === 'beat' ? '1st Beat' : target === 'start' ? 'Start' : 'End'}`;
    return <button type="button" className="loop-adjust-button" data-fine={fine && active && section === 'controls'} aria-label={label} title={`${label}: click for 10 ms; Shift-click for 1 ms (nearest audio sample).`} disabled={next(fine) === null} onClick={e => {
      const value = next(e.shiftKey);
      if (typeof value === 'number') { onStartBeatChange?.(value); onPlacementChange?.(true); }
      else if (value) apply(value);
    }}>{direction < 0 ? '\u25c0' : '\u25b6'}</button>;
  };
  const timeCommit = (target: 'start' | 'end', seconds: number) => !!samples && seconds >= 0 && seconds <= frames / rate && apply(editSamples(samples, target, Math.round(seconds * rate) - samples[target], frames));
  return <div ref={panelRef} className="loop-sample-controls" aria-label="Loop / Sample controls" onKeyDown={e => e.stopPropagation()} onPointerUpCapture={() => setFine(false)} onPointerCancelCapture={() => setFine(false)}>
    <div hidden={section !== 'controls'} className="loop-controls-rows">
      <div className="loop-control-groups">
        <section className="loop-section loop-boundaries" aria-label="Boundaries"><h3>Boundaries</h3>
          <TimeReadout label="Start" disabled={!samples} value={samples ? samples.start / rate : null} commit={seconds => timeCommit('start', seconds)} arrows={direction => adjust('start', direction)} />
          <TimeReadout label="End" disabled={!samples} value={samples ? samples.end / rate : null} commit={seconds => timeCommit('end', seconds)} arrows={direction => adjust('end', direction)} />
          <div className="loop-readout loop-length"><span>Length</span><div className="loop-readout-frame">
            {action('Halve selection', samples && resizeSamples(samples, 0.5, 'start', frames), '\u00bd')}
            <output aria-label="Loop length" title="Selection length in seconds">{samples ? ((samples.end - samples.start) / rate).toFixed(3) : '--'}</output><span className="loop-time-unit" aria-hidden="true">s</span>
            {action('Double selection', samples && resizeSamples(samples, 2, 'start', frames), '\u00d72')}
          </div></div>
        </section>
        <section className="loop-section loop-movement" aria-label="Move Loop"><h3>Move Loop</h3>
          <div className="loop-move-group"><span>Jump</span>
            {action('Previous selection', samples && editSamples(samples, 'whole', -(samples.end - samples.start), frames), '\u25c0', 'move')}
            {action('Next selection', samples && editSamples(samples, 'whole', samples.end - samples.start, frames), '\u25b6', 'move')}
          </div>
          <div className="loop-move-group loop-slide-group"><span>Slide</span><SlideControl recording={audioBuffer} visibleDuration={visibleDuration} start={samples?.start ?? 0} max={samples ? frames - (samples.end - samples.start) : 0} rate={rate} disabled={!samples || !active || section !== 'controls'} onChange={start => { if (samples) apply({ start, end: start + samples.end - samples.start }, 'move'); }} /></div>
        </section>
        <section className="loop-section loop-beat" aria-label="1st Beat"><h3>1st Beat</h3>
          <TimeReadout label="1st Beat" disabled={!samples} value={samples && startBeat !== null ? startBeat / rate : null} arrows={direction => adjust('beat', direction)} commit={seconds => {
            if (!samples) return false;
            const sample = Math.round(seconds * rate);
            if (seconds < samples.start / rate || seconds >= samples.end / rate || sample < samples.start || sample >= samples.end) return false;
            if (sample !== startBeat) { onStartBeatChange?.(sample); onPlacementChange?.(true); } return true;
          }} />
          <div className="loop-tools-row">
            <button type="button" aria-label="Set 1st Beat" title="Toggle 1st Beat placement. Click inside the loop repeatedly; Set or Escape exits." aria-pressed={placingStartBeat} disabled={!samples} onClick={() => onPlacementChange?.(!placingStartBeat)}>Set</button>
            <button type="button" aria-label="Clear 1st Beat" title="Remove the custom 1st Beat marker and use the selection's left boundary." disabled={!samples} onClick={() => { onPlacementChange?.(false); onStartBeatChange?.(null); }}>Clear</button>
          </div>
          <span className="beat-placement-hint loop-control-status" role="status" title={status} data-placement={placingStartBeat}>{placingStartBeat ? 'Click inside the loop' : status}</span>
        </section>
        <section className="loop-section loop-memory" aria-label="Memory"><h3>Memory</h3><div className="loop-memory-keypad">
          {[7, 8, 9, 4, 5, 6, 1, 2, 3, 0].map(index => {
            const slot = loopMemory[index];
            const times = slot ? `Start ${(slot.start / rate).toFixed(3)} s; End ${(slot.end / rate).toFixed(3)} s; 1st Beat ${(slot.beat / rate).toFixed(3)} s (${slot.custom ? 'custom' : 'default'}). ` : '';
            return <button key={index} type="button" className="loop-memory-slot" aria-label={`Loop memory ${index}`} aria-pressed={matching === index} data-filled={!!slot} data-pressed={pressed === index} data-replace={fine && !!slot && !!snapshot} disabled={!slot && !snapshot}
              title={times + (slot ? 'Click / number: recall. Shift-click: replace. Right-click / focused Delete: clear.' : 'Click / number: store current loop.') + (index === 0 ? ' 0 is the tenth slot.' : '')}
              onPointerDown={e => { if (e.button === 0) { setPressed(index); setFine(e.shiftKey); } }}
              onClick={e => onMemoryAction(index, e.shiftKey ? 'replace' : 'activate')}
              onContextMenu={e => { e.preventDefault(); if (slot) onMemoryAction(index, 'clear'); }}
              onKeyDown={e => { if (e.key === 'Delete' && !isTextEntry(e.target)) { e.preventDefault(); if (slot) onMemoryAction(index, 'clear'); } }}
            >{index}</button>;
          })}
        </div></section>
        <button type="button" className="loop-save-action" aria-label="Show sample save" onClick={() => setSection('save')}>Save</button>
      </div>
    </div>
    <div hidden={section !== 'save'}><SampleSaveControls audioBuffer={audioBuffer} selection={samples} startBeat={startBeat} onControls={() => setSection('controls')} onSaved={path => { setStatus(`Saved: ${path}`); setSection('controls'); }} /></div>
  </div>;
}
