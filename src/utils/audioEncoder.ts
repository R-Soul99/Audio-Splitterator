import { Mp3Encoder } from '@breezystack/lamejs';
// @ts-ignore
import flacLib from 'libflacjs';
import { AudioMetadata } from '../types';

let flacInstance: any = null;
let flacLoadingPromise: Promise<any> | null = null;

export async function getFlac(): Promise<any> {
  if (flacInstance && typeof flacInstance.isReady === 'function' && flacInstance.isReady()) {
    return flacInstance;
  }
  if (flacLoadingPromise) {
    return flacLoadingPromise;
  }
  flacLoadingPromise = new Promise((resolve) => {
    try {
      const rawFlac = (flacLib && (flacLib as any).default) ? (flacLib as any).default : flacLib;
      const Flac =
        (typeof rawFlac === 'function' ? rawFlac() : rawFlac) ||
        (typeof window !== 'undefined' ? (window as any).Flac : null);

      if (!Flac) {
        console.warn('FLAC library export not found');
        resolve(null);
        return;
      }

      if (typeof Flac.isReady === 'function' && Flac.isReady()) {
        flacInstance = Flac;
        resolve(Flac);
      } else if (Flac.onready !== undefined) {
        Flac.onready = () => {
          flacInstance = Flac;
          resolve(Flac);
        };
        // Fallback check in case event already fired
        setTimeout(() => {
          if (typeof Flac.isReady === 'function' && Flac.isReady()) {
            flacInstance = Flac;
            resolve(Flac);
          }
        }, 150);
      } else {
        flacInstance = Flac;
        resolve(Flac);
      }
    } catch (err) {
      console.error('Failed to initialize libflacjs:', err);
      resolve(null);
    }
  });
  return flacLoadingPromise;
}

/**
 * Encodes an AudioBuffer into 16-bit or 24-bit PCM WAV with optional RIFF INFO metadata.
 */
