import { SampleSelection } from './loopSelection';
// Copy raw channels only. Track extraction applies fades/zero crossings and is deliberately not used.
export function rotateSampleChannels(source: { length: number; numberOfChannels: number; getChannelData(channel: number): Float32Array }, selection: SampleSelection, beat: number): Float32Array[] {
  const { start, end } = selection;
  if (![start, end, beat].every(Number.isInteger) || start < 0 || end > source.length || end <= start || beat < start || beat >= end) throw Error('Invalid sample boundaries.');
  return Array.from({ length: source.numberOfChannels }, (_, channel) => {
    const original = source.getChannelData(channel);
    const result = new Float32Array(end - start);
    result.set(original.subarray(beat, end));
    result.set(original.subarray(start, beat), end - beat);
    return result;
  });
}
export function snapshotSample(source: AudioBuffer, selection: SampleSelection, beat: number): AudioBuffer {
  const channels = rotateSampleChannels(source, selection, beat);
  const snapshot = new AudioBuffer({ length: selection.end - selection.start, sampleRate: source.sampleRate, numberOfChannels: source.numberOfChannels });
  channels.forEach((data, channel) => snapshot.copyToChannel(data, channel));
  return snapshot;
}
export function sampleFilename(value: string, format: 'wav' | 'flac'): string {
  const stem = value.trim().replace(/\.(wav|flac)$/i, '');
  if (!stem || /[<>:"/\\|?*\x00-\x1f]/.test(stem) || /[. ]$/.test(stem) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(stem) || stem === '.' || stem === '..' || stem.length > 200) throw Error('Enter a valid sample filename (no path or reserved characters).');
  return `${stem}.${format}`;
}
