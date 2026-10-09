import { TimeSelection } from '../types';
import { SampleSelection, sampleSelection } from './loopSelection';
import { analyzeAnomalousPeaks, AnomalousPeakAnalysis, reducePeakChannels } from './audioProcessing';

export type VolumeScope = 'selection' | 'all';

export const NORMALISE_TARGET_DB = { min: -6, max: 0, step: 0.1, default: -0.5 };
export const PEAK_LEVEL_DB = { min: -24, max: 0, step: 0.5 };
export const DEFAULT_THRESHOLD_DB = -3;
export const DEFAULT_CEILING_DB = -6;
/** Material at or below this sample peak (-80 dBFS) is treated as silent, as before. */
export const SILENT_PEAK = 0.0001;

/** Exact sample range for the displayed scope; null when Selection is chosen without a valid selection. */
export function resolveVolumeRange(
  scope: VolumeScope,
  selection: TimeSelection | null,
  sampleRate: number,
  frames: number
): SampleSelection | null {
  if (!(frames > 0)) return null;
  return scope === 'all' ? { start: 0, end: frames } : sampleSelection(selection, sampleRate, frames);
}

export function sameRange(a: SampleSelection | null, b: SampleSelection | null): boolean {
  return !!a && !!b && a.start === b.start && a.end === b.end;
}

/** Highest absolute sample across every channel inside [start, end). Non-finite samples are ignored. */
export function measureSamplePeak(channels: Float32Array[], range: SampleSelection): number {
  let peak = 0;
  for (const data of channels) {
    const end = Math.min(range.end, data.length);
    for (let index = Math.max(0, range.start); index < end; index++) {
      const value = Math.abs(data[index]);
      if (value > peak && value !== Infinity) peak = value;
    }
  }
  return peak;
}

export function linearToDb(value: number): number {
  return value > 0 && Number.isFinite(value) ? 20 * Math.log10(value) : -Infinity;
}

export function formatDbfs(db: number): string {
  return Number.isFinite(db) ? db.toFixed(1) : '\u2212\u221E';
}

export function isValidNormaliseTarget(targetDb: number): boolean {
  return Number.isFinite(targetDb) && targetDb >= NORMALISE_TARGET_DB.min && targetDb <= NORMALISE_TARGET_DB.max;
}

export interface VolumeFailure { ok: false; reason: 'silent' | 'invalid' | 'nothing-to-reduce' }

/** Explicit guard: discriminated unions on ok do not narrow without strictNullChecks. */
export function isFailure(result: { ok: boolean }): result is VolumeFailure {
  return !result.ok;
}

export type NormaliseResult =
  | { ok: true; channels: Float32Array[]; gain: number; peak: number; gainDb: number }
  | VolumeFailure;

/** Uniform, channel-linked gain from the scope's highest peak to the target; outside samples are untouched. */
export function normaliseChannels(
  sourceChannels: Float32Array[],
  range: SampleSelection,
  targetDb: number,
  inPlace = false
): NormaliseResult {
  if (!isValidNormaliseTarget(targetDb) || !(range.end > range.start)) return { ok: false, reason: 'invalid' };
  const peak = measureSamplePeak(sourceChannels, range);
  if (peak <= SILENT_PEAK) return { ok: false, reason: 'silent' };
  const gain = Math.pow(10, targetDb / 20) / peak;
  if (!Number.isFinite(gain)) return { ok: false, reason: 'invalid' };
  const channels = inPlace ? sourceChannels : sourceChannels.map(data => new Float32Array(data));
  for (const data of channels) {
    const end = Math.min(range.end, data.length);
    for (let index = Math.max(0, range.start); index < end; index++) {
      data[index] = Math.max(-1, Math.min(1, data[index] * gain));
    }
  }
  return { ok: true, channels, gain, peak, gainDb: 20 * Math.log10(gain) };
}

export type ReduceNormaliseResult =
  | { ok: true; channels: Float32Array[]; peaksReducedCount: number; gain: number; gainDb: number; peakAfterReduction: number }
  | VolumeFailure;

/** Existing reduction, then normalisation to the target from the freshly measured post-reduction peak. */
export function reduceAndNormaliseChannels(
  sourceChannels: Float32Array[],
  range: SampleSelection,
  options: { thresholdDb: number; ceilingDb: number; targetDb: number }
): ReduceNormaliseResult {
  if (!isValidNormaliseTarget(options.targetDb)) return { ok: false, reason: 'invalid' };
  const reduction = reducePeakChannels(sourceChannels, options.thresholdDb, options.ceilingDb, range.start, range.end);
  if (reduction.peaksReducedCount === 0) return { ok: false, reason: 'nothing-to-reduce' };
  const normalised = normaliseChannels(reduction.channels, range, options.targetDb, true);
  if (isFailure(normalised)) return normalised;
  return {
    ok: true,
    channels: normalised.channels,
    peaksReducedCount: reduction.peaksReducedCount,
    gain: normalised.gain,
    gainDb: normalised.gainDb,
    peakAfterReduction: normalised.peak,
  };
}

