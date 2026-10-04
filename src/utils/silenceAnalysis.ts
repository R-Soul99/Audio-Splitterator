// Shared by noise sampling, auto-split and manual marker snapping.
export const SILENCE_WINDOW_SEC = 0.02;
export const SILENCE_SPIKE_TOLERANCE_SEC = 0.04;
export const NOISE_THRESHOLD_MARGIN_DB = 3;

export interface LevelWindow { start: number; end: number; rms: number }
export interface SilenceRegion { start: number; end: number; candidate: number }

export function analyzeSilenceLevels(buffer: AudioBuffer, startSec = 0, endSec = buffer.duration): LevelWindow[] {
  const rate = buffer.sampleRate;
  const start = Math.max(0, Math.floor(Math.min(startSec, endSec) * rate));
  const end = Math.min(buffer.length, Math.ceil(Math.max(startSec, endSec) * rate));
  const step = Math.max(1, Math.round(rate * SILENCE_WINDOW_SEC));
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
  const windows: LevelWindow[] = [];
  for (let offset = start; offset < end; offset += step) {
    const stop = Math.min(end, offset + step);
    let rms = 0;
    for (const channel of channels) {
      let squares = 0;
      for (let sample = offset; sample < stop; sample++) squares += channel[sample] ** 2;
      rms = Math.max(rms, Math.sqrt(squares / (stop - offset)));
    }
    windows.push({ start: offset / rate, end: stop / rate, rms });
  }
  return windows;
}

// The import path must not synchronously rescan a whole recording while peaks load.
// Keep the same sample windows and stereo RMS rule as analyzeSilenceLevels.
export async function analyzeSilenceLevelsChunked(buffer: AudioBuffer, signal: AbortSignal,
  startSec = 0, endSec = buffer.duration): Promise<LevelWindow[]> {
  const rate = buffer.sampleRate;
  const start = Math.max(0, Math.floor(Math.min(startSec, endSec) * rate));
  const end = Math.min(buffer.length, Math.ceil(Math.max(startSec, endSec) * rate));
  const step = Math.max(1, Math.round(rate * SILENCE_WINDOW_SEC));
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
  const windows: LevelWindow[] = [];
  for (let offset = start, count = 0; offset < end; offset += step, count++) {
    if (count % 64 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
      if (signal.aborted) return [];
    }
    const stop = Math.min(end, offset + step);
    let rms = 0;
    for (const channel of channels) {
      let squares = 0;
      for (let sample = offset; sample < stop; sample++) squares += channel[sample] ** 2;
      rms = Math.max(rms, Math.sqrt(squares / (stop - offset)));
    }
    windows.push({ start: offset / rate, end: stop / rate, rms });
  }
  return signal.aborted ? [] : windows;
}

export function findSilenceRegions(windows: LevelWindow[], thresholdDb: number, minimumSec: number): SilenceRegion[] {
  const threshold = 10 ** (thresholdDb / 20);
  const regions: SilenceRegion[] = [];
  let start: number | null = null;
  let quietEnd = 0;
  let quietDuration = 0;
  const finish = () => {
    if (start !== null && quietDuration + 1e-9 >= minimumSec) {
      regions.push({ start, end: quietEnd, candidate: (start + quietEnd) / 2 });
    }
    start = null;
    quietDuration = 0;
  };
  for (const window of windows) {
    // Only bridge a short interruption when quiet audio actually resumes.
    if (start !== null && window.start - quietEnd > SILENCE_SPIKE_TOLERANCE_SEC + 1e-9) finish();
    if (window.rms <= threshold) {
      if (start === null) start = window.start;
      quietEnd = window.end;
      quietDuration += window.end - window.start;
    } else if (start !== null && window.end - quietEnd > SILENCE_SPIKE_TOLERANCE_SEC + 1e-9) {
      finish();
    }
  }
  finish(); // Include a valid trailing quiet region, using its actual length.
  return regions;
}

export function snapToSilenceCandidate(time: number, candidates: number[], radiusSec: number): number {
  if (radiusSec <= 0) return time;
  let nearest = time;
  let distance = radiusSec + 1e-9;
  for (const candidate of candidates) {
    const delta = Math.abs(candidate - time);
    if (delta <= radiusSec + 1e-9 && delta < distance) { nearest = candidate; distance = delta; }
  }
  return nearest;
}
