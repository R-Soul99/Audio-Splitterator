import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjustStartBeat, placementSample } from './startBeat';
const previous = { start: 100, end: 300 };
test('Start Beat moves with whole region, retains absolute position on edge edits, resets when excluded', () => {
  assert.equal(adjustStartBeat(previous, { start: 200, end: 400 }, 150, 'move'), 250);
  assert.equal(adjustStartBeat(previous, { start: 140, end: 280 }, 150, 'edge'), 150);
  assert.equal(adjustStartBeat(previous, { start: 160, end: 280 }, 150, 'edge'), 160);
  assert.equal(adjustStartBeat(previous, { start: 100, end: 150 }, 150, 'edge'), 100);
  assert.equal(adjustStartBeat(previous, previous, 150, 'new'), 100);
  assert.equal(adjustStartBeat(previous, null, 150, 'edge'), null);
  assert.equal(adjustStartBeat(null, previous, null, 'edge'), 100);
});
test('placement snaps to source sample and selection end is exclusive', () => {
  assert.equal(placementSample(1.5001, 100, previous), 150);
  assert.equal(placementSample(1, 100, previous), 100);
  assert.equal(placementSample(3, 100, previous), null);
  assert.equal(placementSample(.99, 100, previous), null);
  assert.equal(placementSample(2, 100, null), null);
});
