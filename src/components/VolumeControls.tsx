import React, { useEffect, useMemo, useRef, useState } from 'react';
import { TimeSelection } from '../types';
import { analyzeAnomalousPeaks } from '../utils/audioProcessing';
import {
  BusyLatch,
  DEFAULT_CEILING_DB,
  DEFAULT_THRESHOLD_DB,
  NORMALISE_TARGET_DB,
  PEAK_LEVEL_DB,
  VolumeAction,
  VolumeScan,
  VolumeScope,
  computeVolumeAction,
  formatDbfs,
  isFailure,
  linearToDb,
  performVolumeScan,
  resolveVolumeRange,
  sameRange,
  scanHasThreshold,
  scanIsCurrent,
} from '../utils/volumeTools';

interface VolumeControlsProps {
  audioBuffer: AudioBuffer | null;
  selection: TimeSelection | null;
  onApply: (buffer: AudioBuffer, description: string) => void;
}

type Busy = 'scan' | VolumeAction | null;
type Kind = 'info' | 'success' | 'error';
interface Outcome { kind: Kind; text: string; resultBuffer?: AudioBuffer }
interface Status { buffer: AudioBuffer; key: string; kind: Kind; text: string }

const BUSY_TEXT: Record<Exclude<Busy, null>, string> = {
  scan: 'Scanning\u2026',
  reduce: 'Reducing peaks\u2026',
  normalise: 'Normalising\u2026',
  combined: 'Reducing and normalising\u2026',
};
const dbText = (db: number) => `${db < 0 ? '\u2212' : ''}${Math.abs(db).toFixed(1)}`;
const gainText = (db: number) => `${db >= 0 ? '+' : '\u2212'}${Math.abs(db).toFixed(1)}`;
const clampDb = (db: number) => Math.max(PEAK_LEVEL_DB.min, Math.min(PEAK_LEVEL_DB.max, db));

