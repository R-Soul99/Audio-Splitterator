import React, { useState, useRef } from 'react';
import {
  BatchItem,
  AudioFormat,
  SampleRateOption,
  ExportMode,
  Mp3Bitrate,
  WavBitDepth,
  FlacBitDepth,
  FadeSettings,
} from '../types';
import { FadeSettingsPanel } from './FadeSettingsPanel';
import { extractSlice, formatTime, resampleAudioBuffer } from '../utils/audioProcessing';
import { encodeWav, encodeMp3, encodeFlac } from '../utils/audioEncoder';
import { parseArtistTitle } from '../utils/tagParser';
import { saveFilesPrompt, triggerDownload } from '../utils/fileSaver';
import {
  Layers,
  UploadCloud,
  FolderDown,
  FileArchive,
  CheckCircle2,
  AlertCircle,
  Clock,
  Download,
  Trash2,
  ExternalLink,
  Sparkles,
  Volume2,
} from 'lucide-react';

interface BatchProcessorProps {
  onOpenInEditor: (audioBuffer: AudioBuffer, fileName: string) => void;
}

export const BatchProcessor: React.FC<BatchProcessorProps> = ({ onOpenInEditor }) => {
  const [items, setItems] = useState<BatchItem[]>([]);
  const [targetFormat, setTargetFormat] = useState<AudioFormat>('flac');
  const [sampleRate, setSampleRate] = useState<SampleRateOption>(44100);
  const [mp3Bitrate, setMp3Bitrate] = useState<Mp3Bitrate>(320);
  const [wavBitDepth, setWavBitDepth] = useState<WavBitDepth>(16);
  const [flacBitDepth, setFlacBitDepth] = useState<FlacBitDepth>(16);
  const [exportMode, setExportMode] = useState<ExportMode>('individual');
  const [applyTags, setApplyTags] = useState<boolean>(true);
  const [normalize, setNormalize] = useState<boolean>(false);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [overallProgress, setOverallProgress] = useState<{ current: number; total: number }>({
    current: 0,
    total: 0,
  });
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  // Fade configuration
  const [fadeSettings, setFadeSettings] = useState<FadeSettings>({
    fadeInEnabled: true,
    fadeInMs: 25,
    fadeInCurve: 'custom',
    fadeInCurveNode: 0.5,
    fadeInCurveNodePosition: 0.5,
    fadeOutEnabled: true,
    fadeOutMs: 50,
    fadeOutCurve: 'custom',
    fadeOutCurveNode: 0.5,
    fadeOutCurveNodePosition: 0.5,
    zeroCrossing: true,
  });

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Handle files added via input or drag & drop
  const handleAddFiles = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;

    const newItems: BatchItem[] = Array.from(fileList).map((file) => {
      const cleanName = file.name.replace(/\.[^/.]+$/, '');
      const parsed = parseArtistTitle(cleanName);
      return {
        id: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        file,
        name: cleanName,
        parsedArtist: parsed.artist,
        parsedTitle: parsed.title,
        status: 'idle',
        progress: 0,
      };
    });

    setItems((prev) => [...prev, ...newItems]);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    handleAddFiles(e.dataTransfer.files);
  };

  const removeItem = (id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  };

  const clearAll = () => {
    setItems([]);
    setResultMessage(null);
  };

  // Decode file to AudioBuffer
  const decodeFile = async (file: File): Promise<AudioBuffer> => {
    const arrayBuffer = await file.arrayBuffer();
    const audioCtx = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    try {
      const buffer = await audioCtx.decodeAudioData(arrayBuffer);
      audioCtx.close();
      return buffer;
    } catch (err) {
      audioCtx.close();
      throw err;
    }
  };

  // Process a single item
  const processBatchItem = async (
    item: BatchItem,
    index: number
  ): Promise<{ blob: Blob; fileName: string }> => {
    // 1. Decode
    const buffer = await decodeFile(item.file);

    // 2. Normalize if enabled (peak to -0.5 dB)
    if (normalize) {
      const numChannels = buffer.numberOfChannels;
      let maxPeak = 0;
      for (let c = 0; c < numChannels; c++) {
        const data = buffer.getChannelData(c);
        for (let s = 0; s < data.length; s++) {
          const absVal = Math.abs(data[s]);
          if (absVal > maxPeak) maxPeak = absVal;
        }
      }
      if (maxPeak > 0) {
        const targetPeak = Math.pow(10, -0.5 / 20); // -0.5 dBFS
        const gain = targetPeak / maxPeak;
        for (let c = 0; c < numChannels; c++) {
          const data = buffer.getChannelData(c);
          for (let s = 0; s < data.length; s++) {
            data[s] *= gain;
          }
        }
      }
    }

    // 3. Apply Fades and Zero-crossing detection
    const rawProcessed = extractSlice(buffer, 0, buffer.duration, fadeSettings);

    // High-fidelity resampling if specified
    const effectiveSampleRate = sampleRate === 0 ? rawProcessed.sampleRate : sampleRate;
    const processedBuffer =
      effectiveSampleRate !== rawProcessed.sampleRate
        ? await resampleAudioBuffer(rawProcessed, effectiveSampleRate)
        : rawProcessed;

    // 4. Metadata tags from filename
    let metadata = {};
    if (applyTags) {
      const parsed = parseArtistTitle(item.name);
      metadata = {
        artist: parsed.artist || item.parsedArtist || '',
        title: parsed.title || item.parsedTitle || item.name,
        trackNumber: index + 1,
      };
    }

    // 5. Encode into selected format
    let rawBytes: Uint8Array;
    let mimeType = 'audio/wav';
    if (targetFormat === 'wav') {
      rawBytes = encodeWav(processedBuffer, { bitDepth: wavBitDepth, metadata });
      mimeType = 'audio/wav';
    } else if (targetFormat === 'mp3') {
      rawBytes = await encodeMp3(processedBuffer, { kbps: mp3Bitrate, metadata });
      mimeType = 'audio/mpeg';
    } else {
      rawBytes = await encodeFlac(processedBuffer, {
        compressionLevel: 5,
        bitDepth: flacBitDepth,
        metadata,
      });
      mimeType = 'audio/flac';
    }

    const blob = new Blob([rawBytes], { type: mimeType });
    const fileName = `${item.name}.${targetFormat}`;
    return { blob, fileName };
  };

  // Run Batch Processing on all files
  const handleProcessAll = async () => {
    if (items.length === 0) return;

    setIsProcessing(true);
    setResultMessage(null);
    setOverallProgress({ current: 0, total: items.length });

    const filesToSave: { name: string; blob: Blob }[] = [];

    try {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        setOverallProgress({ current: i + 1, total: items.length });

        // Update item status
        setItems((prev) =>
          prev.map((it) =>
            it.id === item.id ? { ...it, status: 'processing', progress: 50 } : it
          )
        );

        try {
          const { blob, fileName } = await processBatchItem(item, i);
          filesToSave.push({ name: fileName, blob });

          setItems((prev) =>
            prev.map((it) =>
              it.id === item.id
                ? {
                    ...it,
                    status: 'ready',
                    progress: 100,
                    resultBlob: blob,
                    resultFileName: fileName,
                  }
                : it
            )
          );
        } catch (err: any) {
          console.error(`Error processing ${item.name}:`, err);
          setItems((prev) =>
            prev.map((it) =>
              it.id === item.id
                ? { ...it, status: 'error', error: err.message || 'Processing failed' }
                : it
            )
          );
        }
      }

      // Save files via directory prompt or direct downloads
      if (filesToSave.length > 0) {
        const result = await saveFilesPrompt(filesToSave, {
          mode: exportMode,
          zipDefaultName: 'batch-processed-audio.zip',
        });
        setResultMessage(result.message);
      }
    } catch (err: any) {
      if (err.message && err.message.includes('cancelled')) {
        setResultMessage('Destination folder selection cancelled.');
      } else {
        setResultMessage('Batch export completed with warnings.');
      }
    } finally {
      setIsProcessing(false);
    }
  };

  // Open item in Main Editor
  const handleOpenItemInEditor = async (item: BatchItem) => {
    try {
      const buffer = await decodeFile(item.file);
      onOpenInEditor(buffer, item.name);
    } catch (err) {
      alert('Could not decode audio file for editor.');
    }
  };

  return (
    <div className="space-y-5">
      {/* File Upload / Dropzone */}
      <div
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className="border-2 border-dashed border-slate-700 hover:border-emerald-500/50 bg-slate-900/60 hover:bg-slate-900 rounded-2xl p-8 text-center cursor-pointer transition shadow-sm group"
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="audio/*,.wav,.flac,.mp3,.ogg,.m4a,.aac"
          className="hidden"
          onChange={(e) => handleAddFiles(e.target.files)}
        />
        <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 group-hover:scale-110 transition-transform">
          <UploadCloud className="w-6 h-6" />
        </div>
        <h3 className="text-base font-semibold text-slate-100">
          Drop multiple audio files here, or click to browse
        </h3>
        <p className="text-xs text-slate-400 mt-1">
          Supports FLAC, WAV, MP3, OGG, and AAC files for batch zero-crossing fades, format conversion, and tag injection
        </p>
      </div>

      {/* Fade Settings Configuration */}
      <FadeSettingsPanel settings={fadeSettings} onChange={setFadeSettings} />

      {/* Batch Options Bar */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-md space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
          <div className="flex items-center space-x-2">
            <h3 className="text-sm font-semibold text-slate-100">Batch Export Settings</h3>
            <span className="text-xs bg-slate-800 text-slate-300 font-mono px-2 py-0.5 rounded border border-slate-700">
              {items.length} files queued
            </span>
          </div>

          <div className="flex items-center space-x-2">
            {items.length > 0 && (
              <button
                type="button"
                onClick={clearAll}
                disabled={isProcessing}
                className="px-2.5 py-1 text-xs text-slate-400 hover:text-red-400 transition cursor-pointer"
              >
                Clear Queue
              </button>
            )}

            <button
              type="button"
              disabled={isProcessing || items.length === 0}
              onClick={handleProcessAll}
              className="flex items-center space-x-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold text-xs transition shadow-md shadow-emerald-950/40 cursor-pointer"
            >
              <FolderDown className="w-4 h-4" />
              <span>Process & Save All Files</span>
            </button>
          </div>
        </div>

        {/* Formats & Tags Config */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
          {/* Format & Sub-options */}
          <div className="flex items-center space-x-2 bg-slate-950 p-2.5 rounded-lg border border-slate-800">
            <span className="text-slate-300 font-medium">Format:</span>
            <div className="flex bg-slate-900 p-0.5 rounded border border-slate-800">
              {(['flac', 'wav', 'mp3'] as AudioFormat[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setTargetFormat(f)}
                  className={`px-2 py-0.5 rounded uppercase font-semibold transition cursor-pointer text-[11px] ${
                    targetFormat === f
                      ? 'bg-emerald-500 text-slate-950 shadow-sm'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>

            {targetFormat === 'mp3' && (
              <select
                value={mp3Bitrate}
                onChange={(e) => setMp3Bitrate(parseInt(e.target.value) as Mp3Bitrate)}
                className="bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200 font-mono text-[11px]"
              >
                <option value="320">320k</option>
                <option value="256">256k</option>
                <option value="192">192k</option>
              </select>
            )}

            {targetFormat === 'wav' && (
              <select
                value={wavBitDepth}
                onChange={(e) => setWavBitDepth(parseInt(e.target.value) as WavBitDepth)}
                className="bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200 font-mono text-[11px]"
              >
                <option value="16">16-bit</option>
                <option value="24">24-bit</option>
              </select>
            )}

            {targetFormat === 'flac' && (
              <select
                value={flacBitDepth}
                onChange={(e) => setFlacBitDepth(parseInt(e.target.value) as FlacBitDepth)}
                className="bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200 font-mono text-[11px]"
                title="16-bit (CD) or 24-bit (Studio Master) lossless FLAC"
              >
                <option value="16">16-bit</option>
                <option value="24">24-bit</option>
              </select>
            )}
          </div>

          {/* Sample Rate */}
          <div className="flex items-center space-x-2 bg-slate-950 p-2.5 rounded-lg border border-slate-800">
            <span className="text-slate-300 font-medium shrink-0">Rate:</span>
            <select
              value={sampleRate}
              onChange={(e) => setSampleRate(parseInt(e.target.value) as SampleRateOption)}
              className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-0.5 text-slate-200 font-mono text-[11px] focus:outline-none focus:border-emerald-500 cursor-pointer"
            >
              <option value="44100">44.1 kHz (Serato/CD)</option>
              <option value="48000">48.0 kHz (Studio)</option>
              <option value="88200">88.2 kHz (2x CD)</option>
              <option value="96000">96.0 kHz (Hi-Res)</option>
              <option value="0">Source Rate</option>
            </select>
          </div>

          {/* Export Mode */}
          <div className="flex items-center space-x-2 bg-slate-950 p-2.5 rounded-lg border border-slate-800">
            <span className="text-slate-300 font-medium shrink-0">Save As:</span>
            <div className="flex bg-slate-900 p-0.5 rounded border border-slate-800 w-full justify-between">
              <button
                type="button"
                onClick={() => setExportMode('individual')}
                className={`px-2 py-0.5 rounded text-[11px] font-medium transition cursor-pointer flex-1 text-center ${
                  exportMode === 'individual'
                    ? 'bg-emerald-500/20 text-emerald-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title="Save individual files directly without ZIP"
              >
                Individual
              </button>
              <button
                type="button"
                onClick={() => setExportMode('zip')}
                className={`px-2 py-0.5 rounded text-[11px] font-medium transition cursor-pointer flex-1 text-center ${
                  exportMode === 'zip'
                    ? 'bg-emerald-500/20 text-emerald-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title="Bundle into ZIP archive"
              >
                .ZIP
              </button>
            </div>
          </div>

          {/* Normalization & Tagging */}
          <div className="flex items-center justify-between bg-slate-950 p-2.5 rounded-lg border border-slate-800">
            <label className="flex items-center space-x-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={applyTags}
                onChange={(e) => setApplyTags(e.target.checked)}
                className="rounded accent-emerald-500 w-3.5 h-3.5 cursor-pointer"
              />
              <span className="text-slate-300 text-[11px] font-medium">Auto-Tag</span>
            </label>

            <label className="flex items-center space-x-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={normalize}
                onChange={(e) => setNormalize(e.target.checked)}
                className="rounded accent-emerald-500 w-3.5 h-3.5 cursor-pointer"
              />
              <span className="text-slate-300 text-[11px] font-medium">Norm -0.5dB</span>
            </label>
          </div>
        </div>

        {/* Progress bar */}
        {isProcessing && (
          <div className="bg-slate-950 p-3 rounded-xl border border-emerald-500/30 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-emerald-400 font-medium flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping inline-block" />
                Processing file {overallProgress.current} of {overallProgress.total}...
              </span>
              <span className="font-mono text-slate-300">
                {Math.round((overallProgress.current / Math.max(1, overallProgress.total)) * 100)}%
              </span>
            </div>
            <div className="w-full bg-slate-900 rounded-full h-2 overflow-hidden border border-slate-800">
              <div
                className="bg-emerald-500 h-full transition-all duration-200"
                style={{
                  width: `${(overallProgress.current / Math.max(1, overallProgress.total)) * 100}%`,
                }}
              />
            </div>
          </div>
        )}

        {/* Result notification */}
        {resultMessage && (
          <div className="bg-slate-950 px-3.5 py-2 rounded-lg border border-slate-700 text-xs text-slate-200 flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span>{resultMessage}</span>
            </div>
            <button
              type="button"
              onClick={() => setResultMessage(null)}
              className="text-slate-400 hover:text-slate-200 cursor-pointer text-[11px]"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Batch Items List */}
        {items.length > 0 && (
          <div className="border border-slate-800 rounded-xl overflow-hidden bg-slate-950">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-900 border-b border-slate-800 text-slate-400 font-medium">
                  <tr>
                    <th className="py-2.5 px-3">File Name</th>
                    {applyTags && <th className="py-2.5 px-3 w-48">Detected Tags</th>}
                    <th className="py-2.5 px-3 w-28">Status</th>
                    <th className="py-2.5 px-3 w-36 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {items.map((item) => {
                    const parsed = parseArtistTitle(item.name);
                    return (
                      <tr key={item.id} className="hover:bg-slate-900/50 transition-colors">
                        <td className="py-2.5 px-3 font-medium text-slate-200">
                          {item.name}
                        </td>

                        {applyTags && (
                          <td className="py-2.5 px-3 text-[11px]">
                            {parsed.artist ? (
                              <div className="space-y-0.5">
                                <div>
                                  <span className="text-slate-500">Artist:</span>{' '}
                                  <span className="text-slate-300 font-medium">
                                    {parsed.artist}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-slate-500">Title:</span>{' '}
                                  <span className="text-slate-300 font-medium">{parsed.title}</span>
                                </div>
                              </div>
                            ) : (
                              <span className="text-slate-500 italic">Title only</span>
                            )}
                          </td>
                        )}

                        <td className="py-2.5 px-3">
                          {item.status === 'idle' && (
                            <span className="text-slate-400 bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
                              Queued
                            </span>
                          )}
                          {item.status === 'processing' && (
                            <span className="text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20 animate-pulse">
                              Processing
                            </span>
                          )}
                          {item.status === 'ready' && (
                            <span className="text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20 font-semibold">
                              Ready
                            </span>
                          )}
                          {item.status === 'error' && (
                            <span className="text-red-400 bg-red-500/10 px-2 py-0.5 rounded border border-red-500/20">
                              Error
                            </span>
                          )}
                        </td>

                        <td className="py-2.5 px-3 text-right">
                          <div className="flex items-center justify-end space-x-2">
                            {/* Open in Waveform Editor */}
                            <button
                              type="button"
                              onClick={() => handleOpenItemInEditor(item)}
                              className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-emerald-400 transition cursor-pointer"
                              title="Open in Waveform Editor to view waveform, crop, or split"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                            </button>

                            {/* Download if ready */}
                            {item.resultBlob && item.resultFileName && (
                              <button
                                type="button"
                                onClick={() =>
                                  triggerDownload(item.resultBlob!, item.resultFileName!)
                                }
                                className="p-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white transition cursor-pointer"
                                title="Download Processed Audio"
                              >
                                <Download className="w-3.5 h-3.5" />
                              </button>
                            )}

                            {/* Remove item */}
                            <button
                              type="button"
                              onClick={() => removeItem(item.id)}
                              className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-red-400 transition cursor-pointer"
                              title="Remove from batch"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
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
        )}
      </div>
    </div>
  );
};
