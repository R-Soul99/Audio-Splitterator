import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Navbar } from './components/Navbar';
import { AudioRecorder } from './components/AudioRecorder';
import { WaveformCanvas } from './components/WaveformCanvas';
import { TransportControls } from './components/TransportControls';
import { SplitsManager } from './components/SplitsManager';
import { BatchProcessor } from './components/BatchProcessor';
import {
  Marker,
  SplitSegment,
  FadeSettings,
  TimeSelection,
} from './types';
import {
  detectSilenceSplits,
  formatTime,
  cropAudioBuffer,
  cutAudioBuffer,
} from './utils/audioProcessing';
import {
  Mic,
  Music,
  Scissors,
  BookmarkPlus,
  HelpCircle,
  FolderOpen,
  Layers,
  Sparkles,
  Trash2,
  PlusCircle,
  Zap,
} from 'lucide-react';

export default function App() {
  const [currentTab, setCurrentTab] = useState<'editor' | 'batch'>('editor');
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [mainFileName, setMainFileName] = useState<string>('Recording_01');
  const [isRecordingActive, setIsRecordingActive] = useState<boolean>(false);

  // Playback state
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isLooping, setIsLooping] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);

  // Crop boundaries
  const [cropStart, setCropStart] = useState<number>(0);
  const [cropEnd, setCropEnd] = useState<number>(0);

  // Selection Brace range
  const [selection, setSelection] = useState<TimeSelection | null>(null);

  // Split markers
  const [markers, setMarkers] = useState<Marker[]>([]);

  // Waveform View Zoom & Offset
  const [zoom, setZoom] = useState<number>(1);
  const [viewOffsetSec, setViewOffsetSec] = useState<number>(0);

  // Visual Draggable Fade Settings (sculpted directly on waveform)
  const [fadeSettings, setFadeSettings] = useState<FadeSettings>({
    fadeInEnabled: true,
    fadeInMs: 75,
    fadeInCurve: 'scurve',
    fadeOutEnabled: true,
    fadeOutMs: 125,
    fadeOutCurve: 'scurve',
    zeroCrossing: true,
  });

  // Audio Context & Playback nodes
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const playheadStartTimeRef = useRef<number>(0);
  const contextStartTimeRef = useRef<number>(0);
  const playbackWallStartTimeRef = useRef<number>(0);
  const animationFrameRef = useRef<number | null>(null);
  const isPlayingRef = useRef<boolean>(false);

  // Synced refs for state accessed inside the continuous real-time animation loop
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const cropStartRef = useRef<number>(0);
  const cropEndRef = useRef<number>(0);
  const isLoopingRef = useRef<boolean>(false);
  const currentTimeRef = useRef<number>(0);
  const startPlaybackRef = useRef<(offsetTime: number) => void>(() => {});

  useEffect(() => {
    audioBufferRef.current = audioBuffer;
  }, [audioBuffer]);

  useEffect(() => {
    cropStartRef.current = cropStart;
  }, [cropStart]);

  useEffect(() => {
    cropEndRef.current = cropEnd;
  }, [cropEnd]);

  useEffect(() => {
    isLoopingRef.current = isLooping;
  }, [isLooping]);

  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Initialize or resume shared AudioContext safely
  const getAudioContext = useCallback(() => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      const CtxClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtxRef.current = new CtxClass();
    }
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  }, []);

  // Stop active playback safely without race conditions
  const stopPlayback = useCallback(() => {
    isPlayingRef.current = false;
    if (sourceNodeRef.current) {
      const node = sourceNodeRef.current;
      sourceNodeRef.current = null;
      try {
        node.onended = null;
        node.stop();
      } catch {}
      try {
        node.disconnect();
      } catch {}
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    setIsPlaying(false);
  }, []);

  // Real-time animation frame loop to track playhead continuously and smoothly
  const startPlayheadLoop = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    const tick = () => {
      if (!isPlayingRef.current) {
        animationFrameRef.current = null;
        return;
      }

      let elapsed = 0;
      if (
        audioCtxRef.current &&
        audioCtxRef.current.state === 'running' &&
        audioCtxRef.current.currentTime > contextStartTimeRef.current
      ) {
        elapsed = audioCtxRef.current.currentTime - contextStartTimeRef.current;
      } else {
        elapsed = (performance.now() - playbackWallStartTimeRef.current) / 1000;
      }

      const newTime = playheadStartTimeRef.current + elapsed;
      const buffer = audioBufferRef.current;

      if (buffer) {
        const endLimit = cropEndRef.current > 0 ? cropEndRef.current : buffer.duration;

        if (newTime >= endLimit) {
          if (isLoopingRef.current) {
            stopPlayback();
            startPlaybackRef.current(cropStartRef.current);
            return;
          } else {
            stopPlayback();
            currentTimeRef.current = endLimit;
            setCurrentTime(endLimit);
            return;
          }
        }
        currentTimeRef.current = newTime;
        setCurrentTime(newTime);
      }

      animationFrameRef.current = requestAnimationFrame(tick);
    };

    animationFrameRef.current = requestAnimationFrame(tick);
  }, [stopPlayback]);

  // Clean up audio nodes & animation frames on unmount only
  useEffect(() => {
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      if (sourceNodeRef.current) {
        try {
          sourceNodeRef.current.onended = null;
          sourceNodeRef.current.stop();
        } catch {}
      }
    };
  }, []);

  // Start playback from a given timestamp
  const startPlayback = useCallback(
    (offsetTime: number) => {
      const buffer = audioBufferRef.current;
      if (!buffer) return;
      stopPlayback();

      const ctx = getAudioContext();
      if (ctx.state === 'suspended') {
        ctx.resume();
      }

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);

      const safeStart = Math.max(0, Math.min(buffer.duration, offsetTime));
      const endLimit = cropEndRef.current > 0 ? cropEndRef.current : buffer.duration;
      const remainingDuration = Math.max(0, endLimit - safeStart);

      const activeSource = source;
      source.onended = () => {
        if (sourceNodeRef.current === activeSource) {
          stopPlayback();
          const resetTime = cropStartRef.current;
          currentTimeRef.current = resetTime;
          setCurrentTime(resetTime);
        }
      };

      source.start(0, safeStart, remainingDuration > 0 ? remainingDuration : undefined);
      sourceNodeRef.current = source;
      playheadStartTimeRef.current = safeStart;
      contextStartTimeRef.current = ctx.currentTime;
      playbackWallStartTimeRef.current = performance.now();
      isPlayingRef.current = true;
      currentTimeRef.current = safeStart;
      setCurrentTime(safeStart);
      setIsPlaying(true);

      startPlayheadLoop();
    },
    [getAudioContext, stopPlayback, startPlayheadLoop]
  );

  useEffect(() => {
    startPlaybackRef.current = startPlayback;
  }, [startPlayback]);

  // Toggle play/pause
  const handlePlayPause = useCallback(() => {
    const buffer = audioBufferRef.current;
    if (!buffer) return;
    if (isPlayingRef.current) {
      stopPlayback();
    } else {
      const endLimit = cropEndRef.current > 0 ? cropEndRef.current : buffer.duration;
      const startLimit = cropStartRef.current;
      const cur = currentTimeRef.current;
      const resumeFrom = cur >= endLimit - 0.05 ? startLimit : cur;
      startPlayback(resumeFrom);
    }
  }, [stopPlayback, startPlayback]);

  // Handle Stop button
  const handleStop = useCallback(() => {
    stopPlayback();
    const resetTime = cropStartRef.current;
    currentTimeRef.current = resetTime;
    setCurrentTime(resetTime);
  }, [stopPlayback]);

  // Seek playhead
  const handleSeek = useCallback(
    (newTime: number) => {
      currentTimeRef.current = newTime;
      setCurrentTime(newTime);
      if (isPlayingRef.current) {
        startPlayback(newTime);
      }
    },
    [startPlayback]
  );

  // Instant audition / preview when clicking anywhere on the waveform
  const handlePreviewStart = useCallback(
    (newTime: number) => {
      currentTimeRef.current = newTime;
      setCurrentTime(newTime);
      startPlayback(newTime);
    },
    [startPlayback]
  );

  // Load new audio buffer (from recording or opened file)
  const loadAudio = (buffer: AudioBuffer, fileName: string) => {
    stopPlayback();
    audioBufferRef.current = buffer;
    cropStartRef.current = 0;
    cropEndRef.current = buffer.duration;
    currentTimeRef.current = 0;

    setAudioBuffer(buffer);
    setMainFileName(fileName);
    setCropStart(0);
    setCropEnd(buffer.duration);
    setSelection(null);
    setCurrentTime(0);
    setMarkers([]);
    setZoom(1);
    setViewOffsetSec(0);
  };

  // Clear current recording for a clean slate to record again
  const handleClearRecording = () => {
    stopPlayback();
    audioBufferRef.current = null;
    cropStartRef.current = 0;
    cropEndRef.current = 0;
    currentTimeRef.current = 0;

    setAudioBuffer(null);
    setMainFileName('Recording_01');
    setCropStart(0);
    setCropEnd(0);
    setSelection(null);
    setCurrentTime(0);
    setMarkers([]);
    setZoom(1);
    setViewOffsetSec(0);
  };

  // Crop to Selection Brace: keeps ONLY the selected region, discards the rest
  const handleCropToSelection = (startSec: number, endSec: number) => {
    if (!audioBuffer) return;
    const s = Math.max(0, Math.min(startSec, endSec));
    const e = Math.min(audioBuffer.duration, Math.max(startSec, endSec));
    if (e - s < 0.05) return;

    stopPlayback();

    const cropped = cropAudioBuffer(audioBuffer, s, e);

    // Adjust existing markers inside the kept range
    const updatedMarkers = markers
      .filter((m) => m.time >= s && m.time <= e)
      .map((m) => ({
        ...m,
        time: m.time - s,
      }));

    // Synchronously sync engine refs
    audioBufferRef.current = cropped;
    cropStartRef.current = 0;
    cropEndRef.current = cropped.duration;
    currentTimeRef.current = 0;

    setAudioBuffer(cropped);
    setCropStart(0);
    setCropEnd(cropped.duration);
    setCurrentTime(0);
    setMarkers(updatedMarkers);
    setSelection(null);
    setZoom(1);
    setViewOffsetSec(0);
  };

  // Cut / Delete Selection Brace: removes the selected section, splices the remainder with micro-crossfade
  const handleCutSelection = (startSec: number, endSec: number) => {
    if (!audioBuffer) return;
    const s = Math.max(0, Math.min(startSec, endSec));
    const e = Math.min(audioBuffer.duration, Math.max(startSec, endSec));
    const cutSpan = e - s;
    if (cutSpan < 0.02) return;

    stopPlayback();

    const spliced = cutAudioBuffer(audioBuffer, s, e);

    // Adjust markers around the cut point
    const updatedMarkers = markers
      .filter((m) => m.time < s || m.time > e)
      .map((m) => {
        if (m.time > e) {
          return { ...m, time: m.time - cutSpan };
        }
        return m;
      });

    const nextTime = Math.min(s, spliced.duration);

    // Synchronously sync engine refs so immediate play uses new spliced buffer
    audioBufferRef.current = spliced;
    cropStartRef.current = 0;
    cropEndRef.current = spliced.duration;
    currentTimeRef.current = nextTime;

    setAudioBuffer(spliced);
    setCropStart(0);
    setCropEnd(spliced.duration);
    setCurrentTime(nextTime);
    setMarkers(updatedMarkers);
    setSelection(null);
    setZoom(1);
    setViewOffsetSec(0);
  };

  // Audition / Play Selection Brace region only
  const handlePlaySelection = useCallback(
    (startSec: number, endSec: number) => {
      const buffer = audioBufferRef.current;
      if (!buffer) return;
      const s = Math.max(0, Math.min(startSec, endSec));
      const e = Math.min(buffer.duration, Math.max(startSec, endSec));
      if (e - s <= 0.01) return;

      stopPlayback();
      const ctx = getAudioContext();
      if (ctx.state === 'suspended') {
        ctx.resume();
      }

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);

      const playDuration = e - s;
      const activeSource = source;
      source.onended = () => {
        if (sourceNodeRef.current === activeSource) {
          stopPlayback();
          currentTimeRef.current = s;
          setCurrentTime(s);
        }
      };

      source.start(0, s, playDuration);
      sourceNodeRef.current = source;
      playheadStartTimeRef.current = s;
      contextStartTimeRef.current = ctx.currentTime;
      playbackWallStartTimeRef.current = performance.now();
      isPlayingRef.current = true;
      currentTimeRef.current = s;
      setCurrentTime(s);
      setIsPlaying(true);

      startPlayheadLoop();
    },
    [getAudioContext, stopPlayback, startPlayheadLoop]
  );

  // Peak Normalize loaded recording or vinyl audio to target peak (-0.5 dBFS)
  const handleNormalizeAudio = (targetPeakDb = -0.5) => {
    if (!audioBuffer) return;

    let maxPeak = 0;
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      const channelData = audioBuffer.getChannelData(c);
      for (let i = 0; i < channelData.length; i++) {
        const val = Math.abs(channelData[i]);
        if (val > maxPeak) maxPeak = val;
      }
    }

    if (maxPeak <= 0.0001) {
      alert('Audio signal is silent or near silent.');
      return;
    }

    const currentPeakDb = 20 * Math.log10(maxPeak);
    const targetLinear = Math.pow(10, targetPeakDb / 20);
    const gainMultiplier = targetLinear / maxPeak;
    const boostDb = targetPeakDb - currentPeakDb;

    const ctx = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const newBuffer = ctx.createBuffer(
      audioBuffer.numberOfChannels,
      audioBuffer.length,
      audioBuffer.sampleRate
    );

    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      const src = audioBuffer.getChannelData(c);
      const dst = newBuffer.getChannelData(c);
      for (let i = 0; i < src.length; i++) {
        dst[i] = Math.max(-1, Math.min(1, src[i] * gainMultiplier));
      }
    }
    ctx.close();

    audioBufferRef.current = newBuffer;
    setAudioBuffer(newBuffer);
  };

  // Open audio file from disk
  const handleFileOpen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const arrayBuffer = await file.arrayBuffer();
      const ctx = new (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const decoded = await ctx.decodeAudioData(arrayBuffer);
      ctx.close();

      const cleanName = file.name.replace(/\.[^/.]+$/, '');
      loadAudio(decoded, cleanName);
      setCurrentTab('editor');
    } catch (err) {
      console.error('Failed to open audio file:', err);
      alert('Could not decode audio file. Please ensure it is a valid WAV, FLAC, or MP3 file.');
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // Add marker at specified time
  const handleAddMarker = useCallback((time: number) => {
    const buffer = audioBufferRef.current;
    if (!buffer) return;
    const startLimit = cropStartRef.current;
    const endLimit = cropEndRef.current > 0 ? cropEndRef.current : buffer.duration;
    const clampedTime = Math.max(startLimit, Math.min(endLimit, time));

    setMarkers((prev) => {
      // Avoid duplicate marker very close
      if (prev.some((m) => Math.abs(m.time - clampedTime) < 0.05)) {
        return prev;
      }

      const newMarker: Marker = {
        id: `marker-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        time: clampedTime,
      };

      return [...prev, newMarker].sort((a, b) => a.time - b.time);
    });
  }, []);

  const handleAddMarkerAtPlayhead = useCallback(() => {
    handleAddMarker(currentTimeRef.current);
  }, [handleAddMarker]);

  const handleMarkerMove = (id: string, newTime: number) => {
    const clampedTime = Math.max(cropStart, Math.min(cropEnd, newTime));
    setMarkers((prev) =>
      prev.map((m) => (m.id === id ? { ...m, time: clampedTime } : m)).sort((a, b) => a.time - b.time)
    );
  };

  const handleRemoveMarker = (id: string) => {
    setMarkers((prev) => prev.filter((m) => m.id !== id));
  };

  const handleClearMarkers = () => {
    setMarkers([]);
  };

  // Auto detect silence to suggest splits
  const handleAutoDetectSilence = () => {
    if (!audioBuffer) return;
    const detected = detectSilenceSplits(audioBuffer, -42, 1.2);
    if (detected.length === 0) {
      alert('No silence pauses detected above threshold (-42dB, >1.2s). You can add markers manually.');
      return;
    }
    const newMarkers: Marker[] = detected.map((sec, idx) => ({
      id: `marker-auto-${idx}-${Date.now()}`,
      time: sec,
    }));
    setMarkers(newMarkers.sort((a, b) => a.time - b.time));
  };

  // Calculate split segments
  const splits = useMemo<SplitSegment[]>(() => {
    if (!audioBuffer) return [];

    const effectiveStart = cropStart;
    const effectiveEnd = cropEnd > 0 ? cropEnd : audioBuffer.duration;

    // Filter markers that fall strictly within crop boundaries
    const activeMarkers = markers
      .filter((m) => m.time > effectiveStart + 0.01 && m.time < effectiveEnd - 0.01)
      .sort((a, b) => a.time - b.time);

    const points = [effectiveStart, ...activeMarkers.map((m) => m.time), effectiveEnd];
    const segments: SplitSegment[] = [];

    for (let i = 0; i < points.length - 1; i++) {
      const segStart = points[i];
      const segEnd = points[i + 1];
      const segIndex = i + 1;
      const indexStr = String(segIndex).padStart(2, '0');
      const defaultName = `${mainFileName}_${indexStr}`;

      segments.push({
        id: `split-${i}-${segStart.toFixed(3)}`,
        index: segIndex,
        trackNumber: segIndex,
        name: defaultName,
        startTime: segStart,
        endTime: segEnd,
        duration: Math.max(0, segEnd - segStart),
      });
    }

    return segments;
  }, [audioBuffer, cropStart, cropEnd, markers, mainFileName]);

  // Keyboard shortcut listener (Space = play/pause, M = add marker, I = In crop, O = Out crop)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        handlePlayPause();
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        handleAddMarkerAtPlayhead();
      } else if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();
        setCropStart(currentTimeRef.current);
      } else if (e.key === 'o' || e.key === 'O') {
        e.preventDefault();
        setCropEnd(currentTimeRef.current);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handlePlayPause, handleAddMarkerAtPlayhead]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-emerald-500 selection:text-slate-950">
      {/* Hidden file input for opening audio files */}
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,.wav,.flac,.mp3,.ogg,.m4a,.aac"
        onChange={handleFileOpen}
        className="hidden"
      />

      {/* Top Navigation */}
      <Navbar
        currentTab={currentTab}
        onSelectTab={setCurrentTab}
        onOpenFile={() => fileInputRef.current?.click()}
        isRecording={isRecordingActive}
        hasAudio={!!audioBuffer}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 lg:p-6 space-y-6">
        {currentTab === 'editor' ? (
          <div className="space-y-6">
            {/* Audio Recorder Section with Live Independent Monitoring & Vertical Meters */}
            <AudioRecorder
              onRecordingComplete={(buf, defaultName) => loadAudio(buf, defaultName)}
              isRecordingActive={isRecordingActive}
              setIsRecordingActive={setIsRecordingActive}
              onClearRecording={handleClearRecording}
              hasLoadedAudio={!!audioBuffer}
            />

            {/* Waveform Editor (Active when audio is loaded) */}
            {audioBuffer ? (
              <div className="space-y-5">
                {/* Active file banner & Quick rename & Clean Slate */}
                <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-900 border border-slate-800 px-4 py-2.5 rounded-xl">
                  <div className="flex items-center space-x-2.5">
                    <Music className="w-4 h-4 text-emerald-400" />
                    <span className="text-xs text-slate-400 font-medium">Active Audio:</span>
                    <input
                      type="text"
                      value={mainFileName}
                      onChange={(e) => setMainFileName(e.target.value)}
                      className="bg-slate-950 border border-slate-700/80 rounded px-2.5 py-1 text-xs font-semibold text-slate-200 focus:outline-none focus:border-emerald-500"
                      placeholder="Project file name..."
                    />
                  </div>

                  <div className="flex items-center space-x-3 text-xs font-mono text-slate-400">
                    <span>
                      Length: <strong className="text-slate-200">{formatTime(audioBuffer.duration)}</strong>
                    </span>
                    <span>•</span>
                    <span>
                      Rate: <strong className="text-slate-200">{audioBuffer.sampleRate} Hz</strong>
                    </span>
                    <span>•</span>
                    <span>
                      Channels: <strong className="text-slate-200">{audioBuffer.numberOfChannels === 2 ? 'Stereo' : 'Mono'}</strong>
                    </span>

                    {/* Normalize Peak button for loaded audio */}
                    <button
                      type="button"
                      onClick={() => handleNormalizeAudio(-0.5)}
                      className="ml-1 flex items-center space-x-1.5 px-2.5 py-1 rounded bg-slate-800 hover:bg-amber-950/40 text-slate-300 hover:text-amber-300 border border-slate-700 hover:border-amber-800/50 text-xs font-semibold transition cursor-pointer"
                      title="Peak normalize loaded audio to -0.5 dBFS to boost quiet vinyl/record deck recordings"
                    >
                      <Zap className="w-3.5 h-3.5 text-amber-400" />
                      <span>Normalize (-0.5 dB)</span>
                    </button>

                    {/* Clear Current Recording (Clean Slate) */}
                    <button
                      type="button"
                      onClick={handleClearRecording}
                      className="ml-1 flex items-center space-x-1.5 px-2.5 py-1 rounded bg-slate-800 hover:bg-red-950/40 text-slate-300 hover:text-red-300 border border-slate-700 hover:border-red-800/50 text-xs font-semibold transition cursor-pointer"
                      title="Discard current recording and reset to a clean slate"
                    >
                      <Trash2 className="w-3.5 h-3.5 text-red-400" />
                      <span>Clear Recording</span>
                    </button>
                  </div>
                </div>

                {/* Interactive Waveform Canvas with Click Preview, Markers, Zoom, Selection Brace & Visual Draggable Volume Fades */}
                <WaveformCanvas
                  audioBuffer={audioBuffer}
                  currentTime={currentTime}
                  cropStart={cropStart}
                  cropEnd={cropEnd}
                  selection={selection}
                  markers={markers}
                  zoom={zoom}
                  viewOffsetSec={viewOffsetSec}
                  fadeSettings={fadeSettings}
                  isPlaying={isPlaying}
                  onSeek={handleSeek}
                  onPreviewStart={handlePreviewStart}
                  onSelectionChange={setSelection}
                  onCropToSelection={handleCropToSelection}
                  onCutSelection={handleCutSelection}
                  onPlaySelection={handlePlaySelection}
                  onCropChange={(start, end) => {
                    setCropStart(start);
                    setCropEnd(end);
                  }}
                  onMarkerMove={handleMarkerMove}
                  onAddMarker={handleAddMarker}
                  onRemoveMarker={handleRemoveMarker}
                  onZoomChange={setZoom}
                  onViewOffsetChange={setViewOffsetSec}
                  onFadeSettingsChange={setFadeSettings}
                />

                {/* Transport & Crop Controls */}
                <TransportControls
                  isPlaying={isPlaying}
                  isLooping={isLooping}
                  currentTime={currentTime}
                  totalDuration={audioBuffer.duration}
                  cropStart={cropStart}
                  cropEnd={cropEnd}
                  zoom={zoom}
                  onPlayPause={handlePlayPause}
                  onStop={handleStop}
                  onToggleLoop={() => setIsLooping(!isLooping)}
                  onZoomChange={setZoom}
                  onZoomFit={() => {
                    setZoom(1);
                    setViewOffsetSec(0);
                  }}
                  onSetInToPlayhead={() => setCropStart(currentTime)}
                  onSetOutToPlayhead={() => setCropEnd(currentTime)}
                  onResetCrop={() => {
                    setCropStart(0);
                    setCropEnd(audioBuffer.duration);
                  }}
                  onCropStartChange={setCropStart}
                  onCropEndChange={setCropEnd}
                  onAddMarkerAtPlayhead={handleAddMarkerAtPlayhead}
                  onClearMarkers={handleClearMarkers}
                  onAutoDetectSilence={handleAutoDetectSilence}
                />

                {/* Splits Management & Export Panel */}
                <SplitsManager
                  sourceBuffer={audioBuffer}
                  splits={splits}
                  mainFileName={mainFileName}
                  fadeSettings={fadeSettings}
                  onSeekTo={handleSeek}
                />
              </div>
            ) : (
              /* Empty State Prompt */
              <div className="border border-slate-800 bg-slate-900/40 rounded-2xl p-10 text-center space-y-4">
                <div className="w-12 h-12 mx-auto rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-400">
                  <Scissors className="w-6 h-6" />
                </div>
                <div className="max-w-md mx-auto space-y-1">
                  <h3 className="text-sm font-semibold text-slate-200">No Audio Loaded Yet</h3>
                  <p className="text-xs text-slate-400">
                    Record audio above from any soundcard, or open an existing audio file (WAV, FLAC, MP3) to crop, split, and sculpt visual volume fades.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center space-x-1.5 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 cursor-pointer shadow-sm transition"
                >
                  <FolderOpen className="w-4 h-4 text-emerald-400" />
                  <span>Open Existing Audio File</span>
                </button>
              </div>
            )}
          </div>
        ) : (
          /* Batch Processing Mode */
          <div className="space-y-6">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                  <Layers className="w-5 h-5 text-emerald-400" />
                  <span>Multi-File Batch Processor</span>
                </h2>
                <p className="text-xs text-slate-400">
                  Process multiple audio files simultaneously: apply customizable fades, zero-crossing detection, format conversion, and tag injection
                </p>
              </div>
            </div>

            <BatchProcessor
              onOpenInEditor={(buf, name) => {
                loadAudio(buf, name);
                setCurrentTab('editor');
              }}
            />
          </div>
        )}
      </main>
    </div>
  );
}
