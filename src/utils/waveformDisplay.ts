// Fixed full-scale mapping, independent of source peaks: 2% margin per channel edge.
export function waveformAmplitudeScale(channelHeight: number, verticalZoom: number): number {
  return channelHeight * .48 * verticalZoom;
}

// One vertical drag pixel corresponds to one visible waveform pixel horizontally.
export function slideSamplesPerPixel(visibleSeconds: number, width: number, rate: number): number {
  return Math.max(0, visibleSeconds) * rate / Math.max(1, width);
}
