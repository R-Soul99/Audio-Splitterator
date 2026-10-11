import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleSelection } from './sampleSelection';

test('shared selection bounds preserve reversed, submillisecond and final-frame regions', () => {
  const rate = 48000, frames = 96001;
  assert.deepEqual(sampleSelection({ start: 96000 / rate, end: frames / rate }, rate, frames), { start: 96000, end: frames });
  assert.deepEqual(sampleSelection({ start: 121 / rate, end: 101 / rate }, rate, frames), { start: 101, end: 121 });
});

test('invalid and collapsed selections cannot become playback or volume regions', () => {
  for (const region of [null, { start: 1, end: 1 }, { start: -1, end: 1 }, { start: 0, end: 3 }, { start: NaN, end: 1 }, { start: 0, end: Infinity }]) {
    assert.equal(sampleSelection(region, 48000, 96000), null);
  }
  assert.equal(sampleSelection({ start: 0, end: 1 }, 0, 96000), null);
});