export interface VolumeScan {
  buffer: AudioBuffer;
  scope: VolumeScope;
  range: SampleSelection;
  thresholdDb: number;
  /** Highest sample peak across all channels (linear). */
  peak: number;
  /** Existing tamer analysis for the scanned threshold. */
  analysis: AnomalousPeakAnalysis;
}

function channelsOf(buffer: AudioBuffer): Float32Array[] {
  return Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
}

export function performVolumeScan(
  buffer: AudioBuffer,
  scope: VolumeScope,
  selection: TimeSelection | null,
  thresholdDb: number
): VolumeScan | null {
  const range = resolveVolumeRange(scope, selection, buffer.sampleRate, buffer.length);
  if (!range) return null;
  return {
    buffer,
    scope,
    range,
    thresholdDb,
    peak: measureSamplePeak(channelsOf(buffer), range),
    analysis: analyzeAnomalousPeaks(buffer, thresholdDb, undefined, range),
  };
}

/** A scan only describes the exact audio revision and scope it measured. */
export function scanIsCurrent(scan: VolumeScan | null, buffer: AudioBuffer | null, scope: VolumeScope, range: SampleSelection | null): scan is VolumeScan {
  return !!scan && scan.buffer === buffer && scan.scope === scope && sameRange(scan.range, range);
}

/** Peak counts and candidates depend on Threshold; stale counts are never used to act. */
export function scanHasThreshold(scan: VolumeScan, thresholdDb: number): boolean {
  return scan.thresholdDb === thresholdDb;
}

export type VolumeAction = 'reduce' | 'normalise' | 'combined';
export type VolumeActionResult =
  | { ok: true; buffer: AudioBuffer; peaksReducedCount: number; gainDb: number | null; description: string }
  | VolumeFailure;

export function bufferFromChannels(channels: Float32Array[], sampleRate: number): AudioBuffer {
  const buffer = new AudioBuffer({ length: channels[0].length, numberOfChannels: channels.length, sampleRate });
  channels.forEach((data, channel) => buffer.copyToChannel(data, channel));
  return buffer;
}

/** Computes the processed audio for one action; never mutates the source buffer. */
export function computeVolumeAction(
  buffer: AudioBuffer,
  action: VolumeAction,
  range: SampleSelection,
  params: { thresholdDb: number; ceilingDb: number; targetDb: number },
  create: (channels: Float32Array[], sampleRate: number) => AudioBuffer = bufferFromChannels
): VolumeActionResult {
  const source = channelsOf(buffer);
  const { thresholdDb, ceilingDb, targetDb } = params;
  if (action === 'normalise') {
    const result = normaliseChannels(source, range, targetDb);
    if (isFailure(result)) return result;
    return { ok: true, buffer: create(result.channels, buffer.sampleRate), peaksReducedCount: 0, gainDb: result.gainDb, description: `Normalise (${targetDb.toFixed(1)} dB)` };
  }
  if (action === 'reduce') {
    const reduction = reducePeakChannels(source, thresholdDb, ceilingDb, range.start, range.end);
    if (reduction.peaksReducedCount === 0) return { ok: false, reason: 'nothing-to-reduce' };
    return { ok: true, buffer: create(reduction.channels, buffer.sampleRate), peaksReducedCount: reduction.peaksReducedCount, gainDb: null, description: `Reduce ${reduction.peaksReducedCount} Anomalous Peaks to ${ceilingDb.toFixed(1)} dB` };
  }
  const result = reduceAndNormaliseChannels(source, range, { thresholdDb, ceilingDb, targetDb });
  if (isFailure(result)) return result;
  return {
    ok: true,
    buffer: create(result.channels, buffer.sampleRate),
    peaksReducedCount: result.peaksReducedCount,
    gainDb: result.gainDb,
    description: `Reduce ${result.peaksReducedCount} Peaks & Normalise (${targetDb.toFixed(1)} dB)`,
  };
}

/** Synchronous single-flight latch so duplicate clicks cannot start a second scan or action. */
export class BusyLatch {
  private token = 0;
  private active: number | null = null;
  acquire(): number | null {
    if (this.active !== null) return null;
    this.active = ++this.token;
    return this.active;
  }
  isActive(token: number): boolean { return this.active === token; }
  release(token: number): void { if (this.active === token) this.active = null; }
  get busy(): boolean { return this.active !== null; }
}
