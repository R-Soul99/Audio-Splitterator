import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceSlide, slideVelocity, SLIDE_DEAD_ZONE } from './slideControl';
import { adjustStartBeatState } from './startBeat';

test('spring Slide direction, central dead zone and proportional speed', () => {
  for (const displacement of [-SLIDE_DEAD_ZONE, -.01, 0, .01, SLIDE_DEAD_ZONE]) assert.equal(Math.abs(slideVelocity(displacement, 20, 48000, false)), 0);
  const full = slideVelocity(1, 20, 48000, false);
  assert.equal(full, 240000); assert.equal(slideVelocity(-1, 20, 48000, false), -full);
  assert.equal(slideVelocity(2, 20, 48000, false), full);
  assert.ok(Math.abs(slideVelocity(.54, 20, 48000, false) - full / 2) < 1e-8);
});
test('visible-span scaling and Shift change velocity, never reset sample position', () => {
  assert.equal(slideVelocity(1, 20, 48000, true), slideVelocity(1, 20, 48000, false) / 10);
  assert.equal(slideVelocity(1, 1, 48000, false), slideVelocity(1, 20, 48000, false) / 20);
  assert.equal(slideVelocity(1, 1, 96000, false), slideVelocity(1, 1, 48000, false) * 2);
  const state = { position: 48001, remainder: .123 };
  for (const fine of [true, false]) assert.deepEqual(advanceSlide(state, slideVelocity(.5, 20, 48000, fine), 0, 1000000), state);
});
test('elapsed-time movement agrees across frame rates and irregular frame delivery', () => {
  const velocity = slideVelocity(.37, 3.17, 44100, true);
  const expected = advanceSlide({ position: 48001, remainder: 0 }, velocity, 1, 1000000);
  for (const fps of [1, 10, 30, 60, 120, 240]) {
    let state = { position: 48001, remainder: 0 };
    for (let i = 0; i < fps; i++) state = advanceSlide(state, velocity, 1 / fps, 1000000);
    assert.equal(state.position, expected.position); assert.ok(Math.abs(state.remainder - expected.remainder) < 1e-7);
  }
  let irregular = { position: 48001, remainder: 0 };
  for (const elapsed of [.003, .2, .01, .5, .287]) irregular = advanceSlide(irregular, velocity, elapsed, 1000000);
  assert.equal(irregular.position, expected.position);
});
test('fractional samples accumulate while output remains integer-aligned', () => {
  let state = { position: 100, remainder: 0 };
  for (let i = 0; i < 100; i++) { state = advanceSlide(state, .2, .1, 1000); assert.ok(Number.isInteger(state.position)); }
  assert.equal(state.position, 102); assert.ok(Math.abs(state.remainder) < 1e-8);
});
test('precise boundary clamps discard overshoot and reverse immediately with exact length / beat offset', () => {
  let state = advanceSlide({ position: 999, remainder: .1 }, 1000, 10, 1000);
  assert.deepEqual(state, { position: 1000, remainder: 0 });
  state = advanceSlide(state, -10, .1, 1000); assert.deepEqual(state, { position: 999, remainder: 0 });
  state = advanceSlide(state, -1000, 10, 1000); assert.deepEqual(state, { position: 0, remainder: 0 });
  state = advanceSlide(state, 10, .1, 1000); assert.deepEqual(state, { position: 1, remainder: 0 });
  const old = { start: 48001, end: 144007 }, next = { start: state.position, end: state.position + old.end - old.start };
  const beat = adjustStartBeatState(old, next, 72013, true, 'move');
  assert.equal(next.end - next.start, 96006); assert.equal(beat.sample! - next.start, 24012); assert.equal(beat.custom, true);
});
