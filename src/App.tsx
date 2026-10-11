import { PlaybackPeakMeter } from './utils/playbackPeakMeter';
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { AudioRecorder } from './components/AudioRecorder';
import { WaveformCanvas } from './components/WaveformCanvas';
import { SplitsManager } from './components/SplitsManager';
import { Marker, SplitSegment, FadeSettings, TimeSelection } from './types';
import { detectSilenceSplits, formatTime, cropAudioBuffer, cutAudioBuffer } from './utils/audioProcessing';
import { sampleSelection } from './utils/sampleSelection';
import { PlaybackSegment, playbackPosition, timelinePosition, outputClock } from './utils/playbackClock';
import { mergeAutoSplitMarkers } from './utils/autoSplitPolicy';
import {
  Mic,
  MicOff,
  Radio,
  BookmarkPlus,
  FolderOpen,
  Trash2,
  Zap,
  Play,
  Pause,
  Tag,
  CheckCircle2,
  RotateCcw,
  Navigation,
  Volume2,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

export default function App() {
  // 3-Workflow sequential tabs state based on mockup (Record -> Edit -> Save)
  const [importStatus, setImportStatus] = useState<{ name: string; stage: 'Reading' | 'Decoding'; progress?: number } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [waveformBusy, setWaveformBusy] = useState(false);
  const loadingRef = useRef(false);
  loadingRef.current = !!importStatus || waveformBusy;
  const [workflowTab, setWorkflowTab] = useState<'record' | 'edit' | 'save'>('record');
  const [processingPanelContainer, setProcessingPanelContainer] = useState<HTMLDivElement | null>(null);
  const trackRowsRef = useRef<HTMLDivElement | null>(null);
  const [trackSlots, setTrackSlots] = useState(15);
  const [trackPage, setTrackPage] = useState(0);

  useEffect(() => {
    if (workflowTab !== 'edit' || !trackRowsRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      // Match the compact 22 px rows; never show a partial slot.
      setTrackSlots(Math.max(1, Math.floor(entry.contentRect.height / 22)));
    });
    observer.observe(trackRowsRef.current);
    return () => observer.disconnect();
  }, [workflowTab]);

  const [loadedAudioId, setLoadedAudioId] = useState(0);
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [mainFileName, setMainFileName] = useState<string>('Recording');
  const [isRecordingActive, setIsRecordingActive] = useState<boolean>(false);

  // Playback state
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [followPlayhead, setFollowPlayhead] = useState<boolean>(false);
  const [autoPreviewOnClick, setAutoPreviewOnClick] = useState<boolean>(false);

  // Crop boundaries
  const [cropStart, setCropStart] = useState<number>(0);
  const [cropEnd, setCropEnd] = useState<number>(0);

  // Selection Brace range
  const [selection, setSelection] = useState<TimeSelection | null>(null);
  // Split markers
  const [markers, setMarkers] = useState<Marker[]>([]);

  const markersRef = useRef<Marker[]>([]);
  const markerUndoRef = useRef<{ markers: Marker[]; trackNames: Record<string, string> }[]>([]);
  const [canUndoMarkers, setCanUndoMarkers] = useState(false);
  const replaceMarkers = useCallback((next: Marker[] | ((previous: Marker[]) => Marker[])) => {
    const updated = typeof next === 'function' ? next(markersRef.current) : next;
    markersRef.current = updated;
    setMarkers(updated);
  }, []);
  const resetMarkerUndo = useCallback(() => {
    markerUndoRef.current = [];
    setCanUndoMarkers(false);
  }, []);

  // Waveform View Zoom & Offset
  const [zoom, setZoom] = useState<number>(1);
  const [viewOffsetSec, setViewOffsetSec] = useState<number>(0);

  // Pre-Record metadata cache
  const [preRecordArtist, setPreRecordArtist] = useState<string>('');
  const [preRecordAlbum, setPreRecordAlbum] = useState<string>('');

  // Per-split track names (maps split ID to user-entered track name)
  const [trackNames, setTrackNames] = useState<{ [splitId: string]: string }>({});

  const pushMarkerUndo = useCallback(() => {
    markerUndoRef.current.push({ markers: markersRef.current.map(marker => ({ ...marker })), trackNames: { ...trackNames } });
    if (markerUndoRef.current.length > 30) markerUndoRef.current.shift();
    setCanUndoMarkers(true);
  }, [trackNames]);
  const handleMarkerUndo = useCallback(() => {
    const previous = markerUndoRef.current.pop();
    if (!previous) return;
    replaceMarkers(previous.markers);
    setTrackNames(previous.trackNames);
    setCanUndoMarkers(markerUndoRef.current.length > 0);
  }, [replaceMarkers]);

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
    selection: TimeSelection | null;
    currentTime: number;
    zoom: number;
    viewOffsetSec: number;
    trackNames: Record<string, string>;
    fadeSettings: FadeSettings;
  }
  const undoStackRef = useRef<UndoState[]>([]);
  const [canUndo, setCanUndo] = useState<boolean>(false);

  // Audio Context & Playback nodes
  const playbackPeakMeter = useRef(new PlaybackPeakMeter()).current;
  useEffect(() => { playbackPeakMeter.recordingChanged(); }, [loadedAudioId, playbackPeakMeter]);
  useEffect(() => () => playbackPeakMeter.dispose(), [playbackPeakMeter]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const playbackSourcesRef = useRef(new Set<AudioBufferSourceNode>());
  const playbackTimelineRef = useRef<PlaybackSegment[]>([]);
  const animationFrameRef = useRef<number | null>(null);
  const isPlayingRef = useRef<boolean>(false);

  // Synced refs
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const cropStartRef = useRef<number>(0);
  const cropEndRef = useRef<number>(0);
  const currentTimeRef = useRef<number>(0);
  const selectionRef = useRef<TimeSelection | null>(null);
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
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  const pushUndo = useCallback((actionName: string) => {
    if (!audioBufferRef.current) return;
    undoStackRef.current.push({
      buffer: audioBufferRef.current,
      markers: markersRef.current.map(marker => ({ ...marker })),
      cropStart: cropStartRef.current,
      cropEnd: cropEndRef.current,
      mainFileName,
      actionName,
      selection: selectionRef.current ? { ...selectionRef.current } : null,
      currentTime: currentTimeRef.current,
      zoom,
      viewOffsetSec,
      trackNames: { ...trackNames },
      fadeSettings: { ...fadeSettings },
    });
    if (undoStackRef.current.length > 10) {
      undoStackRef.current.shift();
    }
    resetMarkerUndo();
    setCanUndo(true);
  }, [mainFileName, zoom, viewOffsetSec, trackNames, fadeSettings, resetMarkerUndo]);

  const handleUndo = useCallback(() => {
    const prev = undoStackRef.current.pop();
    if (!prev) return;
    setCanUndo(undoStackRef.current.length > 0);

    for (const source of playbackSourcesRef.current) {
      try { source.onended = null; source.stop(); source.disconnect(); } catch {}
    }
    playbackSourcesRef.current.clear();
    playbackTimelineRef.current = [];
    sourceNodeRef.current = null;
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    playbackPeakMeter.stop();
    isPlayingRef.current = false;
    setIsPlaying(false);

    audioBufferRef.current = prev.buffer;
    cropStartRef.current = prev.cropStart;
    cropEndRef.current = prev.cropEnd;
    currentTimeRef.current = prev.currentTime;
    selectionRef.current = prev.selection;
    resetMarkerUndo();

    setAudioBuffer(prev.buffer);
    replaceMarkers(prev.markers);
    setCropStart(prev.cropStart);
    setCropEnd(prev.cropEnd);
    setMainFileName(prev.mainFileName);
    setCurrentTime(prev.currentTime);
    setSelection(prev.selection);
    setZoom(prev.zoom);
    setViewOffsetSec(prev.viewOffsetSec);
    setTrackNames(prev.trackNames);
    setFadeSettings(prev.fadeSettings);
  }, [replaceMarkers, resetMarkerUndo]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<'discard' | 'import' | null>(null);

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
  const stopPlayback = useCallback((preserveTimeline = false) => {
    playbackPeakMeter.stop();
    isPlayingRef.current = false;
    sourceNodeRef.current = null;
    for (const node of playbackSourcesRef.current) {
      try { node.onended = null; node.stop(); node.disconnect(); } catch {}
    }
    playbackSourcesRef.current.clear();
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    setIsPlaying(false);
    if (!preserveTimeline) playbackTimelineRef.current = [];
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

      const ctx = audioCtxRef.current;
      const segments = playbackTimelineRef.current;
      if (!ctx || !segments.length) return;
      const clock = outputClock(ctx, performance.now());
      const position = timelinePosition(segments, clock)!;
      // Retain the preceding source/bounds until their buffered audio has been heard.
      while (segments.length > 1 && segments[1].when <= clock) segments.shift();
      currentTimeRef.current = position;
      setCurrentTime(position);
      const active = segments[segments.length - 1];
      if (clock >= active.when + active.end - active.offset) {
        stopPlayback();
        currentTimeRef.current = active.start;
        setCurrentTime(active.start);
        return;
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
      for (const source of playbackSourcesRef.current) {
        try { source.onended = null; source.stop(); source.disconnect(); } catch {}
      }
      playbackSourcesRef.current.clear();
    };
  }, []);

  // Start playback from a given timestamp with sample-aligned selection bounds
  const startPlayback = useCallback(
    (offsetTime: number) => {
      const buffer = audioBufferRef.current;
      if (!buffer) return;
      const ctx = getAudioContext();
      if (isStandbyMode) {
        wakeAudioEngine();
      }

      if (ctx.state === 'suspended') {
        ctx.resume();
      }

      const sel = selectionRef.current;
      const hasSelection = sel && sampleSelection(sel, buffer.sampleRate, buffer.length);
      const effectiveStart = hasSelection ? hasSelection.start / buffer.sampleRate : cropStartRef.current;
      const effectiveEnd = hasSelection
        ? hasSelection.end / buffer.sampleRate
        : (cropEndRef.current > 0 ? cropEndRef.current : buffer.duration);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      // Read the clock after node preparation; schedule both sources at the same
      // future render boundary, so a busy UI cannot make the start offset stale.
      const when = ctx.currentTime + 256 / ctx.sampleRate;
      const safeStart = Math.max(effectiveStart, Math.min(effectiveEnd, offsetTime));
      if (sourceNodeRef.current) sourceNodeRef.current.stop(when);
      else stopPlayback(true);
      playbackSourcesRef.current.add(source);
      playbackPeakMeter.track(source, ctx);
      source.onended = () => { playbackPeakMeter.untrack(source); playbackSourcesRef.current.delete(source); source.disconnect(); };
      // Visual completion follows the output clock after queued audio is heard.
      source.start(when, safeStart, Math.max(0, effectiveEnd - safeStart));

      sourceNodeRef.current = source;
      playbackTimelineRef.current.push({ when, offset: safeStart, start: effectiveStart, end: effectiveEnd });
      isPlayingRef.current = true;
      const heardPosition = timelinePosition(playbackTimelineRef.current, outputClock(ctx, performance.now())) ?? safeStart;
      currentTimeRef.current = heardPosition;
      setCurrentTime(heardPosition);
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
      const ctx = audioCtxRef.current;
      if (ctx) {
        const position = timelinePosition(playbackTimelineRef.current, outputClock(ctx, performance.now()));
        if (position !== null) { currentTimeRef.current = position; setCurrentTime(position); }
      }
      stopPlayback(true);
    } else {
      const endLimit = cropEndRef.current > 0 ? cropEndRef.current : buffer.duration;
      const startLimit = cropStartRef.current;
      const cur = currentTimeRef.current;
      startPlayback(cur >= endLimit - 0.05 ? startLimit : cur);
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

  // Return to the absolute start independently of crop and selection bounds.
  const handleReturnToStart = useCallback(() => {
    if (!audioBufferRef.current) return;
    stopPlayback();
    handleSeek(0);
    setViewOffsetSec(0);
  }, [stopPlayback, handleSeek]);

  // Release selection and seek/audition atomically, creating at most one audio source.
  const handleWaveformClick = useCallback(
    (newTime: number) => {
      const buffer = audioBufferRef.current;
      if (!buffer) return;
      const end = cropEndRef.current > 0 ? cropEndRef.current : buffer.duration;
      const time = Math.max(cropStartRef.current, Math.min(end, newTime));
      selectionRef.current = null;
      setSelection(null);
      currentTimeRef.current = time;
      setCurrentTime(time);
      if (isPlayingRef.current || autoPreviewOnClick) {
        startPlayback(time);
      }
    },
    [startPlayback, autoPreviewOnClick]
  );

  // Selection edits retain ordinary single-pass audition bounds.
  const handleSelectionChange = useCallback((nextSelection: TimeSelection | null) => {
    selectionRef.current = nextSelection;
    setSelection(nextSelection);
    if (isPlayingRef.current) startPlayback(currentTimeRef.current);
  }, [startPlayback]);

  // Load new audio buffer (recording finished or imported file)
  const loadAudio = (buffer: AudioBuffer, fileName: string, artist?: string, album?: string, markerTimes: number[] = []) => {
    stopPlayback();
    audioBufferRef.current = buffer;
    undoStackRef.current = [];
    setCanUndo(false);
    resetMarkerUndo();
    setTrackNames({});
    cropStartRef.current = 0;
    cropEndRef.current = buffer.duration;
    currentTimeRef.current = 0;

    setLoadedAudioId(id => id + 1);
    setAudioBuffer(buffer);
    setMainFileName(fileName);
    if (artist) setPreRecordArtist(artist);
    if (album) setPreRecordAlbum(album);
    setCropStart(0);
    setCropEnd(buffer.duration);
    setSelection(null);
    setCurrentTime(0);
    const markerIdPrefix = `marker-recording-${Date.now()}`;
    replaceMarkers(
      markerTimes
        .filter((time) => time > 0.01 && time < buffer.duration - 0.01)
        .map((time, index) => ({ id: `${markerIdPrefix}-${index}`, time }))
    );
    setZoom(1);
    setViewOffsetSec(0);

    // Switch workflow to EDIT tab automatically
    setWorkflowTab('edit');
  };

  const handleClearRecording = () => {
    stopPlayback();
    undoStackRef.current = [];
    setCanUndo(false);
    resetMarkerUndo();
    setTrackNames({});
    audioBufferRef.current = null;
    cropStartRef.current = 0;
    cropEndRef.current = 0;
    currentTimeRef.current = 0;

    setLoadedAudioId(id => id + 1);
    setAudioBuffer(null);
    setMainFileName('Recording');
    setCropStart(0);
    setCropEnd(0);
    setSelection(null);
    setCurrentTime(0);
    replaceMarkers([]);
    setZoom(1);
    setViewOffsetSec(0);
    setPreRecordArtist('');
    setPreRecordAlbum('');
    setWorkflowTab('record'); // reset back to record tab
  };

  const handleRequestImport = () => {
    if (loadingRef.current) return;
    if (audioBuffer) {
      setConfirmDialog('import');
    } else {
      fileInputRef.current?.click();
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
    replaceMarkers(updatedMarkers);
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
    replaceMarkers(updatedMarkers);
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
    replaceMarkers(updatedMarkers);
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
    replaceMarkers(updatedMarkers);
    setSelection(null);
    setZoom(1);
    setViewOffsetSec(0);
  }, [markers, pushUndo, stopPlayback]);

  // Audition the selection once, preserving source sample boundaries.
  const handlePlaySelection = useCallback((startSec: number, endSec: number) => {
    const buffer = audioBufferRef.current;
    if (!buffer) return;
    const samples = sampleSelection({ start: startSec, end: endSec }, buffer.sampleRate, buffer.length);
    if (!samples) return;
    const region = { start: samples.start / buffer.sampleRate, end: samples.end / buffer.sampleRate };
    selectionRef.current = region;
    setSelection(region);
    startPlayback(region.start);
  }, [startPlayback]);

  // Volume tab results: one undoable step per action, replacing the whole recording buffer.
  const handleApplyVolume = (newBuffer: AudioBuffer, description: string) => {
    if (!audioBufferRef.current) return;
    stopPlayback();
    pushUndo(description);
    audioBufferRef.current = newBuffer;
    setAudioBuffer(newBuffer);
  };
  // Open audio file from disk
  const handleFileOpen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (loadingRef.current) return;
    loadingRef.current = true;
    stopPlayback();
    setWorkflowTab('edit');
    setImportError(null);
    setImportStatus({ name: file.name, stage: 'Reading' });
    let decodeContext: AudioContext | null = null;
    try {
      const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onprogress = (event) => {
          if (event.lengthComputable) setImportStatus({ name: file.name, stage: 'Reading', progress: event.loaded / event.total });
        };
        reader.onerror = () => reject(reader.error ?? new Error('Unable to read file.'));
        reader.onabort = () => reject(new Error('File reading was cancelled.'));
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.readAsArrayBuffer(file);
      });
      setImportStatus({ name: file.name, stage: 'Decoding' });
      decodeContext = new (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const decoded = await decodeContext.decodeAudioData(arrayBuffer);
      setWaveformBusy(true);
      // Imported source names/tags must not become the generated track-name base.
      loadAudio(decoded, 'Recording');
    } catch (err) {
      console.error('Failed to open audio file:', err);
      setImportError('Could not load audio. Please choose a valid WAV, FLAC, or MP3 file.');
      setWaveformBusy(false);
    } finally {
      decodeContext?.close().catch(() => {});
      setImportStatus(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Add marker at specified time
  const handleAddMarker = useCallback((time: number) => {
    const buffer = audioBufferRef.current;
    if (!buffer) return;
    const startLimit = cropStartRef.current;
    const endLimit = cropEndRef.current > 0 ? cropEndRef.current : buffer.duration;
    const clampedTime = Math.max(startLimit, Math.min(endLimit, time));

    if (markersRef.current.some(marker => Math.abs(marker.time - clampedTime) < 0.05)) return;
    pushMarkerUndo();
    const newMarker: Marker = { id: `marker-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, time: clampedTime };
    replaceMarkers(previous => [...previous, newMarker].sort((a, b) => a.time - b.time));
  }, [pushMarkerUndo, replaceMarkers]);

  const handleAddMarkerAtPlayhead = useCallback(() => {
    handleAddMarker(currentTimeRef.current);
  }, [handleAddMarker]);

  const handleMarkerMove = (id: string, newTime: number) => {
    const clampedTime = Math.max(cropStart, Math.min(cropEnd, newTime));
    replaceMarkers((prev) =>
      prev.map((m) => (m.id === id ? { ...m, time: clampedTime } : m)).sort((a, b) => a.time - b.time)
    );
  };

  const handleRemoveMarker = useCallback((id: string) => {
    if (!markersRef.current.some(marker => marker.id === id)) return;
    pushMarkerUndo();
    replaceMarkers((prev) => prev.filter((m) => m.id !== id));
  }, [pushMarkerUndo, replaceMarkers]);

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


      let markerToRemove: Marker | undefined;
      if (splitIndex > 0 && splitIndex - 1 < activeMarkers.length) {
        // Remove the marker that started this split, expanding previous split
        markerToRemove = activeMarkers[splitIndex - 1];
      } else if (splitIndex === 0 && activeMarkers.length > 0) {
        // If first split, remove the marker that ends it
        markerToRemove = activeMarkers[0];
      }

      if (markerToRemove) {
        handleRemoveMarker(markerToRemove.id);
      }
    },
    [markers, handleRemoveMarker]
  );

  const handleClearMarkers = () => {
    if (markersRef.current.length === 0) return;
    pushMarkerUndo();
    replaceMarkers([]);
  };

  const handleAutoSplit = useCallback(
    (thresholdDb: number, minSilenceDurationSec: number, candidates?: readonly number[]): number => {
      const buffer = audioBufferRef.current;
      if (!buffer) return 0;

      const effectiveStart = cropStartRef.current;
      const effectiveEnd = cropEndRef.current > 0 ? cropEndRef.current : buffer.duration;

      const detectedTimes = candidates ? [...candidates] : detectSilenceSplits(
        buffer,
        thresholdDb,
        minSilenceDurationSec,
        effectiveStart,
        effectiveEnd
      );

      if (detectedTimes.length === 0) return 0;

      pushMarkerUndo();
      const newMarkers: Marker[] = detectedTimes.map((time, idx) => ({
        id: `marker-auto-${Date.now()}-${idx}`,
        time,
      }));
      replaceMarkers(mergeAutoSplitMarkers(markersRef.current, newMarkers));
      return newMarkers.length;
    },
    [pushMarkerUndo, replaceMarkers]
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
        id: i === 0 ? 'split-start' : `split-marker-${activeMarkers[i - 1].id}`,
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

  const trackPageCount = Math.max(1, Math.ceil(splits.length / trackSlots));
  const visibleTrackPage = Math.min(trackPage, trackPageCount - 1);
  const firstVisibleTrack = visibleTrackPage * trackSlots;

  useEffect(() => {
    setTrackPage((page) => Math.min(page, trackPageCount - 1));
  }, [trackPageCount]);

  // Keyboard shortcut listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if (loadingRef.current) {
        if (e.code === 'Space' || ['Home', 'Delete', 'Backspace', 'Escape', 'm', 'i', 'o'].includes(e.key)
          || ((e.ctrlKey || e.metaKey) && ['z', 't'].includes(e.key.toLowerCase()))) e.preventDefault();
        return;
      }
      if (e.defaultPrevented) return;
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }

      if (e.key === 'Home' && workflowTab === 'edit') {
        e.preventDefault();
        handleReturnToStart();
      } else if (e.code === 'Space') {
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
        if (workflowTab !== 'record' || !isRecordingActive) {
          handleAddMarkerAtPlayhead();
        }
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
  }, [workflowTab, isRecordingActive, handlePlayPause, handleReturnToStart, handleAddMarkerAtPlayhead, handleCutSelection, handleCropToSelection, handleUndo]);

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
          {/* Import Button on the Left */}
          <div className="flex items-center shrink-0 sm:absolute sm:left-0 sm:top-1/2 sm:-translate-y-1/2">
            <button
              type="button"
              disabled={!!importStatus || waveformBusy}
              onClick={handleRequestImport}
              className="flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg bg-slate-850 hover:bg-emerald-950/40 text-slate-300 hover:text-emerald-400 border border-slate-800 hover:border-emerald-800/40 text-xs font-bold transition cursor-pointer"
              title="Import an audio file"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              <span>Import</span>
            </button>
          </div>

          {/* Centered Workflow Buttons (RECORD, EDIT, EXPORT) serving as global header */}
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

            {/* EXPORT TAB (Always available, but shows empty state if no audio) */}
            <button
              type="button"
              onClick={() => setWorkflowTab('save')}
              className={`py-2 rounded-lg font-mono text-xs tracking-wider uppercase font-bold text-center border transition cursor-pointer ${
                workflowTab === 'save'
                  ? 'border-emerald-500/80 text-emerald-450 bg-emerald-500/10 shadow-[0_0_15px_rgba(16,185,129,0.15)]'
                  : 'text-slate-400 hover:text-slate-200 border-transparent bg-transparent'
              }`}
            >
              EXPORT
            </button>
          </div>

          {/* Brand & Logo on the Right */}
          <div className="flex items-center justify-end space-x-3 shrink-0 mt-2 sm:mt-0 sm:absolute sm:right-0 sm:top-1/2 sm:-translate-y-1/2">
            <div>
              <h1 className="text-base font-bold text-slate-100 tracking-tight">
                Audiophonic Recordinator
              </h1>
            </div>
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
      <main inert={!!importStatus || waveformBusy} className={`flex-1 min-h-0 w-full flex flex-col ${workflowTab === 'save' ? 'px-3 py-2' : workflowTab === 'edit' ? 'px-3 py-2 lg:px-4' : 'p-4 lg:p-6 lg:pb-4'}`}>
        <div className="flex-1 flex flex-col min-h-0 relative">
          {/* Render selected workflow view (Full Screen Container with NO SCROLL) */}
          <div className={`flex-1 flex flex-col relative min-h-0 select-none ${workflowTab === 'edit' || workflowTab === 'save' ? '' : 'bg-slate-950/20 border border-slate-700/60 rounded-2xl overflow-hidden p-4 shadow-[inset_0_0_0_1px_rgba(148,163,184,0.04),0_8px_24px_rgba(0,0,0,0.18)]'}`}>

            {/* WORKFLOW VIEW 1: RECORD CONSOLE */}
            <div style={{ display: workflowTab === 'record' ? undefined : 'none' }} className="flex-1 h-full min-h-0 overflow-hidden">
              <AudioRecorder
                active={workflowTab === 'record'}
                onRecordingComplete={(buf, defaultName, art, alb, markerTimes) => {
                  loadAudio(buf, defaultName, art, alb, markerTimes);
                }}
                isRecordingActive={isRecordingActive}
                setIsRecordingActive={setIsRecordingActive}
                onClearRecording={handleClearRecording}
                hasLoadedAudio={!!audioBuffer}
                isStandbyMode={isStandbyMode}
                onWakeAudioEngine={wakeAudioEngine}
              />
            </div>

            {/* WORKFLOW VIEW 2: WAVEFORM EDITOR & SPLIT REGIONS */}
            {(workflowTab === 'edit' || waveformBusy || importStatus) && (
                <div style={{ display: workflowTab === 'edit' ? undefined : 'none' }} className="h-full min-h-0 grid grid-cols-[minmax(0,1fr)_clamp(340px,34vw,480px)] grid-rows-[minmax(0,1fr)_auto] gap-2.5">
                    {/* Left, top: Waveform canvas & toolbar (Full dynamic height) */}
                    <div className="col-start-1 row-start-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
                      <WaveformCanvas
                        importStatus={importStatus}
                        importError={importError}
                        onAnalysisBusyChange={setWaveformBusy}
                        processingPanelContainer={processingPanelContainer}
                        playbackPeakMeter={playbackPeakMeter}
                        loadedAudioId={loadedAudioId}
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
                        canUndoMarkers={canUndoMarkers}
                        onMarkerUndo={handleMarkerUndo}
                        canUndo={canUndo}
                        followPlayhead={followPlayhead}
                        autoPreviewOnClick={autoPreviewOnClick}
                        onFollowPlayheadChange={setFollowPlayhead}
                        onAutoPreviewOnClickChange={setAutoPreviewOnClick}
                        onPlayPause={handlePlayPause}
                        onReturnToStart={handleReturnToStart}
                        onStop={handleStop}
                        onSeek={handleSeek}
                        onWaveformClick={handleWaveformClick}
                        onSelectionChange={handleSelectionChange}
                        onCropToSelection={handleCropToSelection}
                        onCutSelection={handleCutSelection}
                        onPlaySelection={handlePlaySelection}
                        onTrimStart={handleTrimStart}
                        onTrimEnd={handleTrimEnd}
                        onUndo={handleUndo}
                        onCropChange={(start, end) => {
                          setCropStart(start);
                          setCropEnd(end);
                        }}
                        onMarkerMoveStart={pushMarkerUndo}
                        onMarkerMove={handleMarkerMove}
                        onAddMarker={handleAddMarker}
                        onRemoveMarker={handleRemoveMarker}
                        onClearMarkers={handleClearMarkers}
                        onAutoSplit={handleAutoSplit}
                        onZoomChange={setZoom}
                        onViewOffsetChange={setViewOffsetSec}
                        onFadeSettingsChange={setFadeSettings}
                        onApplyVolume={handleApplyVolume}
                      />
                    </div>

                    {/* Tracks span waveform and Tools, with only as many fixed-height slots as fit. */}
                    <div className="col-start-2 row-start-1 row-span-2 min-w-0 bg-slate-900/60 border border-slate-700/70 px-2 py-2 rounded-xl flex flex-col h-full min-h-0 select-none overflow-hidden shadow-[inset_0_1px_0_rgba(148,163,184,0.04)]">
                      {/* The recording name shares the fixed header without covering track rows. */}
                      <div className="flex items-center justify-between gap-2 border-b border-slate-800 pb-2 px-1 flex-shrink-0">
                        <div className="flex flex-1 min-w-0 items-center gap-2 text-slate-100 font-semibold text-base">
                          <h2 className="shrink-0">Tracks</h2>
                          <input
                            id="recording-name"
                            type="text"
                            aria-label="Recording name"
                            value={mainFileName}
                            onChange={(event) => setMainFileName(event.target.value)}
                            onKeyDown={(event) => {
                              event.stopPropagation();
                              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                                event.preventDefault();
                                event.currentTarget.blur();
                              }
                            }}
                            className="flex-1 min-w-0 h-6 bg-slate-950 border border-slate-700 rounded px-2 text-[11px] font-medium tracking-tight text-slate-200 focus:outline-none focus:border-amber-500"
                            title="Recording name used for default split names; press Enter to finish editing"
                          />
                        </div>
                        <div className="flex shrink-0 items-center space-x-1.5">
                          <span className="text-[11px] font-mono text-sky-300 bg-sky-500/10 px-2 py-0.5 rounded-full border border-sky-500/20">
                            {splits.length} {splits.length === 1 ? 'track' : 'tracks'}
                          </span>
                          {trackPageCount > 1 && (
                            <div className="flex items-center gap-1 text-[10px] text-slate-400" aria-label="Track pages">
                              <button type="button" aria-label="Previous tracks" disabled={visibleTrackPage === 0} onClick={() => setTrackPage(visibleTrackPage - 1)} className="w-6 h-6 flex items-center justify-center rounded hover:bg-slate-800 hover:text-sky-300 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer">
                                <ChevronLeft className="w-3.5 h-3.5" />
                              </button>
                              <span className="font-mono tabular-nums" aria-live="polite">{firstVisibleTrack + 1}–{Math.min(firstVisibleTrack + trackSlots, splits.length)}</span>
                              <button type="button" aria-label="Next tracks" disabled={visibleTrackPage === trackPageCount - 1} onClick={() => setTrackPage(visibleTrackPage + 1)} className="w-6 h-6 flex items-center justify-center rounded hover:bg-slate-800 hover:text-sky-300 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer">
                                <ChevronRight className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}
                          <button
                            type="button"
                            disabled={!audioBuffer}
                            onClick={() => setConfirmDialog('discard')}
                            title="Discard Recording"
                            className="w-5 h-5 flex items-center justify-center rounded border border-rose-800/50 bg-rose-950/30 text-rose-400 hover:bg-rose-900/50 hover:border-rose-600 hover:text-rose-300 transition cursor-pointer disabled:cursor-not-allowed disabled:hover:bg-rose-950/30 disabled:hover:border-rose-800/50 disabled:hover:text-rose-400"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>

                      </div>

                      {/* Consistent columns keep names and timing readable at every track count. */}
                      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                        <div className="shrink-0 grid grid-cols-[28px_22px_minmax(0,1fr)_52px_58px_24px] items-center gap-1 h-7 border-b border-slate-700/70 text-[10px] text-slate-400">
                          <span />
                          <span>#</span>
                          <span>Track name</span>
                          <span className="text-right">Start</span>
                          <span className="text-right">Duration</span>
                          <span />
                        </div>
                        <div ref={trackRowsRef} className="flex-1 min-h-0 overflow-hidden" aria-label="Track slots">
                        {splits.length === 0 ? (
                          <div className="flex-1 flex flex-col items-center justify-center text-center p-4 text-slate-500 text-xs italic">
                            Import or record audio to create tracks.
                          </div>
                        ) : (
                          splits.slice(firstVisibleTrack, firstVisibleTrack + trackSlots).map((split, slotIndex) => {
                            const idx = firstVisibleTrack + slotIndex;
                            const isThisPlaying = isPlaying && currentTime >= split.startTime - 0.05 && currentTime <= split.endTime + 0.05;
                            return (
                              <div
                                key={split.id}
                                className={`group grid grid-cols-[28px_22px_minmax(0,1fr)_52px_58px_24px] items-center gap-1 h-[22px] border-b border-slate-800/80 text-xs transition ${isThisPlaying ? 'bg-emerald-500/10' : 'hover:bg-slate-800/40'}`}
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
                                  aria-label={isThisPlaying ? `Pause track ${split.index}` : `Play track ${split.index}`}
                                  className={`justify-self-center w-6 h-4 m-0 p-0 border-0 bg-transparent flex items-center justify-center leading-4 transition-colors cursor-pointer hover:text-emerald-300 ${isThisPlaying ? 'text-emerald-300' : 'text-emerald-400'}`}
                                  title={isThisPlaying ? 'Pause split preview' : `Play Region ${split.index} (${formatTime(split.duration, false)})`}
                                >
                                  {isThisPlaying ? (
                                    <Pause className="fill-current w-3 h-3" />
                                  ) : (
                                    <span aria-hidden="true" className="block h-4 text-xs leading-4">▶</span>
                                  )}
                                </button>

                                {/* 2. Middle: Track number, name input, start, and duration */}
                                <div className="contents">
                                  <span className="font-mono text-[11px] font-normal leading-4 text-slate-400 tabular-nums">
                                    {String(split.index).padStart(2, '0')}
                                  </span>
                                  <input
                                    type="text"
                                    value={trackNames[split.id] ?? split.name}
                                    onChange={(e) => {
                                      e.stopPropagation();
                                      setTrackNames((prev) => ({ ...prev, [split.id]: e.target.value }));
                                    }}
                                    onClick={(e) => e.stopPropagation()}
                                    aria-label={`Track ${split.index} name`}
                                    className="block w-full min-w-0 h-4 m-0 p-0 border-0 appearance-none bg-transparent font-mono text-[11px] font-normal leading-4 text-slate-200 truncate rounded focus:outline-none focus:ring-1 focus:ring-sky-500/60 focus:bg-slate-800"
                                    placeholder={`Track ${String(split.index).padStart(2, '0')}...`}
                                  />
                                  <span
                                    className="text-right font-mono text-[11px] font-normal leading-4 text-sky-400/80 tabular-nums"
                                    title={`Start time: ${formatTime(split.startTime, false)}`}
                                  >
                                    {formatTime(split.startTime, false)}
                                  </span>
                                  <span
                                    className="text-right font-mono text-[11px] font-normal leading-4 text-slate-400 tabular-nums"
                                    title={`${formatTime(split.startTime, false)} - ${formatTime(split.endTime, false)}`}
                                  >
                                    {formatTime(split.duration, false)}
                                  </span>
                                </div>

                                {/* 3. Delete button at the end (removes split marker, merging into previous split) */}
                                <button
                                  type="button"
                                  disabled={markers.length === 0}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteSplit(idx);
                                  }}
                                  aria-label={`Delete split ${split.index}`}
                                  className="justify-self-center w-6 h-4 m-0 p-0 border-0 bg-transparent flex items-center justify-center leading-4 text-rose-400 hover:text-rose-300 transition-colors cursor-pointer disabled:opacity-20 disabled:cursor-not-allowed"
                                  title={
                                    markers.length === 0
                                      ? 'No split marker to delete'
                                      : idx > 0
                                      ? `Delete split marker (merge into Region ${idx})`
                                      : 'Delete split marker (merge with next region)'
                                  }
                                >
                                  <span aria-hidden="true" className="block h-4 text-lg leading-4">×</span>
                                </button>
                              </div>
                            );
                          })
                        )}
                        </div>
                      </div>
                    </div>

                    {/* Preserve the former transport row height while Tools fills its width. */}
                    <div className="col-start-1 row-start-2 h-[98px] min-w-0 flex items-stretch text-xs">
                      <div ref={setProcessingPanelContainer} className="relative flex-1 min-w-0 bg-slate-900/60 border border-slate-700/70 rounded-xl px-[9px] pt-1 pb-[7.5px]" />
                    </div>

                  {/* Confirm Dialog: Discard / Import Overwrite */}
                  {confirmDialog && (
                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-sm">
                      <div className="w-72 rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl">
                        <h2 className="text-sm font-bold text-slate-100">
                          {confirmDialog === 'discard' ? 'Discard this recording?' : 'Import a new file?'}
                        </h2>
                        <p className="mt-2 text-xs leading-relaxed text-slate-400">
                          {confirmDialog === 'discard'
                            ? 'This will remove the current audio and any unsaved splits or fades. This cannot be undone.'
                            : 'Importing a new file will replace the audio currently loaded, along with any unsaved splits or fades.'}
                        </p>
                        <div className="mt-4 flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setConfirmDialog(null)}
                            className="rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-bold text-slate-300 transition hover:border-slate-500 hover:text-slate-100 cursor-pointer"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const mode = confirmDialog;
                              setConfirmDialog(null);
                              if (mode === 'discard') {
                                handleClearRecording();
                              } else {
                                fileInputRef.current?.click();
                              }
                            }}
                            className="rounded-md border border-red-500/50 bg-red-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-red-500 cursor-pointer"
                          >
                            {confirmDialog === 'discard' ? 'Discard' : 'Import'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
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
