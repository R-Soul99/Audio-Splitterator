import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackSegment, playbackPosition, timelinePosition, outputClock } from './playbackClock';

const first: PlaybackSegment = { when: 10, offset: 1.25, start: 1, end: 1.5, loop: true };
test('audition offset and repeated wraps use source boundaries without frame accumulation', () => {
  assert.equal(playbackPosition(first, 10), 1.25);
  assert.equal(playbackPosition(first, 10.25), 1);
  assert.equal(playbackPosition(first, 510.375), 1.125);
});
test('live edits rebase from render clock, retaining old audio through output latency', () => {
  const when = 10.125;
  const second = { ...first, when, offset: playbackPosition(first, when), start: 1.1, end: 1.4 };
  assert.equal(timelinePosition([first, second], 10.1), playbackPosition(first, 10.1));
  assert.equal(timelinePosition([first, second], when), 1.375);
  assert.ok(Math.abs(timelinePosition([first, second], 10.2)! - 1.15) < 1e-12);
  const jump = { ...first, when: 10.3, offset: 2, start: 2, end: 2.5 };
  assert.equal(timelinePosition([first, second, jump], 10.3), 2);
  assert.equal(timelinePosition([first, second, jump], 10.8), 2);
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
