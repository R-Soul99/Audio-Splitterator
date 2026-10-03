import test from 'node:test';
import assert from 'node:assert/strict';
import { filterAutoSplitCandidates, mergeAutoSplitMarkers } from './autoSplitPolicy';
import { detectSilenceSplits } from './audioProcessing';
import { analyzeSilenceLevels, findSilenceRegions, snapToSilenceCandidate } from './silenceAnalysis';

test('auto edge policy is inclusive at five seconds and rejects short recordings', () => {
  assert.deepEqual(filterAutoSplitCandidates([0, 4.99, 5, 10, 15, 15.01, 20], 20), [5, 10, 15]);
  assert.deepEqual(filterAutoSplitCandidates([2, 4], 8), []);
});
test('Apply preserves manual markers and replaces previous auto results without duplicates', () => {
  const manual = { id: 'manual-one', time: 1 };
  const existing = [manual, { id: 'marker-auto-old', time: 10 }];
  assert.deepEqual(mergeAutoSplitMarkers(existing, [{ id: 'marker-auto-new', time: 12 }]),
    [manual, { id: 'marker-auto-new', time: 12 }]);
  assert.deepEqual(mergeAutoSplitMarkers(existing, []), existing);
  assert.deepEqual(mergeAutoSplitMarkers([manual], [{ id: 'marker-auto-duplicate', time: 1 }]), [manual]);
});
test('edge exclusion applies to auto detection, while manual snapping still uses edge gaps', () => {
  const data = new Float32Array(20000).fill(0.2);
  for (const [start, end] of [[1000, 3000], [9000, 11000], [17000, 19000]]) data.fill(0.001, start, end);
  const buffer = { duration: 20, length: data.length, sampleRate: 1000, numberOfChannels: 1, getChannelData: () => data } as unknown as AudioBuffer;
  assert.deepEqual(detectSilenceSplits(buffer, -45, 1), [10]);
  const candidates = findSilenceRegions(analyzeSilenceLevels(buffer), -45, 1).map(region => region.candidate);
  assert.deepEqual(candidates, [2, 10, 18]);
  assert.equal(snapToSilenceCandidate(1.9, candidates, 0.15), 2);
});
