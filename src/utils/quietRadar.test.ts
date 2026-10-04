import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSilenceLevels, findSilenceRegions } from './silenceAnalysis';
import { buildQuietRuns, acquireQuietTarget, QuietRadarAcquisition } from './quietRadar';

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

const acquisitionRuns = [
  { start: 10, end: 12, candidate: 11 },
  { start: 14, end: 16, candidate: 15 },
];
const capture = (time: number) => acquireQuietTarget(time, acquisitionRuns, 0.15);

test('entering a quiet capture zone emits one acquisition, including the Snap margin', () => {
  const acquisition = new QuietRadarAcquisition();
  assert.equal(acquisition.update(capture(9.9)), true);
  assert.equal(acquisition.update(capture(10)), false);
});

test('movement across the whole quiet region and both Snap margins never repeats the ping', () => {
  const acquisition = new QuietRadarAcquisition();
  const times = [9.9, 10.05, 10.2, 10.9, 11, 11.8, 12, 12.1, 11.2, 10.1];
  const targets = times.map(capture);
  assert.ok(targets.every(target => target?.runStart === 10));
  assert.ok(new Set(targets.map(target => target?.time)).size > 1, 'snap timestamps vary within one region');
  assert.deepEqual(targets.map(target => acquisition.update(target)), [true, ...times.slice(1).map(() => false)]);
  // Re-evaluation after any amount of time also stays acquired; no cooldown exists.
  for (let move = 0; move < 1000; move++) assert.equal(acquisition.update(capture(10.1)), false);
});

test('leaving the acquisition zone re-arms and re-entering emits one new event immediately', () => {
  const acquisition = new QuietRadarAcquisition();
  assert.equal(acquisition.update(capture(10.2)), true);
  assert.equal(capture(12.4), null);
  assert.equal(acquisition.update(capture(12.4)), false);
  assert.equal(acquisition.update(null), false);
  assert.equal(acquisition.update(capture(10.2)), true);
  assert.equal(acquisition.update(capture(10.3)), false);
});

test('moving directly to a distinct quiet region emits a new acquisition', () => {
  const acquisition = new QuietRadarAcquisition();
  assert.equal(acquisition.update(capture(10.2)), true);
  assert.equal(acquisition.update(capture(14.2)), true);
  assert.equal(acquisition.update(capture(15.8)), false);
  assert.equal(acquisition.update(capture(10.2)), true);
});

test('pointer exit or cancellation resets acquisition even when no outside sample is evaluated', () => {
  const acquisition = new QuietRadarAcquisition();
  assert.equal(acquisition.update(capture(10.2)), true);
  acquisition.reset();
  assert.equal(acquisition.update(capture(10.2)), true);
  assert.equal(acquisition.update(capture(10.2)), false);
});

test('Snap Off loses acquisition and switching it back on can re-acquire', () => {
  const acquisition = new QuietRadarAcquisition();
  assert.equal(acquisition.update(capture(10.2)), true);
  assert.equal(acquisition.update(acquireQuietTarget(10.2, acquisitionRuns, 0)), false);
  assert.equal(acquisition.update(capture(10.2)), true);
});

test('20 ms above-threshold interruption changes candidates without reacquiring the quiet area', () => {
  const buffer = signal(10, 10.3);
  buffer.getChannelData(0).fill(0.1, 10100, 10120);
  const runs = buildQuietRuns(analyzeSilenceLevels(buffer), -46);
  assert.deepEqual(runs.map(run => [run.start, run.end]), [[10, 10.1], [10.12, 10.3]]);
  const acquisition = new QuietRadarAcquisition();
  const times = [9.86, 10.02, 10.09, 10.11, 10.14, 10.28, 10.44, 10.14, 10.02, 10.28];
  const targets = times.map(time => acquireQuietTarget(time, runs, 0.15)!);
  assert.equal(new Set(targets.map(target => target.runStart)).size, 2);
  assert.deepEqual(targets.map(target => acquisition.update(target)), [true, ...times.slice(1).map(() => false)]);
  assert.equal(targets[0].zone.start, 9.85);
  assert.ok(Math.abs(targets[0].zone.end - 10.45) < 1e-9);
  assert.equal(acquisition.update(acquireQuietTarget(10.46, runs, 0.15)), false);
  assert.equal(acquisition.update(acquireQuietTarget(10.28, runs, 0.15)), true);
  assert.equal(acquisition.update(acquireQuietTarget(9.84, runs, 0.15)), false);
  assert.equal(acquisition.update(acquireQuietTarget(10.02, runs, 0.15)), true);
  // Grouping does not move snap targets into the interruption or merge centres.
  assert.equal(acquireQuietTarget(10.05, runs, 0.15)!.time, runs[0].candidate);
  assert.equal(acquireQuietTarget(10.21, runs, 0.15)!.time, runs[1].candidate);
});

test('touching envelopes and transitive neighbours share acquisition; separated areas do not', () => {
  const runs = [
    { start: 1, end: 1.25, candidate: 1.125 },
    { start: 1.5, end: 1.75, candidate: 1.625 },
    { start: 2, end: 2.25, candidate: 2.125 },
    { start: 3, end: 3.25, candidate: 3.125 },
  ];
  const acquisition = new QuietRadarAcquisition();
  const capture = (time: number) => acquireQuietTarget(time, runs, 0.125);
  const times = [0.875, 1.125, 1.375, 1.625, 1.875, 2.125, 2.375, 1.125];
  assert.ok(times.every(time => capture(time) !== null));
  assert.deepEqual(times.map(time => acquisition.update(capture(time))), [true, ...times.slice(1).map(() => false)]);
  assert.equal(acquisition.update(capture(2.5)), false);
  assert.equal(acquisition.update(capture(3.125)), true);
  assert.equal(acquisition.update(capture(3.2)), false);
  // A jump to another disjoint envelope also establishes that the old zone was left.
  assert.equal(acquisition.update(capture(1.625)), true);
});
