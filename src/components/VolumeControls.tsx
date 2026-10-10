import React, { useEffect, useMemo, useRef, useState } from 'react';
import { TimeSelection } from '../types';
import { RotaryKnob } from './RotaryKnob';
import { PlaybackPeakMeter, PeakLevels } from '../utils/playbackPeakMeter';
import { VolumeScope, VolumeAction, resolveVolumeRange, sameRange, formatDbfs, linearToDb, isFailure } from '../utils/volumeTools';
import { VolumeAnalysis, analyseVolume, analysisIsCurrent, affectedFrames, processVolume } from '../utils/volumeAnalysis';

interface Props { audioBuffer: AudioBuffer | null; selection: TimeSelection | null; onApply: (buffer: AudioBuffer, description: string) => void; active: boolean; meter: PlaybackPeakMeter }
interface Status { buffer: AudioBuffer | null; key: string; text: string; error?: boolean }
function Parameter({ label, title, value, min, step, disabled, onChange, units = 'dB', onError }: { label: string; title: string; value: number; min: number; step: number; disabled: boolean; onChange: (value: number) => void; units?: string; onError: (text: string) => void }) {
  const [text, setText] = useState(value.toFixed(1));
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setText(value.toFixed(1)); }, [value]);
  const commit = () => {
    if (!editing.current) return;
    editing.current = false;
    const n = Number(text.trim());
    const legal = text.trim() !== '' && Number.isFinite(n) && n >= min && n <= 0 && Math.abs(n / step - Math.round(n / step)) < 1e-7;
    if (legal) { onChange(Number(n.toFixed(1))); setText(n.toFixed(1)); }
    else { setText(value.toFixed(1)); onError(`${label}: enter ${min} to 0 in ${step} dB steps.`); }
  };
  return <div className="volume-parameter">
    <span>{label}</span>
    <RotaryKnob value={value} min={min} max={0} step={step} fineStep={step} size={26} disabled={disabled} showDragValue={false} title={title} formatValue={v => `${v.toFixed(1)} ${units}; Shift: finer drag`} onChange={v => onChange(Number(v.toFixed(1)))} />
    <label className="volume-digital" data-units={units} title={`${title}. Enter/blur commits; Escape cancels`}><input aria-label={`${label} value in ${units}`} value={text} disabled={disabled} inputMode="decimal" onFocus={() => { editing.current = true; }} onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(); e.currentTarget.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); editing.current = false; setText(value.toFixed(1)); e.currentTarget.blur(); }
    }} /><small>{units}</small></label>
  </div>;
}
function Meters({ meter, active, disabled }: { meter: PlaybackPeakMeter; active: boolean; disabled: boolean }) {
  const [levels, setLevels] = useState<PeakLevels>({ live: [0, 0], held: [0, 0] });
  useEffect(() => meter.subscribe(setLevels), [meter]);
  useEffect(() => { meter.setActive(active); return () => meter.setActive(false); }, [meter, active]);
  return <section className="volume-section volume-meters" aria-label="Playback sample peaks">
    <h3>Playback peaks</h3>
    {[0, 1].map(c => {
      const live = linearToDb(levels.live[c]), held = linearToDb(levels.held[c]);
      return <div className="volume-meter-row" key={c} title={`${c ? 'Right' : 'Left'} live ${formatDbfs(live)} dBFS; held ${formatDbfs(held)} dBFS`}><b>{c ? 'R' : 'L'}</b>
        <div role="meter" aria-label={`${c ? 'Right' : 'Left'} live sample peak`} aria-valuemin={-60} aria-valuemax={0} aria-valuenow={Math.max(-60, Math.min(0, live))} className="volume-dots">
          {Array.from({ length: 12 }, (_, i) => { const db = -55 + i * 5; return <i key={i} className={`${i >= 10 ? 'red' : i >= 8 ? 'yellow' : 'green'} ${live >= db ? 'lit' : ''} ${held >= db && held < db + 5 ? 'held' : ''}`} />; })}
        </div><output aria-label={`${c ? 'Right' : 'Left'} held sample peak`}>{formatDbfs(held)}</output>
      </div>;
    })}
    <div className="volume-meter-footer"><button className="volume-reset" disabled={disabled} onClick={() => meter.reset()} title="Reset held sample peaks only">Reset</button><small className="volume-meter-unit" title={levels.error}>{levels.error ? 'Unavailable' : 'held dBFS'}</small></div>
  </section>;
}
export function VolumeControls({ audioBuffer, selection, onApply, active, meter }: Props) {
  const [scope, setScope] = useState<VolumeScope>('all');
  const [thresholdDb, setThresholdDb] = useState(-3), [ceilingDb, setCeilingDb] = useState(-6), [targetDb, setTargetDb] = useState(-0.5);
  const [cache, setCache] = useState<VolumeAnalysis | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [countParams, setCountParams] = useState({ thresholdDb, ceilingDb });
  const [status, setStatus] = useState<Status | null>(null);
  const operation = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const range = useMemo(() => audioBuffer ? resolveVolumeRange(scope, selection, audioBuffer.sampleRate, audioBuffer.length) : null, [audioBuffer, scope, selection]);
  const hasSelection = !!audioBuffer && !!resolveVolumeRange('selection', selection, audioBuffer.sampleRate, audioBuffer.length);
  const key = range ? `${scope}:${range.start}:${range.end}` : `${scope}:invalid`;
  const current = analysisIsCurrent(cache, audioBuffer, scope, range) ? cache : null;
  const latest = useRef({ audioBuffer, scope, range }); latest.current = { audioBuffer, scope, range };
  useEffect(() => { operation.current?.abort(); }, [audioBuffer, key]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current?.abort(); }; }, []);
  useEffect(() => {
    setRefreshing(true);
    const timer = setTimeout(() => { setCountParams({ thresholdDb, ceilingDb }); setRefreshing(false); }, 100);
    return () => clearTimeout(timer);
  }, [thresholdDb, ceilingDb]);
  const countsCurrent = !refreshing && countParams.thresholdDb === thresholdDb && countParams.ceilingDb === ceilingDb;
  const count = current && countsCurrent ? affectedFrames(current, thresholdDb, ceilingDb) : null;
  const idle = !!audioBuffer && !!range && !busy;
  const canReduce = idle && count !== null && count > 0;
  const shownStatus = status?.buffer === audioBuffer && status.key === key ? status : null;
  const reportError = (text: string) => setStatus({ buffer: audioBuffer, key, text, error: true });
  const run = async (action?: VolumeAction) => {
    if (!audioBuffer || !range || operation.current || (action && action !== 'normalise' && !canReduce)) return;
    const buffer = audioBuffer, scoped = range, startScope = scope;
    const controller = new AbortController(); operation.current = controller;
    setBusy(action === 'normalise' ? 'Normalising\u2026' : action === 'reduce' ? 'Reducing peaks\u2026' : action === 'combined' ? 'Reducing and normalising\u2026' : 'Detecting\u2026');
    const valid = () => mounted.current && !controller.signal.aborted && latest.current.audioBuffer === buffer && latest.current.scope === startScope && sameRange(latest.current.range, scoped);
    try {
      // Normalise keeps its existing one-click workflow, but always obtains fresh compatible analysis.
      const analysis = action && current ? current : await analyseVolume(buffer, startScope, scoped, controller.signal);
      if (!valid()) return;
      setCache(analysis);
      if (!action) { setStatus({ buffer, key, text: analysis.peak > 0 ? 'Detected. Affected frames update with Threshold / Ceiling.' : 'Silent range.' }); return; }
      const result = await processVolume(analysis, action, { thresholdDb, ceilingDb, targetDb }, controller.signal);
      if (!valid()) return;
      if (isFailure(result)) { reportError(result.reason === 'silent' ? 'Too quiet to normalise (below -80 dBFS).' : result.reason === 'nothing-to-reduce' ? 'No affected peaks. Audio unchanged.' : 'Invalid value. Audio unchanged.'); return; }
      onApply(result.buffer, result.description);
      setStatus({ buffer: result.buffer, key, text: action === 'normalise' ? `Normalised to ${targetDb.toFixed(1)} dBFS.` : `Reduced ${result.peaksReducedCount} sample frames${action === 'combined' ? `; normalised to ${targetDb.toFixed(1)} dBFS` : ''}.` });
    } catch (error) { if (valid() && !(error instanceof DOMException && error.name === 'AbortError')) reportError('Processing failed. Audio unchanged.'); }
    finally { if (operation.current === controller) { operation.current = null; if (mounted.current) setBusy(null); } }
  };
  const param = (label: string, title: string, value: number, min: number, step: number, onChange: (v: number) => void, units?: string) => <Parameter {...{ label, title, value, min, step, onChange, units }} disabled={!!busy && busy !== 'Detecting\u2026'} onError={reportError} />;
  return <div className="tools-volume" aria-label="Volume controls">
    <section className="volume-section volume-detect" aria-label="Detect and range">
      <h3>Detect / Range</h3>
      <div className="volume-range" role="group" aria-label="Analysis range">
        <button aria-pressed={scope === 'selection'} disabled={!hasSelection || !!busy} onClick={() => setScope('selection')} title={hasSelection ? 'Analyse and process selection only' : 'Make a valid selection first'}>Selection</button>
        <button role="switch" aria-label="Entire recording range" aria-checked={scope === 'all'} disabled={!audioBuffer || !!busy || (!hasSelection && scope === 'all')} onClick={() => setScope(scope === 'all' ? 'selection' : 'all')} className={`volume-flip ${scope === 'all' ? 'entire' : ''}`} title="Selection / Entire Recording"><i /></button>
        <button aria-pressed={scope === 'all'} disabled={!audioBuffer || !!busy} onClick={() => setScope('all')}>Entire Recording</button>
      </div>
      <button className="volume-button volume-primary" disabled={!idle} onClick={() => void run()} title="Detect highest audio sample peak and affected frames in this range; unlike Auto-Split Detect, this does not measure the noise floor">Detect</button>
      <output className="volume-highest" aria-label="Highest peak in dBFS" title="Highest absolute sample in either channel, independent of Threshold">Peak <strong>{current ? formatDbfs(linearToDb(current.peak)) : '\u2014'}</strong><small>dBFS</small></output>
    </section>
    <Meters meter={meter} active={active} disabled={!audioBuffer} />
    <section className="volume-section volume-normalise" aria-label="Normalise"><h3>Normalise</h3><div className="volume-knob-action">{param('Target', 'Normalise target peak', targetDb, -6, .1, setTargetDb, 'dBFS')}<button className="volume-button volume-primary" disabled={!idle} onClick={() => void run('normalise')} title="Uniform channel-linked gain to Target, inside the displayed range">Normalise</button></div></section>
    <section className="volume-section volume-tamer" aria-label="Peak Tamer"><h3>Peak Tamer</h3><div className="volume-knob-action">
      {param('Threshold', 'Threshold: only samples above this level can be reduced', thresholdDb, -24, .5, setThresholdDb)}
      {param('Ceiling', 'Ceiling: clamp affected samples to this level', ceilingDb, -24, .5, setCeilingDb)}
      <button className="volume-button volume-primary" disabled={!canReduce} onClick={() => void run('reduce')} title="Clamp samples above both Threshold and Ceiling; affected frames count once across stereo">Reduce{' '}<br />Peaks</button>
    </div></section>
    <section className="volume-section volume-combined" aria-label="Combined"><h3>Combined</h3><button className="volume-button volume-primary" disabled={!canReduce} onClick={() => void run('combined')} title="Reduce with displayed Threshold / Ceiling, then measure and normalise to Target; one undo">Reduce &amp;{' '}<br />Normalise</button></section>
    <div role="status" aria-live="polite" aria-busy={!!busy || refreshing} className={`volume-status ${shownStatus?.error ? 'volume-status-error' : ''}`}>
      {busy || (!audioBuffer ? 'Load audio to begin' : !range ? 'Select a region first' : refreshing && current ? 'Updating affected frames\u2026' : shownStatus?.text ?? '')}
      <output title="Sample frames reduced at current Threshold and Ceiling; either channel counts, coincident stereo samples count once">Affected frames: {count ?? '\u2014'}</output>
    </div>
  </div>;
}
