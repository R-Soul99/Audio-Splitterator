import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BusyLatch,
  computeVolumeAction,
  formatDbfs,
  linearToDb,
  measureSamplePeak,
  normaliseChannels,
  performVolumeScan,
  reduceAndNormaliseChannels,
  resolveVolumeRange,
  scanHasThreshold,
  scanIsCurrent,
} from './volumeTools';

const RATE = 1000;

function fakeBuffer(channels: Float32Array[]): AudioBuffer {
  return {
    duration: channels[0].length / RATE,
    length: channels[0].length,
    sampleRate: RATE,
    numberOfChannels: channels.length,
    getChannelData: (c: number) => channels[c],
  } as unknown as AudioBuffer;
}

const create = (channels: Float32Array[]) => fakeBuffer(channels);
const db = (x: number) => Math.pow(10, x / 20);

function stereo(frames = 1000): Float32Array[] {
  const left = new Float32Array(frames).fill(0.1);
  const right = new Float32Array(frames).fill(0.05);
  return [left, right];
}

test('entire and selection scans use exact sample bounds', () => {
  const ch = stereo();
  ch[0][500] = 0.9;
  const buffer = fakeBuffer(ch);
  const whole = performVolumeScan(buffer, 'all', null, -3)!;
  assert.deepEqual(whole.range, { start: 0, end: 1000 });
  assert.ok(Math.abs(whole.peak - 0.9) < 1e-6);
  const inside = performVolumeScan(buffer, 'selection', { start: 0.4, end: 0.6 }, -3)!;
  assert.deepEqual(inside.range, { start: 400, end: 600 });
  assert.ok(Math.abs(inside.peak - 0.9) < 1e-6);
  const outside = performVolumeScan(buffer, 'selection', { start: 0.6, end: 0.8 }, -3)!;
  assert.ok(Math.abs(outside.peak - 0.1) < 1e-6);
  assert.equal(performVolumeScan(buffer, 'selection', null, -3), null);
});

test('peak is measured across channels and silence reads as minus infinity', () => {
  const ch = stereo();
  ch[1][10] = -0.7;
  assert.ok(Math.abs(measureSamplePeak(ch, { start: 0, end: 1000 }) - 0.7) < 1e-6);
  const silent = [new Float32Array(100), new Float32Array(100)];
  const peak = measureSamplePeak(silent, { start: 0, end: 100 });
  assert.equal(peak, 0);
  assert.equal(linearToDb(peak), -Infinity);
  assert.equal(formatDbfs(-Infinity), '\u2212\u221E');
  assert.equal(formatDbfs(-0.5), '-0.5');
});

test('normalise reaches every supported target and keeps stereo balance', () => {
  for (const target of [-6, -3.3, -0.5, 0]) {
    const ch = stereo();
    ch[0][5] = 0.4;
    const result = normaliseChannels(ch, { start: 0, end: 1000 }, target);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.ok(Math.abs(measureSamplePeak(result.channels, { start: 0, end: 1000 }) - db(target)) < 1e-5);
    assert.ok(Math.abs(result.channels[0][0] / result.channels[1][0] - 2) < 1e-4);
    assert.equal(ch[0][5], Math.fround(0.4), 'source is not mutated');
  }
});

test('normalise rejects silence and invalid targets without NaN', () => {
  const silent = [new Float32Array(100)];
  assert.deepEqual(normaliseChannels(silent, { start: 0, end: 100 }, -0.5), { ok: false, reason: 'silent' });
  const ch = stereo();
  for (const bad of [NaN, Infinity, 1, -7]) {
    assert.deepEqual(normaliseChannels(ch, { start: 0, end: 1000 }, bad), { ok: false, reason: 'invalid' });
  }
});

test('selection normalise leaves outside samples bit-identical', () => {
  const ch = stereo();
  ch[0][500] = 0.5;
  const before = ch.map(c => new Float32Array(c));
  const result = normaliseChannels(ch, { start: 400, end: 600 }, -0.5);
  assert.ok(result.ok);
  if (!result.ok) return;
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < 1000; i++) {
      if (i < 400 || i >= 600) assert.equal(result.channels[c][i], before[c][i]);
    }
  }
  assert.equal(result.channels[0].length, 1000);
});

