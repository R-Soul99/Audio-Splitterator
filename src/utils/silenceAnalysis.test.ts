import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSilenceLevels, findSilenceRegions, snapToSilenceCandidate } from './silenceAnalysis';
import { measureNoiseFloorDb } from './audioProcessing';

// Test the underlying gap model independently of the auto-only edge policy.
function detectSilenceSplits(buffer: AudioBuffer, threshold = -45, minimum = 1, start = 0, end = buffer.duration): number[] {
  return findSilenceRegions(analyzeSilenceLevels(buffer, start, end), threshold, minimum).map(region => region.candidate);
}

function recording(gap: number, clicks: number[] = [], sampleRate = 1000): AudioBuffer {
  const duration = 2 + gap;
  const data = Float32Array.from({ length: Math.round(duration * sampleRate) }, (_, index) => {
    const time = index / sampleRate;
    return time >= 1 && time < 1 + gap ? 0.001 : 0.2;
  });
  for (const time of clicks) data[Math.round(time * sampleRate)] = 0.9;
  return { duration, sampleRate, length: data.length, numberOfChannels: 2, getChannelData: () => data } as unknown as AudioBuffer;
}

test('A, B, D: one central candidate per gap, including isolated vinyl clicks', () => {
  for (const rate of [1000, 44100, 48000]) {
    for (const [gap, clicks] of [[2.5, []], [2.5, [2.003]], [4, []], [4, [2.003, 3.003]]] as [number, number[]][]) {
      assert.deepEqual(detectSilenceSplits(recording(gap, clicks, rate), -45, 1), [1 + gap / 2]);
    }
  }
});
test('C: reject a quiet dip shorter than Gap', () => {
  assert.deepEqual(detectSilenceSplits(recording(0.3), -45, 1), []);
});
test('E, F: Snap is bounded, chooses nearest candidate, and supports Off', () => {
  assert.equal(snapToSilenceCandidate(2.15, [2.25], 0.15), 2.25);
  assert.equal(snapToSilenceCandidate(1.75, [2.25], 0.15), 1.75);
  assert.equal(snapToSilenceCandidate(2.15, [2.25], 0), 2.15);
  assert.equal(snapToSilenceCandidate(2.15, [2.25, 2.1], 0.15), 2.1);
  assert.equal(snapToSilenceCandidate(2.15, [], 0.15), 2.15);
});
test('stereo uses the louder channel rather than mistaking one silent channel for a gap', () => {
  const buffer = recording(2.5);
  const loud = new Float32Array(buffer.length).fill(0.2);
  const quiet = buffer.getChannelData(0);
  buffer.getChannelData = (channel) => channel ? loud : quiet;
  assert.deepEqual(detectSilenceSplits(buffer, -45, 1), []);
});
test('Detect uses robust stereo background plus 3 dB, accepts reversed selections', () => {
  const buffer = recording(2.5, [2.003]);
  const measured = measureNoiseFloorDb(buffer, 3.5, 1);
  assert.ok(Math.abs(measured.suggestedThresholdDb - (-57)) < 0.01);
  assert.equal(detectSilenceSplits(buffer, measured.suggestedThresholdDb, 1).length, 1);
});
test('trailing silence is flushed and partial windows do not inflate duration', () => {
  const buffer = recording(2.5);
  assert.deepEqual(detectSilenceSplits(buffer, -45, 1, 1, 3.5), [2.25]);
  const windows = analyzeSilenceLevels(buffer, 1, 1.995);
  assert.deepEqual(findSilenceRegions(windows, -45, 1), []);
});
test('sustained musical interruptions are not bridged', () => {
  const buffer = recording(4);
  buffer.getChannelData(0).fill(0.2, 2400, 2600);
  assert.equal(detectSilenceSplits(buffer, -45, 1).length, 2);
});
