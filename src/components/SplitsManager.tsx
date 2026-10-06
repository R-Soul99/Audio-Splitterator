import React, { useState, useEffect, useRef } from 'react';
import {
  Download,
  Tag,
  CheckCircle2,
} from 'lucide-react';
import { AudioMetadata, AudioFormat, Mp3Bitrate, WavBitDepth, FlacBitDepth, FlacCompressionLevel, FolderHierarchyType, NamingPattern } from '../types';
import { formatTime, extractSlice } from '../utils/audioProcessing';
import { saveFilesPrompt, FileToSave, resolveFolderSegments } from '../utils/fileSaver';
import { getExportPage, getSelectedSplits, getSelectionState, selectAllTracks, EXPORT_PAGE_SIZE } from '../utils/exportPanel';
import { getDesktopExport } from '../utils/desktopExport';
// Keep encoders in the startup bundle: an open desktop app must not fetch a
// stale hashed chunk after its on-disk build has been replaced.
import { encodeFlac, encodeMp3, encodeWav } from '../utils/audioEncoder';

interface SplitsManagerProps {
  sourceBuffer: AudioBuffer;
  splits: any[];
  mainFileName: string;
  fadeSettings: any;
  onSeekTo: (time: number) => void;
  preRecordArtist?: string;
  preRecordAlbum?: string;
  trackNames?: { [splitId: string]: string };
  onTrackNameChange?: (splitId: string, name: string) => void;
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
  trackNames = {},
  onTrackNameChange,
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
  const [genre, setGenre] = useState<string>('');
  const selectionRef = useRef<HTMLInputElement>(null);
  const [page, setPage] = useState(0);
  const [showExportedFiles, setShowExportedFiles] = useState(false);
  const [startTrackNumber] = useState<number>(1);
  const [padTrackNumbers] = useState<boolean>(true);
  const [namingPattern] = useState<NamingPattern>('track_title');
  const [createSubfolders, setCreateSubfolders] = useState<boolean>(() => localStorage.getItem('exportNestedFolders') === 'true');
  const [exportFolder, setExportFolder] = useState('');
  const desktopExport = getDesktopExport();
  useEffect(() => {
    desktopExport?.getExportFolder().then(setExportFolder).catch((error) => setSaveResultNotice(String(error)));
  }, []);
  const browseExportFolder = async () => {
    try { const folder = await desktopExport?.chooseExportFolder(); if (folder) setExportFolder(folder); }
    catch (error) { setSaveResultNotice(`Unable to select export folder: ${String(error)}`); }
  };
  const [folderHierarchyType] = useState<FolderHierarchyType>('artist_album');

  // Automatic split micro-fades toggle (defaults to true)
  const [autoSplitFades, setAutoSplitFades] = useState<boolean>(true);

  // Naming options
  const [includeTrackNumbers, setIncludeTrackNumbers] = useState<boolean>(true);
  const [includeArtistInFilename, setIncludeArtistInFilename] = useState<boolean>(true);
  const [includeAlbumInFilename, setIncludeAlbumInFilename] = useState<boolean>(true);
  const [includeTags, setIncludeTags] = useState<boolean>(true);