test('reduce keeps the original clamp algorithm and Threshold/Ceiling semantics', () => {
  const ch = stereo();
  ch[0][300] = 0.95;
  ch[0][700] = -0.9;
  ch[1][300] = 0.8;
  const buffer = fakeBuffer(ch);
  const actual = computeVolumeAction(buffer, 'reduce', { start: 0, end: 1000 }, { thresholdDb: -3, ceilingDb: -6, targetDb: -0.5 }, create);
  assert.ok(actual.ok);
  if (!actual.ok) return;
  const threshold = db(-3), ceiling = db(-6);
  for (let c = 0; c < 2; c++) {
    const out = actual.buffer.getChannelData(c);
    for (let i = 0; i < 1000; i++) {
      const x = ch[c][i];
      const expected = Math.abs(x) > threshold && Math.abs(x) > ceiling ? Math.sign(x) * ceiling : x;
      assert.ok(Math.abs(out[i] - expected) < 1e-6);
    }
  }
  assert.equal(actual.peaksReducedCount, 2);
  assert.equal(ch[0][300], Math.fround(0.95), 'source is not mutated');
});
test('combined uses the post-reduction peak and the displayed target', () => {
  const ch = stereo();
  ch[0][300] = 0.95;
  const result = reduceAndNormaliseChannels(ch, { start: 0, end: 1000 }, { thresholdDb: -3, ceilingDb: -6, targetDb: -2 });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(Math.abs(result.peakAfterReduction - db(-6)) < 1e-6, 'peak measured after reduction, not the 0.95 scan peak');
  assert.ok(Math.abs(measureSamplePeak(result.channels, { start: 0, end: 1000 }) - db(-2)) < 1e-5);
  assert.equal(result.peaksReducedCount, 1);
});

test('combined with nothing to reduce does nothing', () => {
  const result = reduceAndNormaliseChannels(stereo(), { start: 0, end: 1000 }, { thresholdDb: -3, ceilingDb: -6, targetDb: -0.5 });
  assert.deepEqual(result, { ok: false, reason: 'nothing-to-reduce' });
});

test('combined selection leaves outside samples unchanged', () => {
  const ch = stereo();
  ch[0][500] = 0.95;
  ch[0][100] = 0.99;
  const buffer = fakeBuffer(ch);
  const result = computeVolumeAction(buffer, 'combined', { start: 400, end: 600 }, { thresholdDb: -3, ceilingDb: -6, targetDb: -1 }, create);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.buffer.getChannelData(0)[100], Math.fround(0.99));
  assert.equal(result.buffer.length, 1000);
  assert.equal(result.buffer.sampleRate, RATE);
  assert.equal(result.buffer.numberOfChannels, 2);
});

test('scans are tied to buffer, scope and exact range', () => {
  const buffer = fakeBuffer(stereo());
  const scan = performVolumeScan(buffer, 'selection', { start: 0.2, end: 0.4 }, -3)!;
  const range = resolveVolumeRange('selection', { start: 0.2, end: 0.4 }, RATE, 1000);
  assert.ok(scanIsCurrent(scan, buffer, 'selection', range));
  assert.ok(!scanIsCurrent(scan, fakeBuffer(stereo()), 'selection', range), 'new audio revision (edit, undo)');
  assert.ok(!scanIsCurrent(scan, buffer, 'all', { start: 0, end: 1000 }), 'scope changed');
  assert.ok(!scanIsCurrent(scan, buffer, 'selection', resolveVolumeRange('selection', { start: 0.2, end: 0.401 }, RATE, 1000)), 'selection edited');
  assert.ok(!scanIsCurrent(scan, buffer, 'selection', null));
  assert.ok(scanHasThreshold(scan, -3));
  assert.ok(!scanHasThreshold(scan, -4));
});

test('busy latch prevents duplicate actions and ignores stale tokens', () => {
  const latch = new BusyLatch();
  const first = latch.acquire();
  assert.notEqual(first, null);
  assert.equal(latch.acquire(), null);
  assert.ok(latch.busy);
  latch.release(999);
  assert.ok(latch.busy);
  latch.release(first!);
  assert.ok(!latch.busy);
  assert.notEqual(latch.acquire(), null);
});
