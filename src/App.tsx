import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { AudioRecorder } from './components/AudioRecorder';
import { WaveformCanvas } from './components/WaveformCanvas';
import { SplitsManager } from './components/SplitsManager';
import { Marker, SplitSegment, FadeSettings, TimeSelection } from './types';
import { detectSilenceSplits, formatTime, cropAudioBuffer, cutAudioBuffer } from './utils/audioProcessing';
import {
  Mic,
  MicOff,
  Radio,
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
  RotateCcw,
} from 'lucide-react';

export default function App() {
  // 3-Workflow sequential tabs state based on mockup (Record -> Edit -> Save)
  const [workflowTab, setWorkflowTab] = useState<'record' | 'edit' | 'save'>('record');

  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [mainFileName, setMainFileName] = useState<string>('Recording');
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

  // Per-split track names (maps split ID to user-entered track name)
  const [trackNames, setTrackNames] = useState<{ [splitId: string]: string }>({});

  // Silence Detection Parameters
  const [silenceThreshold, setSilenceThreshold] = useState<number>(-42);
  const [silenceDuration, setSilenceDuration] = useState<number>(1.2);

  // Visual Draggable Fade Settings
  const [fadeSettings, setFadeSettings] = useState<FadeSettings>({
    fadeInEnabled: true,
    fadeInMs: 75,
    fadeInCurve: 'custom',
    fadeInCurveNode: 0.5,
    fadeInCurveNodePosition: 0.5,
    fadeOutEnabled: true,
    fadeOutMs: 125,
    fadeOutCurve: 'custom',
    fadeOutCurveNode: 0.5,
    fadeOutCurveNodePosition: 0.5,
    zeroCrossing: true,
  });

  // Standby mode for preview (releases all mic inputs and suspends audio context to avoid clashes with local dev)
  const [isStandbyMode, setIsStandbyMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem('audiophonic_preview_standby') === 'true';
    } catch {
      return false;
    }
  });

  // Undo history stack
  interface UndoState {
    buffer: AudioBuffer;
    markers: Marker[];
    cropStart: number;
    cropEnd: number;
    mainFileName: string;
    actionName: string;
  }
  const undoStackRef = useRef<UndoState[]>([]);
  const [canUndo, setCanUndo] = useState<boolean>(false);

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
  const selectionRef = useRef<TimeSelection | null>(null);
  const startPlaybackRef = useRef<(offsetTime: number, forceLoop?: boolean) => void>(() => {});

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

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  const pushUndo = useCallback((actionName: string) => {
    if (!audioBufferRef.current) return;
    undoStackRef.current.push({
      buffer: audioBufferRef.current,
      markers: [...markers],
      cropStart: cropStartRef.current,
      cropEnd: cropEndRef.current,
      mainFileName,
      actionName,
    });
    if (undoStackRef.current.length > 10) {
      undoStackRef.current.shift();
    }
    setCanUndo(true);
  }, [markers, mainFileName]);

  const handleUndo = useCallback(() => {
    const prev = undoStackRef.current.pop();
    if (!prev) return;
    setCanUndo(undoStackRef.current.length > 0);

    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.onended = null;
        sourceNodeRef.current.stop();
      } catch {}
      sourceNodeRef.current = null;
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    isPlayingRef.current = false;
    setIsPlaying(false);

    audioBufferRef.current = prev.buffer;
    cropStartRef.current = prev.cropStart;
    cropEndRef.current = prev.cropEnd;
    currentTimeRef.current = 0;

    setAudioBuffer(prev.buffer);
    setMarkers(prev.markers);
    setCropStart(prev.cropStart);
    setCropEnd(prev.cropEnd);
    setMainFileName(prev.mainFileName);
    setCurrentTime(0);
    setSelection(null);
    setZoom(1);
    setViewOffsetSec(0);
  }, []);

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

  const wakeAudioEngine = useCallback(() => {
    setIsStandbyMode(false);
    try {
      localStorage.setItem('audiophonic_preview_standby', 'false');
    } catch {}
  }, []);

  const toggleStandbyMode = useCallback(() => {
    setIsStandbyMode((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('audiophonic_preview_standby', String(next));
      } catch {}
      if (next) {
        stopPlayback();
        if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
          audioCtxRef.current.suspend().catch(() => {});
        }
      }
      return next;
    });
  }, [stopPlayback]);

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

      const buffer = audioBufferRef.current;
      if (!buffer) {
        animationFrameRef.current = null;
        return;
      }

      const sel = selectionRef.current;
      const hasSelection = sel && Math.abs(sel.end - sel.start) > 0.02;
      const effectiveStart = hasSelection ? Math.min(sel.start, sel.end) : cropStartRef.current;
      const effectiveEnd = hasSelection
        ? Math.max(sel.start, sel.end)
        : (cropEndRef.current > 0 ? cropEndRef.current : buffer.duration);
      const loopSpan = Math.max(0.01, effectiveEnd - effectiveStart);

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

      if (isLoopingRef.current) {
        const initialOffset = Math.max(0, playheadStartTimeRef.current - effectiveStart);
        const loopPos = (initialOffset + elapsed) % loopSpan;
        const currentT = effectiveStart + loopPos;
        currentTimeRef.current = currentT;
        setCurrentTime(currentT);
      } else {
        const newTime = playheadStartTimeRef.current + elapsed;
        if (newTime >= effectiveEnd) {
          stopPlayback();
          currentTimeRef.current = effectiveEnd;
          setCurrentTime(effectiveEnd);
          return;
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

  // Start playback from a given timestamp with seamless native loop support
  const startPlayback = useCallback(
    (offsetTime: number, forceLoop?: boolean) => {
      const buffer = audioBufferRef.current;
      if (!buffer) return;
      stopPlayback();

      if (isStandbyMode) {
        wakeAudioEngine();
      }

      const ctx = getAudioContext();
      if (ctx.state === 'suspended') {
        ctx.resume();
      }

      const activeLoop = forceLoop !== undefined ? forceLoop : isLoopingRef.current;

      const sel = selectionRef.current;
      const hasSelection = sel && Math.abs(sel.end - sel.start) > 0.02;
      const effectiveStart = hasSelection ? Math.min(sel.start, sel.end) : cropStartRef.current;
      const effectiveEnd = hasSelection
        ? Math.max(sel.start, sel.end)
        : (cropEndRef.current > 0 ? cropEndRef.current : buffer.duration);

      const loopSpan = Math.max(0.01, effectiveEnd - effectiveStart);
      const safeStart = Math.max(effectiveStart, Math.min(effectiveEnd, offsetTime));

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);

      const activeSource = source;

      if (activeLoop && loopSpan > 0.02) {
        source.loop = true;
        source.loopStart = effectiveStart;
        source.loopEnd = effectiveEnd;
        source.start(0, safeStart);
      } else {
        source.loop = false;
        const playDuration = Math.max(0, effectiveEnd - safeStart);
        source.onended = () => {
          if (sourceNodeRef.current === activeSource) {
            stopPlayback();
            currentTimeRef.current = effectiveStart;
            setCurrentTime(effectiveStart);
          }
        };
        source.start(0, safeStart, playDuration > 0 ? playDuration : undefined);
      }

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
      setMainFileName('Recording');
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
  const handleCropToSelection = useCallback((startSec: number, endSec: number) => {
    const buffer = audioBufferRef.current;
    if (!buffer) return;
    const s = Math.max(0, Math.min(startSec, endSec));
    const e = Math.min(buffer.duration, Math.max(startSec, endSec));
    if (e - s < 0.05) return;

    pushUndo('Crop to Selection');
    stopPlayback();

    const cropped = cropAudioBuffer(buffer, s, e);

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
  }, [markers, pushUndo, stopPlayback]);

  // Cut / Delete Selection Brace (Splices remaining audio seamlessly)
  const handleCutSelection = useCallback((startSec: number, endSec: number) => {
    const buffer = audioBufferRef.current;
    if (!buffer) return;
    const s = Math.max(0, Math.min(startSec, endSec));
    const e = Math.min(buffer.duration, Math.max(startSec, endSec));
    const cutSpan = e - s;
    if (cutSpan < 0.02) return;

    pushUndo('Cut Selection');
    stopPlayback();

    const spliced = cutAudioBuffer(buffer, s, e);

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
  }, [markers, pushUndo, stopPlayback]);

  // Trim Start: Remove unnecessary lead-in audio (from 0:00 up to selection start or playhead)
  const handleTrimStart = useCallback((targetTime?: number) => {
    const buffer = audioBufferRef.current;
    if (!buffer) return;

    let t = targetTime !== undefined ? targetTime : currentTimeRef.current;
    const sel = selectionRef.current;
    if (sel && Math.abs(sel.end - sel.start) > 0.02) {
      t = Math.min(sel.start, sel.end);
    }

    if (t <= 0.02) return;
    if (t >= buffer.duration - 0.05) return;

    pushUndo('Trim Start');
    stopPlayback();

    const cropped = cropAudioBuffer(buffer, t, buffer.duration);
    const updatedMarkers = markers
      .filter((m) => m.time >= t)
      .map((m) => ({
        ...m,
        time: m.time - t,
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
  }, [markers, pushUndo, stopPlayback]);

  // Trim End: Remove unnecessary run-out audio (from selection end or playhead to file end)
  const handleTrimEnd = useCallback((targetTime?: number) => {
    const buffer = audioBufferRef.current;
    if (!buffer) return;

    let t = targetTime !== undefined ? targetTime : currentTimeRef.current;
    const sel = selectionRef.current;
    if (sel && Math.abs(sel.end - sel.start) > 0.02) {
      t = Math.max(sel.start, sel.end);
    }

    if (t <= 0.05) return;
    if (t >= buffer.duration - 0.02) return;

    pushUndo('Trim End');
    stopPlayback();

    const cropped = cropAudioBuffer(buffer, 0, t);
    const updatedMarkers = markers.filter((m) => m.time <= t);

    audioBufferRef.current = cropped;
    cropStartRef.current = 0;
    cropEndRef.current = cropped.duration;
    currentTimeRef.current = Math.min(currentTimeRef.current, cropped.duration);

    setAudioBuffer(cropped);
    setCropStart(0);
    setCropEnd(cropped.duration);
    setCurrentTime(Math.min(currentTimeRef.current, cropped.duration));
    setMarkers(updatedMarkers);
    setSelection(null);
    setZoom(1);
    setViewOffsetSec(0);
  }, [markers, pushUndo, stopPlayback]);

  // Loop Selection: Automatically start looping and play selected section seamlessly
  const handleLoopSelection = useCallback(
    (startSec: number, endSec: number) => {
      const buffer = audioBufferRef.current;
      if (!buffer) return;
      const s = Math.max(0, Math.min(startSec, endSec));
      const e = Math.min(buffer.duration, Math.max(startSec, endSec));
      if (e - s <= 0.02) return;

      stopPlayback();
      setIsLooping(true);
      isLoopingRef.current = true;
      setSelection({ start: s, end: e });
      selectionRef.current = { start: s, end: e };

      startPlayback(s, true);
    },
    [stopPlayback, startPlayback]
  );

  // Audition / Play Selection region once or looped
  const handlePlaySelection = useCallback(
    (startSec: number, endSec: number) => {
      handleLoopSelection(startSec, endSec);
    },
    [handleLoopSelection]
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

    pushUndo(`Normalise (${targetPeakDb.toFixed(1)} dB)`);

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

  // Apply De-Pop / Vinyl scratch attenuation with full Undo support
  const handleApplyDePop = (newBuffer: AudioBuffer, description: string) => {
    pushUndo(description || 'De-Pop Vinyl Scratches');
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
    pushUndo('Delete Split Marker');
    setMarkers((prev) => prev.filter((m) => m.id !== id));
  };

  // Delete a split region by removing its boundary marker (incorporating into previous split)
  const handleDeleteSplit = useCallback(
    (splitIndex: number) => {
      const buffer = audioBufferRef.current;
      if (!buffer) return;

      const effectiveStart = cropStartRef.current;
      const effectiveEnd = cropEndRef.current > 0 ? cropEndRef.current : buffer.duration;

      const activeMarkers = markers
        .filter((m) => m.time > effectiveStart + 0.01 && m.time < effectiveEnd - 0.01)
        .sort((a, b) => a.time - b.time);

      if (activeMarkers.length === 0) return;

      pushUndo('Delete Split Marker');

      let markerToRemove: Marker | undefined;
      if (splitIndex > 0 && splitIndex - 1 < activeMarkers.length) {
        // Remove the marker that started this split, expanding previous split
        markerToRemove = activeMarkers[splitIndex - 1];
      } else if (splitIndex === 0 && activeMarkers.length > 0) {
        // If first split, remove the marker that ends it
        markerToRemove = activeMarkers[0];
      }

      if (markerToRemove) {
        setMarkers((prev) => prev.filter((m) => m.id !== markerToRemove!.id));
      }
    },
    [markers, pushUndo]
  );

  const handleClearMarkers = () => {
    pushUndo('Clear Split Markers');
    setMarkers([]);
  };

  const handleAutoSplit = useCallback(
    (thresholdDb: number, minSilenceDurationSec: number): number => {
      const buffer = audioBufferRef.current;
      if (!buffer) return 0;

      const effectiveStart = cropStartRef.current;
      const effectiveEnd = cropEndRef.current > 0 ? cropEndRef.current : buffer.duration;

      const detectedTimes = detectSilenceSplits(
        buffer,
        thresholdDb,
        minSilenceDurationSec,
        effectiveStart,
        effectiveEnd
      );

      if (detectedTimes.length === 0) return 0;

      pushUndo('Auto-Split Silence');
      const newMarkers: Marker[] = detectedTimes.map((time, idx) => ({
        id: `marker-auto-${Date.now()}-${idx}`,
        time,
      }));
      setMarkers(newMarkers);
      return newMarkers.length;
    },
    [pushUndo]
  );

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
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        const sel = selectionRef.current;
        if (sel && Math.abs(sel.end - sel.start) > 0.02) {
          e.preventDefault();
          handleCutSelection(sel.start, sel.end);
        }
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        handleUndo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 't' || e.key === 'T')) {
        const sel = selectionRef.current;
        if (sel && Math.abs(sel.end - sel.start) > 0.05) {
          e.preventDefault();
          handleCropToSelection(sel.start, sel.end);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setSelection(null);
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
  }, [handlePlayPause, handleAddMarkerAtPlayhead, handleCutSelection, handleCropToSelection, handleUndo]);

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
        <div className="max-w-7xl mx-auto relative flex flex-col sm:block">
          {/* Brand & Logo on the Left */}
          <div className="flex items-center space-x-3 shrink-0 sm:absolute sm:left-0 sm:top-1/2 sm:-translate-y-1/2">
            <div>
              <h1 className="text-base font-bold text-slate-100 tracking-tight">
                Audiophonic Recordinator
              </h1>
            </div>
          </div>

          {/* Centered Workflow Buttons (RECORD, EDIT, SAVE) serving as global header */}
          <div className="grid grid-cols-3 gap-2 w-full sm:w-[380px] mx-auto mt-4 sm:mt-0 bg-slate-950/80 p-1 rounded-xl border border-slate-800">
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

        </div>
      </header>

      {/* Standby Mode Ribbon Banner */}
      {isStandbyMode && (
        <div className="bg-amber-950/40 border-b border-amber-500/30 px-4 py-1.5 flex items-center justify-between text-xs text-amber-200 shrink-0">
          <div className="flex items-center space-x-2">
            <MicOff className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              <strong>Preview Audio in Standby:</strong> Microphones and Web Audio are released so this preview won't echo or clash with your local dev app.
            </span>
          </div>
          <button
            type="button"
            onClick={wakeAudioEngine}
            className="ml-3 px-2.5 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/35 text-amber-300 font-semibold text-[11px] transition border border-amber-500/40 cursor-pointer shrink-0"
          >
            Wake Audio Engine
          </button>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 min-h-0 w-full p-4 lg:p-6 lg:pb-4 flex flex-col">
        <div className="flex-1 flex flex-col min-h-0 relative">
          {/* Render selected workflow view (Full Screen Container with NO SCROLL) */}
          <div className="flex-1 flex flex-col relative bg-slate-950/20 border border-slate-900 rounded-2xl overflow-hidden p-4 min-h-0 select-none">
            
            {/* WORKFLOW VIEW 1: RECORD CONSOLE */}
            {workflowTab === 'record' && (
              <div className="flex-1 h-full min-h-0 overflow-hidden">
                <AudioRecorder
                  onRecordingComplete={(buf, defaultName, art, alb) => {
                    loadAudio(buf, defaultName, art, alb);
                  }}
                  isRecordingActive={isRecordingActive}
                  setIsRecordingActive={setIsRecordingActive}
                  onClearRecording={handleClearRecording}
                  hasLoadedAudio={!!audioBuffer}
                  isStandbyMode={isStandbyMode}
                  onWakeAudioEngine={wakeAudioEngine}
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
                <div className="flex flex-col h-full min-h-0 gap-3 overflow-hidden">
                  {/* Top: Project Metadata Bar */}
                  <div className="flex-shrink-0 h-12 flex items-center justify-between gap-3 bg-slate-900 border border-slate-800 px-4 py-2 rounded-xl text-xs overflow-hidden">
                    <div className="flex items-center gap-4 min-w-0">
                      {/* Artist */}
                      <div className="flex items-center space-x-2">
                        <Tag className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-slate-400 font-medium">Artist:</span>
                        <input
                          type="text"
                          value={preRecordArtist}
                          onChange={(e) => setPreRecordArtist(e.target.value)}
                          className="bg-slate-950 border border-slate-800 rounded px-2.5 py-1 text-xs font-semibold text-slate-200 focus:outline-none focus:border-emerald-500 w-36"
                          placeholder="Artist / Band name..."
                        />
                      </div>
                      {/* Album */}
                      <div className="flex items-center space-x-2">
                        <Tag className="w-3.5 h-3.5 text-sky-400" />
                        <span className="text-slate-400 font-medium">Album:</span>
                        <input
                          type="text"
                          value={preRecordAlbum}
                          onChange={(e) => setPreRecordAlbum(e.target.value)}
                          className="bg-slate-950 border border-slate-800 rounded px-2.5 py-1 text-xs font-semibold text-slate-200 focus:outline-none focus:border-sky-500 w-36"
                          placeholder="Album / Record title..."
                        />
                      </div>
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

                  {/* 2-Column Workspace: Waveform on Left, Split Regions List on Right */}
                  <div className="flex-1 min-h-0 grid grid-cols-[minmax(0,1fr)_320px] gap-3 overflow-hidden">
                    {/* Left: Waveform canvas & toolbar (Full dynamic height) */}
                    <div className="min-w-0 min-h-0 flex flex-col overflow-hidden">
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
                        isLooping={isLooping}
                        canUndo={canUndo}
                        onPlayPause={handlePlayPause}
                        onStop={handleStop}
                        onSeek={handleSeek}
                        onPreviewStart={handlePreviewStart}
                        onSelectionChange={setSelection}
                        onLoopSelection={handleLoopSelection}
                        onCropToSelection={handleCropToSelection}
                        onCutSelection={handleCutSelection}
                        onPlaySelection={handlePlaySelection}
                        onTrimStart={handleTrimStart}
                        onTrimEnd={handleTrimEnd}
                        onUndo={handleUndo}
                        onToggleLoop={() => setIsLooping(!isLooping)}
                        onCropChange={(start, end) => {
                          setCropStart(start);
                          setCropEnd(end);
                        }}
                        onMarkerMove={handleMarkerMove}
                        onAddMarker={handleAddMarker}
                        onRemoveMarker={handleRemoveMarker}
                        onClearMarkers={handleClearMarkers}
                        onAutoSplit={handleAutoSplit}
                        onZoomChange={setZoom}
                        onViewOffsetChange={setViewOffsetSec}
                        onFadeSettingsChange={setFadeSettings}
                        onNormalise={handleNormalizeAudio}
                        onApplyDePop={handleApplyDePop}
                      />
                    </div>

                    {/* Right: Split Regions List (Never a scroll list - all entries visible at all times) */}
                    <div className="w-[320px] min-w-0 bg-slate-900/60 border border-slate-800 p-3 rounded-xl flex flex-col h-full min-h-0 select-none overflow-hidden">
                      {/* Header */}
                      <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-2 flex-shrink-0">
                        <div className="flex items-center space-x-2 text-slate-200 font-bold uppercase tracking-wider text-[10px]">
                          <Layers className="w-3.5 h-3.5 text-amber-500" />
                          <span>Split Regions</span>
                        </div>
                        <div className="flex items-center space-x-1.5">
                          <span className="text-[10px] font-mono font-bold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
                            {splits.length} {splits.length === 1 ? 'Track' : 'Tracks'}
                          </span>
                        </div>
                      </div>

                      {/* Entries Container (NO scrollbar, strictly overflow-hidden, dynamically fitted) */}
                      <div className="flex-1 min-h-0 flex flex-col justify-start gap-1 overflow-hidden">
                        {splits.length === 0 ? (
                          <div className="flex-1 flex flex-col items-center justify-center text-center p-4 text-slate-500 text-xs italic">
                            No split regions detected.
                          </div>
                        ) : (
                          splits.map((split, idx) => {
                            const colors = ['#f87171', '#fb923c', '#4ade80', '#38bdf8', '#c084fc', '#f43f5e', '#a855f7'];
                            const color = colors[idx % colors.length];
                            const isThisPlaying = isPlaying && currentTime >= split.startTime - 0.05 && currentTime <= split.endTime + 0.05;
                            const isCompact = splits.length > 8;
                            const isUltraCompact = splits.length > 13;

                            return (
                              <div
                                key={split.id}
                                className={`group flex items-center justify-between bg-slate-950/70 border border-slate-850 hover:border-slate-700 hover:bg-slate-900/60 rounded-lg transition shrink min-h-0 ${
                                  isUltraCompact
                                    ? 'py-0.5 px-1.5 text-[10px]'
                                    : isCompact
                                    ? 'py-1 px-2 text-[11px]'
                                    : 'py-2 px-2.5 text-xs'
                                }`}
                              >
                                {/* 1. Play button at the start */}
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (isThisPlaying) {
                                      handlePlayPause();
                                    } else {
                                      handlePlaySelection(split.startTime, split.endTime);
                                    }
                                  }}
                                  className={`rounded-md flex items-center justify-center transition cursor-pointer shrink-0 border ${
                                    isUltraCompact ? 'w-5 h-5' : 'w-6 h-6'
                                  } ${
                                    isThisPlaying
                                      ? 'bg-emerald-600 text-white border-emerald-500 shadow-sm animate-pulse'
                                      : 'bg-slate-900 hover:bg-emerald-600/20 text-emerald-400 hover:text-emerald-300 border-slate-800 hover:border-emerald-500/40'
                                  }`}
                                  title={isThisPlaying ? 'Pause split preview' : `Play Region ${split.index} (${formatTime(split.duration, false)})`}
                                >
                                  {isThisPlaying ? (
                                    <Pause className="w-2.5 h-2.5 fill-current" />
                                  ) : (
                                    <Play className="w-2.5 h-2.5 fill-current ml-0.5" />
                                  )}
                                </button>

                                {/* 2. Middle: Track number, name input, duration, and timestamps */}
                                <div className="flex-1 min-w-0 mx-2 flex flex-col justify-center">
                                  <div className="flex items-center space-x-1.5">
                                    <span
                                      className="font-mono text-[9px] font-bold px-1 rounded shrink-0 leading-none py-0.5"
                                      style={{
                                        backgroundColor: `${color}22`,
                                        color: color,
                                        border: `1px solid ${color}44`,
                                      }}
                                    >
                                      #{String(split.index).padStart(2, '0')}
                                    </span>
                                    <input
                                      type="text"
                                      value={trackNames[split.id] ?? split.name}
                                      onChange={(e) => {
                                        e.stopPropagation();
                                        setTrackNames((prev) => ({ ...prev, [split.id]: e.target.value }));
                                      }}
                                      onClick={(e) => e.stopPropagation()}
                                      className="flex-1 min-w-0 bg-transparent text-slate-200 text-xs font-bold truncate leading-tight focus:outline-none focus:bg-slate-800/50 rounded px-1 -mx-1 group-hover:text-amber-400 transition placeholder-slate-600"
                                      placeholder={`Track ${String(split.index).padStart(2, '0')}...`}
                                    />
                                  </div>
                                  {!isUltraCompact && (
                                    <div className="text-[10px] font-mono text-slate-400 flex items-center gap-1.5 mt-0.5 leading-none">
                                      <span className="text-slate-300 font-semibold">{formatTime(split.duration, false)}</span>
                                      <span className="text-slate-700">•</span>
                                      <span className="text-slate-500 truncate">{formatTime(split.startTime, false)} - {formatTime(split.endTime, false)}</span>
                                    </div>
                                  )}
                                </div>

                                {/* 3. Delete button at the end (removes split marker, merging into previous split) */}
                                <button
                                  type="button"
                                  disabled={markers.length === 0}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteSplit(idx);
                                  }}
                                  className={`rounded-md flex items-center justify-center transition cursor-pointer shrink-0 border ${
                                    isUltraCompact ? 'w-5 h-5' : 'w-6 h-6'
                                  } ${
                                    markers.length === 0
                                      ? 'opacity-20 cursor-not-allowed border-transparent text-slate-600'
                                      : 'bg-slate-900 hover:bg-rose-950/60 text-slate-400 hover:text-rose-400 border-slate-800 hover:border-rose-800/50'
                                  }`}
                                  title={
                                    markers.length === 0
                                      ? 'No split marker to delete'
                                      : idx > 0
                                      ? `Delete split marker (merge into Region ${idx})`
                                      : 'Delete split marker (merge with next region)'
                                  }
                                >
                                  <Trash2 className="w-2.5 h-2.5" />
                                </button>
                              </div>
                            );
                          })
                        )}
                      </div>
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
                    trackNames={trackNames}
                    onTrackNameChange={(splitId, name) => setTrackNames((prev) => ({ ...prev, [splitId]: name }))}
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