import test from 'node:test';
import assert from 'node:assert/strict';
import { getExportPage, getSelectedSplits, getSelectionState, selectAllTracks, EXPORT_PAGE_SIZE } from './exportPanel';
const tracks = Array.from({ length: 19 }, (_, index) => ({ id: String(index), title: `Track ${index}` }));
test('pagination keeps source indices, handles final/empty pages and clamps after removal', () => {
  assert.deepEqual(getExportPage(tracks, 1).items, tracks.slice(EXPORT_PAGE_SIZE, EXPORT_PAGE_SIZE * 2));
  assert.equal(getExportPage(tracks, 1).items.length, 7);
  assert.equal(getExportPage(tracks.slice(0, 2), 2).page, 0);
  assert.deepEqual(getExportPage([], 9), { page: 0, pageCount: 1, items: [] });
});
test('global selection and export include every page and ignore stale IDs', () => {
  const selected = selectAllTracks(tracks, true);
  assert.deepEqual(getSelectionState(tracks, selected), { count: 19, all: true, mixed: false });
  selected['0'] = false;
  selected.stale = true;
  assert.deepEqual(getSelectionState(tracks, selected), { count: 18, all: false, mixed: true });
  assert.deepEqual(getSelectedSplits(tracks, selected), tracks.slice(1));
  assert.equal(getSelectedSplits(tracks, selectAllTracks(tracks, false)).length, 0);
  assert.deepEqual(getSelectionState([], selected), { count: 0, all: false, mixed: false });
});
test('paging never mutates title edits or selection keyed by track identity', () => {
  const edited = tracks.map((track) => track.id === '13' ? { ...track, title: 'Edited title' } : track);
  const selected = { '13': true, '18': true };
  getExportPage(edited, 2);
  assert.equal(getExportPage(edited, 1).items[1].title, 'Edited title');
  assert.deepEqual(getSelectedSplits(edited, selected).map((track) => track.id), ['13', '18']);
});
