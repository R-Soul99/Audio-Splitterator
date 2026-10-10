import { ChannelPyramid } from './waveformPeaks';

// Map every overview pixel to its full-recording sample interval, never a
// rounded stride that can run out of peaks before the right-hand edge.
export function overviewPeaks(pyramid: ChannelPyramid, length: number, completed: number, width: number): ({ min: number; max: number } | null)[] {
  const samplesPerPixel = length / width;
  const level = [...pyramid.levels].reverse().find(item => item.blockSize <= samplesPerPixel) ?? pyramid.levels[0];
  return Array.from({ length: width }, (_, x) => {
    const start = Math.floor(x * samplesPerPixel);
    const end = Math.min(completed, Math.ceil((x + 1) * samplesPerPixel));
    if (start >= end) return null;
    let min = Infinity, max = -Infinity;
    for (let block = Math.floor(start / level.blockSize); block < Math.ceil(end / level.blockSize); block++) {
      min = Math.min(min, level.min[block]);
      max = Math.max(max, level.max[block]);
    }
    return { min, max };
  });
}
