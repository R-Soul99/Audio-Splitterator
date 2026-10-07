import { test } from 'node:test';
import assert from 'node:assert/strict';
import { samplePreferences } from './samplePreferences';

test('sample export defaults to FLAC 16-bit and preserves explicit preferences independently', () => {
  assert.deepEqual(samplePreferences(null, null), { format: 'flac', depth: 16 });
  for (const format of ['wav', 'flac'] as const) for (const depth of [16, 24] as const) {
    assert.deepEqual(samplePreferences(format, String(depth)), { format, depth });
  }
  assert.deepEqual(samplePreferences('wav', null), { format: 'wav', depth: 16 });
  assert.deepEqual(samplePreferences(null, '24'), { format: 'flac', depth: 24 });
});
