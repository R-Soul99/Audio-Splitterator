import test from 'node:test';
import assert from 'node:assert/strict';
import { snapToSilenceRegion } from './silenceAnalysis';

const gap = { start: 10, end: 12, candidate: 11 };
test('A–F: capture entire quiet region plus ±150 ms, retain the same candidate', () => {
  for (const [time, expected] of [[10.2, 11], [9.9, 11], [9.7, 9.7], [11.8, 11], [12.1, 11], [12.4, 12.4]]) {
    assert.equal(snapToSilenceRegion(time, [gap], 0.15), expected);
  }
  assert.equal(snapToSilenceRegion(9.85, [gap], 0.15), 11);
  assert.equal(snapToSilenceRegion(12.15, [gap], 0.15), 11);
});
test('Off, missing gaps, narrower gaps and overlapping capture zones', () => {
  assert.equal(snapToSilenceRegion(10.2, [gap], 0), 10.2);
  assert.equal(snapToSilenceRegion(10.2, [], 0.15), 10.2);
  const narrow = { start: 12.2, end: 12.3, candidate: 12.25 };
  assert.equal(snapToSilenceRegion(12.18, [gap, narrow], 0.3), 12.25);
  assert.equal(snapToSilenceRegion(12.05, [gap, narrow], 0.3), 11);
  assert.equal(snapToSilenceRegion(12.22, [gap, narrow], 0.3), 12.25);
});
test('pixel/time conversion used by the waveform preserves region capture under zoom and pan', () => {
  const duration = 1800, width = 588;
  for (const [zoom, offset] of [[1, 0], [10, 5], [100, 8], [500, 9.5]]) {
    const visibleDuration = duration / zoom;
    for (const [time, expected] of [[10.2, 11], [12.1, 11], [9.7, 9.7]]) {
      const x = ((time - offset) / visibleDuration) * width;
      const converted = offset + (x / width) * visibleDuration;
      assert.ok(Math.abs(snapToSilenceRegion(converted, [gap], 0.15) - expected) < 1e-9);
    }
  }
});
