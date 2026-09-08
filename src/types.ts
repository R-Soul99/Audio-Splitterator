export type AudioFormat = 'flac' | 'wav' | 'mp3';

export type SampleRateOption = 0 | 44100 | 48000 | 88200 | 96000;

export type Mp3Bitrate = 128 | 192 | 256 | 320;

export type WavBitDepth = 16 | 24;

export type FlacBitDepth = 16 | 24;

export type FlacCompressionLevel = 0 | 5 | 8;

export type ExportMode = 'individual' | 'zip';

export interface FolderStructureOptions {
  enabled: boolean;
  artist?: string;
  album?: string;
}

export type NamingPattern =
  | 'track_title'
  | 'track_artist_title'
  | 'artist_title'
  | 'artist_album_track_title';

export interface AlbumDetails {
  albumArtist: string;
  albumTitle: string;
  year: string;
  genre: string;
  startTrackNumber: number;
  padTrackNumbers: boolean;
  namingPattern: NamingPattern;
}

export type FadeCurve = 'scurve' | 'logarithmic' | 'linear';

export interface FadeSettings {
  fadeInEnabled: boolean;
  fadeInMs: number;
  fadeInCurve: FadeCurve;
  fadeOutEnabled: boolean;
  fadeOutMs: number;
  fadeOutCurve: FadeCurve;
  zeroCrossing: boolean;
}

export interface SplitSegment {
  id: string;
  index: number;
  trackNumber: number;
  name: string;
  artist?: string;
  title?: string;
  startTime: number; // in seconds
  endTime: number;   // in seconds
  duration: number;  // in seconds
  artistTag?: string;
  titleTag?: string;
}

export interface TimeSelection {
  start: number; // in seconds
  end: number;   // in seconds
}

export interface Marker {
  id: string;
  time: number; // in seconds
  label?: string;
}

export interface AudioMetadata {
  artist: string;
  title: string;
  album?: string;
  albumArtist?: string;
  trackNumber?: number;
  totalTracks?: number;
  year?: string;
  genre?: string;
}

export interface AudioDeviceOption {
  deviceId: string;
  label: string;
  groupId?: string;
}

export interface BatchItem {
  id: string;
  file: File;
  name: string;
  parsedArtist?: string;
  parsedTitle?: string;
  status: 'idle' | 'decoding' | 'processing' | 'ready' | 'error';
  progress: number;
  duration?: number;
  error?: string;
  resultBlob?: Blob;
  resultUrl?: string;
  resultFileName?: string;
}
