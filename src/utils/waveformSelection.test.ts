import test from 'node:test';
import assert from 'node:assert/strict';
import { selectionEndpoint } from './waveformSelection';

test('selection reaches exact recording boundaries even with snapping and overshoot', () => {
  const duration = 100001 / 48000;
  const snap = () => duration - 0.02;
  assert.equal(selectionEndpoint(duration, duration, snap), duration);
  assert.equal(selectionEndpoint(duration + 0.1, duration, snap), duration);
  assert.equal(selectionEndpoint(-0.1, duration, snap), 0);
  assert.equal(selectionEndpoint(0, duration, snap), 0);
});
test('interior selection keeps existing snapping and clamps out-of-range snapped targets', () => {
  assert.equal(selectionEndpoint(4.2, 10, () => 4.25), 4.25);
  assert.equal(selectionEndpoint(9.9, 10, () => 12), 10);
  assert.equal(selectionEndpoint(0.1, 10, () => -1), 0);
  assert.equal(selectionEndpoint(4.2, 10), 4.2);
});
