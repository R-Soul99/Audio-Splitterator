import { FadeSettings, FadeCurve } from '../types';

/**
 * Finds the closest zero-crossing sample within a search window around targetSample.
 * Looks for sign change: (s[i] <= 0 && s[i+1] >= 0) or (s[i] >= 0 && s[i+1] <= 0),
 * or sample with minimum absolute amplitude.
 */
export function findZeroCrossing(
  channelData: Float32Array,
  targetSample: number,
  maxWindowSamples = 512
): number {
  const len = channelData.length;
  const start = Math.max(0, targetSample - maxWindowSamples);
  const end = Math.min(len - 2, targetSample + maxWindowSamples);

  let bestIdx = targetSample;
  let minDiff = Infinity;
  let minAbs = Infinity;

  for (let i = start; i <= end; i++) {
    const s1 = channelData[i];
    const s2 = channelData[i + 1];

    // True zero crossing: sign change
    if ((s1 <= 0 && s2 >= 0) || (s1 >= 0 && s2 <= 0)) {
      const distance = Math.abs(i - targetSample);
      if (distance < minDiff) {
        minDiff = distance;
        bestIdx = Math.abs(s1) < Math.abs(s2) ? i : i + 1;
      }
    }

    // Secondary fallback: lowest amplitude sample
    const absVal = Math.abs(s1);
    if (absVal < minAbs) {
      minAbs = absVal;
      if (minDiff === Infinity) {
        bestIdx = i;
      }
    }
  }

  return bestIdx;
}

/**
 * Calculate volume multiplier for a fade curve.
 * fraction is from 0.0 (silent) to 1.0 (full volume).
 */
export function calculateFadeGain(fraction: number, curve: FadeCurve): number {
  const clamped = Math.max(0, Math.min(1, fraction));
  if (curve === 'linear') {
    return clamped;
  }
  if (curve === 'scurve') {
    // S-curve: Raised cosine smoothstep (tangent at 0 and 1) as seen in professional DAWs
    return 0.5 * (1 - Math.cos(clamped * Math.PI));
  }
  // Logarithmic / Perceptual audio curve (equal-power)
  return Math.sin(clamped * (Math.PI / 2));
}

/**
 * Applies fade in and fade out to Float32Array channel data in-place.
 */
export function applyFadesToChannel(
  samples: Float32Array,
  sampleRate: number,
  settings: FadeSettings
) {
  const totalSamples = samples.length;
  if (totalSamples === 0) return;

  // Apply Fade In
  if (settings.fadeInEnabled && settings.fadeInMs > 0) {
    const fadeInSamples = Math.min(
      totalSamples,
      Math.round((settings.fadeInMs / 1000) * sampleRate)
    );
    for (let i = 0; i < fadeInSamples; i++) {
      const fraction = i / fadeInSamples;
      const gain = calculateFadeGain(fraction, settings.fadeInCurve);
      samples[i] *= gain;
    }
  }

  // Apply Fade Out
  if (settings.fadeOutEnabled && settings.fadeOutMs > 0) {
    const fadeOutSamples = Math.min(
      totalSamples,
      Math.round((settings.fadeOutMs / 1000) * sampleRate)
    );
    for (let i = 0; i < fadeOutSamples; i++) {
      const sampleIdx = totalSamples - 1 - i;
      const fraction = i / fadeOutSamples;
      const gain = calculateFadeGain(fraction, settings.fadeOutCurve);
      samples[sampleIdx] *= gain;
    }
  }
}

/**
 * Slices an AudioBuffer from startSec to endSec, optionally finding zero crossings
 * and applying fade in / fade out.
 */
export function extractSlice(
  sourceBuffer: AudioBuffer,
  startSec: number,
  endSec: number,
  fadeSettings?: FadeSettings
): AudioBuffer {
  const sampleRate = sourceBuffer.sampleRate;
  const numChannels = sourceBuffer.numberOfChannels;
  const totalSourceSamples = sourceBuffer.length;

  let startSample = Math.max(0, Math.round(startSec * sampleRate));
  let endSample = Math.min(totalSourceSamples, Math.round(endSec * sampleRate));

  if (startSample >= endSample) {
    endSample = Math.min(totalSourceSamples, startSample + 1);
  }

  // Apply zero-crossing detection if requested
  if (fadeSettings?.zeroCrossing) {
    const ch0 = sourceBuffer.getChannelData(0);
    // Snap start to zero crossing
    if (startSample > 0 && startSample < totalSourceSamples) {
      startSample = findZeroCrossing(ch0, startSample, Math.round(sampleRate * 0.015)); // up to 15ms window
    }
    // Snap end to zero crossing
    if (endSample > 0 && endSample < totalSourceSamples) {
      endSample = findZeroCrossing(ch0, endSample, Math.round(sampleRate * 0.015));
    }
  }

  const length = Math.max(1, endSample - startSample);
  const audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  const targetBuffer = audioCtx.createBuffer(numChannels, length, sampleRate);

  for (let ch = 0; ch < numChannels; ch++) {
    const sourceData = sourceBuffer.getChannelData(ch);
    const targetData = targetBuffer.getChannelData(ch);

    // Copy segment
    targetData.set(sourceData.subarray(startSample, startSample + length));

    // Apply fades if settings provided
    if (fadeSettings) {
      applyFadesToChannel(targetData, sampleRate, fadeSettings);
    }
  }

  return targetBuffer;
}

