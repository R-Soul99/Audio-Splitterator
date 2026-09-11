import React, { useState, useEffect, useRef } from 'react';
import {
  Download,
  FolderDown,
  Folder,
  Play,
  Pause,
  Tag,
  CheckCircle2,
  Square,
} from 'lucide-react';
import { AudioMetadata, AudioFormat, Mp3Bitrate, WavBitDepth, FlacBitDepth, FlacCompressionLevel, FolderHierarchyType, NamingPattern } from '../types';
import { formatTime, extractSlice } from '../utils/audioProcessing';
import { saveFilesPrompt, FileToSave } from '../utils/fileSaver';

interface SplitsManagerProps {
  sourceBuffer: AudioBuffer;
  splits: any[]; // Accept calculated Splits from App.tsx
  mainFileName: string;
  fadeSettings: any;
  onSeekTo: (time: number) => void;
  preRecordArtist?: string;
  preRecordAlbum?: string;
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
  preRecordArtist = '',
  preRecordAlbum = '',
}) => {
  // Output format configuration
  const [format, setFormat] = useState<AudioFormat>('flac');
  const [mp3Bitrate, setMp3Bitrate] = useState<Mp3Bitrate>(320);
  const [wavBitDepth, setWavBitDepth] = useState<WavBitDepth>(16);
  const [flacBitDepth, setFlacBitDepth] = useState<FlacBitDepth>(16);
  const [flacCompression] = useState<FlacCompressionLevel>(5);

  // Album/Recording metadata inputs
  const [albumTitle, setAlbumTitle] = useState<string>('');
  const [albumArtist, setAlbumArtist] = useState<string>('');
  const [startTrackNumber] = useState<number>(1);
  const [padTrackNumbers] = useState<boolean>(true);
  const [namingPattern] = useState<NamingPattern>('track_title');
  const [createSubfolders, setCreateSubfolders] = useState<boolean>(true);
  const [folderHierarchyType] = useState<FolderHierarchyType>('artist_album');

  // Automatic split micro-fades toggle (defaults to true)
  const [autoSplitFades, setAutoSplitFades] = useState<boolean>(true);

  // Track data dictionary keyed by split ID
  const [tracksData, setTracksData] = useState<{ [splitId: string]: TrackCustomData }>({});
  
  // Track selection state for export checklists
  const [selectedTracks, setSelectedTracks] = useState<{ [splitId: string]: boolean }>({});

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

  // Load pre-record metadata if passed
  useEffect(() => {
    if (preRecordArtist) setAlbumArtist(preRecordArtist);
  }, [preRecordArtist]);

  useEffect(() => {
    if (preRecordAlbum) setAlbumTitle(preRecordAlbum);
  }, [preRecordAlbum]);

  // Synchronise splits tracking metadata when they change
  useEffect(() => {
    setTracksData((prev) => {
      let changed = false;
      const next = { ...prev };
      splits.forEach((split, idx) => {
        if (!next[split.id]) {
          const initialTrackNum = startTrackNumber + idx;
          next[split.id] = {
            trackNumber: initialTrackNum,
            title: '', // blank ready for user input
            artist: albumArtist || preRecordArtist || '',
          };
          changed = true;
        }
      });
      return changed ? next : prev;
    });

    // Auto check newly detected tracks
    setSelectedTracks((prev) => {
      const next = { ...prev };
      splits.forEach((split) => {
        if (next[split.id] === undefined) {
          next[split.id] = true;
        }
      });
      return next;
    });
  }, [splits, startTrackNumber, albumArtist, preRecordArtist]);

  // Calculate effective fade settings based on toggle
  const getEffectiveFadeSettings = (): any => {
    return autoSplitFades
      ? {
          fadeInEnabled: true,
          fadeInMs: 10,
          fadeInCurve: 'scurve',
          fadeOutEnabled: true,
          fadeOutMs: 10,
          fadeOutCurve: 'scurve',
          zeroCrossing: fadeSettings.zeroCrossing,
        }
      : {
          fadeInEnabled: false,
          fadeInMs: 0,
          fadeInCurve: 'linear',
          fadeOutEnabled: false,
          fadeOutMs: 0,
          fadeOutCurve: 'linear',
          zeroCrossing: fadeSettings.zeroCrossing,
        };
  };

  // Preview / Audition single split
  const handleTogglePreviewSplit = async (split: any) => {
    if (playingSplitId === split.id) {
      if (previewSourceRef.current) {
        try {
          previewSourceRef.current.stop();
        } catch {}
        previewSourceRef.current = null;
      }
      setPlayingSplitId(null);
      return;
    }

    if (previewSourceRef.current) {
      try {
        previewSourceRef.current.stop();
      } catch {}
      previewSourceRef.current = null;
    }

    try {
      const ctx = new (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      previewCtxRef.current = ctx;

      const sliceBuffer = extractSlice(
        sourceBuffer,
        split.startTime,
        split.endTime,
        getEffectiveFadeSettings()
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

  const constructFileName = (
    trackNum: number,
    artist: string,
    title: string,
    pattern: NamingPattern,
    pad: boolean
  ): string => {
    const numStr = pad ? String(trackNum).padStart(2, '0') : String(trackNum);
    const cleanTitle = (title || `Track_${numStr}`).trim();
    const cleanArtist = (artist || albumArtist || '').trim();

    let name = cleanArtist ? `${numStr} - ${cleanArtist} - ${cleanTitle}` : `${numStr} - ${cleanTitle}`;
    return name.replace(/[/\\?%*:|"<>]/g, '_').trim();
  };

  const handleApplyAlbumArtistToAll = () => {
    const cleanArtist = albumArtist.trim();
    if (!cleanArtist) return;
    setTracksData((prev) => {
      const updated: { [splitId: string]: TrackCustomData } = {};
      splits.forEach((split) => {
        const cur = prev[split.id] || {
          trackNumber: split.trackNumber,
          title: '',
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

  const encodeSplitSlice = async (split: any): Promise<{ blob: Blob; fileName: string }> => {
    const rawSlice = extractSlice(sourceBuffer, split.startTime, split.endTime, getEffectiveFadeSettings());

    const track = tracksData[split.id];
    const trackArtist = (track?.artist || albumArtist || '').trim();
    const trackTitle = (track?.title || `Track_${String(split.trackNumber).padStart(2, '0')}`).trim();
    const trackNumber = track?.trackNumber ?? split.trackNumber ?? split.index;

    const metadata: AudioMetadata = {
      artist: trackArtist,
      albumArtist: albumArtist.trim() || trackArtist,
      title: trackTitle,
      album: albumTitle.trim(),
      trackNumber,
    };

    let encoderModule;
    if (format === 'flac') {
      encoderModule = await import('../utils/audioEncoder');
      const blob = await encoderModule.encodeWavToFlac(rawSlice, flacBitDepth, flacCompression, metadata);
      const name = `${constructFileName(trackNumber, trackArtist, trackTitle, namingPattern, padTrackNumbers)}.flac`;
      return { blob, fileName: name };
    } else if (format === 'mp3') {
      encoderModule = await import('../utils/audioEncoder');
      const blob = await encoderModule.encodeWavToMp3(rawSlice, mp3Bitrate, metadata);
      const name = `${constructFileName(trackNumber, trackArtist, trackTitle, namingPattern, padTrackNumbers)}.mp3`;
      return { blob, fileName: name };
    } else {
      encoderModule = await import('../utils/audioEncoder');
      const blob = await encoderModule.encodeWavToRaw(rawSlice, wavBitDepth, metadata);
      const name = `${constructFileName(trackNumber, trackArtist, trackTitle, namingPattern, padTrackNumbers)}.wav`;
      return { blob, fileName: name };
    }
  };

  const handleExportAllTracks = async () => {
    const exportSplits = splits.filter((s) => selectedTracks[s.id]);
    if (exportSplits.length === 0) {
      alert("No tracks selected for export.");
      return;
    }
    
    setIsSavingAll(true);
    setSaveProgress({ current: 0, total: exportSplits.length, message: 'Preparing tracks for export...' });
    setSaveResultNotice(null);

    try {
      const filesToSave: FileToSave[] = [];

      for (let i = 0; i < exportSplits.length; i++) {
        const split = exportSplits[i];
        const track = tracksData[split.id];
        const trackArtist = (track?.artist || albumArtist || '').trim();
        const trackTitle = (track?.title || `Track_${String(split.trackNumber).padStart(2, '0')}`).trim();

        setSaveProgress({
          current: i,
          total: exportSplits.length,
          message: `Encoding split ${i + 1} of ${exportSplits.length}: ${trackTitle}...`,
        });

        const encoded = await encodeSplitSlice(split);

        filesToSave.push({
          blob: encoded.blob,
          name: encoded.fileName,
        });
      }

      setSaveProgress({ current: exportSplits.length, total: exportSplits.length, message: 'Saving tracks to disk...' });

      const result = await saveFilesPrompt(filesToSave, {
        zipDefaultName: `${albumTitle.trim() || 'Slices'}_Archive`,
        mode: 'zip',
      });

      if (result.method !== 'iframe_blocked') {
        setSaveResultNotice(`Successfully exported ${exportSplits.length} tracks to folder/ZIP!`);
      } else if (result.files) {
        setFallbackModalData({ isOpen: true, files: result.files });
      }
    } catch (err) {
      console.error('Failed to export tracks:', err);
      alert('Failed to encode and save track slices.');
    } finally {
      setIsSavingAll(false);
    }
  };

  const handleCloseFallbackModal = () => {
    setFallbackModalData({ isOpen: false, files: [] });
  };

  const selectedCount = splits.filter((s) => selectedTracks[s.id]).length;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 h-full min-h-0 select-none">
      
      {/* LEFT COLUMN: Batch Splits Checklist */}
      <div className="lg:col-span-5 flex flex-col min-h-0 border-r border-slate-800 pr-4">
        <div className="flex items-center justify-between border-b border-slate-800 pb-2.5 mb-3 flex-shrink-0">
          <div className="flex items-center space-x-2 text-slate-200 font-bold uppercase tracking-wider text-[10px]">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            <span>Select Slices to Export</span>
          </div>
          <div className="flex items-center space-x-1.5">
            <button
              type="button"
              onClick={() => setSelectedTracks(splits.reduce((acc, s) => ({ ...acc, [s.id]: true }), {}))}
              className="text-[10px] text-emerald-400 hover:text-emerald-300 font-bold hover:underline cursor-pointer"
            >
              All
            </button>
            <span className="text-slate-700 font-mono text-[9px]">•</span>
            <button
              type="button"
              onClick={() => setSelectedTracks(splits.reduce((acc, s) => ({ ...acc, [s.id]: false }), {}))}
              className="text-[10px] text-slate-400 hover:text-slate-300 font-bold hover:underline cursor-pointer"
            >
              None
            </button>
          </div>
        </div>

        {/* Scrollable Tracks Checklist */}
        <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1.5">
          {splits.map((split, idx) => {
            const track = tracksData[split.id] || { trackNumber: idx + 1, artist: '', title: '' };
            const isChecked = !!selectedTracks[split.id];

            return (
              <div
                key={split.id}
                onClick={() => setSelectedTracks((prev) => ({ ...prev, [split.id]: !prev[split.id] }))}
                className={`flex items-center justify-between p-3 border rounded-lg cursor-pointer transition text-xs ${
                  isChecked
                    ? 'bg-emerald-950/10 border-emerald-500/20 text-emerald-300'
                    : 'bg-slate-950/40 border-slate-850 text-slate-400 hover:bg-slate-900/30'
                }`}
              >
                <div className="flex items-center space-x-3 truncate">
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => {}} // handled by div onClick
                    className="rounded accent-emerald-500 w-3.5 h-3.5 cursor-pointer flex-shrink-0"
                  />
                  <div className="truncate text-left">
                    <div className="font-bold text-[11px] truncate">
                      Track {String(track.trackNumber).padStart(2, '0')}: {track.title || splits[idx].name}
                    </div>
                    {track.artist && <div className="text-[10px] text-slate-500 truncate">Artist: {track.artist}</div>}
                  </div>
                </div>

                <div className="flex items-center space-x-3 shrink-0 font-mono text-[10px]">
                  <span>{formatTime(split.duration)}</span>
                  {/* Play Audition */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation(); // prevent checkbox toggle
                      handleTogglePreviewSplit(split);
                    }}
                    className={`p-1.5 rounded transition border cursor-pointer ${
                      playingSplitId === split.id
                        ? 'bg-amber-600/15 border-amber-500/30 text-amber-300'
                        : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {playingSplitId === split.id ? <Square className="w-2.5 h-2.5 fill-current" /> : <Play className="w-2.5 h-2.5 fill-current" />}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* RIGHT COLUMN: Album details, export settings & giant EXPORT button */}
      <div className="lg:col-span-7 flex flex-col justify-between h-full min-h-0">
        <div className="space-y-4 overflow-y-auto flex-1 pr-1">
          {/* Metadata Section */}
          <div className="space-y-3 bg-slate-950/40 p-4 rounded-xl border border-slate-900 flex-shrink-0">
            <div className="flex items-center space-x-2 text-slate-200 font-bold uppercase tracking-wider text-[10px]">
              <Tag className="w-3.5 h-3.5 text-emerald-400" />
              <span>Project Metadata Details</span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col space-y-1 text-left">
                <label className="text-slate-400 font-semibold">Album/Recording Title</label>
                <input
                  type="text"
                  value={albumTitle}
                  onChange={(e) => setAlbumTitle(e.target.value)}
                  className="bg-slate-900 border border-slate-800 rounded px-2.5 py-1.5 text-xs text-slate-100 font-semibold focus:outline-none focus:border-emerald-500/40"
                  placeholder="Album title..."
                />
              </div>

              <div className="flex flex-col space-y-1 text-left">
                <label className="text-slate-400 font-semibold">Album Artist Name</label>
                <div className="flex space-x-2">
                  <input
                    type="text"
                    value={albumArtist}
                    onChange={(e) => setAlbumArtist(e.target.value)}
                    className="flex-1 bg-slate-900 border border-slate-800 rounded px-2.5 py-1.5 text-xs text-slate-100 font-semibold focus:outline-none focus:border-emerald-500/40"
                    placeholder="Artist name..."
                  />
                  <button
                    type="button"
                    onClick={handleApplyAlbumArtistToAll}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-[10px] rounded hover:text-white transition cursor-pointer border border-slate-700"
                    title="Apply this artist name to all splits"
                  >
                    Apply All
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Format Settings Card */}
          <div className="space-y-3.5 bg-slate-950/40 p-4 rounded-xl border border-slate-900 flex-shrink-0 text-xs">
            <div className="flex items-center space-x-2 text-slate-200 font-bold uppercase tracking-wider text-[10px]">
              <Folder className="w-3.5 h-3.5 text-emerald-400" />
              <span>Export Format & Quality Codecs</span>
            </div>

            <div className="grid grid-cols-2 gap-4">
              {/* Output Format Select */}
              <div className="flex flex-col space-y-1 text-left">
                <label className="text-slate-400 font-semibold">Output Audio Format</label>
                <select
                  value={format}
                  onChange={(e) => setFormat(e.target.value as AudioFormat)}
                  className="bg-slate-900 border border-slate-800 rounded px-2.5 py-1.5 text-xs text-slate-100 font-bold focus:outline-none cursor-pointer"
                >
                  <option value="flac">FLAC (Lossless)</option>
                  <option value="wav">WAV (Lossless uncompressed)</option>
                  <option value="mp3">MP3 (Compressed)</option>
                </select>
              </div>

              {/* Bit Depth / Quality selectors */}
              <div className="flex flex-col space-y-1 text-left">
                {format === 'flac' && (
                  <>
                    <label className="text-slate-400 font-semibold">Bit Depth</label>
                    <div className="grid grid-cols-2 gap-1.5 bg-slate-900 p-1 rounded border border-slate-800">
                      <button
                        type="button"
                        onClick={() => setFlacBitDepth(16)}
                        className={`py-1 text-[11px] font-bold rounded cursor-pointer transition ${
                          flacBitDepth === 16 ? 'bg-slate-800 text-emerald-400' : 'text-slate-400'
                        }`}
                      >
                        16-bit
                      </button>
                      <button
                        type="button"
                        onClick={() => setFlacBitDepth(24)}
                        className={`py-1 text-[11px] font-bold rounded cursor-pointer transition ${
                          flacBitDepth === 24 ? 'bg-slate-800 text-emerald-400' : 'text-slate-400'
                        }`}
                      >
                        24-bit
                      </button>
                    </div>
                  </>
                )}

                {format === 'wav' && (
                  <>
                    <label className="text-slate-400 font-semibold">Bit Depth</label>
                    <div className="grid grid-cols-2 gap-1.5 bg-slate-900 p-1 rounded border border-slate-800">
                      <button
                        type="button"
                        onClick={() => setWavBitDepth(16)}
                        className={`py-1 text-[11px] font-bold rounded cursor-pointer transition ${
                          wavBitDepth === 16 ? 'bg-slate-800 text-emerald-400' : 'text-slate-400'
                        }`}
                      >
                        16-bit
                      </button>
                      <button
                        type="button"
                        onClick={() => setWavBitDepth(24)}
                        className={`py-1 text-[11px] font-bold rounded cursor-pointer transition ${
                          wavBitDepth === 24 ? 'bg-slate-800 text-emerald-400' : 'text-slate-400'
                        }`}
                      >
                        24-bit
                      </button>
                    </div>
                  </>
                )}

                {format === 'mp3' && (
                  <>
                    <label className="text-slate-400 font-semibold">Encoding Bitrate</label>
                    <select
                      value={mp3Bitrate}
                      onChange={(e) => setMp3Bitrate(Number(e.target.value) as Mp3Bitrate)}
                      className="bg-slate-900 border border-slate-800 rounded px-2 py-1.5 text-xs text-slate-100 font-bold focus:outline-none cursor-pointer"
                    >
                      <option value={128}>128 kbps (Draft)</option>
                      <option value={192}>192 kbps (Standard)</option>
                      <option value={256}>256 kbps (High Quality)</option>
                      <option value={320}>320 kbps (Extreme/Archival)</option>
                    </select>
                  </>
                )}
              </div>
            </div>

            {/* Split Micro-fades Option */}
            <label className="flex items-center space-x-2.5 text-[11px] text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoSplitFades}
                onChange={(e) => setAutoSplitFades(e.target.checked)}
                className="rounded accent-emerald-500 w-3.5 h-3.5 cursor-pointer"
              />
              <span className="font-semibold text-slate-200">
                Auto-apply 10ms micro-fades at boundaries to prevent pops/clicks (UK spelling)
              </span>
            </label>
          </div>
        </div>

        {/* Global Save action panel (Bottom fixed deck) */}
        <div className="space-y-4 pt-4 border-t border-slate-900 bg-slate-950/40 p-4 rounded-xl flex-shrink-0 text-left">
          {/* Progress loader */}
          {isSavingAll && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-[10px] text-slate-400 font-mono">
                <span className="animate-pulse text-emerald-400 font-bold uppercase">{saveProgress.message}</span>
                <span>
                  {saveProgress.current} / {saveProgress.total} Tracks
                </span>
              </div>
              <div className="w-full bg-slate-900 h-1.5 rounded overflow-hidden border border-slate-850">
                <div
                  className="bg-emerald-500 h-full transition-all duration-300"
                  style={{ width: `${(saveProgress.current / Math.max(1, saveProgress.total)) * 100}%` }}
                />
              </div>
            </div>
          )}

          {/* Results notice banner */}
          {saveResultNotice && (
            <div className="flex items-center space-x-2.5 px-3.5 py-2.5 bg-emerald-950/20 border border-emerald-500/20 rounded text-xs text-emerald-300">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span className="font-mono">{saveResultNotice}</span>
            </div>
          )}

          <div className="flex items-center justify-between gap-4">
            <div className="text-[10px] font-mono text-slate-500 uppercase">
              Ready to export <strong className="text-emerald-400 font-bold">{selectedCount}</strong> out of <strong className="text-slate-300">{splits.length}</strong> slices
            </div>

            {/* Giant full-width green EXPORT ALL button */}
            <button
              type="button"
              onClick={handleExportAllTracks}
              disabled={selectedCount === 0 || isSavingAll}
              className="flex items-center space-x-2.5 px-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-bold border border-emerald-500/20 cursor-pointer shadow-md transition-all uppercase tracking-wider text-xs disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <FolderDown className="w-4 h-4 text-emerald-200" />
              <span>EXPORT ALL</span>
            </button>
          </div>
        </div>

      </div>

      {/* Manual save Fallback Modal */}
      {fallbackModalData.isOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-slate-800 rounded p-5 max-w-lg w-full shadow-2xl space-y-4">
            <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wide">
              Manual Save Required (Blocked popup fallback)
            </h3>
            <p className="text-xs text-slate-400">
              Your browser blocks automated multiple-file downloads. Please click the buttons below to manually download each compiled track file:
            </p>
            <div className="max-h-36 overflow-y-auto space-y-1.5 pr-1 text-xs">
              {fallbackModalData.files.map((file, idx) => (
                <div key={idx} className="flex justify-between items-center bg-slate-950 p-2 rounded border border-slate-850">
                  <span className="font-mono text-slate-300 text-[11px] truncate w-80">{file.name}</span>
                  <button
                    type="button"
                    onClick={() => {
                      const url = URL.createObjectURL(file.blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = file.name;
                      document.body.appendChild(a);
                      a.click();
                      document.body.removeChild(a);
                      URL.revokeObjectURL(url);
                    }}
                    className="flex items-center space-x-1 px-2.5 py-1 bg-emerald-700 hover:bg-emerald-600 text-white rounded text-[10px] font-bold cursor-pointer"
                  >
                    <Download className="w-3 h-3" />
                    <span>Download</span>
                  </button>
                </div>
              ))}
            </div>
            <div className="text-right">
              <button
                type="button"
                onClick={handleCloseFallbackModal}
                className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded font-semibold text-xs transition cursor-pointer"
              >
                Close Panel
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};