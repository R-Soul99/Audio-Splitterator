export const EXPORT_PAGE_SIZE = 12;

export function getExportPage<T>(tracks: readonly T[], requestedPage: number) {
  const pageCount = Math.max(1, Math.ceil(tracks.length / EXPORT_PAGE_SIZE));
  const page = Math.min(Math.max(0, Math.floor(requestedPage)), pageCount - 1);
  return { page, pageCount, items: tracks.slice(page * EXPORT_PAGE_SIZE, (page + 1) * EXPORT_PAGE_SIZE) };
}

export function getSelectedSplits<T extends { id: string }>(tracks: readonly T[], selected: Record<string, boolean>): T[] {
  return tracks.filter((track) => selected[track.id]);
}

export function getSelectionState(tracks: readonly { id: string }[], selected: Record<string, boolean>) {
  const count = getSelectedSplits(tracks, selected).length;
  return { count, all: tracks.length > 0 && count === tracks.length, mixed: count > 0 && count < tracks.length };
}

export function selectAllTracks(tracks: readonly { id: string }[], checked: boolean): Record<string, boolean> {
  return Object.fromEntries(tracks.map((track) => [track.id, checked]));
}