  // Track data dictionary keyed by split ID
  const [tracksData, setTracksData] = useState<{ [splitId: string]: TrackCustomData }>({});
  const editedTrackTitlesRef = useRef<Set<string>>(new Set());

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
        const initialTrackNum = startTrackNumber + idx;
        const initialTitle = trackNames[split.id] || split.name || `Track_${String(initialTrackNum).padStart(2, '0')}`;
        if (!next[split.id] || (!next[split.id].title && !editedTrackTitlesRef.current.has(split.id))) {
          next[split.id] = {
            ...next[split.id],
            trackNumber: initialTrackNum,
            title: initialTitle,
            artist: next[split.id]?.artist || albumArtist || preRecordArtist || '',
          };
          changed = true;
        }
      });
      return changed ? next : prev;
    });

    setSelectedTracks((prev) => {
      const next = { ...prev };
      splits.forEach((split) => {
        if (next[split.id] === undefined) {
          next[split.id] = true;
        }
      });
      return next;
    });
  }, [splits, startTrackNumber, albumArtist, preRecordArtist, trackNames]);

  // Calculate effective fade settings based on toggle
  const getEffectiveFadeSettings = (): any => {
    return autoSplitFades
      ? {
          fadeInEnabled: true,
          fadeInMs: 10,
          fadeInCurve: 'custom',
          fadeInCurveNode: 0.5,
          fadeInCurveNodePosition: 0.5,
          fadeOutEnabled: true,
          fadeOutMs: 10,
          fadeOutCurve: 'custom',
          fadeOutCurveNode: 0.5,
          fadeOutCurveNodePosition: 0.5,
          zeroCrossing: fadeSettings.zeroCrossing,
        }
      : {
          fadeInEnabled: false,
          fadeInMs: 0,
          fadeInCurve: 'custom',
          fadeInCurveNode: 0.5,
          fadeInCurveNodePosition: 0.5,
          fadeOutEnabled: false,
          fadeOutMs: 0,
          fadeOutCurve: 'custom',
          fadeOutCurveNode: 0.5,
          fadeOutCurveNodePosition: 0.5,
          zeroCrossing: fadeSettings.zeroCrossing,
        };
  };

  // Preview / Audition single split
  const handleTogglePreviewSplit = async (split: any) => {
    if (playingSplitId === split.id) {
      if (previewSourceRef.current) {
        try { previewSourceRef.current.stop(); } catch {}
        previewSourceRef.current = null;
      }
      setPlayingSplitId(null);
      return;
    }
    if (previewSourceRef.current) {
      try { previewSourceRef.current.stop(); } catch {}
      previewSourceRef.current = null;
    }
    try {
      const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      previewCtxRef.current = ctx;
      const sliceBuffer = extractSlice(sourceBuffer, split.startTime, split.endTime, getEffectiveFadeSettings());
      const source = ctx.createBufferSource();
      source.buffer = sliceBuffer;
      source.connect(ctx.destination);
      source.onended = () => { setPlayingSplitId(null); };
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
    const parts: string[] = [];
    if (includeTrackNumbers) parts.push(numStr);
    if (includeArtistInFilename && albumArtist.trim()) parts.push(albumArtist.trim());
    if (includeAlbumInFilename && albumTitle.trim()) parts.push(albumTitle.trim());
    parts.push(cleanTitle);
    return parts.join(' - ').replace(/[/\\?%*:|"<>]/g, '_').trim();
  };

  const getTrackTitle = (split: any, index: number) => {
    const savedTitle = tracksData[split.id]?.title;
    if (savedTitle && savedTitle.length > 0) return savedTitle;
    if (editedTrackTitlesRef.current.has(split.id)) return savedTitle ?? '';
    return trackNames[split.id] || split.name || `Track_${String(index + 1).padStart(2, '0')}`;
  };

  const encodeSplitSlice = async (split: any): Promise<{ blob: Blob; fileName: string }> => {
    const rawSlice = extractSlice(sourceBuffer, split.startTime, split.endTime, getEffectiveFadeSettings());
    const track = tracksData[split.id];
    const trackArtist = albumArtist.trim();
    const trackTitle = (track?.title || getTrackTitle(split, (split.trackNumber ?? split.index ?? 1) - 1)).trim();
    const trackNumber = splits.findIndex((item) => item.id === split.id) + startTrackNumber;

    const metadata: AudioMetadata = {
      artist: trackArtist,
      albumArtist: albumArtist.trim() || trackArtist,
      title: trackTitle,
      album: albumTitle.trim(),
      genre: genre.trim(),
      trackNumber,
    };

    const exportMetadata = includeTags ? metadata : undefined;
    if (format === 'flac') {
      const bytes = await encodeFlac(rawSlice, { bitDepth: flacBitDepth, compressionLevel: flacCompression, metadata: exportMetadata });
      const blob = new Blob([bytes], { type: 'audio/flac' });
      return { blob, fileName: `${constructFileName(trackNumber, trackArtist, trackTitle, namingPattern, padTrackNumbers)}.flac` };
    } else if (format === 'mp3') {
      const bytes = await encodeMp3(rawSlice, { kbps: mp3Bitrate, metadata: exportMetadata });
      const blob = new Blob([bytes], { type: 'audio/mpeg' });
      return { blob, fileName: `${constructFileName(trackNumber, trackArtist, trackTitle, namingPattern, padTrackNumbers)}.mp3` };
    } else {
      const bytes = encodeWav(rawSlice, { bitDepth: wavBitDepth, metadata: exportMetadata });
      const blob = new Blob([bytes], { type: 'audio/wav' });
      return { blob, fileName: `${constructFileName(trackNumber, trackArtist, trackTitle, namingPattern, padTrackNumbers)}.wav` };
    }
  };

  const handleExportAllTracks = async () => {
    const exportSplits = getSelectedSplits<any>(splits, selectedTracks);
    if (exportSplits.length === 0) { alert("No tracks selected for export."); return; }
    if (desktopExport && !exportFolder) { await browseExportFolder(); return; }

    setIsSavingAll(true);
    setSaveProgress({ current: 0, total: exportSplits.length, message: 'Preparing tracks for export...' });
    setSaveResultNotice(null);

    try {
      const filesToSave: FileToSave[] = [];
      const folderStructure = { enabled: createSubfolders, type: folderHierarchyType, artist: albumArtist, album: albumTitle };
      const segments = resolveFolderSegments(folderStructure);
      for (let i = 0; i < exportSplits.length; i++) {
        const split = exportSplits[i];
        const track = tracksData[split.id];
        const trackTitle = (track?.title || getTrackTitle(split, (split.trackNumber ?? split.index ?? 1) - 1)).trim();
        setSaveProgress({ current: i, total: exportSplits.length, message: `Encoding split ${i + 1} of ${exportSplits.length}: ${trackTitle}...` });
        const encoded = await encodeSplitSlice(split);
        if (desktopExport) {
          await desktopExport.saveExportFile({ name: encoded.fileName, data: new Uint8Array(await encoded.blob.arrayBuffer()), segments });
        } else {
          filesToSave.push({ blob: encoded.blob, name: encoded.fileName });
        }
      }

      setSaveProgress({ current: exportSplits.length, total: exportSplits.length, message: 'Saving tracks to disk...' });
      if (desktopExport) {
        setSaveResultNotice(`Saved ${exportSplits.length} audio files to ${[exportFolder, ...segments].join(' / ')}`);
        if (showExportedFiles) {
          try { await desktopExport.openExportFolder(segments); }
          catch (error) { setSaveResultNotice(`Files saved; unable to open folder: ${String(error)}`); }
        }
        return;
      }
      const result = await saveFilesPrompt(filesToSave, { mode: 'individual', folderStructure });

      if (result.method !== 'iframe_blocked') {
        setSaveResultNotice(result.message);
      } else if (result.files) {
        setFallbackModalData({ isOpen: true, files: result.files });
      }
    } catch (err) {
      console.error('Failed to export tracks:', err);
      const detail = err instanceof Error ? err.message : String(err);
      setSaveResultNotice(`Export failed: ${detail}`);
    } finally {
      setIsSavingAll(false);
    }
  };

  const handleCloseFallbackModal = () => { setFallbackModalData({ isOpen: false, files: [] }); };
  const selection = getSelectionState(splits, selectedTracks);
  const selectedCount = selection.count;
  const pagination = getExportPage<any>(splits, page);
  useEffect(() => { setPage(pagination.page); }, [pagination.page]);
  useEffect(() => { if (selectionRef.current) selectionRef.current.indeterminate = selection.mixed; }, [selection.mixed]);
  const controlClass = 'rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200 focus:outline-none focus:border-emerald-500 disabled:opacity-40';
  const checkbox = (label: string, checked: boolean, change: (value: boolean) => void, disabled = false) => (
    <label className="inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => change(event.target.checked)} className="accent-emerald-500 disabled:opacity-40" />{label}
    </label>
  );
  const status = isSavingAll ? saveProgress.message : saveResultNotice || (selectedCount ? 'Ready to export' : 'Select tracks to export');

  return (
    <div className="relative flex h-full min-h-0 flex-col gap-2 overflow-hidden select-none text-[10px] text-slate-300">
      <fieldset disabled={isSavingAll} className="m-0 flex min-h-0 flex-1 flex-col border-0 p-0">
        <div aria-label="Recording info" className="mb-1 flex h-7 shrink-0 items-center gap-2">
          <strong className="mr-1 shrink-0 text-slate-300">Recording info</strong>
          <label className="flex shrink-0 items-center gap-1.5" htmlFor="export-artist">Artist
            <input id="export-artist" type="text" title={albumArtist} className={`${controlClass} h-6 w-[150px] min-w-0 py-0.5`} value={albumArtist} onChange={(event) => setAlbumArtist(event.target.value)} />
          </label>
          <label className="flex shrink-0 items-center gap-1.5" htmlFor="export-album">Album
            <input id="export-album" type="text" title={albumTitle} className={`${controlClass} h-6 w-[150px] min-w-0 py-0.5`} value={albumTitle} onChange={(event) => setAlbumTitle(event.target.value)} />
          </label>
          <label className="flex shrink-0 items-center gap-1.5" htmlFor="export-genre">Genre
            <input id="export-genre" type="text" title={genre} className={`${controlClass} h-6 w-[120px] min-w-0 py-0.5`} value={genre} onChange={(event) => setGenre(event.target.value)} />
          </label>
          <div className="ml-auto shrink-0">{checkbox('Include tags', includeTags, setIncludeTags)}</div>
        </div>
        <div className="grid h-6 shrink-0 grid-cols-[44%_56%] items-center">
          <div className="flex items-center gap-2 pr-2">
            <span>Include in filename:</span>
            {checkbox('Track no.', includeTrackNumbers, setIncludeTrackNumbers)}
            {checkbox('Artist', includeArtistInFilename, setIncludeArtistInFilename)}
            {checkbox('Album', includeAlbumInFilename, setIncludeAlbumInFilename)}
          </div>
          <div className="flex items-center justify-between border-l border-slate-700 pl-2">
            <strong className="uppercase tracking-wider text-emerald-400">Track tags</strong>
          </div>
        </div>
        <div role="table" aria-label="Tracks to export and track tags" className="flex min-h-0 flex-1 flex-col overflow-hidden border-y border-slate-700">
          <div role="row" className="grid h-7 shrink-0 grid-cols-[24px_minmax(0,1fr)_48px_14%_18%_14%_10%] items-center bg-slate-900 text-[9px] uppercase tracking-wider">
            <div role="columnheader"><input ref={selectionRef} type="checkbox" aria-label="Select all tracks across all pages" aria-checked={selection.mixed ? 'mixed' : selection.all} checked={selection.all} disabled={!splits.length} onChange={(event) => setSelectedTracks(selectAllTracks(splits, event.target.checked))} className="accent-emerald-500" /></div>
            <div role="columnheader">Tracks to export</div><div role="columnheader">Time</div>
            {['Artist', 'Title', 'Album', 'Genre'].map((name) => <div role="columnheader" key={name} className="border-l border-slate-800 px-2">{name}</div>)}
          </div>
          <div className="grid min-h-0 flex-1" style={{ gridTemplateRows: `repeat(${EXPORT_PAGE_SIZE}, minmax(0, 1fr))` }}>
            {Array.from({ length: EXPORT_PAGE_SIZE }, (_, slot) => {
              const split = pagination.items[slot];
              if (!split) return <div key={`empty-${slot}`} aria-hidden="true" className="border-b border-slate-800/50" />;
              const idx = pagination.page * EXPORT_PAGE_SIZE + slot;
              const title = getTrackTitle(split, idx);
              const filename = `${constructFileName(idx + 1, albumArtist, title, namingPattern, padTrackNumbers)}.${format}`;
              return <div role="row" key={split.id} className={`grid min-h-0 grid-cols-[24px_minmax(0,1fr)_48px_14%_18%_14%_10%] items-center border-b border-slate-800/70 font-mono ${selectedTracks[split.id] ? 'bg-emerald-950/10 text-emerald-300' : 'text-slate-400'}`}>
                <div role="cell"><input type="checkbox" aria-label={`Export track ${idx + 1}`} checked={!!selectedTracks[split.id]} onChange={(event) => setSelectedTracks((prev) => ({ ...prev, [split.id]: event.target.checked }))} className="accent-emerald-500" /></div>
                <div role="cell" className="truncate pr-2" title={filename}>{filename}</div>
                <div role="cell" className="text-slate-400">{formatTime(split.duration)}</div>
                <div role="cell" className="truncate border-l border-slate-800 px-2" title={albumArtist}>{albumArtist || '—'}</div>
                <div role="cell" className="min-w-0 border-l border-slate-800 px-1">
                  <input aria-label={`Title for track ${idx + 1}`} value={title} className="w-full min-w-0 rounded bg-transparent px-1 py-1 focus:outline-none focus:ring-1 focus:ring-emerald-500" onChange={(event) => {
                    const value = event.target.value;
                    editedTrackTitlesRef.current.add(split.id);
                    setTracksData((prev) => ({ ...prev, [split.id]: { trackNumber: idx + 1, title: value, artist: albumArtist } }));
                    onTrackNameChange?.(split.id, value);
                  }} onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
                    if (!['Enter', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
                    event.preventDefault();
                    const inputs = Array.from(event.currentTarget.closest('[role="table"]')?.querySelectorAll('input[aria-label^="Title for track "]') ?? []) as HTMLInputElement[];
                    const next = inputs[inputs.indexOf(event.currentTarget) + (event.key === 'ArrowUp' ? -1 : 1)];
                    next?.focus(); next?.select();
                  }} />
                </div>
                <div role="cell" className="truncate border-l border-slate-800 px-2" title={albumTitle}>{albumTitle || '—'}</div>
                <div role="cell" className="truncate border-l border-slate-800 px-2" title={genre}>{genre || '—'}</div>
              </div>;
            })}
          </div>
        </div>
        <div aria-label="Export pagination" className="flex h-6 shrink-0 items-center justify-end gap-1.5 text-[9px]">
          {!splits.length && <span className="mr-auto text-slate-500">No tracks to export</span>}
          <button type="button" aria-label="Previous page" className="h-5 w-5 rounded border border-slate-700 bg-slate-950 text-emerald-300 disabled:opacity-30" disabled={pagination.page === 0} onClick={() => setPage(pagination.page - 1)}>&#8249;</button>
          <span className="w-12 text-center font-mono tabular-nums">{pagination.page + 1} / {pagination.pageCount}</span>
          <button type="button" aria-label="Next page" className="h-5 w-5 rounded border border-slate-700 bg-slate-950 text-emerald-300 disabled:opacity-30" disabled={pagination.page + 1 >= pagination.pageCount} onClick={() => setPage(pagination.page + 1)}>&#8250;</button>
        </div>
      </fieldset>
      <fieldset aria-label="Export controls" disabled={isSavingAll} className="m-0 h-[124px] shrink-0 rounded border border-slate-700 bg-slate-900/70 p-2">
        <div className="flex h-6 items-center gap-2">
          <span className="shrink-0">Export folder</span>
          <span aria-label="Export destination" className="block w-[300px] min-w-0 truncate rounded border border-slate-800 px-2 py-1 font-mono" title={exportFolder}>{exportFolder || (desktopExport ? 'Choose destination...' : 'Browser save destination')}</span>
          <button type="button" className={`${controlClass} h-6 shrink-0 py-0.5`} disabled={!desktopExport} onClick={browseExportFolder}>Browse&#8230;</button>
          <div aria-label="Output settings" className="ml-2 flex items-center gap-3">
            <label className="flex items-center gap-2">Format
              <select aria-label="Format" className={`${controlClass} h-6 w-[76px] py-0.5`} value={format} onChange={(event) => setFormat(event.target.value as AudioFormat)}><option value="flac">FLAC</option><option value="wav">WAV</option><option value="mp3">MP3</option></select>
            </label>
            <label className="flex items-center gap-2"><span className="whitespace-nowrap">{format === 'mp3' ? 'Bitrate' : 'Bit depth'}</span>
              <select aria-label={format === 'mp3' ? 'Bitrate' : 'Bit depth'} className={`${controlClass} h-6 w-[76px] py-0.5`} value={format === 'mp3' ? mp3Bitrate : format === 'flac' ? flacBitDepth : wavBitDepth} onChange={(event) => {
                const value = Number(event.target.value);
                if (format === 'mp3') setMp3Bitrate(value as Mp3Bitrate);
                else if (format === 'flac') setFlacBitDepth(value as FlacBitDepth);
                else setWavBitDepth(value as WavBitDepth);
              }}>{format === 'mp3' ? [128, 192, 256, 320].map((value) => <option key={value} value={value}>{value} kbps</option>) : [16, 24].map((value) => <option key={value} value={value}>{value}-bit</option>)}</select>
            </label>
          </div>
        </div>
        <div className="mt-1 flex items-start gap-3">
          <div aria-label="Export action" className="w-[160px] shrink-0">
            <button type="button" onClick={handleExportAllTracks} disabled={!selectedCount || isSavingAll} className="inline-flex h-7 items-center gap-2 rounded border border-emerald-400/30 bg-emerald-700 px-3 font-bold uppercase tracking-wide text-white hover:bg-emerald-600 disabled:opacity-40"><Download className="h-3.5 w-3.5" />Export</button>
            <div role="status" aria-live="polite" className="mt-1 h-11 w-full text-[9px] leading-[14px]">
              <div className="truncate">{selectedCount} of {splits.length} tracks selected</div>
              <div className="line-clamp-2 break-words text-emerald-300" title={status}>{status}</div>
            </div>
          </div>
          <div aria-label="Export options" className="flex flex-col gap-2 pt-1 text-[9px]">
            {checkbox('Save in Artist/Album folders', createSubfolders, (value) => { setCreateSubfolders(value); localStorage.setItem('exportNestedFolders', String(value)); })}
            {checkbox('Micro fade between splits', autoSplitFades, setAutoSplitFades)}
            {checkbox('Show exported files after export', showExportedFiles, setShowExportedFiles, !desktopExport)}
          </div>
        </div>
      </fieldset>
      {/* Manual save Fallback Modal */}
      {fallbackModalData.isOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-slate-800 rounded p-5 max-w-lg w-full shadow-2xl space-y-4">
            <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wide">Manual Save Required (Blocked popup fallback)</h3>
            <p className="text-xs text-slate-400">Your browser blocks automated multiple-file downloads. Please click the buttons below to manually download each compiled track file:</p>
            <div className="max-h-36 overflow-y-auto space-y-1.5 pr-1 text-xs">
              {fallbackModalData.files.map((file, idx) => (
                <div key={idx} className="flex justify-between items-center bg-slate-950 p-2 rounded border border-slate-850">
                  <span className="font-mono text-slate-300 text-[11px] truncate w-80">{file.name}</span>
                  <button type="button" onClick={() => { const url = URL.createObjectURL(file.blob); const a = document.createElement('a'); a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url); }} className="flex items-center space-x-1 px-2.5 py-1 bg-emerald-700 hover:bg-emerald-600 text-white rounded text-[10px] font-bold cursor-pointer">
                    <Download className="w-3 h-3" />
                    <span>Download</span>
                  </button>
                </div>
              ))}
            </div>
            <div className="text-right">
              <button type="button" onClick={handleCloseFallbackModal} className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded font-semibold text-xs transition cursor-pointer">Close Panel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
