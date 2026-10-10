import { SampleSelection } from './loopSelection';
import { VolumeScope, VolumeAction, VolumeActionResult, SILENT_PEAK, sameRange } from './volumeTools';

const levels = Array.from({ length: 49 }, (_, i) => Math.pow(10, (-24 + i * 0.5) / 20));
export interface VolumeAnalysis {
  buffer: AudioBuffer; scope: VolumeScope; range: SampleSelection; peak: number;
  /** Union of affected sample frames across channels, strictly above each legal level. */
  counts: Uint32Array;
}
export function analysisIsCurrent(cache: VolumeAnalysis | null, buffer: AudioBuffer | null, scope: VolumeScope, range: SampleSelection | null): cache is VolumeAnalysis {
  return !!cache && cache.buffer === buffer && cache.scope === scope && sameRange(cache.range, range);
}
export function affectedFrames(cache: VolumeAnalysis, thresholdDb: number, ceilingDb?: number): number {
  const db = Math.max(thresholdDb, ceilingDb ?? thresholdDb);
  return cache.counts[Math.round((db + 24) * 2)] ?? 0;
}
function cancelled(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); }
const yieldUI = () => new Promise<void>(resolve => setTimeout(resolve, 0));
/** One read-only pass, bounded chunks, no audio copy or amplitude sort. Cache is independent of Threshold. */
export async function analyseVolume(buffer: AudioBuffer, scope: VolumeScope, range: SampleSelection, signal?: AbortSignal): Promise<VolumeAnalysis> {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const bins = new Uint32Array(50);
  let peak = 0;
  for (let start = range.start; start < range.end; start += 32768) {
    cancelled(signal);
    const end = Math.min(range.end, start + 32768);
    for (let i = start; i < end; i++) {
      let amplitude = 0;
      for (const channel of channels) { const value = Math.abs(channel[i]); if (Number.isFinite(value) && value > amplitude) amplitude = value; }
      if (amplitude > peak) peak = amplitude;
      // Most programme samples never reach the lowest adjustable Threshold.
      if (amplitude <= levels[0]) continue;
      let lo = 0, hi = levels.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (amplitude > levels[mid]) lo = mid + 1; else hi = mid; }
      bins[lo]++;
    }
    await yieldUI();
  }
  cancelled(signal);
  const counts = new Uint32Array(49);
  let count = 0;
  for (let i = 49; i > 0; i--) { count += bins[i]; counts[i - 1] = count; }
  return { buffer, scope, range: { ...range }, peak, counts };
}
/** Writes a new buffer directly, yielding between chunks. Combined uses its fresh post-clamp peak. */
export async function processVolume(cache: VolumeAnalysis, action: VolumeAction, params: { thresholdDb: number; ceilingDb: number; targetDb: number }, signal?: AbortSignal): Promise<VolumeActionResult> {
  const { buffer, range } = cache;
  const { thresholdDb, ceilingDb, targetDb } = params;
  if (![thresholdDb, ceilingDb, targetDb].every(Number.isFinite) || thresholdDb < -24 || thresholdDb > 0 || ceilingDb < -24 || ceilingDb > 0 || targetDb < -6 || targetDb > 0) return { ok: false, reason: 'invalid' };
  if (cache.peak <= SILENT_PEAK) return { ok: false, reason: 'silent' };
  if (action !== 'normalise' && !affectedFrames(cache, thresholdDb, ceilingDb)) return { ok: false, reason: 'nothing-to-reduce' };
  const output = new AudioBuffer({ length: buffer.length, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate });
  const source = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const dest = source.map((_, c) => output.getChannelData(c));
  const threshold = Math.pow(10, thresholdDb / 20), ceiling = Math.pow(10, ceilingDb / 20);
  let peak = 0, reduced = 0;
  for (let start = 0; start < buffer.length; start += 32768) {
    cancelled(signal);
    const end = Math.min(buffer.length, start + 32768);
    for (let i = start; i < end; i++) {
      const inside = i >= range.start && i < range.end;
      let changed = false;
      for (let c = 0; c < source.length; c++) {
        let value = source[c][i];
        if (inside && action !== 'normalise' && Math.abs(value) > threshold && Math.abs(value) > ceiling) { value = Math.sign(value) * ceiling; changed = true; }
        dest[c][i] = value;
        const amplitude = Math.abs(dest[c][i]);
        if (inside && Number.isFinite(amplitude) && amplitude > peak) peak = amplitude;
      }
      if (changed) reduced++;
    }
    await yieldUI();
  }
  let gainDb: number | null = null;
  if (action !== 'reduce') {
    if (peak <= SILENT_PEAK) return { ok: false, reason: 'silent' };
    const gain = Math.pow(10, targetDb / 20) / peak;
    gainDb = 20 * Math.log10(gain);
    for (let start = range.start; start < range.end; start += 32768) {
      cancelled(signal);
      const end = Math.min(range.end, start + 32768);
      for (const channel of dest) for (let i = start; i < end; i++) channel[i] = Math.max(-1, Math.min(1, channel[i] * gain));
      await yieldUI();
    }
  }
  cancelled(signal);
  return { ok: true, buffer: output, peaksReducedCount: reduced, gainDb, description: action === 'normalise' ? `Normalise (${targetDb.toFixed(1)} dB)` : action === 'reduce' ? `Reduce ${reduced} peak frames` : `Reduce ${reduced} peak frames & Normalise (${targetDb.toFixed(1)} dB)` };
}
