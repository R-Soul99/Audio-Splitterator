import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSilenceLevels } from './silenceAnalysis';
import { detectSilenceSplits } from './audioProcessing';
import { detectionCandidates, quietCandidatePolicy, CHOP_CAPTURE_SECONDS, acquireQuietTarget, QuietRadarAcquisition } from './quietRadar';

function recording(loudRight = false) {
  const rate = 1000, left = new Float32Array(20000).fill(.1);
  for (const [start, end] of [[1, 3], [5, 7], [12, 14], [17, 19]]) left.fill(.001, start * rate, end * rate);
  left.fill(.1, 5900, 5920); // Existing short-spike bridging.
  const right = loudRight ? new Float32Array(left.length).fill(.1) : left;
  return { sampleRate: rate, length: left.length, duration: 20, numberOfChannels: 2,
    getChannelData: (c: number) => c ? right : left } as unknown as AudioBuffer;
}

test('shared dots preserve Auto-Split algorithm, Gap, sensitivity, stereo and edge exclusions', () => {
  for (const sensitivity of [0, 50, 100]) for (const gap of [.1, 1, 3]) for (const loudRight of [false, true]) {
    const b = recording(loudRight), policy = quietCandidatePolicy(-45, sensitivity);
    const dots = detectionCandidates(analyzeSilenceLevels(b), -45, sensitivity, gap, b.duration);
    assert.deepEqual(dots.map(d => d.candidate), detectSilenceSplits(b, policy.thresholdDb, Math.max(gap, policy.minimumSec)));
    assert.ok(dots.every(d => d.candidate >= 5 && d.candidate <= 15));
  }
  const b = recording(), levels = analyzeSilenceLevels(b);
  assert.equal(detectionCandidates(levels, -70, 100, 1, 20).length, 0);
  assert.equal(detectionCandidates(levels, -45, 100, 1, 20).length, 2);
  assert.equal(detectionCandidates(levels, -45, 100, 3, 20).length, 0);
  const marginal = [{ start: 6, end: 6.2, rms: 10 ** (-48 / 20) }];
  assert.equal(detectionCandidates(marginal, -45, 100, .1, 20).length, 1);
  assert.equal(detectionCandidates(marginal, -45, 0, .1, 20).length, 0);
});

test('fixed default capture snaps only to shared dot positions and preserves acquisition/rearming', () => {
  assert.equal(CHOP_CAPTURE_SECONDS, .15);
  const b = recording(), dots = detectionCandidates(analyzeSilenceLevels(b), -45, 100, 1, 20);
  const target = acquireQuietTarget(4.86, dots, CHOP_CAPTURE_SECONDS)!;
  assert.equal(target.time, dots[0].candidate);
  assert.equal(acquireQuietTarget(4.84, dots, CHOP_CAPTURE_SECONDS), null);
  assert.equal(acquireQuietTarget(9, dots, CHOP_CAPTURE_SECONDS), null);
  const latch = new QuietRadarAcquisition();
  assert.equal(latch.update(target), true);
  assert.equal(latch.update(acquireQuietTarget(6.5, dots, CHOP_CAPTURE_SECONDS)), false);
  assert.equal(latch.update(null), false);
  assert.equal(latch.update(target), true);
});
