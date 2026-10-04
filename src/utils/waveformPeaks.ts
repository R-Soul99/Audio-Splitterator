export interface PeakLevel { blockSize: number; min: Float32Array; max: Float32Array }
export interface ChannelPyramid { levels: PeakLevel[] }

export async function buildWaveformPeaks(buffer: AudioBuffer, signal: AbortSignal,
  onProgress: (pyramids: ChannelPyramid[], completedSamples: number) => void): Promise<void> {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
  const pyramids = channels.map(() => ({ levels: [32, 128, 512, 2048].map(blockSize => ({
    blockSize, min: new Float32Array(Math.ceil(buffer.length / blockSize)).fill(1),
    max: new Float32Array(Math.ceil(buffer.length / blockSize)).fill(-1),
  })) }));
  const chunk = 65536;
  let lastProgress = -Infinity;
  for (let start = 0; start < buffer.length; start += chunk) {
    if (signal.aborted) return;
    const end = Math.min(buffer.length, start + chunk);
    for (let channel = 0; channel < channels.length; channel++) {
      const data = channels[channel];
      const levels = pyramids[channel].levels;
      for (let offset = start; offset < end; offset += 32) {
        let min = 1, max = -1;
        for (let sample = offset; sample < Math.min(end, offset + 32); sample++) {
          min = Math.min(min, data[sample]); max = Math.max(max, data[sample]);
        }
        for (const level of levels) {
          const block = Math.floor(offset / level.blockSize);
          level.min[block] = Math.min(level.min[block], min);
          level.max[block] = Math.max(level.max[block], max);
        }
      }
    }
    const now = performance.now();
    if (end === buffer.length || now - lastProgress >= 50) {
      onProgress(pyramids, end);
      lastProgress = now;
    }
    // Give painting/input a turn between bounded chunks; percentages count real samples.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}
