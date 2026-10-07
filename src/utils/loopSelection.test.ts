import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editSamples, resizeSamples, sampleSelection, sampleTimes, parseLoopTime, loopEditPosition, adjustmentSamples, adjustBeatSample } from './loopSelection';
const region = { start: 100, end: 300 };
test('halving/doubling with either boundary fixed, and rejected overflow', () => {
  assert.deepEqual(resizeSamples(region, .5, 'start', 1000), { start: 100, end: 200 });
  assert.deepEqual(resizeSamples(region, .5, 'end', 1000), { start: 200, end: 300 });
  assert.deepEqual(resizeSamples(region, 2, 'start', 1000), { start: 100, end: 500 });
  assert.equal(resizeSamples(region, 2, 'end', 1000), null);
  assert.deepEqual(resizeSamples({ start: 400, end: 600 }, 2, 'end', 1000), { start: 200, end: 600 });
  assert.equal(resizeSamples({ start: 1, end: 2 }, .5, 'start', 1000), null);
  assert.equal(resizeSamples({ start: 1, end: 4 }, .5, 'start', 1000), null, 'Do not silently round an odd sample span');
  assert.equal(resizeSamples(region, 10, 'start', 1000), null);
});
test('whole moves preserve exact sample length; no partial boundary steps', () => {
  assert.deepEqual(editSamples(region, 'whole', 200, 1000), { start: 300, end: 500 });
  assert.equal(editSamples(region, 'whole', -200, 1000), null);
  assert.deepEqual(editSamples(region, 'whole', -100, 1000), { start: 0, end: 200 });
  assert.equal(editSamples({ start: 800, end: 1000 }, 'whole', 1, 1000), null);
});
test('independent edge edits preserve one sample and reject crossing/bounds', () => {
  assert.deepEqual(editSamples(region, 'start', 199, 1000), { start: 299, end: 300 });
  for (const [target, delta] of [['start', 200], ['start', -101], ['end', -200], ['end', 701]] as const) assert.equal(editSamples(region, target, delta, 1000), null);
});
test('sample rate conversion, reversed selection and time entry', () => {
  for (const rate of [44100, 48000, 96000]) {
    assert.deepEqual(sampleSelection(sampleTimes({ start: 5, end: 6 }, rate), rate, rate), { start: 5, end: 6 });
    assert.equal(sampleSelection({ start: 0, end: 0 }, rate, rate), null);
  }
  assert.deepEqual(sampleSelection({ start: 3, end: 1 }, 100, 500), region);
  assert.equal(sampleSelection({ start: NaN, end: 1 }, 100, 500), null);
  assert.equal(parseLoopTime('1:02.125'), 62.125);
  assert.equal(parseLoopTime('0.001'), .001);
  for (const text of ['-1', '1:99', 'junk', 'Infinity']) assert.equal(parseLoopTime(text), null);
});
test('loop edits retain position inside, safely restart at either excluded edge', () => {
  assert.deepEqual(loopEditPosition(2, { start: 1, end: 3 }), { position: 2, restart: false });
  for (const position of [0, 3, 4]) assert.deepEqual(loopEditPosition(position, { start: 1, end: 3 }), { position: 1, restart: true });
});

test('coarse/fine steps align to each source rate and Start Beat excludes End', () => {
  for (const rate of [44100, 48000, 96000]) {
    assert.equal(adjustmentSamples(rate, false), Math.round(rate / 100));
    assert.equal(adjustmentSamples(rate, true), Math.round(rate / 1000));
    const delta = adjustmentSamples(rate, true);
    assert.deepEqual(editSamples({ start: 0, end: rate }, 'start', delta, rate), { start: delta, end: rate });
    assert.equal(editSamples({ start: 0, end: delta }, 'start', delta, rate), null);
    assert.equal(adjustBeatSample(rate - delta, { start: 0, end: rate }, delta), null);
    assert.equal(adjustBeatSample(delta, { start: 0, end: rate }, -delta), 0);
    assert.equal(adjustBeatSample(0, { start: 0, end: rate }, -delta), null);
  }
});