export function VolumeControls({ audioBuffer, selection, onApply }: VolumeControlsProps) {
  const [scope, setScope] = useState<VolumeScope>('all');
  const [thresholdDb, setThresholdDb] = useState(DEFAULT_THRESHOLD_DB);
  const [ceilingDb, setCeilingDb] = useState(DEFAULT_CEILING_DB);
  const [targetDb, setTargetDb] = useState(NORMALISE_TARGET_DB.default);
  const [scan, setScan] = useState<VolumeScan | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const latch = useRef(new BusyLatch());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const range = useMemo(
    () => (audioBuffer ? resolveVolumeRange(scope, selection, audioBuffer.sampleRate, audioBuffer.length) : null),
    [audioBuffer, scope, selection]
  );
  const hasSelection = !!audioBuffer && !!resolveVolumeRange('selection', selection, audioBuffer.sampleRate, audioBuffer.length);
  const rangeKey = range ? `${scope}:${range.start}-${range.end}` : '';
  const current = scanIsCurrent(scan, audioBuffer, scope, range) ? scan : null;
  const tamerReady = !!current && scanHasThreshold(current, thresholdDb);
  const spikes = tamerReady ? current.analysis.peaksCount : null;
  const idle = !busy && !!audioBuffer && !!range;
  const canReduce = idle && (spikes ?? 0) > 0;

  const latest = useRef({ audioBuffer, range, scope });
  latest.current = { audioBuffer, range, scope };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const shown: { kind: Kind; text: string } | null = busy
    ? { kind: 'info', text: BUSY_TEXT[busy] }
    : !audioBuffer
      ? { kind: 'info', text: 'Load audio to begin' }
      : scope === 'selection' && !hasSelection
        ? { kind: 'info', text: 'Select a region first' }
        : status && status.buffer === audioBuffer && status.key === rangeKey
          ? status
          : null;

  // Work starts after a paint so busy feedback is visible; results are discarded if audio or scope moved on.
  const run = (kind: Exclude<Busy, null>, work: (context: { buffer: AudioBuffer; range: NonNullable<typeof range> }) => Outcome) => {
    const buffer = audioBuffer;
    const startRange = range;
    const startScope = scope;
    const key = rangeKey;
    if (!buffer || !startRange) return;
    const token = latch.current.acquire();
    if (token === null) return;
    setBusy(kind);
    timer.current = setTimeout(() => {
      timer.current = null;
      const now = latest.current;
      try {
        if (now.audioBuffer === buffer && now.scope === startScope && sameRange(now.range, startRange)) {
          const outcome = work({ buffer, range: startRange });
          setStatus({ buffer: outcome.resultBuffer ?? buffer, key, kind: outcome.kind, text: outcome.text });
        }
      } catch {
        setStatus({ buffer, key, kind: 'error', text: 'Processing failed. Audio unchanged.' });
      } finally {
        latch.current.release(token);
        setBusy(null);
      }
    }, 25);
  };

  const startScan = () => run('scan', ({ buffer }) => {
    const result = performVolumeScan(buffer, scope, selection, thresholdDb);
    if (!result) return { kind: 'error', text: 'No valid scope to scan.' };
    setScan(result);
    return { kind: 'success', text: result.peak > 0 ? `Spikes ${result.analysis.peaksCount} / Nominal ${formatDbfs(result.analysis.nominalProgramPeakDb)}` : 'Silent range.' };
  });

  // Existing suggestion: threshold just above the nominal programme level, ceiling below it.
  const suggest = () => run('scan', ({ buffer, range: scoped }) => {
    const analysis = current ? current.analysis : analyzeAnomalousPeaks(buffer, -1.0, undefined, scoped);
    let threshold = -3.0;
    if (analysis.nominalProgramPeakDb > -50) {
      threshold = Math.min(analysis.trueMaxPeakDb - 0.5, Math.max(-18.0, analysis.nominalProgramPeakDb + 2.5));
    }
    threshold = clampDb(Math.round(threshold * 2) / 2);
    const ceiling = Math.min(threshold - 1.5, Math.max(-18.0, analysis.nominalProgramPeakDb));
    setThresholdDb(threshold);
    setCeilingDb(clampDb(Math.round(ceiling * 2) / 2));
    return { kind: 'info', text: 'Threshold set. Scan again to count peaks.' };
  });

  const apply = (action: VolumeAction) => {
    if (action !== 'normalise' && !canReduce) return;
    run(action, ({ buffer, range: scoped }) => {
      const result = computeVolumeAction(buffer, action, scoped, { thresholdDb, ceilingDb, targetDb });
      if (isFailure(result)) {
        const text = result.reason === 'silent' ? 'Too quiet to normalise (below \u221280 dBFS).'
          : result.reason === 'nothing-to-reduce' ? 'No peaks exceed the ceiling. Audio unchanged.'
          : 'Invalid value. Audio unchanged.';
        return { kind: result.reason === 'nothing-to-reduce' ? 'info' : 'error', text };
      }
      onApply(result.buffer, result.description);
      const text = action === 'reduce' ? `Reduced ${result.peaksReducedCount} peaks to ${dbText(ceilingDb)} dB.`
        : action === 'normalise' ? `Normalised ${gainText(result.gainDb!)} dB to ${dbText(targetDb)} dBFS.`
        : `Reduced ${result.peaksReducedCount} peaks, normalised ${gainText(result.gainDb!)} dB to ${dbText(targetDb)} dBFS.`;
      return { kind: 'success', text, resultBuffer: result.buffer };
    });
  };

  const peakText = current ? formatDbfs(linearToDb(current.peak)) : '\u2014';
  const scopeButton = (value: VolumeScope, label: string, disabled: boolean) => (
    <button type="button" aria-pressed={scope === value} disabled={disabled || !!busy} onClick={() => setScope(value)}
      title={value === 'selection' ? (hasSelection ? 'Process the selected region only' : 'Make a selection on the waveform first') : 'Process the entire recording'}
      className={`volume-scope ${scope === value ? 'volume-scope-on' : ''}`}>{label}</button>
  );

  return (
    <div aria-label="Volume controls" className="tools-volume">
      <section className="detection-section volume-scan" aria-label="Scan and range">
        <h3>Scan / Range</h3>
        <div className="volume-seg" role="group" aria-label="Range">
          {scopeButton('selection', 'Selection', !audioBuffer || !hasSelection)}
          {scopeButton('all', 'Entire', !audioBuffer)}
        </div>
        <div className="volume-row">
          <button type="button" onClick={startScan} disabled={!idle} aria-busy={busy === 'scan'} className="volume-button volume-scan-button">Scan</button>
          <output aria-label="Highest peak in dBFS" title="Highest sample peak across all channels in the scanned range" className="volume-readout volume-peak">
            <span>Peak</span><strong>{peakText}</strong>
          </output>
        </div>
      </section>

      <section className="detection-section volume-tamer" aria-label="Peak Tamer">
        <h3>Peak Tamer</h3>
        <div className="volume-row">
          <label htmlFor="volume-threshold">Threshold</label>
          <input id="volume-threshold" aria-label="Peak threshold in dB" type="range" min={PEAK_LEVEL_DB.min} max={PEAK_LEVEL_DB.max} step={PEAK_LEVEL_DB.step}
            value={thresholdDb} disabled={!!busy} onChange={event => setThresholdDb(parseFloat(event.target.value))} className="volume-slider" />
          <output className="volume-value">{dbText(thresholdDb)}</output>
          <button type="button" onClick={suggest} disabled={!idle} title="Suggest Threshold and Ceiling from the nominal programme level" className="volume-button volume-auto volume-col-button">Auto</button>
        </div>
        <div className="volume-row">
          <label htmlFor="volume-ceiling">Ceiling</label>
          <input id="volume-ceiling" aria-label="Peak ceiling in dB" type="range" min={PEAK_LEVEL_DB.min} max={PEAK_LEVEL_DB.max} step={PEAK_LEVEL_DB.step}
            value={ceilingDb} disabled={!!busy} onChange={event => setCeilingDb(parseFloat(event.target.value))} className="volume-slider" />
          <output className="volume-value">{dbText(ceilingDb)}</output>
          <button type="button" onClick={() => apply('reduce')} disabled={!canReduce}
            title={tamerReady ? 'Clamp peaks above Threshold down to Ceiling' : 'Scan at this Threshold first'} className="volume-button volume-primary volume-col-button">Reduce Peaks</button>
        </div>
      </section>

      <section className="detection-section volume-normalise" aria-label="Normalise">
        <h3>Normalise</h3>
        <div className="volume-row">
          <label htmlFor="volume-target">Target</label>
          <output aria-label="Target peak in dBFS" className="volume-readout volume-target"><strong>{dbText(targetDb)}</strong><span>dBFS</span></output>
        </div>
        <div className="volume-row">
          <input id="volume-target" aria-label="Normalise target peak in dBFS" type="range" min={NORMALISE_TARGET_DB.min} max={NORMALISE_TARGET_DB.max} step={NORMALISE_TARGET_DB.step}
            value={targetDb} disabled={!!busy} onChange={event => setTargetDb(parseFloat(event.target.value))} className="volume-slider volume-target-slider" />
          <button type="button" onClick={() => apply('normalise')} disabled={!idle}
            title="Apply uniform gain so the range's highest peak reaches the target" className="volume-button volume-primary">Normalise</button>
        </div>
      </section>

      <section className="detection-section volume-combined" aria-label="Combined">
        <h3>Combined</h3>
        <button type="button" onClick={() => apply('combined')} disabled={!canReduce}
          title="Reduce Peaks, then normalise the result to the Target" className="volume-button volume-primary volume-wide">Reduce &amp; Normalise</button>
        <div role="status" aria-live="polite" aria-busy={!!busy} className={`volume-status volume-status-${shown?.kind ?? 'info'}`} title={shown?.text}>{shown?.text ?? ''}</div>
      </section>
    </div>
  );
}
