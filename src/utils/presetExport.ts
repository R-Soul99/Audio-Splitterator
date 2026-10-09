import { LoopPreset } from './loopMemory';
import { SampleSelection } from './loopSelection';
import { sampleFilename, rotateSampleChannels } from './sampleExport';
import { SampleSaveRequest } from './desktopExport';

export interface ExportItem extends SampleSelection { id: number; beat: number; name: string; chunk: number }
export interface ExportSnapshot { sampleRate: number; channels: Float32Array[][]; items: ExportItem[]; folder: string; format: 'wav' | 'flac'; depth: 16 | 24 }
export type ItemResult = { state: 'pending' | 'saving' | 'saved' | 'failed'; path?: string; name?: string; error?: string };
export interface CollisionPolicy { mode: 'replace' | 'numbered' | null }
export function loopExportList(presets: (LoopPreset | null)[], selection: SampleSelection | null, beat: number | null) {
  const occupied = [1,2,3,4,5,6,7,8,9,0].filter(id => !!presets[id]);
  return occupied.length ? occupied.map(id => ({ id, region: { ...presets[id]! } })) : selection && beat !== null ? [{ id: -1, region: { ...selection, beat } }] : [];
}
export function writtenFilename(path: string) { return path.split(/[\\/]/).pop()!; }
export function presetFilename(base: string, slot: number, format: 'wav' | 'flac') {
  if (!Number.isInteger(slot) || slot < 0 || slot > 9) throw Error('Invalid preset slot.');
  const name = sampleFilename(base, format);
  return sampleFilename(`${name.slice(0, -(format.length + 1))}_${String(slot === 0 ? 10 : slot).padStart(2, '0')}`, format);
}
// Copy only the union of selected regions, sharing overlapping spans. One
// rotated item and encoded file are allocated at a time; retries never read live state.
export function captureExport(source: { length: number; sampleRate: number; numberOfChannels: number; getChannelData(channel: number): Float32Array }, regions: { id: number; region: Pick<LoopPreset, 'start' | 'end' | 'beat'> }[], settings: { base: string; folder: string; format: 'wav' | 'flac'; depth: 16 | 24 }, presets: boolean): ExportSnapshot {
  if (!regions.length) throw Error('Choose at least one loop.');
  for (const { region: r } of regions) if (![r.start, r.end, r.beat].every(Number.isInteger) || r.start < 0 || r.end > source.length || r.end <= r.start || r.beat < r.start || r.beat >= r.end) throw Error('Invalid stored loop boundaries.');
  const spans: SampleSelection[] = [];
  for (const { region } of [...regions].sort((a, b) => a.region.start - b.region.start)) {
    const previous = spans[spans.length - 1];
    if (previous && region.start <= previous.end) previous.end = Math.max(previous.end, region.end);
    else spans.push({ start: region.start, end: region.end });
  }
  const items = regions.map(({ id, region }) => {
    const chunk = spans.findIndex(span => span.start <= region.start && span.end >= region.end);
    const origin = spans[chunk].start;
    return { id, chunk, start: region.start - origin, end: region.end - origin, beat: region.beat - origin,
      name: presets ? presetFilename(settings.base, id, settings.format) : sampleFilename(settings.base, settings.format) };
  });
  return { sampleRate: source.sampleRate, channels: spans.map(span => Array.from({ length: source.numberOfChannels }, (_, c) => source.getChannelData(c).slice(span.start, span.end))), folder: settings.folder, format: settings.format, depth: settings.depth, items };
}
export function exportItemChannels(snapshot: ExportSnapshot, item: ExportItem) {
  const channels = snapshot.channels[item.chunk];
  return rotateSampleChannels({ length: channels[0].length, numberOfChannels: channels.length, getChannelData: c => channels[c] }, item, item.beat);
}
export async function runExport(snapshot: ExportSnapshot, results: Record<number, ItemResult>, handlers: {
  policy?: CollisionPolicy;
  cancelled: () => boolean;
  encode: (snapshot: ExportSnapshot, item: ExportItem) => Promise<Uint8Array>;
  write: (request: SampleSaveRequest) => Promise<{ status: 'saved' | 'exists'; path: string }>;
  collision: (name: string) => Promise<'replace' | 'numbered' | null>;
  update: (id: number, result: ItemResult, ordinal: number, total: number) => void;
}) {
  const remaining = snapshot.items.filter(item => results[item.id]?.state !== 'saved');
  for (const [index, item] of remaining.entries()) {
    if (handlers.cancelled()) break;
    const update = (result: ItemResult) => { results[item.id] = result; handlers.update(item.id, result, index + 1, remaining.length); };
    update({ state: 'saving' });
    try {
      const data = await handlers.encode(snapshot, item);
      if (handlers.cancelled()) { update({ state: 'pending' }); break; }
      const request: SampleSaveRequest = { name: item.name, folder: snapshot.folder, data, mode: 'ask' };
      let result = await handlers.write(request);
      if (result.status === 'exists') {
        if (handlers.cancelled()) { update({ state: 'pending' }); break; }
        const mode = handlers.policy?.mode ?? await handlers.collision(item.name);
        if (!mode || handlers.cancelled()) { update({ state: 'pending' }); break; }
        result = await handlers.write({ ...request, mode });
      }
      if (result.status !== 'saved') throw Error('File was not saved.');
      update({ state: 'saved', path: result.path, name: writtenFilename(result.path) });
    } catch (error) { update({ state: 'failed', error: (error as Error).message }); }
  }
  return { saved: snapshot.items.filter(item => results[item.id]?.state === 'saved').length, total: snapshot.items.length, cancelled: handlers.cancelled() };
}
