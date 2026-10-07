import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rotateSampleChannels, sampleFilename } from './sampleExport';
const channels = [Float32Array.from([0, 1, 2, 3, 4, 5]), Float32Array.from([10, 11, 12, 13, 14, 15])];
const source = { length: 6, numberOfChannels: 2, getChannelData: (channel: number) => channels[channel] };
test('default and rotated sample exports copy exactly one cycle with stereo alignment', () => {
  assert.deepEqual(rotateSampleChannels(source, { start: 1, end: 5 }, 1).map(data => Array.from(data)), [[1, 2, 3, 4], [11, 12, 13, 14]]);
  const result = rotateSampleChannels(source, { start: 1, end: 5 }, 3);
  assert.deepEqual(result.map(data => Array.from(data)), [[3, 4, 1, 2], [13, 14, 11, 12]]);
  channels[0][3] = 99; assert.equal(result[0][0], 3, 'Snapshot is independent'); channels[0][3] = 3;
});
test('one sample, final sample, rotation at last included sample, and exclusive end', () => {
  assert.deepEqual(rotateSampleChannels(source, { start: 5, end: 6 }, 5)[0], Float32Array.of(5));
  assert.deepEqual(rotateSampleChannels(source, { start: 0, end: 6 }, 5)[0], Float32Array.from([5, 0, 1, 2, 3, 4]));
  for (const beat of [-1, 6, .5]) assert.throws(() => rotateSampleChannels(source, { start: 0, end: 6 }, beat));
});
test('filenames match format and reject traversal, reserved names and invalid components', () => {
  assert.equal(sampleFilename('My Loop.wav', 'flac'), 'My Loop.flac');
  assert.equal(sampleFilename('Loop', 'wav'), 'Loop.wav');
  for (const value of ['', '../loop', 'C:\\loop', 'NUL', 'con.wav', 'bad?', 'loop.', '.']) assert.throws(() => sampleFilename(value, 'wav'));
});
