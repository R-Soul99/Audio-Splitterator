import React, { useState, useEffect, useRef } from 'react';
import {
  SplitSegment,
  AudioFormat,
  SampleRateOption,
  Mp3Bitrate,
  WavBitDepth,
  FlacBitDepth,
  FlacCompressionLevel,
  ExportMode,
  FolderHierarchyType,
  NamingPattern,
  FadeSettings,
  AudioMetadata,
} from '../types';
import { formatTime, extractSlice, resampleAudioBuffer } from '../utils/audioProcessing';
import { encodeWav, encodeMp3, encodeFlac } from '../utils/audioEncoder';
import { parseArtistTitle } from '../utils/tagParser';
import {
  saveFilesPrompt,
  triggerDownload,
  isRunningInIframe,
  FileToSave,
  resolveFolderSegments,
} from '../utils/fileSaver';
import {
  Download,
  FolderDown,
  Folder,
  FolderOpen,
  Play,
  Pause,
  Tag,
  Music,
  Check,
  AlertCircle,
  Clock,
  FileAudio,
  Sparkles,
  Layers,
  Disc,
  ListOrdered,
  RefreshCw,
  Sliders,
  ChevronDown,
  ChevronUp,
  FileArchive,
  ArrowRight,
  FolderTree,
  ExternalLink,
  Info,
  X,
} from 'lucide-react';

interface SplitsManagerProps {
  sourceBuffer: AudioBuffer;
  splits: SplitSegment[];
  mainFileName: string;
  fadeSettings: FadeSettings;
  onSeekTo: (time: number) => void;
}

interface TrackCustomData {
  trackNumber: number;
  title: string;
  artist: string;
}

