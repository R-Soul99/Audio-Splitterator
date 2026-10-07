/** Copy captured PCM without changing its rate, channel alignment or pause gaps.
 * The caller retains its chunks until the destination accepts the complete take.
 */
export async function finaliseRecordingTake(
  createBuffer: (channels: number, length: number, sampleRate: number) => AudioBuffer,
  channels: readonly (readonly Float32Array[])[],
  length: number,
  sampleRate: number,
  accept: (buffer: AudioBuffer) => void | Promise<void>,
): Promise<void> {
  if (length < 1) throw new Error('No audio captured. Resume capture and retry.');
  const buffer = createBuffer(channels.length, length, sampleRate);
  channels.forEach((chunks, channel) => {
    const samples = buffer.getChannelData(channel);
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    if (offset !== length) throw new Error('Incomplete capture channel. Take retained.');
  });
  await accept(buffer);
}
