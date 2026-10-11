import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackSegment, playbackPosition, timelinePosition, outputClock } from './playbackClock';

const first: PlaybackSegment = { when: 10, offset: 1.25, start: 1, end: 1.5 };
test('single-pass audition clamps at the exclusive end without wrapping', () => {
  assert.equal(playbackPosition(first, 9), 1.25);
  assert.equal(playbackPosition(first, 10), 1.25);
  assert.equal(playbackPosition(first, 10.25), 1.5);
  assert.equal(playbackPosition(first, 510.375), 1.5);
});
test('seek handover retains heard position until the scheduled source starts', () => {
  const second = { when: 10.125, offset: 2, start: 2, end: 3 };
  assert.equal(timelinePosition([first, second], 10.1), playbackPosition(first, 10.1));
  assert.equal(timelinePosition([first, second], 10.125), 2);
  assert.equal(timelinePosition([first, second], 11.5), 3);
  assert.equal(timelinePosition([], 11), null);
});
test('output timestamp tracks heard audio; fallback accounts for latency and suspension never advances', () => {
  const ctx = { currentTime: 11, state: 'running', baseLatency: .01, outputLatency: .02, getOutputTimestamp: () => ({ contextTime: 10.9, performanceTime: 1000 }) } as AudioContext;
  assert.ok(Math.abs(outputClock(ctx, 1050) - 10.95) < 1e-12);
  assert.equal(outputClock(ctx, 2000), 11);
  ctx.getOutputTimestamp = () => ({ contextTime: 0, performanceTime: 0 });
  assert.ok(Math.abs(outputClock(ctx, 2000) - 10.97) < 1e-12);
  Object.assign(ctx, { state: 'suspended' });
  assert.equal(outputClock(ctx, 10000), 11);
});
