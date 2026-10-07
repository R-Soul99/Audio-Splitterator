import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finaliseRecordingTake } from './recordingTake';

const chunks = [[new Float32Array([.25, .5]), new Float32Array([.75])], [new Float32Array([-.5, -.25]), new Float32Array([.5])]];
const create = (channels: number, length: number, sampleRate: number) => {
  const data = Array.from({ length: channels }, () => new Float32Array(length));
  return { length, sampleRate, numberOfChannels: channels, duration: length / sampleRate, getChannelData: (channel: number) => data[channel] } as AudioBuffer;
};

test('complete take preserves rate, aligned channels and consecutive captured sections', async () => {
  await finaliseRecordingTake(create, chunks, 3, 44100, buffer => {
    assert.equal(buffer.duration, 3 / 44100);
    assert.deepEqual([...buffer.getChannelData(0)], [.25, .5, .75]);
    assert.deepEqual([...buffer.getChannelData(1)], [-.5, -.25, .5]);
  });
  assert.deepEqual([...chunks[0][0]], [.25, .5]);
});

test('finalisation waits for asynchronous loading; rejection retains chunks for retry', async () => {
  let reject!: (error: Error) => void;
  let settled = false;
  const pending = finaliseRecordingTake(create, chunks, 3, 48000, () => new Promise<void>((_, fail) => { reject = fail; }));
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  reject(new Error('Loading failed'));
  await assert.rejects(pending, /Loading failed/);
  await finaliseRecordingTake(create, chunks, 3, 48000, buffer => assert.equal(buffer.length, 3));
});

test('allocation and synchronous loading failures retain PCM; empty or incomplete take is rejected', async () => {
  await assert.rejects(finaliseRecordingTake(() => { throw new Error('Allocation failed'); }, chunks, 3, 44100, () => {}), /Allocation failed/);
  await assert.rejects(finaliseRecordingTake(create, chunks, 3, 44100, () => { throw new Error('Load failed'); }), /Load failed/);
  await assert.rejects(finaliseRecordingTake(create, [[]], 0, 44100, () => {}), /No audio captured/);
  await assert.rejects(finaliseRecordingTake(create, [chunks[0], []], 3, 44100, () => {}), /Incomplete capture channel/);
  assert.deepEqual([...chunks[0][1]], [.75]);
});
