import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waveformAmplitudeScale, slideSamplesPerPixel } from './waveformDisplay';

test('full scale fills 96% of each channel at unity with symmetrical fixed margins', () => {
  for (const height of [100, 118, 180]) for (const channel of [0, 1]) {
    const center = (channel + .5) * height, scale = waveformAmplitudeScale(height, 1);
    assert.ok(Math.abs(center - scale - (channel + .02) * height) < 1e-10);
    assert.ok(Math.abs(center + scale - (channel + .98) * height) < 1e-10);
    assert.equal(waveformAmplitudeScale(height, .5), scale / 2);
    assert.equal(waveformAmplitudeScale(height, 2), scale * 2);
    assert.equal(.02 * scale, .02 * waveformAmplitudeScale(height, 1), 'Quiet recordings retain their true amplitude');
  }
});
test('encoder movement is a consistent visible-span proportion, independent of source or selection', () => {
  for (const span of [.001, .1, 20, 3600]) {
    const sensitivity = slideSamplesPerPixel(span, 550, 48000);
    assert.ok(Math.abs(sensitivity * 50 / 48000 / span - 50 / 550) < 1e-10);
    assert.ok(Math.abs(sensitivity * .1 * 50 / 48000 / span - 5 / 550) < 1e-10);
  }
  assert.ok(slideSamplesPerPixel(.001, 550, 48000) < 1, 'Subsample movements remain fractional');
});
