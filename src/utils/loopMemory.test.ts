import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLoopMemory, loopSnapshot, matchingLoopSlot, memoryDigit } from './loopMemory';
import { sampleTimes, sampleSelection } from './loopSelection';
import { rotateSampleChannels } from './sampleExport';

test('memory snapshots preserve exact samples and custom/default marker identity', () => {
  const snapshot = loopSnapshot({ start: 48001, end: 144007 }, 72013, true, 200000)!;
  assert.deepEqual(snapshot, { start: 48001, end: 144007, beat: 72013, custom: true });
  assert.deepEqual(sampleSelection(sampleTimes(snapshot, 48000), 48000, 200000), { start: 48001, end: 144007 });
  assert.equal(loopSnapshot(snapshot, snapshot.start, true, 200000)!.custom, true);
  assert.equal(loopSnapshot(snapshot, 72013, false, 200000)!.beat, 48001);
  for (const beat of [48000, 144007, 72013.5, null]) assert.equal(loopSnapshot(snapshot, beat, true, 200000), null);
  assert.equal(loopSnapshot(snapshot, 72013, true, 144006), null);
  assert.equal(loopSnapshot(null, null, false, 200000), null);
});
test('matching prefers most recently used identical slot; edits never mutate presets', () => {
  const current = loopSnapshot({ start: 1, end: 10 }, 3, true, 20)!;
  const slots = emptyLoopMemory(); slots[7] = { ...current, used: 1 }; slots[0] = { ...current, used: 2 };
  assert.equal(matchingLoopSlot(slots, current), 0);
  slots[7] = { ...slots[7]!, used: 3 }; assert.equal(matchingLoopSlot(slots, current), 7);
  for (const change of [{ start: 2 }, { end: 9 }, { beat: 4 }, { custom: false }]) assert.equal(matchingLoopSlot(slots, { ...current, ...change }), null);
  assert.equal(slots[7]!.start, 1); slots[7] = null; assert.equal(matchingLoopSlot(slots, current), 0);
  assert.equal(matchingLoopSlot(emptyLoopMemory(), current), null);
});
test('digit shortcuts reject modified, repeating and Num Lock off navigation events', () => {
  const event = { key: '0', repeat: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };
  for (const key of '0123456789') assert.equal(memoryDigit({ ...event, key }), Number(key));
  for (const modifier of ['repeat', 'shiftKey', 'ctrlKey', 'altKey', 'metaKey']) assert.equal(memoryDigit({ ...event, [modifier]: true }), null);
  for (const key of ['Insert', 'End', 'ArrowDown', 'Delete', '!']) assert.equal(memoryDigit({ ...event, key }), null);
});
test('recalled snapshots feed existing export with exact stereo order and count', () => {
  const channels = [Float32Array.from([0,1,2,3,4,5]), Float32Array.from([10,11,12,13,14,15])];
  const snapshot = loopSnapshot({ start: 1, end: 6 }, 4, true, 6)!;
  const output = rotateSampleChannels({ length: 6, numberOfChannels: 2, getChannelData: (c: number) => channels[c] }, snapshot, snapshot.beat);
  assert.deepEqual(output.map(c => Array.from(c)), [[4,5,1,2,3], [14,15,11,12,13]]);
});
