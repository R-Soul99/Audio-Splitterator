import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSilenceLevels, analyzeSilenceLevelsChunked } from './silenceAnalysis';
import { buildWaveformPeaks } from './waveformPeaks';

const channels = [Float32Array.from({ length: 180003 }, (_, i) => Math.sin(i) * .4),
  Float32Array.from({ length: 180003 }, (_, i) => Math.cos(i) * .7)];
const buffer = { length: channels[0].length, numberOfChannels: 2, sampleRate: 44100,
  duration: channels[0].length / 44100, getChannelData: (c: number) => channels[c] } as AudioBuffer;

test('chunked silence preparation preserves exact stereo windows, reversed bounds and partial samples', async () => {
  for (const [start, end] of [[0, buffer.duration], [.123456, 3.78901], [3.78901, .123456]]) {
    assert.deepEqual(await analyzeSilenceLevelsChunked(buffer, new AbortController().signal, start, end),
      analyzeSilenceLevels(buffer, start, end));
  }
});

test('superseded peak analysis never publishes over its replacement', async () => {
  const stale = new AbortController();
  const latest = new AbortController();
  const publications: string[] = [];
  const first = buildWaveformPeaks(buffer, stale.signal, () => {
    publications.push('old'); stale.abort();
  });
  await first;
  await buildWaveformPeaks(buffer, latest.signal, () => publications.push('new'));
  assert.equal(publications.filter(p => p === 'old').length, 1);
  assert.equal(publications.at(-1), 'new');
});

test('analysis yields before publishing and handles cancellation before its first chunk', async () => {
  const controller = new AbortController();
  let publications = 0;
  const pending = buildWaveformPeaks(buffer, controller.signal, () => publications++);
  assert.equal(publications, 0);
  controller.abort();
  await pending;
  assert.equal(publications, 0);
  assert.deepEqual(await analyzeSilenceLevelsChunked(buffer, controller.signal), []);
});