/**
 * Crops an AudioBuffer so only the region between startSec and endSec remains.
 * Everything outside the selection is discarded.
 */
export function cropAudioBuffer(
  sourceBuffer: AudioBuffer,
  startSec: number,
  endSec: number,
  zeroCrossing = true
): AudioBuffer {
  const sampleRate = sourceBuffer.sampleRate;
  const numChannels = sourceBuffer.numberOfChannels;
  const totalSamples = sourceBuffer.length;

  let startSample = Math.max(0, Math.round(startSec * sampleRate));
  let endSample = Math.min(totalSamples, Math.round(endSec * sampleRate));

  if (startSample >= endSample) {
    startSample = Math.max(0, startSample - 100);
    endSample = Math.min(totalSamples, startSample + 200);
  }

  if (zeroCrossing) {
    const ch0 = sourceBuffer.getChannelData(0);
    if (startSample > 0 && startSample < totalSamples) {
      startSample = findZeroCrossing(ch0, startSample, Math.round(sampleRate * 0.015));
    }
    if (endSample > 0 && endSample < totalSamples) {
      endSample = findZeroCrossing(ch0, endSample, Math.round(sampleRate * 0.015));
    }
  }

  const length = Math.max(1, endSample - startSample);
  const audioCtx = new (window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  const cropped = audioCtx.createBuffer(numChannels, length, sampleRate);

  for (let ch = 0; ch < numChannels; ch++) {
    const src = sourceBuffer.getChannelData(ch);
    const dst = cropped.getChannelData(ch);
    dst.set(src.subarray(startSample, startSample + length));
  }

  audioCtx.close();
  return cropped;
}

/**
 * Cuts out / removes the region between startSec and endSec from an AudioBuffer,
 * splicing the audio before startSec and after endSec together with a smooth micro-crossfade.
 */
export function cutAudioBuffer(
  sourceBuffer: AudioBuffer,
  startSec: number,
  endSec: number,
  zeroCrossing = true,
  crossfadeMs = 8
): AudioBuffer {
  const sampleRate = sourceBuffer.sampleRate;
  const numChannels = sourceBuffer.numberOfChannels;
  const totalSamples = sourceBuffer.length;

  let cutStartSample = Math.max(0, Math.round(startSec * sampleRate));
  let cutEndSample = Math.min(totalSamples, Math.round(endSec * sampleRate));

  if (cutStartSample >= cutEndSample) {
    return sourceBuffer;
  }

  if (zeroCrossing) {
    const ch0 = sourceBuffer.getChannelData(0);
    if (cutStartSample > 0 && cutStartSample < totalSamples) {
      cutStartSample = findZeroCrossing(ch0, cutStartSample, Math.round(sampleRate * 0.015));
    }
    if (cutEndSample > 0 && cutEndSample < totalSamples) {
      cutEndSample = findZeroCrossing(ch0, cutEndSample, Math.round(sampleRate * 0.015));
    }
  }

  const leftPartLength = cutStartSample;
  const rightPartLength = totalSamples - cutEndSample;
  const newLength = Math.max(1, leftPartLength + rightPartLength);

  const audioCtx = new (window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  const newBuffer = audioCtx.createBuffer(numChannels, newLength, sampleRate);

  const xfadeSamples = Math.min(
    Math.round((crossfadeMs / 1000) * sampleRate),
    Math.floor(leftPartLength / 2),
    Math.floor(rightPartLength / 2)
  );

  for (let ch = 0; ch < numChannels; ch++) {
    const src = sourceBuffer.getChannelData(ch);
    const dst = newBuffer.getChannelData(ch);

    // Copy left piece
    if (leftPartLength > 0) {
      dst.set(src.subarray(0, leftPartLength), 0);
    }

    // Copy right piece
    if (rightPartLength > 0) {
      dst.set(src.subarray(cutEndSample, totalSamples), leftPartLength);
    }

    // Apply micro crossfade at splice point to eliminate any potential click
    if (xfadeSamples > 0 && leftPartLength > 0 && rightPartLength > 0) {
      const seam = leftPartLength;
      for (let i = 0; i < xfadeSamples; i++) {
        const t = (i + 1) / (xfadeSamples + 1);
        const wLeft = Math.cos(t * 0.5 * Math.PI);
        const wRight = Math.sin(t * 0.5 * Math.PI);

        const leftIdx = seam - xfadeSamples + i;
        const rightSample = src[cutEndSample + i];
        dst[leftIdx] = dst[leftIdx] * wLeft + rightSample * wRight;
      }
    }
  }

  audioCtx.close();
  return newBuffer;
}

export interface AnomalousPeakEvent {
  id: string;
  timeSec: number;
  peakDb: number;
}

export interface AnomalousPeakAnalysis {
  trueMaxPeakDb: number;
  nominalProgramPeakDb: number;
  peaksCount: number;
  detectedPeaks: AnomalousPeakEvent[];
}

export function measureNoiseFloorDb(
  sourceBuffer: AudioBuffer,
  startSec = 0,
  endSec = sourceBuffer.duration
): { peakDb: number; suggestedThresholdDb: number } {
  const channel = sourceBuffer.getChannelData(0);
  const start = Math.max(0, Math.floor(startSec * sourceBuffer.sampleRate));
  const end = Math.min(channel.length, Math.ceil(endSec * sourceBuffer.sampleRate));
  let peak = 0;

  for (let index = start; index < end; index++) {
    peak = Math.max(peak, Math.abs(channel[index]));
  }

  const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  return {
    peakDb,
    suggestedThresholdDb: Math.max(-80, peakDb - 12),
  };
}

export function analyzeAnomalousPeaks(
  sourceBuffer: AudioBuffer,
  thresholdDb: number,
  scopeRange?: { startSec: number; endSec: number }
): AnomalousPeakAnalysis {
  const channel = sourceBuffer.getChannelData(0);
  const start = Math.max(1, Math.floor((scopeRange?.startSec ?? 0) * sourceBuffer.sampleRate));
  const end = Math.min(
    channel.length - 1,
    Math.ceil((scopeRange?.endSec ?? sourceBuffer.duration) * sourceBuffer.sampleRate)
  );
  const threshold = Math.pow(10, thresholdDb / 20);
  let maxAmplitude = 0;
  const amplitudes: number[] = [];
  const detectedPeaks: AnomalousPeakEvent[] = [];

  for (let index = start; index < end; index++) {
    const amplitude = Math.abs(channel[index]);
    amplitudes.push(amplitude);
    maxAmplitude = Math.max(maxAmplitude, amplitude);
  }

  const sorted = [...amplitudes].sort((left, right) => right - left);
  const nominalAmplitude = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.1))] ?? 0;

  for (let index = start + 1; index < end - 1; index++) {
    const amplitude = Math.abs(channel[index]);
    if (amplitude >= threshold && amplitude >= Math.abs(channel[index - 1]) && amplitude >= Math.abs(channel[index + 1])) {
      detectedPeaks.push({
        id: `${index}`,
        timeSec: index / sourceBuffer.sampleRate,
        peakDb: 20 * Math.log10(Math.max(amplitude, 1e-10)),
      });
    }
  }

  return {
    trueMaxPeakDb: maxAmplitude > 0 ? 20 * Math.log10(maxAmplitude) : -Infinity,
    nominalProgramPeakDb: nominalAmplitude > 0 ? 20 * Math.log10(nominalAmplitude) : -Infinity,
    peaksCount: detectedPeaks.length,
    detectedPeaks,
  };
}

