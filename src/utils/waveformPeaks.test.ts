import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWaveformPeaks, ChannelPyramid } from './waveformPeaks';

test('chunked peaks match original min/max at every resolution, including partial blocks', async () => {
  const channels = [Float32Array.from({ length: 140003 }, (_, index) => Math.sin(index)),
    Float32Array.from({ length: 140003 }, (_, index) => Math.cos(index))];
  const buffer = { length: channels[0].length, numberOfChannels: 2, getChannelData: (channel: number) => channels[channel] } as unknown as AudioBuffer;
  let result: ChannelPyramid[] = [];
  const progress: number[] = [];
  await buildWaveformPeaks(buffer, new AbortController().signal, (pyramids, completed) => { result = pyramids; progress.push(completed); });
  assert.ok(progress[0] < buffer.length);
  assert.equal(progress.at(-1), buffer.length);
  for (let channel = 0; channel < channels.length; channel++) for (const level of result[channel].levels) {
    for (let block = 0; block < level.min.length; block++) {
      const data = channels[channel].subarray(block * level.blockSize, (block + 1) * level.blockSize);
      assert.equal(level.min[block], Math.min(1, ...data));
      assert.equal(level.max[block], Math.max(-1, ...data));
    }
  }
});
test('aborted analysis stops publishing stale progress', async () => {
  const controller = new AbortController();
  const data = new Float32Array(200000);
  const buffer = { length: data.length, numberOfChannels: 1, getChannelData: () => data } as unknown as AudioBuffer;
  let updates = 0;
  await buildWaveformPeaks(buffer, controller.signal, () => { updates++; controller.abort(); });
  assert.equal(updates, 1);
});
