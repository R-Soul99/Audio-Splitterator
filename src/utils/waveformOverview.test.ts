import test from 'node:test';
import assert from 'node:assert/strict';
import { overviewPeaks } from './waveformOverview';

const pyramid = { levels: [{ blockSize: 1, min: new Float32Array([-.1, -.2, -.3, -.4, -.5]), max: new Float32Array([.1, .2, .3, .4, .5]) }] };
test('overview spans the full recording with unequal pixel intervals and ordered peaks', () => {
  const peaks = overviewPeaks(pyramid, 5, 5, 3);
  assert.equal(peaks.length, 3);
  assert.equal(peaks[2]?.max, .5);
  assert.equal(peaks[2]?.min, -.5);
  assert.ok(peaks.every(peak => peak && peak.min < peak.max));
});
test('overview supports short recordings and leaves unanalyzed samples blank', () => {
  assert.equal(overviewPeaks(pyramid, 5, 5, 10)[9]?.max, .5);
  assert.deepEqual(overviewPeaks(pyramid, 5, 2, 5).slice(2), [null, null, null]);
  assert.deepEqual(overviewPeaks(pyramid, 5, 0, 3), [null, null, null]);
});
