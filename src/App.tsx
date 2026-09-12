import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { AudioRecorder } from './components/AudioRecorder';
import { WaveformCanvas } from './components/WaveformCanvas';
import { SplitsManager } from './components/SplitsManager';
import { Marker, SplitSegment, FadeSettings, TimeSelection } from './types';
import { detectSilenceSplits, formatTime, cropAudioBuffer, cutAudioBuffer } from './utils/audioProcessing';
import {
  Mic,
  Music,
  Scissors,
  BookmarkPlus,
  FolderOpen,
  Layers,
  Trash2,
  Zap,
  Play,
  Pause,
  Square,
  Tag,
  CheckCircle2,
} from 'lucide-react';

export default function App() {
  // 3-Workflow sequential tabs state based on mockup (Record -> Edit -> Save)
  const [workflowTab, setWorkflowTab] = useState<'record' | 'edit' | 'save'>('record');

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

  // Pre-Record metadata cache
  const [preRecordArtist, setPreRecordArtist] = useState<string>('');
  const [preRecordAlbum, setPreRecordAlbum] = useState<string>('');

  // Silence Detection Parameters
  const [silenceThreshold, setSilenceThreshold] = useState<number>(-42);
  const [silenceDuration, setSilenceDuration] = useState<number>(1.2);

  // Visual Draggable Fade Settings
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

  // Synced refs
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

  // Stop active playback safely
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

  // Real-time animation frame loop to track playhead smoothly
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

  // Instant audition / preview
  const handlePreviewStart = useCallback(
    (newTime: number) => {
      currentTimeRef.current = newTime;
      setCurrentTime(newTime);
      startPlayback(newTime);
    },
    [startPlayback]
  );

  // Load new audio buffer (recording finished or imported file)
  const loadAudio = (buffer: AudioBuffer, fileName: string, artist?: string, album?: string) => {
    stopPlayback();
    audioBufferRef.current = buffer;
    cropStartRef.current = 0;
    cropEndRef.current = buffer.duration;
    currentTimeRef.current = 0;

    setAudioBuffer(buffer);
    setMainFileName(fileName);
    if (artist) setPreRecordArtist(artist);
    if (album) setPreRecordAlbum(album);
    setCropStart(0);
    setCropEnd(buffer.duration);
    setSelection(null);
    setCurrentTime(0);
    setMarkers([]);
    setZoom(1);
    setViewOffsetSec(0);

    // Switch workflow to EDIT tab automatically
    setWorkflowTab('edit');
  };

  const handleClearRecording = () => {
    if (confirm("Are you sure you want to discard this recording? Any unsaved splits or fades will be lost.")) {
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
      setPreRecordArtist('');
      setPreRecordAlbum('');
      setWorkflowTab('record'); // reset back to record tab
    }
  };

  // Crop to Selection Brace
  const handleCropToSelection = (startSec: number, endSec: number) => {
    if (!audioBuffer) return;
    const s = Math.max(0, Math.min(startSec, endSec));
    const e = Math.min(audioBuffer.duration, Math.max(startSec, endSec));
    if (e - s < 0.05) return;

    stopPlayback();

    const cropped = cropAudioBuffer(audioBuffer, s, e);

    const updatedMarkers = markers
      .filter((m) => m.time >= s && m.time <= e)
      .map((m) => ({
        ...m,
        time: m.time - s,
      }));

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

  // Cut / Delete Selection Brace
  const handleCutSelection = (startSec: number, endSec: number) => {
    if (!audioBuffer) return;
    const s = Math.max(0, Math.min(startSec, endSec));
    const e = Math.min(audioBuffer.duration, Math.max(startSec, endSec));
    const cutSpan = e - s;
    if (cutSpan < 0.02) return;

    stopPlayback();

    const spliced = cutAudioBuffer(audioBuffer, s, e);

    const updatedMarkers = markers
      .filter((m) => m.time < s || m.time > e)
      .map((m) => {
        if (m.time > e) {
          return { ...m, time: m.time - cutSpan };
        }
        return m;
      });

    const nextTime = Math.min(s, spliced.duration);

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

  // Audition / Play Selection region only
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

      const playDuration = e - s;
      const source = ctx.createBufferSource();
      const activeSource = source;
      source.buffer = buffer;
      source.connect(ctx.destination);

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

  // Peak Normalise (UK spelling)
  const handleNormalizeAudio = (targetPeakDb: number) => {
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

    const gainMultiplier = Math.pow(10, targetPeakDb / 20) / maxPeak;

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
      setWorkflowTab('edit');
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

  // Calculate split segments
  const splits = useMemo<SplitSegment[]>(() => {
    if (!audioBuffer) return [];

    const effectiveStart = cropStart;
    const effectiveEnd = cropEnd > 0 ? cropEnd : audioBuffer.duration;

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

  // Keyboard shortcut listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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
    <div className="h-screen max-h-screen overflow-hidden bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-emerald-500 selection:text-slate-950">
      {/* Hidden file input for opening audio files */}
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,.wav,.flac,.mp3,.ogg,.m4a,.aac"
        onChange={handleFileOpen}
        className="hidden"
      />

      {/* Global DAW Header (Replaces Navbar and integrates Brand & 3 Workflow Tabs) */}
      <header className="bg-slate-900 border-b border-slate-800 px-4 py-3 sticky top-0 z-40 flex-shrink-0 select-none">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          {/* Brand & Logo on the Left */}
          <div className="flex items-center space-x-3 shrink-0">
            <div>
              <div className="flex items-center space-x-2">
                <h1 className="text-base font-bold text-slate-100 tracking-tight">
                  Audiophonic Recordinator
                </h1>
                <span className="text-[10px] font-bold tracking-wide uppercase px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700">
                  Studio Edition
                </span>
              </div>
            </div>
          </div>

          {/* Centered Workflow Buttons (RECORD, EDIT, SAVE) serving as global header */}
          <div className="grid grid-cols-3 gap-2 w-full sm:w-[380px] bg-slate-950/80 p-1 rounded-xl border border-slate-800 flex-shrink-0">
            {/* RECORD TAB */}
            <button
              type="button"
              onClick={() => setWorkflowTab('record')}
              className={`py-2 rounded-lg font-mono text-xs tracking-wider uppercase font-bold text-center border transition cursor-pointer ${
                workflowTab === 'record'
                  ? 'border-red-500/80 text-red-400 bg-red-500/10 shadow-[0_0_15px_rgba(239,68,68,0.15)]'
                  : 'text-slate-400 hover:text-slate-200 border-transparent bg-transparent'
              }`}
            >
              RECORD
            </button>

            {/* EDIT TAB (Always available, but shows empty state if no audio) */}
            <button
              type="button"
              onClick={() => setWorkflowTab('edit')}
              className={`py-2 rounded-lg font-mono text-xs tracking-wider uppercase font-bold text-center border transition cursor-pointer ${
                workflowTab === 'edit'
                  ? 'border-amber-500/80 text-amber-400 bg-amber-500/10 shadow-[0_0_15px_rgba(245,158,11,0.15)]'
                  : 'text-slate-400 hover:text-slate-200 border-transparent bg-transparent'
              }`}
            >
              EDIT
            </button>

            {/* SAVE TAB (Always available, but shows empty state if no audio) */}
            <button
              type="button"
              onClick={() => setWorkflowTab('save')}
              className={`py-2 rounded-lg font-mono text-xs tracking-wider uppercase font-bold text-center border transition cursor-pointer ${
                workflowTab === 'save'
                  ? 'border-emerald-500/80 text-emerald-450 bg-emerald-500/10 shadow-[0_0_15px_rgba(16,185,129,0.15)]'
                  : 'text-slate-400 hover:text-slate-200 border-transparent bg-transparent'
              }`}
            >
              SAVE
            </button>
          </div>

          {/* Quick File Import Trigger on the Right */}
          <div className="flex items-center space-x-2 shrink-0">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-slate-300 bg-slate-800 hover:bg-slate-750 border border-slate-700 transition shadow-sm cursor-pointer"
              title="Import local audio file directly into the editor"
            >
              <FolderOpen className="w-3.5 h-3.5 text-emerald-400" />
              <span>Import Audio</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 min-h-0 w-full p-4 lg:p-6 lg:pb-4 flex flex-col">
        <div className="flex-1 flex flex-col min-h-0 relative">
          {/* Render selected workflow view (Full Screen Container with NO SCROLL) */}
          <div className="flex-1 relative bg-slate-950/20 border border-slate-900 rounded-2xl overflow-hidden p-4 min-h-0 select-none bg-[radial-gradient(#1e293b_1px,transparent_1px)] [background-size:16px_16px]">
            
            {/* WORKFLOW VIEW 1: RECORD CONSOLE */}
            {workflowTab === 'record' && (
              <div className="flex-1 h-full overflow-y-auto pr-1">
                <AudioRecorder
                  onRecordingComplete={(buf, defaultName, art, alb) => {
                    loadAudio(buf, defaultName, art, alb);
                  }}
                  isRecordingActive={isRecordingActive}
                  setIsRecordingActive={setIsRecordingActive}
                  onClearRecording={handleClearRecording}
                  hasLoadedAudio={!!audioBuffer}
                />
              </div>
            )}

            {/* WORKFLOW VIEW 2: WAVEFORM EDITOR & SPLIT REGIONS */}
            {workflowTab === 'edit' && (
              !audioBuffer ? (
                <div className="flex-1 h-full flex flex-col items-center justify-center p-8 text-center bg-slate-900/20 border border-slate-900/60 rounded-2xl">
                  {/* Visual empty state icon */}
                  <div className="w-16 h-16 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-500 mb-4 animate-pulse">
                    <Scissors className="w-8 h-8" />
                  </div>
                  <h3 className="text-base font-bold text-slate-200 mb-2">No Active Recording Found</h3>
                  <p className="text-xs text-slate-400 max-w-sm leading-relaxed">
                    No active recording found. Please complete a recording or import an audio file in the <strong className="text-red-400">RECORD</strong> tab to begin editing.
                  </p>
                  <button
                    type="button"
                    onClick={() => setWorkflowTab('record')}
                    className="mt-6 px-4 py-2 bg-slate-900 border border-slate-800 hover:border-amber-500/50 text-slate-300 rounded-lg text-xs font-bold transition hover:bg-slate-850 cursor-pointer"
                  >
                    Go to RECORD Tab
                  </button>
                </div>
              ) : (
                <div className="flex flex-col h-full space-y-4 min-h-0">
                  {/* Top: Active Project Rename & Reset banner */}
                  <div className="flex-shrink-0 flex flex-wrap items-center justify-between gap-3 bg-slate-900 border border-slate-800 px-4 py-2 rounded-xl text-xs">
                    <div className="flex items-center space-x-2.5">
                      <Music className="w-4 h-4 text-amber-500" />
                      <span className="text-slate-400 font-medium">Recording Name:</span>
                      <input
                        type="text"
                        value={mainFileName}
                        onChange={(e) => setMainFileName(e.target.value)}
                        className="bg-slate-950 border border-slate-800 rounded px-2.5 py-1 text-xs font-semibold text-slate-200 focus:outline-none focus:border-amber-500"
                        placeholder="Project name..."
                      />
                    </div>
                    
                    <button
                      type="button"
                      onClick={handleClearRecording}
                      className="flex items-center space-x-1.5 px-2.5 py-1 rounded bg-slate-850 hover:bg-red-950/40 text-slate-400 hover:text-red-400 border border-slate-800 hover:border-red-800/40 text-xs font-bold transition cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Discard Recording</span>
                    </button>
                  </div>

                  {/* Waveform canvas (Dynamic Height) */}
                  <div className="flex-1 min-h-0 flex flex-col">
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
                      onNormalise={handleNormalizeAudio}
                    />
                  </div>

                  {/* Bottom: Playback timeline controls */}
                  <div className="flex items-center justify-between border-t border-slate-900 pt-2.5 flex-shrink-0 select-none">
                    <div className="flex items-center space-x-2">
                      <button
                        type="button"
                        onClick={handlePlayPause}
                        className="px-3.5 py-1.5 rounded-lg bg-slate-850 hover:bg-slate-750 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer border border-slate-800"
                      >
                        {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 fill-current" />}
                        <span>{isPlaying ? 'Pause' : 'Play'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleStop}
                        className="px-3.5 py-1.5 rounded-lg bg-slate-850 hover:bg-slate-750 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer border border-slate-800"
                      >
                        <Square className="w-3.5 h-3.5 fill-current" />
                        <span>Stop</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setIsLooping(!isLooping)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer border ${
                          isLooping
                            ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                            : 'bg-slate-850 hover:bg-slate-750 text-slate-300 border-slate-800'
                        }`}
                      >
                        Loop: {isLooping ? 'ON' : 'OFF'}
                      </button>
                    </div>

                    <div className="text-[10px] font-mono text-slate-400">
                      Length: <strong className="text-slate-200">{formatTime(audioBuffer.duration)}</strong> • Rate: <strong className="text-slate-200">{audioBuffer.sampleRate} Hz</strong>
                    </div>
                  </div>

                  {/* Redesigned bottom Split Regions List from Mockup */}
                  <div className="bg-slate-900/60 border border-slate-800 p-3.5 rounded-xl flex flex-col h-56 min-h-0 flex-shrink-0 select-none">
                    <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-2 flex-shrink-0">
                      <div className="flex items-center space-x-2 text-slate-200 font-bold uppercase tracking-wider text-[10px]">
                        <Layers className="w-3.5 h-3.5 text-amber-500" />
                        <span>Split Regions List</span>
                      </div>
                      <span className="text-[10px] font-mono text-slate-500">
                        {splits.length} regions detected. Ready for fine-tuning.
                      </span>
                    </div>

                    <div className="flex-1 min-h-0 overflow-y-auto space-y-1.5 pr-1 font-medium">
                      {splits.length === 0 ? (
                        <div className="text-center text-slate-500 italic py-6 text-xs">
                          No split markers set. Double-click on the waveform canvas to place a marker.
                        </div>
                      ) : (
                        splits.map((split, idx) => {
                          const colors = ['#f87171', '#fb923c', '#4ade80', '#38bdf8', '#c084fc'];
                          const color = colors[idx % colors.length];

                          return (
                            <div key={split.id} className="flex items-center justify-between bg-slate-950/60 p-2 rounded border border-slate-850 hover:bg-slate-900/30 transition text-xs">
                              {/* Left: Name and duration */}
                              <div className="flex items-center space-x-3 w-40 shrink-0 text-left">
                                <input type="checkbox" defaultChecked disabled className="rounded accent-emerald-500 w-3.5 h-3.5 flex-shrink-0 cursor-not-allowed opacity-50" />
                                <div className="truncate">
                                  <div className="font-bold text-[11px] text-slate-200">{split.name}</div>
                                  <div className="text-[10px] font-mono text-slate-500">
                                    {formatTime(split.startTime, false)} • {formatTime(split.duration, false)}
                                  </div>
                                </div>
                              </div>

                              {/* Center: Visual Colored segment block */}
                              <div className="flex-1 px-4">
                                <div className="h-4.5 bg-slate-900 rounded border border-slate-850 relative overflow-hidden flex items-center justify-center">
                                  <div
                                    className="absolute top-0 bottom-0 opacity-20"
                                    style={{
                                      left: `${(split.startTime / audioBuffer.duration) * 100}%`,
                                      width: `${(split.duration / audioBuffer.duration) * 100}%`,
                                      backgroundColor: color,
                                    }}
                                  />
                                  <span className="text-[9px] font-mono text-slate-500 z-10 font-bold uppercase tracking-wider">
                                    Region {split.index}
                                  </span>
                                </div>
                              </div>

                              {/* Right: Seek trigger */}
                              <div className="flex items-center space-x-1.5 w-24 justify-end shrink-0">
                                <button
                                  type="button"
                                  onClick={() => handleSeek(split.startTime)}
                                  className="px-2.5 py-1 bg-slate-900 border border-slate-850 hover:border-slate-700 text-slate-400 hover:text-sky-400 rounded text-[10px] font-mono transition cursor-pointer"
                                >
                                  Seek
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handlePlaySelection(split.startTime, split.endTime)}
                                  className="p-1 rounded bg-slate-900 border border-slate-850 text-slate-400 hover:text-emerald-400 hover:bg-slate-850 transition cursor-pointer"
                                >
                                  <Play className="w-2.5 h-2.5 fill-current" />
                                </button>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>
              )
            )}

            {/* WORKFLOW VIEW 3: SAVE WORKSPACE */}
            {workflowTab === 'save' && (
              !audioBuffer ? (
                <div className="flex-1 h-full flex flex-col items-center justify-center p-8 text-center bg-slate-900/20 border border-slate-900/60 rounded-2xl">
                  <div className="w-16 h-16 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mb-4 animate-pulse">
                    <CheckCircle2 className="w-8 h-8" />
                  </div>
                  <h3 className="text-base font-bold text-slate-200 mb-2">No Active Recording Found</h3>
                  <p className="text-xs text-slate-400 max-w-sm leading-relaxed">
                    No active recording found. Please complete a recording or import an audio file in the <strong className="text-red-400">RECORD</strong> tab to select regions and save files.
                  </p>
                  <button
                    type="button"
                    onClick={() => setWorkflowTab('record')}
                    className="mt-6 px-4 py-2 bg-slate-900 border border-slate-800 hover:border-emerald-500/50 text-slate-300 rounded-lg text-xs font-bold transition hover:bg-slate-850 cursor-pointer"
                  >
                    Go to RECORD Tab
                  </button>
                </div>
              ) : (
                <div className="h-full overflow-hidden">
                  <SplitsManager
                    sourceBuffer={audioBuffer}
                    splits={splits}
                    mainFileName={mainFileName}
                    fadeSettings={fadeSettings}
                    onSeekTo={handleSeek}
                    preRecordArtist={preRecordArtist}
                    preRecordAlbum={preRecordAlbum}
                  />
                </div>
              )
            )}

          </div>
        </div>
      </main>
    </div>
  );
}