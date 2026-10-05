import test from 'node:test';
import assert from 'node:assert/strict';
import { combinedStereoLevelDb } from './recordingDisplay';

test('combined display uses stereo energy, retaining equal/opposite channel levels without cancellation', () => {
  const left = Float32Array.from([0.5, -0.5]);
  const right = Float32Array.from([-0.5, 0.5]);
  const level = (samples: Float32Array) => 10 * Math.log10(samples.reduce((sum, value) => sum + value ** 2, 0) / samples.length);
  assert.equal(combinedStereoLevelDb(level(left), level(right)), level(left));
  assert.deepEqual([...left], [0.5, -0.5]);
  assert.deepEqual([...right], [-0.5, 0.5]);
  assert.ok(Math.abs(combinedStereoLevelDb(0, -60) + 3.0102956) < 1e-6);
});
