// Fixed full-scale mapping, independent of source peaks: 2% margin per channel edge.
export function waveformAmplitudeScale(channelHeight: number, verticalZoom: number): number {
  return channelHeight * .48 * verticalZoom;
}