export const SplitsManager: React.FC<SplitsManagerProps> = ({
  sourceBuffer,
  splits,
  mainFileName,
  fadeSettings,
  onSeekTo,
}) => {
  // Output format & quality configuration
  const [format, setFormat] = useState<AudioFormat>('flac');
  const [sampleRate, setSampleRate] = useState<SampleRateOption>(44100); // 44.1 kHz universal Serato / CD standard
  const [mp3Bitrate, setMp3Bitrate] = useState<Mp3Bitrate>(320);
  const [wavBitDepth, setWavBitDepth] = useState<WavBitDepth>(16);
  const [flacBitDepth, setFlacBitDepth] = useState<FlacBitDepth>(16);
  const [flacCompression, setFlacCompression] = useState<FlacCompressionLevel>(5);
  const [exportMode, setExportMode] = useState<ExportMode>('individual'); // Individual files without ZIP by default

  // Album & Vinyl Metadata Suite
  const [showAlbumSuite, setShowAlbumSuite] = useState<boolean>(true);
  const [albumTitle, setAlbumTitle] = useState<string>('');
  const [albumArtist, setAlbumArtist] = useState<string>('');
  const [albumYear, setAlbumYear] = useState<string>('');
  const [albumGenre, setAlbumGenre] = useState<string>('');
  const [startTrackNumber, setStartTrackNumber] = useState<number>(1);
  const [padTrackNumbers, setPadTrackNumbers] = useState<boolean>(true);
  const [namingPattern, setNamingPattern] = useState<NamingPattern>('track_title');
  const [createSubfolders, setCreateSubfolders] = useState<boolean>(true); // Auto-create nested folder hierarchy
  const [folderHierarchyType, setFolderHierarchyType] = useState<FolderHierarchyType>('artist_album');
  const [customFolderPattern, setCustomFolderPattern] = useState<string>('{artist}/{album}');
  const [showTreePreview, setShowTreePreview] = useState<boolean>(false);

  // Track data dictionary keyed by split ID
  const [tracksData, setTracksData] = useState<{ [splitId: string]: TrackCustomData }>({});

  // Saving / Processing state
  const [isSavingAll, setIsSavingAll] = useState<boolean>(false);
  const [saveProgress, setSaveProgress] = useState<{ current: number; total: number; message: string }>({
    current: 0,
    total: 0,
    message: '',
  });
  const [saveResultNotice, setSaveResultNotice] = useState<string | null>(null);

  // Fallback modal state when running in an iframe with blocked multiple downloads
  const [fallbackModalData, setFallbackModalData] = useState<{
    isOpen: boolean;
    files: FileToSave[];
  }>({
    isOpen: false,
    files: [],
  });

  // Preview playback of individual split
  const [playingSplitId, setPlayingSplitId] = useState<string | null>(null);
  const previewSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const previewCtxRef = useRef<AudioContext | null>(null);

  const inIframe = isRunningInIframe();

  // Initialize or synchronize track data whenever splits change
  useEffect(() => {
    setTracksData((prev) => {
      let changed = false;
      const next = { ...prev };
      splits.forEach((split, idx) => {
        if (!next[split.id]) {
          const parsed = parseArtistTitle(split.name);
          const initialTrackNum = startTrackNumber + idx;
          next[split.id] = {
            trackNumber: initialTrackNum,
            title: parsed.title || split.name || `Track ${initialTrackNum}`,
            artist: parsed.artist || albumArtist || '',
          };
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [splits, startTrackNumber, albumArtist]);

  // Helper to construct a clean file name according to the pattern
  const constructFileName = (
    trackNum: number,
    artist: string,
    title: string,
    album: string,
    pattern: NamingPattern,
    pad: boolean
  ): string => {
    const numStr = pad ? String(trackNum).padStart(2, '0') : String(trackNum);
    const cleanTitle = (title || 'Track').trim();
    const cleanArtist = (artist || albumArtist || '').trim();
    const cleanAlbum = (album || albumTitle || '').trim();

    let name = '';
    switch (pattern) {
      case 'track_title':
        name = `${numStr} - ${cleanTitle}`;
        break;
      case 'track_artist_title':
        name = cleanArtist ? `${numStr} - ${cleanArtist} - ${cleanTitle}` : `${numStr} - ${cleanTitle}`;
        break;
      case 'artist_title':
        name = cleanArtist ? `${cleanArtist} - ${cleanTitle}` : cleanTitle;
        break;
      case 'artist_album_track_title':
        if (cleanArtist && cleanAlbum) {
          name = `${cleanArtist} - ${cleanAlbum} - ${numStr} - ${cleanTitle}`;
        } else if (cleanArtist) {
          name = `${cleanArtist} - ${numStr} - ${cleanTitle}`;
        } else {
          name = `${numStr} - ${cleanTitle}`;
        }
        break;
      default:
        name = `${numStr} - ${cleanTitle}`;
    }

    // Sanitize illegal filesystem characters: / \ ? * : | " < >
    return name.replace(/[/\\?%*:|"<>]/g, '_').trim();
  };

  // One-click action: Apply Album Artist to all tracks
  const handleApplyAlbumArtistToAll = () => {
    const cleanArtist = albumArtist.trim();
    if (!cleanArtist) return;
    setTracksData((prev) => {
      const updated: { [splitId: string]: TrackCustomData } = {};
      splits.forEach((split) => {
        const cur = prev[split.id] || {
          trackNumber: split.trackNumber,
          title: split.name,
          artist: '',
        };
        updated[split.id] = {
          ...cur,
          artist: cleanArtist,
        };
      });
      return updated;
    });
  };

  // One-click action: Auto-Number All Tracks sequentially
  const handleAutoNumberTracks = () => {
    setTracksData((prev) => {
      const updated: { [splitId: string]: TrackCustomData } = {};
      splits.forEach((split, i) => {
        const cur = prev[split.id] || {
          trackNumber: startTrackNumber + i,
          title: split.name,
          artist: albumArtist,
        };
        updated[split.id] = {
          ...cur,
          trackNumber: startTrackNumber + i,
        };
      });
      return updated;
    });
  };

  // One-click action: Reapply naming template across all tracks
  const handleReapplyNamingPattern = () => {
    setSaveResultNotice(`Naming template "${namingPattern}" is active for all output files.`);
    setTimeout(() => {
      setSaveResultNotice((cur) => (cur?.includes('Naming template') ? null : cur));
    }, 2500);
  };

  // Update track title
  const handleUpdateTrackTitle = (splitId: string, newTitle: string) => {
    setTracksData((prev) => {
      const cur = prev[splitId] || {
        trackNumber: 1,
        title: newTitle,
        artist: albumArtist,
      };
      return {
        ...prev,
        [splitId]: { ...cur, title: newTitle },
      };
    });
  };

  // Update track artist
  const handleUpdateTrackArtist = (splitId: string, newArtist: string) => {
    setTracksData((prev) => {
      const cur = prev[splitId] || {
        trackNumber: 1,
        title: '',
        artist: newArtist,
      };
      return {
        ...prev,
        [splitId]: { ...cur, artist: newArtist },
      };
    });
  };

  // Update track number
  const handleUpdateTrackNumber = (splitId: string, newNum: number) => {
    setTracksData((prev) => {
      const cur = prev[splitId] || {
        trackNumber: newNum,
        title: '',
        artist: albumArtist,
      };
      return {
        ...prev,
        [splitId]: { ...cur, trackNumber: newNum },
      };
    });
  };

  // Stop preview playback
  const stopSplitPreview = () => {
    if (previewSourceRef.current) {
      try {
        previewSourceRef.current.stop();
      } catch {}
      previewSourceRef.current.disconnect();
      previewSourceRef.current = null;
    }
    setPlayingSplitId(null);
  };

  // Play a specific split slice
  const playSplitPreview = (split: SplitSegment) => {
    stopSplitPreview();

    try {
      const ctx = new (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      previewCtxRef.current = ctx;

      const sliceBuffer = extractSlice(
        sourceBuffer,
        split.startTime,
        split.endTime,
        fadeSettings
      );

      const source = ctx.createBufferSource();
      source.buffer = sliceBuffer;
      source.connect(ctx.destination);

      source.onended = () => {
        setPlayingSplitId(null);
      };

      source.start();
      previewSourceRef.current = source;
      setPlayingSplitId(split.id);
    } catch (err) {
      console.error('Failed to preview split:', err);
    }
  };

  // Encode a single split slice with resampling and embedded tags
  const encodeSplitSlice = async (split: SplitSegment): Promise<{ blob: Blob; fileName: string }> => {
    // 1. Extract slice with fades and zero-crossing detection
    const rawSlice = extractSlice(sourceBuffer, split.startTime, split.endTime, fadeSettings);

    // 2. High-fidelity sinc anti-aliased resampling if target sample rate differs from source
    const effectiveSampleRate = sampleRate === 0 ? rawSlice.sampleRate : sampleRate;
    const sliceBuffer =
      effectiveSampleRate !== rawSlice.sampleRate
        ? await resampleAudioBuffer(rawSlice, effectiveSampleRate)
        : rawSlice;

    // 3. Metadata tags
    const track = tracksData[split.id];
    const trackArtist = (track?.artist || albumArtist || '').trim();
    const trackTitle = (track?.title || split.name || 'Track').trim();
    const trackNumber = track?.trackNumber ?? split.trackNumber ?? split.index;

    const metadata: AudioMetadata = {
      artist: trackArtist,
      albumArtist: albumArtist.trim() || trackArtist,
      title: trackTitle,
      album: albumTitle.trim(),
      trackNumber,
      totalTracks: splits.length,
      year: albumYear.trim(),
      genre: albumGenre.trim(),
    };

    // 4. Encode audio into selected format
    let rawBytes: Uint8Array;
    let mimeType = 'audio/flac';
    const ext = format;

    if (format === 'wav') {
      rawBytes = encodeWav(sliceBuffer, { bitDepth: wavBitDepth, metadata });
      mimeType = 'audio/wav';
    } else if (format === 'mp3') {
      rawBytes = await encodeMp3(sliceBuffer, { kbps: mp3Bitrate, metadata });
      mimeType = 'audio/mpeg';
    } else {
      // FLAC (Lossless bit-for-bit with STREAMINFO duration & Vorbis metadata)
      rawBytes = await encodeFlac(sliceBuffer, {
        compressionLevel: flacCompression,
        bitDepth: flacBitDepth,
        metadata,
      });
      mimeType = 'audio/flac';
    }

    const blob = new Blob([rawBytes], { type: mimeType });
    const finalBaseName = constructFileName(
      trackNumber,
      trackArtist,
      trackTitle,
      albumTitle,
      namingPattern,
      padTrackNumbers
    );
    const fileName = `${finalBaseName}.${ext}`;
    return { blob, fileName };
  };

  // Download a single split immediately
  const handleSaveSingleSplit = async (split: SplitSegment) => {
    try {
      const { blob, fileName } = await encodeSplitSlice(split);
      triggerDownload(blob, fileName);
    } catch (err) {
      console.error('Error saving split:', err);
      alert('Failed to encode audio file.');
    }
  };

  // Save all splits
  const handleSaveAllSplits = async () => {
    if (splits.length === 0) return;

    setIsSavingAll(true);
    setSaveResultNotice(null);
    setSaveProgress({ current: 0, total: splits.length, message: 'Preparing tracks for export...' });

    try {
      const filesToSave: FileToSave[] = [];

      for (let i = 0; i < splits.length; i++) {
        const split = splits[i];
        const track = tracksData[split.id];
        const tTitle = track?.title || split.name;
        const srDisplay = sampleRate === 0 ? `${sourceBuffer.sampleRate / 1000}kHz` : `${sampleRate / 1000}kHz`;

        setSaveProgress({
          current: i + 1,
          total: splits.length,
          message: `Resampling & encoding track ${i + 1} of ${splits.length} (${srDisplay}): "${tTitle}"...`,
        });

        const { blob, fileName } = await encodeSplitSlice(split);
        filesToSave.push({ name: fileName, blob });
      }

      setSaveProgress({
        current: splits.length,
        total: splits.length,
        message:
          exportMode === 'individual'
            ? 'Selecting destination folder / saving files...'
            : 'Packaging tracks into ZIP archive...',
      });

      const defaultArchiveName = `${
        albumTitle.trim()
          ? `${albumArtist ? `${albumArtist} - ` : ''}${albumTitle}`
          : mainFileName || 'audio_splits'
      }.zip`;

      const currentFolderOptions = {
        enabled: createSubfolders && folderHierarchyType !== 'flat',
        type: folderHierarchyType,
        artist: albumArtist,
        album: albumTitle,
        year: albumYear,
        genre: albumGenre,
        customFolderPattern: folderHierarchyType === 'custom' ? customFolderPattern : undefined,
      };

      const result = await saveFilesPrompt(filesToSave, {
        mode: exportMode,
        zipDefaultName: defaultArchiveName,
        folderStructure: currentFolderOptions,
        onProgress: (cur, tot, fName) => {
          setSaveProgress({
            current: cur,
            total: tot,
            message: `Writing "${fName}" (${cur}/${tot})...`,
          });
        },
      });

      if (result.method === 'iframe_blocked') {
        // Show the helpful fallback modal to prevent browser download blocking
        setFallbackModalData({
          isOpen: true,
          files: filesToSave,
        });
        setSaveResultNotice(result.message);
      } else {
        setSaveResultNotice(result.message);
      }
    } catch (err: any) {
      if (err.message && err.message.includes('cancelled')) {
        setSaveResultNotice('Directory selection cancelled.');
      } else {
        console.error('Failed to save all splits:', err);
        setSaveResultNotice('Error occurred while saving tracks.');
      }
    } finally {
      setIsSavingAll(false);
    }
  };

  // Download folder archive from fallback modal
  const handleDownloadArchiveFromModal = async () => {
    if (fallbackModalData.files.length === 0) return;
    const defaultArchiveName = `${
      albumTitle.trim()
        ? `${albumArtist ? `${albumArtist} - ` : ''}${albumTitle}`
        : mainFileName || 'audio_splits'
    }.zip`;

    await saveFilesPrompt(fallbackModalData.files, {
      mode: 'zip',
      zipDefaultName: defaultArchiveName,
      folderStructure: {
        enabled: createSubfolders && folderHierarchyType !== 'flat',
        type: folderHierarchyType,
        artist: albumArtist,
        album: albumTitle,
        year: albumYear,
        genre: albumGenre,
        customFolderPattern: folderHierarchyType === 'custom' ? customFolderPattern : undefined,
      },
    });
    setFallbackModalData((prev) => ({ ...prev, isOpen: false }));
    setSaveResultNotice(`Downloaded folder archive "${defaultArchiveName}" with internal folder structure.`);
  };

  const isResampling = sampleRate !== 0 && sampleRate !== sourceBuffer.sampleRate;

  const resolvedFolderSegments = resolveFolderSegments({
    enabled: createSubfolders,
    type: folderHierarchyType,
    artist: albumArtist,
    album: albumTitle,
    year: albumYear,
    genre: albumGenre,
    customFolderPattern: folderHierarchyType === 'custom' ? customFolderPattern : undefined,
  });

  const folderPathPreview = resolvedFolderSegments.join(' / ');

  // Compute sample preview track names for the interactive directory tree
  const previewSampleTracks = splits.slice(0, 3).map((split, i) => {
    const tr = tracksData[split.id];
    const trNum = tr?.trackNumber ?? (startTrackNumber + i);
    const trArtist = tr?.artist || albumArtist || '';
    const trTitle = tr?.title || split.name || `Track ${trNum}`;
    const baseName = constructFileName(
      trNum,
      trArtist,
      trTitle,
      albumTitle,
      namingPattern,
      padTrackNumbers
    );
    return `${baseName}.${format}`;
  });

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-md space-y-4">
      {/* Iframe Notice Banner if in preview */}
      {inIframe && (
        <div className="bg-emerald-950/40 border border-emerald-500/30 rounded-lg p-3 text-xs text-emerald-200 flex items-center justify-between gap-3">
          <div className="flex items-center space-x-2.5">
            <Info className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>
              <strong>Embedded Preview Mode:</strong> Web browsers restrict native folder access (`showDirectoryPicker`) inside iframes. For direct disk folder saving,{' '}
              <a
                href={window.location.href}
                target="_blank"
                rel="noopener noreferrer"
                className="underline font-semibold hover:text-white inline-flex items-center gap-0.5"
              >
                open in a new tab <ExternalLink className="w-3 h-3" />
              </a>
              .
            </span>
          </div>
        </div>
      )}

      {/* Top Header & Main Action */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
        <div className="flex items-center space-x-2.5">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
            <Layers className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h3 className="text-sm font-semibold text-slate-100">Audio Splits & Tracks</h3>
              <span className="text-xs bg-slate-800 text-slate-300 font-mono px-2 py-0.5 rounded border border-slate-700">
                {splits.length} {splits.length === 1 ? 'track' : 'tracks'}
              </span>
              {isResampling && (
                <span className="text-[11px] bg-amber-500/10 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded flex items-center gap-1 font-mono">
                  <RefreshCw className="w-2.5 h-2.5 animate-spin" />
                  Resampling {sourceBuffer.sampleRate / 1000}k → {sampleRate / 1000}kHz
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400">
              Vinyl album tagging, sample rate conversion (44.1 kHz / 48 kHz), and automatic folder hierarchy
            </p>
          </div>
        </div>

        {/* Global Save Button */}
        <button
          type="button"
          id="export-all-tracks-btn"
          disabled={isSavingAll || splits.length === 0}
          onClick={handleSaveAllSplits}
          className="flex items-center space-x-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold text-xs transition shadow-md shadow-emerald-950/40 cursor-pointer"
          title={
            exportMode === 'individual'
              ? 'Save all tracks into destination directory with Artist / Album folders'
              : 'Export all tracks compressed in a single .zip archive'
          }
        >
          {exportMode === 'individual' ? <FolderDown className="w-4 h-4" /> : <FileArchive className="w-4 h-4" />}
          <span>
            {exportMode === 'individual'
              ? 'Export All Tracks (Separate Files)'
              : 'Export All as .ZIP Archive'}
          </span>
        </button>
      </div>

      {/* Output Format, Sample Rate & Export Settings Bar */}
      <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
          {/* Format Buttons */}
          <div className="flex items-center space-x-2">
            <span className="text-xs font-medium text-slate-300 shrink-0">Format:</span>
            <div className="flex bg-slate-900 p-0.5 rounded-lg border border-slate-800 text-xs">
              {(['flac', 'wav', 'mp3'] as AudioFormat[]).map((fmt) => (
                <button
                  key={fmt}
                  type="button"
                  id={`format-btn-${fmt}`}
                  onClick={() => setFormat(fmt)}
                  className={`px-3 py-1 rounded uppercase font-semibold transition cursor-pointer ${
                    format === fmt
                      ? 'bg-emerald-500 text-slate-950 shadow-sm'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {fmt}
                </button>
              ))}
            </div>
          </div>

          {/* Sample Rate Dropdown (Crucial for Serato / Vinyl / DJ workflows) */}
          <div className="flex items-center space-x-2">
            <span className="text-xs font-medium text-slate-300 shrink-0">Sample Rate:</span>
            <select
              id="sample-rate-select"
              value={sampleRate}
              onChange={(e) => setSampleRate(parseInt(e.target.value) as SampleRateOption)}
              className="bg-slate-900 border border-slate-700 hover:border-emerald-500/50 rounded-lg px-2.5 py-1 text-xs text-slate-200 font-mono focus:outline-none focus:border-emerald-500 cursor-pointer"
              title="Select output sample rate. 44.1 kHz is recommended for Serato, CDJs, and standard music libraries."
            >
              <option value="44100">44.1 kHz (Serato / CD Standard) ★</option>
              <option value="48000">48.0 kHz (Studio / Video Audio)</option>
              <option value="88200">88.2 kHz (Hi-Res 2x CD)</option>
              <option value="96000">96.0 kHz (Hi-Res Studio)</option>
              <option value="0">Source Rate ({sourceBuffer.sampleRate} Hz)</option>
            </select>
          </div>

          {/* Format-Specific Options: Bitrate / Bit Depth / FLAC Lossless Info */}
          <div className="flex items-center space-x-2">
            {format === 'mp3' && (
              <>
                <span className="text-xs font-medium text-slate-300 shrink-0">Bitrate:</span>
                <select
                  id="mp3-bitrate-select"
                  value={mp3Bitrate}
                  onChange={(e) => setMp3Bitrate(parseInt(e.target.value) as Mp3Bitrate)}
                  className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1 text-xs text-slate-200 font-mono focus:outline-none cursor-pointer"
                >
                  <option value="320">320 kbps (CBR Best)</option>
                  <option value="256">256 kbps (High)</option>
                  <option value="192">192 kbps (Medium)</option>
                  <option value="128">128 kbps (Compact)</option>
                </select>
              </>
            )}

            {format === 'wav' && (
              <>
                <span className="text-xs font-medium text-slate-300 shrink-0">Encoding:</span>
                <select
                  id="wav-bitdepth-select"
                  value={wavBitDepth}
                  onChange={(e) => setWavBitDepth(parseInt(e.target.value) as WavBitDepth)}
                  className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1 text-xs text-slate-200 font-mono focus:outline-none cursor-pointer"
                  title="WAV is completely uncompressed raw PCM audio"
                >
                  <option value="16">16-bit PCM (CD / Raw Uncompressed)</option>
                  <option value="24">24-bit PCM (Studio / Raw Uncompressed)</option>
                </select>
              </>
            )}

            {format === 'flac' && (
              <>
                <span className="text-xs font-medium text-slate-300 shrink-0">Bit Depth:</span>
                <select
                  id="flac-bitdepth-select"
                  value={flacBitDepth}
                  onChange={(e) => setFlacBitDepth(parseInt(e.target.value) as FlacBitDepth)}
                  className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1 text-xs text-slate-200 font-mono focus:outline-none cursor-pointer"
                  title="FLAC bit-depth: 16-bit (CD standard) or 24-bit (Studio Master). Both are 100% bit-for-bit lossless with full STREAMINFO duration and metadata."
                >
                  <option value="16">16-bit (CD Quality, Lossless)</option>
                  <option value="24">24-bit (Studio Master, Lossless)</option>
                </select>

                <span className="text-xs font-medium text-slate-300 shrink-0 ml-1">Compression:</span>
                <select
                  id="flac-compression-select"
                  value={flacCompression}
                  onChange={(e) => setFlacCompression(parseInt(e.target.value) as FlacCompressionLevel)}
                  className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1 text-xs text-slate-200 font-mono focus:outline-none cursor-pointer"
                  title="FLAC compression is 100% bit-for-bit lossless. Level only controls encode time vs file size, never sound quality."
                >
                  <option value="5">Level 5 (Standard)</option>
                  <option value="8">Level 8 (Max Compression)</option>
                  <option value="0">Level 0 (Fastest)</option>
                </select>
              </>
            )}
          </div>

          {/* Export Mode Toggle: Individual Files (Direct) vs ZIP */}
          <div className="flex items-center space-x-2 border-l border-slate-800 pl-3">
            <span className="text-xs font-medium text-slate-300 shrink-0">Output:</span>
            <div className="flex bg-slate-900 p-0.5 rounded-lg border border-slate-800 text-xs">
              <button
                type="button"
                id="export-mode-individual"
                onClick={() => setExportMode('individual')}
                className={`px-2.5 py-1 rounded text-[11px] font-medium transition cursor-pointer flex items-center gap-1 ${
                  exportMode === 'individual'
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title="Saves files directly as individual tracks without creating a ZIP file"
              >
                <FolderDown className="w-3 h-3" />
                Individual Files
              </button>
              <button
                type="button"
                id="export-mode-zip"
                onClick={() => setExportMode('zip')}
                className={`px-2.5 py-1 rounded text-[11px] font-medium transition cursor-pointer flex items-center gap-1 ${
                  exportMode === 'zip'
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title="Bundles all split files into a .zip archive"
              >
                <FileArchive className="w-3 h-3" />
                ZIP Archive
              </button>
            </div>
          </div>
        </div>

        {/* Informative Explanation of FLAC / WAV */}
        <div className="text-[11px] text-slate-400 bg-slate-900/60 p-2 rounded-lg border border-slate-800/80 flex items-start gap-2">
          <Info className="w-3.5 h-3.5 text-slate-400 mt-0.5 shrink-0" />
          <span>
            {format === 'flac' && (
              <>
                <strong className="text-slate-200">FLAC is 100% bit-for-bit lossless audio</strong> (identical to original studio soundcard recording). The compression level only optimizes file size on disk without discarding any audio fidelity (like ZIP for audio). For uncompressed raw PCM, select <strong>WAV</strong>.
              </>
            )}
            {format === 'wav' && (
              <>
                <strong className="text-slate-200">WAV PCM is completely raw and uncompressed</strong> audio data. 16-bit 44.1 kHz is standard for Serato and Audio CDs; 24-bit is optimal for studio mastering.
              </>
            )}
            {format === 'mp3' && (
              <>
                <strong className="text-slate-200">MP3 is compressed lossy audio</strong> with ID3v2 tags, optimal for car stereos and high-compatibility playback.
              </>
            )}
          </span>
        </div>
      </div>

      {/* Album & Vinyl Digitization Metadata Suite */}
      <div className="bg-slate-950 rounded-xl border border-slate-800 overflow-hidden">
        <div
          onClick={() => setShowAlbumSuite(!showAlbumSuite)}
          className="flex items-center justify-between px-3.5 py-2.5 bg-slate-900/80 hover:bg-slate-900 cursor-pointer transition select-none"
        >
          <div className="flex items-center space-x-2">
            <Disc className="w-4 h-4 text-emerald-400" />
            <span className="text-xs font-semibold text-slate-200">
              Album Details & Automatic Folder Hierarchy
            </span>
            <span className="text-[11px] text-slate-400">
              (Sets album, artist, track numbers, and creates [Artist] / [Album] folder structure)
            </span>
          </div>
          <div className="flex items-center space-x-2 text-slate-400">
            {showAlbumSuite ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </div>
        </div>

        {showAlbumSuite && (
          <div className="p-3.5 space-y-3.5 border-t border-slate-800/80">
            {/* Album Metadata Inputs */}
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
              {/* Album Artist */}
              <div>
                <label className="block text-[11px] font-medium text-slate-300 mb-1">
                  Album Artist
                </label>
                <input
                  type="text"
                  id="album-artist-input"
                  value={albumArtist}
                  onChange={(e) => setAlbumArtist(e.target.value)}
                  placeholder="e.g. Fleetwood Mac"
                  className="w-full bg-slate-900 border border-slate-700 focus:border-emerald-500 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none"
                />
              </div>

              {/* Album Title */}
              <div>
                <label className="block text-[11px] font-medium text-slate-300 mb-1">
                  Album Title
                </label>
                <input
                  type="text"
                  id="album-title-input"
                  value={albumTitle}
                  onChange={(e) => setAlbumTitle(e.target.value)}
                  placeholder="e.g. Rumours"
                  className="w-full bg-slate-900 border border-slate-700 focus:border-emerald-500 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none"
                />
              </div>

              {/* Year */}
              <div>
                <label className="block text-[11px] font-medium text-slate-300 mb-1">
                  Year / Release Date
                </label>
                <input
                  type="text"
                  id="album-year-input"
                  value={albumYear}
                  onChange={(e) => setAlbumYear(e.target.value)}
                  placeholder="e.g. 1977"
                  className="w-full bg-slate-900 border border-slate-700 focus:border-emerald-500 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none"
                />
              </div>

              {/* Genre */}
              <div>
                <label className="block text-[11px] font-medium text-slate-300 mb-1">
                  Genre
                </label>
                <input
                  type="text"
                  id="album-genre-input"
                  value={albumGenre}
                  onChange={(e) => setAlbumGenre(e.target.value)}
                  placeholder="e.g. Rock / Vinyl Rip"
                  className="w-full bg-slate-900 border border-slate-700 focus:border-emerald-500 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none"
                />
              </div>
            </div>

            {/* Folder Organization Options & Tree Preview */}
            <div className="bg-slate-900/95 p-3 rounded-lg border border-slate-800 space-y-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2.5">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center space-x-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      id="create-subfolders-checkbox"
                      checked={createSubfolders}
                      onChange={(e) => setCreateSubfolders(e.target.checked)}
                      className="rounded accent-emerald-500 w-4 h-4 cursor-pointer"
                    />
                    <span className="text-slate-200 font-semibold flex items-center gap-1.5 text-xs">
                      <FolderTree className="w-4 h-4 text-emerald-400" />
                      Organize into Subfolders
                    </span>
                  </label>

                  {createSubfolders && (
                    <div className="flex items-center space-x-1.5">
                      <select
                        id="folder-hierarchy-type-select"
                        value={folderHierarchyType}
                        onChange={(e) => setFolderHierarchyType(e.target.value as FolderHierarchyType)}
                        className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1 text-xs text-slate-200 font-medium focus:outline-none focus:border-emerald-500 cursor-pointer"
                      >
                        <option value="artist_album">[Artist] / [Album] (Standard Library)</option>
                        <option value="artist_year_album">[Artist] / [Year - Album] (Chronological)</option>
                        <option value="album_only">[Album] / [Tracks] (Album Only)</option>
                        <option value="custom">Custom Hierarchy Pattern...</option>
                        <option value="flat">Flat (Direct in Target Folder)</option>
                      </select>
                    </div>
                  )}
                </div>

                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    id="toggle-tree-preview-btn"
                    onClick={() => setShowTreePreview((prev) => !prev)}
                    className={`px-2.5 py-1 rounded text-[11px] font-medium flex items-center gap-1.5 transition cursor-pointer border ${
                      showTreePreview
                        ? 'bg-emerald-950/70 border-emerald-500/50 text-emerald-300'
                        : 'bg-slate-800/80 border-slate-700 text-slate-300 hover:text-white'
                    }`}
                    title="Toggle visual directory tree preview"
                  >
                    <FolderTree className="w-3 h-3 text-emerald-400" />
                    <span>{showTreePreview ? 'Hide Layout Tree' : 'Preview Layout Tree'}</span>
                    {showTreePreview ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  </button>
                </div>
              </div>

              {/* Custom Pattern Input if custom selected */}
              {createSubfolders && folderHierarchyType === 'custom' && (
                <div className="pt-2 border-t border-slate-800/80 space-y-1.5">
                  <div className="flex items-center space-x-2">
                    <span className="text-slate-400 text-[11px] shrink-0">Pattern:</span>
                    <input
                      type="text"
                      id="custom-folder-pattern-input"
                      value={customFolderPattern}
                      onChange={(e) => setCustomFolderPattern(e.target.value)}
                      placeholder="{artist}/{album}"
                      className="flex-1 bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-100 font-mono focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px] text-slate-400 flex-wrap">
                    <span>Click token to add:</span>
                    {['{artist}', '{album}', '{year}', '{genre}'].map((token) => (
                      <button
                        key={token}
                        type="button"
                        onClick={() => setCustomFolderPattern((prev) => (prev ? `${prev}/${token}` : token))}
                        className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-emerald-400 font-mono transition cursor-pointer"
                      >
                        +{token}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Destination Path Preview Line */}
              <div className="text-[11px] text-slate-400 font-mono flex items-center justify-between gap-2 pt-1 border-t border-slate-800/60">
                <div className="flex items-center gap-1.5 truncate">
                  <span className="text-slate-500 shrink-0">Target Path:</span>
                  <span className="text-slate-300 bg-slate-950 px-2 py-0.5 rounded border border-slate-800 truncate">
                    📁 [Selected Directory] {folderPathPreview ? `/ 📁 ${folderPathPreview}` : ''} / 🎵 01 - ...
                  </span>
                </div>
                <span className="text-slate-500 text-[10px] shrink-0">
                  {resolvedFolderSegments.length > 0
                    ? `${resolvedFolderSegments.length} subfolder level${resolvedFolderSegments.length > 1 ? 's' : ''}`
                    : 'Direct root export'}
                </span>
              </div>

              {/* Visual Tree Preview */}
              {showTreePreview && (
                <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 font-mono text-xs text-slate-300 space-y-1">
                  <div className="flex items-center gap-1.5 text-slate-400 font-semibold text-[11px] mb-1.5 pb-1 border-b border-slate-800">
                    <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
                    <span>Visual Disk & Archive Layout Preview:</span>
                  </div>

                  <div className="text-slate-400 flex items-center gap-1.5">
                    <Folder className="w-3.5 h-3.5 text-amber-400" />
                    <span className="text-slate-300">[Target Export Folder]</span>
                  </div>

                  {resolvedFolderSegments.length === 0 && (
                    <div className="pl-4 space-y-0.5 text-slate-400">
                      {previewSampleTracks.map((tName, idx) => (
                        <div key={idx} className="flex items-center gap-1.5">
                          <span className="text-slate-600">{idx === previewSampleTracks.length - 1 && splits.length <= 3 ? '└──' : '├──'}</span>
                          <span className="text-emerald-400">🎵</span>
                          <span className="text-slate-200">{tName}</span>
                        </div>
                      ))}
                      {splits.length > 3 && (
                        <div className="flex items-center gap-1.5 text-slate-500 text-[11px]">
                          <span className="text-slate-600">└──</span>
                          <span>... and {splits.length - 3} more tracks</span>
                        </div>
                      )}
                    </div>
                  )}

                  {resolvedFolderSegments.length === 1 && (
                    <div className="pl-4 space-y-0.5">
                      <div className="flex items-center gap-1.5 text-slate-300">
                        <span className="text-slate-600">└──</span>
                        <Folder className="w-3.5 h-3.5 text-amber-400" />
                        <span className="text-amber-300 font-semibold">{resolvedFolderSegments[0]}</span>
                      </div>
                      <div className="pl-8 space-y-0.5 text-slate-400">
                        {previewSampleTracks.map((tName, idx) => (
                          <div key={idx} className="flex items-center gap-1.5">
                            <span className="text-slate-600">{idx === previewSampleTracks.length - 1 && splits.length <= 3 ? '└──' : '├──'}</span>
                            <span className="text-emerald-400">🎵</span>
                            <span className="text-slate-200">{tName}</span>
                          </div>
                        ))}
                        {splits.length > 3 && (
                          <div className="flex items-center gap-1.5 text-slate-500 text-[11px]">
                            <span className="text-slate-600">└──</span>
                            <span>... and {splits.length - 3} more tracks</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {resolvedFolderSegments.length >= 2 && (
                    <div className="pl-4 space-y-0.5">
                      <div className="flex items-center gap-1.5 text-slate-300">
                        <span className="text-slate-600">└──</span>
                        <Folder className="w-3.5 h-3.5 text-amber-400" />
                        <span className="text-amber-300 font-semibold">{resolvedFolderSegments[0]}</span>
                      </div>
                      <div className="pl-8 space-y-0.5">
                        <div className="flex items-center gap-1.5 text-slate-300">
                          <span className="text-slate-600">└──</span>
                          <Folder className="w-3.5 h-3.5 text-amber-400" />
                          <span className="text-amber-200 font-semibold">
                            {resolvedFolderSegments.slice(1).join(' / ')}
                          </span>
                        </div>
                        <div className="pl-8 space-y-0.5 text-slate-400">
                          {previewSampleTracks.map((tName, idx) => (
                            <div key={idx} className="flex items-center gap-1.5">
                              <span className="text-slate-600">{idx === previewSampleTracks.length - 1 && splits.length <= 3 ? '└──' : '├──'}</span>
                              <span className="text-emerald-400">🎵</span>
                              <span className="text-slate-200">{tName}</span>
                            </div>
                          ))}
                          {splits.length > 3 && (
                            <div className="flex items-center gap-1.5 text-slate-500 text-[11px]">
                              <span className="text-slate-600">└──</span>
                              <span>... and {splits.length - 3} more tracks</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Track Numbering & Naming Pattern Options */}
            <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-center pt-2 border-t border-slate-800/60 text-xs">
              {/* Starting Track # */}
              <div className="md:col-span-3 flex items-center space-x-2">
                <span className="text-slate-300 text-[11px] shrink-0">Start Track #:</span>
                <input
                  type="number"
                  id="start-track-number-input"
                  min={1}
                  value={startTrackNumber}
                  onChange={(e) => setStartTrackNumber(Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-16 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-100 font-mono text-center focus:outline-none focus:border-emerald-500"
                  title="Starting track number (e.g. 1 for Side A, or 7 if recording Side B of vinyl)"
                />
                <label className="flex items-center space-x-1.5 text-[11px] text-slate-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={padTrackNumbers}
                    onChange={(e) => setPadTrackNumbers(e.target.checked)}
                    className="rounded accent-emerald-500 w-3.5 h-3.5 cursor-pointer"
                  />
                  <span>01 Pad</span>
                </label>
              </div>

              {/* Naming Pattern Preset */}
              <div className="md:col-span-5 flex items-center space-x-2">
                <span className="text-slate-300 text-[11px] shrink-0">Filename Pattern:</span>
                <select
                  id="naming-pattern-select"
                  value={namingPattern}
                  onChange={(e) => setNamingPattern(e.target.value as NamingPattern)}
                  className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1 text-xs text-slate-200 font-mono focus:outline-none focus:border-emerald-500 cursor-pointer w-full"
                >
                  <option value="track_title">01 - Title (Standard)</option>
                  <option value="track_artist_title">01 - Artist - Title</option>
                  <option value="artist_title">Artist - Title</option>
                  <option value="artist_album_track_title">Artist - Album - 01 - Title</option>
                </select>
              </div>

              {/* Quick Action Buttons */}
              <div className="md:col-span-4 flex items-center justify-end space-x-2">
                <button
                  type="button"
                  id="apply-artist-all-btn"
                  onClick={handleApplyAlbumArtistToAll}
                  disabled={!albumArtist.trim()}
                  className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 hover:text-emerald-300 font-medium text-[11px] transition cursor-pointer border border-slate-700"
                  title="Fills in the Album Artist for all tracks without having to type on each line"
                >
                  Apply Artist to All
                </button>
                <button
                  type="button"
                  id="auto-number-all-btn"
                  onClick={handleAutoNumberTracks}
                  className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-emerald-300 font-medium text-[11px] transition cursor-pointer border border-slate-700 flex items-center gap-1"
                  title="Re-numbers all tracks sequentially starting from the Start Track #"
                >
                  <ListOrdered className="w-3 h-3" />
                  Auto-Number
                </button>
                <button
                  type="button"
                  id="sync-filenames-btn"
                  onClick={handleReapplyNamingPattern}
                  className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-emerald-300 font-medium text-[11px] transition cursor-pointer border border-slate-700 flex items-center gap-1"
                  title="Re-formats all filenames according to the selected naming pattern"
                >
                  <RefreshCw className="w-3 h-3" />
                  Sync Names
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Encoding progress bar */}
      {isSavingAll && (
        <div className="bg-slate-950 p-3 rounded-xl border border-emerald-500/30 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-emerald-400 font-medium flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping inline-block" />
              {saveProgress.message}
            </span>
            <span className="font-mono text-slate-300">
              {saveProgress.current} / {saveProgress.total}
            </span>
          </div>
          <div className="w-full bg-slate-900 rounded-full h-2 overflow-hidden border border-slate-800">
            <div
              className="bg-emerald-500 h-full transition-all duration-200"
              style={{
                width: `${(saveProgress.current / Math.max(1, saveProgress.total)) * 100}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Notification banner */}
      {saveResultNotice && (
        <div className="bg-slate-950 px-3.5 py-2.5 rounded-lg border border-slate-700 text-xs text-slate-200 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Check className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{saveResultNotice}</span>
          </div>
          <button
            type="button"
            onClick={() => setSaveResultNotice(null)}
            className="text-slate-400 hover:text-slate-200 cursor-pointer text-[11px] ml-3"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Splits Table / List */}
      <div className="border border-slate-800 rounded-xl overflow-hidden bg-slate-950">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-900 border-b border-slate-800 text-slate-400 font-medium">
              <tr>
                <th className="py-2.5 px-3 w-16 text-center">Track #</th>
                <th className="py-2.5 px-3 w-1/3">Track Title</th>
                <th className="py-2.5 px-3 w-1/4">Artist</th>
                <th className="py-2.5 px-3 w-32">Time Span</th>
                <th className="py-2.5 px-3 w-24">Duration</th>
                <th className="py-2.5 px-3 w-28 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {splits.map((split, i) => {
                const track = tracksData[split.id] || {
                  trackNumber: startTrackNumber + i,
                  title: split.name,
                  artist: albumArtist,
                };
                const isPlaying = playingSplitId === split.id;
                const finalFileName = `${constructFileName(
                  track.trackNumber,
                  track.artist || albumArtist,
                  track.title,
                  albumTitle,
                  namingPattern,
                  padTrackNumbers
                )}.${format}`;

                return (
                  <tr
                    key={split.id}
                    className="hover:bg-slate-900/50 transition-colors group"
                  >
                    {/* Track Number */}
                    <td className="py-2 px-3 text-center">
                      <input
                        type="number"
                        min={1}
                        value={track.trackNumber}
                        onChange={(e) =>
                          handleUpdateTrackNumber(split.id, Math.max(1, parseInt(e.target.value) || 1))
                        }
                        className="w-12 bg-slate-900 border border-slate-700/80 focus:border-emerald-500 rounded px-1.5 py-1 text-slate-100 font-mono text-center text-xs focus:outline-none"
                      />
                    </td>

                    {/* Track Title */}
                    <td className="py-2 px-3">
                      <div className="space-y-1">
                        <input
                          type="text"
                          value={track.title}
                          onChange={(e) => handleUpdateTrackTitle(split.id, e.target.value)}
                          className="w-full bg-slate-900 border border-slate-700/80 focus:border-emerald-500 rounded px-2.5 py-1 text-slate-100 font-medium text-xs focus:outline-none"
                          placeholder="e.g. Dreams"
                        />
                        <div className="text-[10px] text-slate-500 font-mono truncate flex items-center gap-1">
                          <span>Output:</span>
                          <span className="text-emerald-400/90">{finalFileName}</span>
                        </div>
                      </div>
                    </td>

                    {/* Track Artist */}
                    <td className="py-2 px-3">
                      <div className="relative">
                        <input
                          type="text"
                          value={track.artist}
                          onChange={(e) => handleUpdateTrackArtist(split.id, e.target.value)}
                          placeholder={albumArtist || 'Track Artist'}
                          className="w-full bg-slate-900 border border-slate-700/80 focus:border-emerald-500 rounded px-2.5 py-1 text-slate-100 text-xs focus:outline-none"
                        />
                        {!track.artist && albumArtist && (
                          <span className="absolute right-2 top-1.5 text-[10px] text-slate-500 pointer-events-none">
                            (Inherits Album)
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Start - End Time */}
                    <td className="py-2 px-3 font-mono text-slate-400">
                      <button
                        type="button"
                        onClick={() => onSeekTo(split.startTime)}
                        className="hover:text-emerald-400 transition cursor-pointer text-[11px]"
                        title="Click to seek playhead to start of this split"
                      >
                        {formatTime(split.startTime, false)} → {formatTime(split.endTime, false)}
                      </button>
                    </td>

                    {/* Duration */}
                    <td className="py-2 px-3 font-mono text-emerald-400 font-semibold">
                      {formatTime(split.duration, true)}
                    </td>

                    {/* Action buttons: Play slice, Save single file */}
                    <td className="py-2 px-3 text-right">
                      <div className="flex items-center justify-end space-x-1.5">
                        {/* Preview play button */}
                        <button
                          type="button"
                          onClick={() => (isPlaying ? stopSplitPreview() : playSplitPreview(split))}
                          className={`p-1.5 rounded transition cursor-pointer ${
                            isPlaying
                              ? 'bg-emerald-500 text-slate-950'
                              : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                          }`}
                          title={isPlaying ? 'Stop Preview' : 'Preview this Split with Fades'}
                        >
                          {isPlaying ? (
                            <Pause className="w-3.5 h-3.5 fill-current" />
                          ) : (
                            <Play className="w-3.5 h-3.5 fill-current" />
                          )}
                        </button>

                        {/* Save single file directly without ZIP */}
                        <button
                          type="button"
                          onClick={() => handleSaveSingleSplit(split)}
                          className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-emerald-400 transition cursor-pointer"
                          title={`Direct download "${finalFileName}"`}
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Fallback Dialog for Preview Frames where multiple automated downloads or directory pickers are blocked */}
      {fallbackModalData.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-start justify-between">
              <div className="flex items-center space-x-2.5">
                <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400">
                  <AlertCircle className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-slate-100">
                    Preview Frame Download Restriction
                  </h3>
                  <p className="text-xs text-slate-400">
                    Browser blocked directory picker or multiple simultaneous file downloads
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setFallbackModalData((prev) => ({ ...prev, isOpen: false }))}
                className="text-slate-400 hover:text-slate-200 cursor-pointer p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="text-xs text-slate-300 space-y-2 bg-slate-950 p-3.5 rounded-xl border border-slate-800">
              <p>
                Web browsers enforce strict security inside embedded preview frames:
              </p>
              <ul className="list-disc pl-4 space-y-1 text-slate-400">
                <li>
                  <code className="text-slate-300 font-mono">showDirectoryPicker()</code> (saving directly into folders) is disabled in cross-origin iframes.
                </li>
                <li>
                  Automated multiple downloads from a single click are blocked (which is why only track 1 downloaded).
                </li>
              </ul>
            </div>

            <div className="space-y-2.5">
              <p className="text-xs font-semibold text-slate-200">Select how you'd like to save your {fallbackModalData.files.length} tracks:</p>

              {/* Option 1: Open in New Tab for native disk saving */}
              <a
                href={window.location.href}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between p-3 rounded-xl bg-slate-800/80 hover:bg-slate-800 border border-slate-700 text-xs text-slate-200 group transition"
              >
                <div className="space-y-0.5">
                  <div className="font-semibold text-emerald-400 flex items-center gap-1.5">
                    <ExternalLink className="w-3.5 h-3.5" />
                    Open App in New Tab (Full Access)
                  </div>
                  <div className="text-slate-400 text-[11px]">
                    Grants your browser native permission to pick your disk folder and automatically create <span className="font-mono text-slate-300">[Artist] / [Album]</span>.
                  </div>
                </div>
                <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-emerald-400 group-hover:translate-x-0.5 transition" />
              </a>

              {/* Option 2: Download folder-structured zip */}
              <button
                type="button"
                onClick={handleDownloadArchiveFromModal}
                className="w-full text-left flex items-center justify-between p-3 rounded-xl bg-slate-800/80 hover:bg-slate-800 border border-slate-700 text-xs text-slate-200 group transition cursor-pointer"
              >
                <div className="space-y-0.5">
                  <div className="font-semibold text-emerald-400 flex items-center gap-1.5">
                    <FolderTree className="w-3.5 h-3.5" />
                    Download Folder Archive (.ZIP)
                  </div>
                  <div className="text-slate-400 text-[11px]">
                    Downloads all tracks pre-organized in <span className="font-mono text-slate-300">{folderPathPreview ? `${folderPathPreview}/` : 'Artist/Album/'}</span> subfolders.
                  </div>
                </div>
                <Download className="w-4 h-4 text-slate-400 group-hover:text-emerald-400 transition" />
              </button>
            </div>

            {/* Option 3: Track list direct downloads */}
            <div className="pt-2 border-t border-slate-800 space-y-2">
              <span className="text-[11px] font-semibold text-slate-400 block">
                Or download individual tracks one-by-one:
              </span>
              <div className="max-h-36 overflow-y-auto space-y-1 pr-1 text-xs">
                {fallbackModalData.files.map((f, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between py-1 px-2 rounded bg-slate-950 border border-slate-800 text-[11px]"
                  >
                    <span className="truncate font-mono text-slate-300">{f.name}</span>
                    <button
                      type="button"
                      onClick={() => triggerDownload(f.blob, f.name)}
                      className="ml-2 px-2 py-0.5 rounded bg-slate-800 hover:bg-emerald-600 text-slate-200 text-[10px] font-medium transition cursor-pointer"
                    >
                      Save
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