export function encodeWav(
  audioBuffer: AudioBuffer,
  options?: { bitDepth?: 16 | 24; metadata?: Partial<AudioMetadata> }
): Uint8Array {
  const bitDepth = options?.bitDepth || 16;
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const numSamples = audioBuffer.length;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;

  // Build RIFF INFO chunk if metadata present
  let infoChunk: Uint8Array | null = null;
  if (
    options?.metadata?.artist ||
    options?.metadata?.title ||
    options?.metadata?.trackNumber ||
    options?.metadata?.album ||
    options?.metadata?.year ||
    options?.metadata?.genre
  ) {
    const subChunks: { id: string; text: string }[] = [];
    if (options.metadata.title) subChunks.push({ id: 'INAM', text: options.metadata.title });
    if (options.metadata.artist) subChunks.push({ id: 'IART', text: options.metadata.artist });
    if (options.metadata.album) subChunks.push({ id: 'IPRD', text: options.metadata.album });
    if (options.metadata.trackNumber) {
      const trkStr = options.metadata.totalTracks
        ? `${options.metadata.trackNumber}/${options.metadata.totalTracks}`
        : String(options.metadata.trackNumber);
      subChunks.push({ id: 'ITRK', text: trkStr });
    }
    if (options.metadata.year) subChunks.push({ id: 'ICRD', text: options.metadata.year });
    if (options.metadata.genre) subChunks.push({ id: 'IGNR', text: options.metadata.genre });

    let infoSize = 4; // 'INFO' ID
    const encodedSubChunks: { id: string; data: Uint8Array; paddedLen: number }[] = [];
    for (const sc of subChunks) {
      const textBytes = new TextEncoder().encode(sc.text + '\0');
      const paddedLen = textBytes.length + (textBytes.length % 2); // WORD aligned
      encodedSubChunks.push({ id: sc.id, data: textBytes, paddedLen });
      infoSize += 8 + paddedLen;
    }

    const infoBuf = new ArrayBuffer(8 + infoSize);
    const infoView = new DataView(infoBuf);
    writeString(infoView, 0, 'LIST');
    infoView.setUint32(4, infoSize, true);
    writeString(infoView, 8, 'INFO');
    let offset = 12;
    for (const esc of encodedSubChunks) {
      writeString(infoView, offset, esc.id);
      infoView.setUint32(offset + 4, esc.data.length, true);
      offset += 8;
      new Uint8Array(infoBuf, offset, esc.data.length).set(esc.data);
      offset += esc.paddedLen;
    }
    infoChunk = new Uint8Array(infoBuf);
  }

  const extraSize = infoChunk ? infoChunk.byteLength : 0;
  const headerSize = 44;
  const totalFileSize = headerSize + dataSize + extraSize;
  const buffer = new ArrayBuffer(totalFileSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, totalFileSize - 8, true);
  writeString(view, 8, 'WAVE');

  // fmt subchunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size for PCM
  view.setUint16(20, 1, true);  // AudioFormat 1 = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);

  // data subchunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Write samples
  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) {
    channels.push(audioBuffer.getChannelData(c));
  }

  let offset = 44;
  if (bitDepth === 16) {
    for (let i = 0; i < numSamples; i++) {
      for (let c = 0; c < numChannels; c++) {
        let s = Math.max(-1, Math.min(1, channels[c][i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        offset += 2;
      }
    }
  } else if (bitDepth === 24) {
    for (let i = 0; i < numSamples; i++) {
      for (let c = 0; c < numChannels; c++) {
        let s = Math.max(-1, Math.min(1, channels[c][i]));
        const sample24 = Math.floor(s < 0 ? s * 0x800000 : s * 0x7fffff);
        view.setUint8(offset, sample24 & 0xff);
        view.setUint8(offset + 1, (sample24 >> 8) & 0xff);
        view.setUint8(offset + 2, (sample24 >> 16) & 0xff);
        offset += 3;
      }
    }
  }

  // Append INFO chunk if present
  if (infoChunk) {
    new Uint8Array(buffer, offset).set(infoChunk);
  }

  return new Uint8Array(buffer);
}

/**
 * Creates ID3v2.3 metadata header & frames (TIT2, TPE1, TPE2, TRCK, TALB, TYER, TCON).
 */
export function createId3v2Tag(metadata?: Partial<AudioMetadata>): Uint8Array | null {
  if (
    !metadata ||
    (!metadata.artist &&
      !metadata.title &&
      !metadata.trackNumber &&
      !metadata.album &&
      !metadata.albumArtist &&
      !metadata.year &&
      !metadata.genre)
  ) {
    return null;
  }

  const frames: { id: string; text: string }[] = [];
  if (metadata.title) frames.push({ id: 'TIT2', text: metadata.title });
  if (metadata.artist) frames.push({ id: 'TPE1', text: metadata.artist });
  if (metadata.albumArtist) frames.push({ id: 'TPE2', text: metadata.albumArtist });
  if (metadata.album) frames.push({ id: 'TALB', text: metadata.album });
  if (metadata.trackNumber) {
    const trkStr = metadata.totalTracks
      ? `${metadata.trackNumber}/${metadata.totalTracks}`
      : String(metadata.trackNumber);
    frames.push({ id: 'TRCK', text: trkStr });
  }
  if (metadata.year) frames.push({ id: 'TYER', text: metadata.year });
  if (metadata.genre) frames.push({ id: 'TCON', text: metadata.genre });

  if (frames.length === 0) return null;

  // Build frame buffers
  // Frame Header: ID (4), Size (4 bytes uint32), Flags (2 bytes) = 10 bytes
  // Content: 1 byte encoding (0x03 for UTF-8) + UTF-8 string bytes
  const encoder = new TextEncoder();
  const encodedFrames: Uint8Array[] = [];
  let totalFramesSize = 0;

  for (const f of frames) {
    const textBytes = encoder.encode(f.text);
    const frameContentSize = 1 + textBytes.length;
    const frameBuffer = new Uint8Array(10 + frameContentSize);
    const view = new DataView(frameBuffer.buffer);

    // Frame ID
    for (let j = 0; j < 4; j++) {
      frameBuffer[j] = f.id.charCodeAt(j);
    }
    // Size (excluding header)
    view.setUint32(4, frameContentSize, false);
    // Flags (0x00, 0x00)
    view.setUint16(8, 0, false);
    // Encoding 0x03 (UTF-8)
    frameBuffer[10] = 0x03;
    // Text
    frameBuffer.set(textBytes, 11);

    encodedFrames.push(frameBuffer);
    totalFramesSize += frameBuffer.length;
  }

  // ID3v2 Header: 10 bytes
  // 'ID3', ver 03 00, flags 00, synchsafe integer (4 bytes)
  const tagBuffer = new Uint8Array(10 + totalFramesSize);
  tagBuffer[0] = 0x49; // 'I'
  tagBuffer[1] = 0x44; // 'D'
  tagBuffer[2] = 0x33; // '3'
  tagBuffer[3] = 0x03; // version 2.3
  tagBuffer[4] = 0x00;
  tagBuffer[5] = 0x00; // flags

  // Synchsafe size encoding (7 bits per byte)
  let sz = totalFramesSize;
  tagBuffer[6] = (sz >> 21) & 0x7f;
  tagBuffer[7] = (sz >> 14) & 0x7f;
  tagBuffer[8] = (sz >> 7) & 0x7f;
  tagBuffer[9] = sz & 0x7f;

  let offset = 10;
  for (const ef of encodedFrames) {
    tagBuffer.set(ef, offset);
    offset += ef.length;
  }

  return tagBuffer;
}

/**
 * Encodes an AudioBuffer into MP3 format with optional ID3v2 metadata.
 */
export async function encodeMp3(
  audioBuffer: AudioBuffer,
  options?: { kbps?: number; metadata?: Partial<AudioMetadata> }
): Promise<Uint8Array> {
  const kbps = options?.kbps || 192;
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const numSamples = audioBuffer.length;

  const encoder = new Mp3Encoder(numChannels > 1 ? 2 : 1, sampleRate, kbps);

  // Convert float samples to 16-bit PCM arrays
  const ch0 = audioBuffer.getChannelData(0);
  const left = new Int16Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, ch0[i]));
    left[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  let right: Int16Array | null = null;
  if (numChannels > 1) {
    const ch1 = audioBuffer.getChannelData(1);
    right = new Int16Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      const s = Math.max(-1, Math.min(1, ch1[i]));
      right[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  }

  // Encode in chunks (1152 samples per frame)
  const chunkSize = 1152;
  const mp3Chunks: Uint8Array[] = [];

  for (let i = 0; i < numSamples; i += chunkSize) {
    const end = Math.min(numSamples, i + chunkSize);
    const leftChunk = left.subarray(i, end);
    let chunkBytes: Int8Array | Uint8Array;
    if (right) {
      const rightChunk = right.subarray(i, end);
      chunkBytes = encoder.encodeBuffer(leftChunk, rightChunk);
    } else {
      chunkBytes = encoder.encodeBuffer(leftChunk);
    }
    if (chunkBytes && chunkBytes.length > 0) {
      mp3Chunks.push(new Uint8Array(chunkBytes.buffer, chunkBytes.byteOffset, chunkBytes.byteLength));
    }
  }

  const flushBytes: Int8Array | Uint8Array = encoder.flush();
  if (flushBytes && flushBytes.length > 0) {
    mp3Chunks.push(new Uint8Array(flushBytes.buffer, flushBytes.byteOffset, flushBytes.byteLength));
  }

  // Combine MP3 chunks
  const totalMp3Bytes = mp3Chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const mp3Combined = new Uint8Array(totalMp3Bytes);
  let pos = 0;
  for (const chunk of mp3Chunks) {
    mp3Combined.set(chunk, pos);
    pos += chunk.length;
  }

  // Prepend ID3v2 tag if metadata available
  const id3Tag = createId3v2Tag(options?.metadata);
  if (id3Tag) {
    const taggedFile = new Uint8Array(id3Tag.length + mp3Combined.length);
    taggedFile.set(id3Tag, 0);
    taggedFile.set(mp3Combined, id3Tag.length);
    return taggedFile;
  }

  return mp3Combined;
}

/**
 * Creates a standard Vorbis Comment metadata block for FLAC.
 * Includes vendor string and tags (ARTIST, ALBUM, TITLE, TRACKNUMBER, TOTALTRACKS, etc.).
 */
function createVorbisCommentBlock(metadata?: Partial<AudioMetadata>): Uint8Array {
  const vendor = 'Audiophonic Splitterator';
  const encoder = new TextEncoder();
  const vendorBytes = encoder.encode(vendor);

  const comments: string[] = [];
  if (metadata) {
    if (metadata.artist) comments.push(`ARTIST=${metadata.artist}`);
    if (metadata.albumArtist) comments.push(`ALBUMARTIST=${metadata.albumArtist}`);
    if (metadata.title) comments.push(`TITLE=${metadata.title}`);
    if (metadata.album) comments.push(`ALBUM=${metadata.album}`);
    if (metadata.trackNumber !== undefined && metadata.trackNumber !== null) {
      comments.push(`TRACKNUMBER=${metadata.trackNumber}`);
    }
    if (metadata.totalTracks !== undefined && metadata.totalTracks !== null) {
      comments.push(`TOTALTRACKS=${metadata.totalTracks}`);
      comments.push(`TRACKTOTAL=${metadata.totalTracks}`);
    }
    if (metadata.year) comments.push(`DATE=${metadata.year}`);
    if (metadata.genre) comments.push(`GENRE=${metadata.genre}`);
  }

  const commentByteArrays = comments.map((c) => encoder.encode(c));
  let commentPayloadSize = 4 + vendorBytes.length + 4;
  for (const cba of commentByteArrays) {
    commentPayloadSize += 4 + cba.length;
  }

  // 4-byte block header: 0x84 (isLast: 1, type: 4 = VORBIS_COMMENT) + 24-bit big endian length
  const block = new Uint8Array(4 + commentPayloadSize);
  const view = new DataView(block.buffer);

  block[0] = 0x84; // Last metadata block = true (0x80), type = 4 (VORBIS_COMMENT)
  block[1] = (commentPayloadSize >> 16) & 0xff;
  block[2] = (commentPayloadSize >> 8) & 0xff;
  block[3] = commentPayloadSize & 0xff;

  let offset = 4;
  // Vendor length (little-endian 32-bit uint)
  view.setUint32(offset, vendorBytes.length, true);
  offset += 4;
  block.set(vendorBytes, offset);
  offset += vendorBytes.length;

  // Comments count (little-endian 32-bit uint)
  view.setUint32(offset, comments.length, true);
  offset += 4;

  for (const cba of commentByteArrays) {
    view.setUint32(offset, cba.length, true);
    offset += 4;
    block.set(cba, offset);
    offset += cba.length;
  }

  return block;
}

/**
 * Encodes an AudioBuffer into standard FLAC with full STREAMINFO headers (duration / sample count)
 * and Vorbis Comments (Artist, Title, Album, Track, etc.) for full compatibility with professional
 * audio players and DAWs (Resonic Pro, Foobar2000, Ableton, Traktor, Pioneer DJ).
 */
export async function encodeFlac(
  audioBuffer: AudioBuffer,
  options?: { compressionLevel?: number; metadata?: Partial<AudioMetadata>; bitDepth?: 16 | 24 }
): Promise<Uint8Array> {
  const Flac = await getFlac();
  if (!Flac) {
    throw new Error('FLAC encoder is not available.');
  }

  const sampleRate = audioBuffer.sampleRate;
  const numChannels = audioBuffer.numberOfChannels;
  const numSamples = audioBuffer.length;
  const bps: 16 | 24 = options?.bitDepth === 24 ? 24 : 16;
  const compressionLevel = options?.compressionLevel ?? 5;

  const enc = Flac.create_libflac_encoder(sampleRate, numChannels, bps, compressionLevel, 0, false);
  if (!enc) {
    throw new Error('Failed to create libflac encoder instance.');
  }

  const outChunks: Uint8Array[] = [];
  const initStatus = Flac.init_encoder_stream(
    enc,
    (buffer: ArrayBuffer, bytes: number) => {
      outChunks.push(new Uint8Array(buffer.slice(0, bytes)));
    },
    null,
    false,
    0
  );

  if (initStatus !== 0) {
    Flac.FLAC__stream_encoder_delete(enc);
    throw new Error(`FLAC encoder initialization failed with status: ${initStatus}`);
  }

  // Interleaved 32-bit samples for libflac
  const totalSamples = numSamples * numChannels;
  const bufferI32 = new Int32Array(totalSamples);
  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = numChannels > 1 ? audioBuffer.getChannelData(1) : null;

  if (bps === 24) {
    for (let i = 0; i < numSamples; i++) {
      const s0 = Math.max(-1, Math.min(1, ch0[i]));
      const val0 = Math.floor(s0 < 0 ? s0 * 0x800000 : s0 * 0x7fffff);
      if (ch1) {
        const s1 = Math.max(-1, Math.min(1, ch1[i]));
        const val1 = Math.floor(s1 < 0 ? s1 * 0x800000 : s1 * 0x7fffff);
        bufferI32[i * 2] = val0;
        bufferI32[i * 2 + 1] = val1;
      } else {
        bufferI32[i] = val0;
      }
    }
  } else {
    for (let i = 0; i < numSamples; i++) {
      const s0 = Math.max(-1, Math.min(1, ch0[i]));
      const val0 = s0 < 0 ? s0 * 0x8000 : s0 * 0x7fff;
      if (ch1) {
        const s1 = Math.max(-1, Math.min(1, ch1[i]));
        const val1 = s1 < 0 ? s1 * 0x8000 : s1 * 0x7fff;
        bufferI32[i * 2] = val0;
        bufferI32[i * 2 + 1] = val1;
      } else {
        bufferI32[i] = val0;
      }
    }
  }

  const processOk = Flac.FLAC__stream_encoder_process_interleaved(enc, bufferI32, numSamples);
  if (!processOk) {
    Flac.FLAC__stream_encoder_delete(enc);
    throw new Error('FLAC stream encoding failed.');
  }

  Flac.FLAC__stream_encoder_finish(enc);
  Flac.FLAC__stream_encoder_delete(enc);

  // Combine raw FLAC chunks
  const totalLen = outChunks.reduce((acc, c) => acc + c.length, 0);
  const rawFlac = new Uint8Array(totalLen);
  let pos = 0;
  for (const chunk of outChunks) {
    rawFlac.set(chunk, pos);
    pos += chunk.length;
  }

  if (rawFlac.length < 42) {
    return rawFlac;
  }

  // 1. Patch exact total sample count (36 bits) into STREAMINFO header:
  // FLAC STREAMINFO structure (34 bytes data starting at offset 8):
  // Byte 21 (offset 21 in file): top 4 bits are (bps - 1), bottom 4 bits are sample count bits 35..32
  // Bytes 22..25: sample count bits 31..0 in big endian
  const top4 = Math.floor(numSamples / 0x100000000) & 0x0f;
  rawFlac[21] = (rawFlac[21] & 0xf0) | top4;
  rawFlac[22] = (numSamples >>> 24) & 0xff;
  rawFlac[23] = (numSamples >>> 16) & 0xff;
  rawFlac[24] = (numSamples >>> 8) & 0xff;
  rawFlac[25] = numSamples & 0xff;

  // 2. Mark STREAMINFO as NOT the last metadata block (bit 7 of byte 4 = 0)
  rawFlac[4] = rawFlac[4] & 0x7f;

  // 3. Build standard Vorbis Comments block (always attached so duration & tags remain intact)
  const vorbisBlock = createVorbisCommentBlock(options?.metadata);

  // 4. Scan existing metadata blocks in rawFlac to locate where audio frames start
  let offset = 4;
  while (offset < rawFlac.length) {
    const isLast = (rawFlac[offset] & 0x80) !== 0;
    const len = (rawFlac[offset + 1] << 16) | (rawFlac[offset + 2] << 8) | rawFlac[offset + 3];
    offset += 4 + len;
    if (isLast) break;
  }

  const streamInfo = rawFlac.subarray(0, 42); // 4 magic bytes ('fLaC') + 4 header + 34 STREAMINFO data
  const audioFrames = rawFlac.subarray(offset);

  const finalFlac = new Uint8Array(streamInfo.length + vorbisBlock.length + audioFrames.length);
  finalFlac.set(streamInfo, 0);
  finalFlac.set(vorbisBlock, streamInfo.length);
  finalFlac.set(audioFrames, streamInfo.length + vorbisBlock.length);
  return finalFlac;
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