export function reduceAnomalousPeaks(
  sourceBuffer: AudioBuffer,
  options: {
    thresholdDb: number;
    targetCeilingDb: number;
    scopeRange?: { startSec: number; endSec: number };
    kneeMs?: number;
  }
): {
  repairedBuffer: AudioBuffer;
  peaksReducedCount: number;
  originalMaxPeakDb: number;
  newMaxPeakDb: number;
  headroomGainedDb: number;
} {
  const audioContext = new (window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  const repairedBuffer = audioContext.createBuffer(
    sourceBuffer.numberOfChannels,
    sourceBuffer.length,
    sourceBuffer.sampleRate
  );
  const threshold = Math.pow(10, options.thresholdDb / 20);
  const ceiling = Math.pow(10, options.targetCeilingDb / 20);
  const start = Math.max(0, Math.floor((options.scopeRange?.startSec ?? 0) * sourceBuffer.sampleRate));
  const end = Math.min(sourceBuffer.length, Math.ceil((options.scopeRange?.endSec ?? sourceBuffer.duration) * sourceBuffer.sampleRate));
  let peaksReducedCount = 0;
  let originalMax = 0;
  let newMax = 0;

  for (let channelIndex = 0; channelIndex < sourceBuffer.numberOfChannels; channelIndex++) {
    const source = sourceBuffer.getChannelData(channelIndex);
    const target = repairedBuffer.getChannelData(channelIndex);
    target.set(source);
    for (let index = 0; index < source.length; index++) {
      const amplitude = Math.abs(source[index]);
      originalMax = Math.max(originalMax, amplitude);
      if (index >= start && index < end && amplitude > threshold && amplitude > ceiling) {
        target[index] = Math.sign(source[index]) * ceiling;
        if (channelIndex === 0) peaksReducedCount++;
      }
      newMax = Math.max(newMax, Math.abs(target[index]));
    }
  }

  audioContext.close();
  const originalMaxPeakDb = originalMax > 0 ? 20 * Math.log10(originalMax) : -Infinity;
  const newMaxPeakDb = newMax > 0 ? 20 * Math.log10(newMax) : -Infinity;
  return {
    repairedBuffer,
    peaksReducedCount,
    originalMaxPeakDb,
    newMaxPeakDb,
    headroomGainedDb: newMaxPeakDb - originalMaxPeakDb,
  };
}

/**
 * Formats time in seconds to mm:ss.ms or hh:mm:ss.ms
 */
export function formatTime(seconds: number, includeMs = true): string {
  if (isNaN(seconds) || seconds < 0) seconds = 0;
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);

  const minsStr = hrs > 0 ? String(mins).padStart(2, '0') : String(mins);
  const secsStr = String(secs).padStart(2, '0');
  const msStr = String(ms).padStart(3, '0');

  if (hrs > 0) {
    return includeMs
      ? `${hrs}:${minsStr}:${secsStr}.${msStr}`
      : `${hrs}:${minsStr}:${secsStr}`;
  }
  return includeMs ? `${minsStr}:${secsStr}.${msStr}` : `${minsStr}:${secsStr}`;
}

