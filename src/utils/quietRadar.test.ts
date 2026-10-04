import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSilenceLevels, findSilenceRegions } from './silenceAnalysis';
import { buildQuietRuns, acquireQuietTarget } from './quietRadar';

function signal(start = 10.1, end = 10.4, loudRight = false) {
  const rate = 1000;
  const left = new Float32Array(12000).fill(10 ** (-30 / 20));
  left.fill(10 ** (-60 / 20), Math.round(start * rate), Math.round(end * rate));
  const right = loudRight ? new Float32Array(left.length).fill(10 ** (-30 / 20)) : left;
  return { length: left.length, duration: 12, sampleRate: rate, numberOfChannels: 2,
    getChannelData: (channel: number) => channel ? right : left } as unknown as AudioBuffer;
}

test('live radar acquires a 300 ms -60 dB patch with -46 dB threshold even when Gap rejects it', () => {
  const levels = analyzeSilenceLevels(signal());
  assert.deepEqual(findSilenceRegions(levels, -46, 1), []);
  const target = acquireQuietTarget(10, buildQuietRuns(levels, -46), 0.15);
  assert.ok(target);
  assert.ok(target.time >= 10.1 && target.time <= 10.15);
});
test('loud music is rejected; larger Snap reaches a more distant quiet patch', () => {
  const runs = buildQuietRuns(analyzeSilenceLevels(signal(10.4, 10.7)), -46);
  assert.equal(acquireQuietTarget(10, runs, 0.15), null);
  assert.ok(acquireQuietTarget(10, runs, 0.5));
  assert.equal(acquireQuietTarget(5, runs, 0.5), null);
  assert.equal(acquireQuietTarget(10.5, runs, 0), null);
});
test('louder stereo channel must also qualify; short windows are valid manual targets', () => {
  assert.equal(acquireQuietTarget(10.2, buildQuietRuns(analyzeSilenceLevels(signal(10.1, 10.4, true)), -46), 0.15), null);
  assert.ok(acquireQuietTarget(10.1, buildQuietRuns(analyzeSilenceLevels(signal(10.1, 10.12)), -46), 0.15));
});
test('nearby pointer movement stays on the same quiet-run identity and centre when reachable', () => {
  const runs = buildQuietRuns(analyzeSilenceLevels(signal()), -46);
  const first = acquireQuietTarget(10.2, runs, 0.15)!;
  const next = acquireQuietTarget(10.21, runs, 0.15)!;
  assert.equal(first.runStart, next.runStart);
  assert.equal(first.time, next.time);
});