/**
 * Detect silence regions for auto-splitting.
 * Returns proposed split boundary seconds.
 */
export function detectSilenceSplits(
  audioBuffer: AudioBuffer,
  thresholdDb = -42,
  minSilenceDurationSec = 1.2,
  startSec = 0,
  endSec = audioBuffer.duration
): number[] {
  const sampleRate = audioBuffer.sampleRate;
  const numChannels = audioBuffer.numberOfChannels;
  const len = audioBuffer.length;
  const startSample = Math.max(0, Math.floor(startSec * sampleRate));
  const endSample = Math.min(len, Math.ceil(endSec * sampleRate));
  const thresholdLinear = Math.pow(10, thresholdDb / 20);
  const minSilenceSamples = Math.round(minSilenceDurationSec * sampleRate);

  const splitPoints: number[] = [];
  const windowSize = Math.round(sampleRate * 0.05); // 50ms window
  let silenceCount = 0;
  let inSilence = false;
  let silenceStartSample = 0;

  for (let i = startSample; i < endSample; i += windowSize) {
    let windowPeak = 0;
    const end = Math.min(endSample, i + windowSize);
    for (let ch = 0; ch < numChannels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for (let s = i; s < end; s++) {
        const absVal = Math.abs(data[s]);
        if (absVal > windowPeak) windowPeak = absVal;
      }
    }

    if (windowPeak < thresholdLinear) {
      if (!inSilence) {
        inSilence = true;
        silenceStartSample = i;
      }
      silenceCount += windowSize;
    } else {
      if (inSilence && silenceCount >= minSilenceSamples) {
        // Center of the silence region
        const splitSample = Math.round((silenceStartSample + (silenceStartSample + silenceCount)) / 2);
        splitPoints.push(splitSample / sampleRate);
      }
      inSilence = false;
      silenceCount = 0;
    }
  }

  return splitPoints;
}

/**
 * Resamples an AudioBuffer to targetSampleRate using the browser's native,
 * high-fidelity bandlimited sinc anti-aliased OfflineAudioContext renderer.
 * If targetSampleRate is 0 or matches source, returns the original buffer.
 */
export async function resampleAudioBuffer(
  audioBuffer: AudioBuffer,
  targetSampleRate: number
): Promise<AudioBuffer> {
  if (!targetSampleRate || targetSampleRate === audioBuffer.sampleRate) {
    return audioBuffer;
  }

  const numChannels = audioBuffer.numberOfChannels;
  const targetLength = Math.max(1, Math.round(audioBuffer.duration * targetSampleRate));

  const OfflineCtxClass =
    window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;

  if (!OfflineCtxClass) {
    console.warn('OfflineAudioContext not available for resampling.');
    return audioBuffer;
  }

  const offlineCtx = new OfflineCtxClass(numChannels, targetLength, targetSampleRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineCtx.destination);
  source.start(0);

  return await offlineCtx.startRendering();
}
