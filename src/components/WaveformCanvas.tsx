import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { buildWaveformPeaks } from '../utils/waveformPeaks';
import { createPortal } from 'react-dom';
import { RotaryKnob } from './RotaryKnob';
import { analyzeSilenceLevels, findSilenceRegions, snapToSilenceCandidate, analyzeSilenceLevelsChunked } from '../utils/silenceAnalysis';
import { Marker, FadeSettings, TimeSelection } from '../types';
import {
  formatTime,
  calculateFadeGain,
  findZeroCrossing,
  measureNoiseFloorDb,
  detectSilenceSplits,
  analyzeAnomalousPeaks,
  reduceAnomalousPeaks,
  AnomalousPeakAnalysis,
  AnomalousPeakEvent,
} from '../utils/audioProcessing';
import {
  Ear,
  ZoomIn,
  ZoomOut,
  ScanLine,
  Crop,
  Scissors,
  X,
  RotateCcw,
  Repeat,
  Activity,
  AudioWaveform,
  UnfoldVertical,
  Volume2,
} from 'lucide-react';

interface WaveformCanvasProps {
  importStatus?: { name: string; stage: 'Reading' | 'Decoding'; progress?: number } | null;
  importError?: string | null;
  onAnalysisBusyChange?: (busy: boolean) => void;
  processingPanelContainer: HTMLDivElement | null;
  audioBuffer: AudioBuffer | null;
  currentTime: number;
  cropStart: number;
  cropEnd: number;
  selection: TimeSelection | null;
  markers: Marker[];
  zoom: number;
  viewOffsetSec: number;
  fadeSettings: FadeSettings;
  isPlaying: boolean;
  isLooping?: boolean;
  canUndo?: boolean;
  canUndoMarkers?: boolean;
  onMarkerUndo?: () => void;
  followPlayhead: boolean;
  autoPreviewOnClick: boolean;
  onFollowPlayheadChange: (enabled: boolean) => void;
  onAutoPreviewOnClickChange: (enabled: boolean) => void;
  onPlayPause?: () => void;
  onStop?: () => void;
  onSeek: (time: number) => void;
  onWaveformClick: (time: number) => void;
  onSelectionChange?: (selection: TimeSelection | null) => void;
  onLoopSelection?: (start: number, end: number) => void;
  onCropToSelection?: (start: number, end: number) => void;
  onCutSelection?: (start: number, end: number) => void;
  onPlaySelection?: (start: number, end: number) => void;
  onTrimStart?: () => void;
  onTrimEnd?: () => void;
  onUndo?: () => void;
  onCropChange?: (start: number, end: number) => void;
  onMarkerMoveStart?: () => void;
  onMarkerMove: (id: string, newTime: number) => void;
  onAddMarker: (time: number) => void;
  onRemoveMarker: (id: string) => void;
  onClearMarkers?: () => void;
  onAutoSplit?: (thresholdDb: number, silenceDurationSec: number) => number | void;
  onZoomChange: (zoom: number) => void;
  onViewOffsetChange: (offset: number) => void;
  onFadeSettingsChange: (settings: FadeSettings) => void;
  onNormalise: (targetPeakDb: number) => void; // UK spelling!
  onApplyDePop?: (newBuffer: AudioBuffer, description: string) => void;
}

const RULER_HEIGHT = 18;
// Round up to a "nice" tick spacing so ruler labels never crowd together while zooming.
const RULER_NICE_INTERVALS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
const pickRulerInterval = (visibleDuration: number, width: number): number => {
  const secondsPerPixel = visibleDuration / Math.max(1, width);
  const rawInterval = 70 * secondsPerPixel;
  for (const interval of RULER_NICE_INTERVALS) {
    if (interval >= rawInterval) return interval;
  }
  return RULER_NICE_INTERVALS[RULER_NICE_INTERVALS.length - 1];
};

// Compact, uniform size icon button with 0.5s delayed HTML tooltip
interface TooltipButtonProps {
  onClick: (e: React.MouseEvent) => void;
  icon: React.ReactNode;
  label: string;
  caption?: string;
  captionAbove?: boolean;
  compact?: boolean;
  isActive?: boolean;
  activeClass?: string;
  disabled?: boolean;
}

const TooltipButton: React.FC<TooltipButtonProps> = ({
  onClick,
  icon,
  label,
  caption,
  captionAbove = false,
  compact = false,
  isActive = false,
  activeClass = "bg-emerald-600 text-white border-emerald-500 shadow-sm",
  disabled = false,
}) => {
  const [showTooltip, setShowTooltip] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const handleMouseEnter = () => {
    timerRef.current = setTimeout(() => {
      setShowTooltip(true);
    }, 500); // 0.5s hover delay!
  };

  const handleMouseLeave = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setShowTooltip(false);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div className={`relative inline-flex ${captionAbove ? 'flex-col items-center gap-0.5' : ''}`} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
      {caption && captionAbove && <span className="text-[8px] font-bold uppercase tracking-wider text-slate-500 whitespace-nowrap">{caption}</span>}
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        aria-label={label}
        title={label}
        className={`${compact || captionAbove ? 'w-6 h-6' : caption && !captionAbove ? 'h-9 px-2 gap-1.5' : 'w-9 h-9'} flex items-center justify-center rounded-md border text-slate-300 font-semibold transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
          isActive
            ? activeClass
            : 'bg-slate-950 hover:bg-slate-800 border-slate-800 hover:border-slate-700'
        }`}
      >
        {icon}
        {caption && !captionAbove && <span className="text-xs font-medium">{caption}</span>}
      </button>
      {showTooltip && (
        <div className="absolute top-full left-1/2 transform -translate-x-1/2 mt-2.5 px-2.5 py-1.5 bg-slate-950 text-slate-200 border border-slate-850 text-[10px] font-medium font-sans rounded shadow-2xl whitespace-nowrap z-50 pointer-events-none">
          {label}
        </div>
      )}
    </div>
  );
};

export const WaveformCanvas: React.FC<WaveformCanvasProps> = ({
  importStatus, importError, onAnalysisBusyChange,
  audioBuffer,
  currentTime,
  cropStart,
  cropEnd,
  selection,
  markers,
  zoom,
  viewOffsetSec,
  fadeSettings,
  isPlaying,
  isLooping = false,
  canUndo = false,
  canUndoMarkers = false,
  onMarkerUndo,
  followPlayhead,
  autoPreviewOnClick,
  onFollowPlayheadChange,
  onAutoPreviewOnClickChange,
  onPlayPause,
  onStop,
  onSeek,
  onWaveformClick,
  onSelectionChange,
  onLoopSelection,
  onCropToSelection,
  onCutSelection,
  onPlaySelection,
  onTrimStart,
  onTrimEnd,
  onUndo,
  onCropChange,
  onMarkerMoveStart,
  onMarkerMove,
  onAddMarker,
  onRemoveMarker,
  onClearMarkers,
  onAutoSplit,
  onZoomChange,
  onViewOffsetChange,
  onFadeSettingsChange,
  onNormalise,
  onApplyDePop,
  processingPanelContainer,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rulerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const minimapRef = useRef<HTMLCanvasElement | null>(null);
  const pointerDownPositionRef = useRef<{ x: number; y: number } | null>(null);

  // Radar-style "ping" when the cursor crosses onto a detected noise-floor snap point
  const snapPingRef = useRef<{ x: number; start: number } | null>(null);
  const wasOverSnapPointRef = useRef<boolean>(false);
  const pingRafRef = useRef<number | null>(null);

  const [canvasDimensions, setCanvasDimensions] = useState({ width: 600, height: 180 });
  const markerMoveStartedRef = useRef(false);
  const [verticalZoom, setVerticalZoom] = useState(1);
  const verticalZoomRef = useRef(1);

  // Popover States
  const [processingOpen, setProcessingOpen] = useState(false);
  const [showNormalisePopover, setShowNormalisePopover] = useState<boolean>(false);
  const [normaliseTargetDb, setNormaliseTargetDb] = useState<number>(-0.5);

  // Anomalous Peak Tamer States
  const [showPeakTamerPopover, setShowPeakTamerPopover] = useState<boolean>(false);
  const [peakThresholdDb, setPeakThresholdDb] = useState<number>(-3.0);
  const [peakTargetCeilingDb, setPeakTargetCeilingDb] = useState<number>(-6.0);
  const [peakScope, setPeakScope] = useState<'selection' | 'all'>('selection');
  const [peakAnalysis, setPeakAnalysis] = useState<AnomalousPeakAnalysis | null>(null);
  const [isProcessingPeaks, setIsProcessingPeaks] = useState<boolean>(false);
  const peakScanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Noise Floor & Auto-Split States
  const [noiseFloorDb, setNoiseFloorDb] = useState<number>(-45.0);
  // Snap radius in seconds; 0 = off. Adjustable via the rotary knob in the Detection group.
  const [snapAmountSec, setSnapAmountSec] = useState<number>(0.15);
  const [silenceDurationSec, setSilenceDurationSec] = useState<number>(1.0);
  const [autoSplitPreview, setAutoSplitPreview] = useState<{
    buffer: AudioBuffer;
    thresholdDb: number;
    silenceDuration: number;
    start: number;
    end: number;
    times: number[];
  } | null>(null);
  const [thresholdFlashKey, setThresholdFlashKey] = useState<number>(0);
  const [appliedPreview, setAppliedPreview] = useState<typeof autoSplitPreview>(null);
  const [feedbackToast, setFeedbackToast] = useState<{ text: string; type: 'success' | 'info' | 'warning' } | null>(null);

  // Dragging States
  const [activeDrag, setActiveDrag] = useState<{
    type: 'playhead' | 'marker' | 'fadeIn' | 'fadeOut' | 'fadeInCurve' | 'fadeOutCurve' | 'selectionStart' | 'selectionEnd' | 'selectionMove' | 'selectionCreate';
    id?: string;
    startX?: number;
    startTime?: number;
  } | null>(null);

  // Minimap Dragging and Hover States
  const [minimapDrag, setMinimapDrag] = useState<{
    mode: 'slide' | 'resizeLeft' | 'resizeRight';
    startX: number;
    initialOffset: number;
    initialZoom: number;
    initialVisibleDuration: number;
  } | null>(null);
  const [minimapHover, setMinimapHover] = useState<'left' | 'right' | 'body' | null>(null);

  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverPosition, setHoverPosition] = useState<{ x: number; y: number } | null>(null);
  const [hoveredElement, setHoveredElement] = useState<'fadeIn' | 'fadeOut' | 'cropStart' | 'cropEnd' | 'selectionStart' | 'selectionEnd' | 'selectionBar' | 'marker' | null>(null);
  const [hoveredMarkerId, setHoveredMarkerId] = useState<string | null>(null);



  // Peak Pyramids
  interface PeakLevel {
    blockSize: number;
    min: Float32Array;
    max: Float32Array;
  }
  interface ChannelPyramid {
    levels: PeakLevel[];
  }
  const pyramidRef = useRef<ChannelPyramid[] | null>(null);

  const duration = audioBuffer?.duration ?? 0;
  const autoSplitEnd = cropEnd > 0 ? cropEnd : duration;
  const previewsApplied = appliedPreview?.buffer === audioBuffer &&
    appliedPreview?.thresholdDb === noiseFloorDb && appliedPreview?.silenceDuration === silenceDurationSec &&
    appliedPreview?.start === cropStart && appliedPreview?.end === autoSplitEnd;

  // Preview only: debounce changes and never add markers until Auto-Split is clicked.
  useEffect(() => {
    if (!processingOpen || !audioBuffer || previewsApplied) return;
    const timer = setTimeout(() => {
      setAutoSplitPreview({
        buffer: audioBuffer,
        thresholdDb: noiseFloorDb,
        silenceDuration: silenceDurationSec,
        start: cropStart,
        end: autoSplitEnd,
        times: detectSilenceSplits(audioBuffer, noiseFloorDb, silenceDurationSec, cropStart, autoSplitEnd),
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [processingOpen, audioBuffer, noiseFloorDb, silenceDurationSec, cropStart, autoSplitEnd, previewsApplied, thresholdFlashKey]);

  const previewTimes = autoSplitPreview?.buffer === audioBuffer &&
    autoSplitPreview?.thresholdDb === noiseFloorDb &&
    autoSplitPreview?.silenceDuration === silenceDurationSec &&
    autoSplitPreview?.start === cropStart && autoSplitPreview?.end === autoSplitEnd
    ? autoSplitPreview.times : null;
  // Applying auto-splits preserves manual markers.
  const previewSliceCount = previewTimes === null ? null : 1 +
    (previewTimes.length > 0 ? previewTimes : markers.map((marker) => marker.time))
      .filter((time) => time > cropStart + 0.01 && time < autoSplitEnd - 0.01).length;
  const visibleDuration = duration / Math.max(1, zoom);
  const maxOffset = Math.max(0, duration - visibleDuration);
  const currentOffset = Math.max(0, Math.min(maxOffset, viewOffsetSec));

  useEffect(() => {
    verticalZoomRef.current = 1;
    setVerticalZoom(1);
  }, [audioBuffer]);

  const [analyzedSamples, setAnalyzedSamples] = useState(0);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    pyramidRef.current = null;
    setAnalyzedSamples(0);
    setAnalysisError(null);
    if (!audioBuffer) { setAnalysisBusy(false); onAnalysisBusyChange?.(false); return; }
    setAnalysisBusy(true);
    onAnalysisBusyChange?.(true);
    buildWaveformPeaks(audioBuffer, controller.signal, (pyramids, samples) => {
      pyramidRef.current = pyramids;
      setAnalyzedSamples(samples);
    }).catch(() => {
      if (!controller.signal.aborted) {
        setAnalysisError('Unable to build the waveform. Try importing the file again.');
        setAnalysisBusy(false);
        onAnalysisBusyChange?.(false);
      }
    });
    return () => { controller.abort(); };
  }, [audioBuffer, onAnalysisBusyChange]);

  // Observer to keep canvas sharp and responsive
  useEffect(() => {
    if (!canvasContainerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 50 && height > 50) {
          setCanvasDimensions({ width: Math.floor(width), height: Math.floor(height) });
        }
      }
    });
    observer.observe(canvasContainerRef.current);
    return () => observer.disconnect();
  }, []);

  // Follow playhead scrolling
  useEffect(() => {
    if (!isPlaying || !followPlayhead) return;
    if (!audioBuffer) return;
    const buffer = audioBuffer;
    const currentVisible = buffer.duration / Math.max(1, zoom);
    const halfVisible = currentVisible / 2;

    if (currentTime < currentOffset || currentTime > currentOffset + currentVisible) {
      const idealOffset = Math.max(0, Math.min(buffer.duration - currentVisible, currentTime - halfVisible));
      onViewOffsetChange(idealOffset);
    }
  }, [currentTime, isPlaying, followPlayhead, zoom, currentOffset, audioBuffer, onViewOffsetChange]);

  // Keep latest zoom/offset/duration in refs for non-passive wheel event handling
  const zoomRef = useRef(zoom);
  const currentOffsetRef = useRef(currentOffset);
  const durationRef = useRef(duration);
  const onZoomChangeRef = useRef(onZoomChange);
  const onViewOffsetChangeRef = useRef(onViewOffsetChange);

  useEffect(() => {
    zoomRef.current = zoom;
    currentOffsetRef.current = currentOffset;
    durationRef.current = duration;
    onZoomChangeRef.current = onZoomChange;
    onViewOffsetChangeRef.current = onViewOffsetChange;
  }, [zoom, currentOffset, duration, onZoomChange, onViewOffsetChange]);

  // Mouse wheel zooms time around the cursor; Shift + wheel adjusts waveform amplitude.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      e.preventDefault();

      const wheelDelta = Math.max(-200, Math.min(200, e.deltaY));
      const zoomFactor = Math.pow(1.0015, -wheelDelta);

      if (e.shiftKey) {
        const currentVerticalZoom = verticalZoomRef.current;
        const nextVerticalZoom = Math.max(0.25, Math.min(64, currentVerticalZoom * zoomFactor));
        if (nextVerticalZoom !== currentVerticalZoom) {
          verticalZoomRef.current = nextVerticalZoom;
          setVerticalZoom(nextVerticalZoom);
        }
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const width = rect.width;
      if (width <= 0) return;

      const dur = durationRef.current;
      if (dur <= 0) return;
      const currZoom = zoomRef.current;
      const currOffset = currentOffsetRef.current;
      const currVisible = dur / Math.max(1, currZoom);

      // Time at cursor before zoom
      const cursorRatio = Math.max(0, Math.min(1, cursorX / width));
      const cursorTime = currOffset + cursorRatio * currVisible;

      const nextZoom = Math.max(1, Math.min(60, currZoom * zoomFactor));

      if (nextZoom === currZoom) return;

      // New visible duration
      const nextVisible = dur / nextZoom;
      // New offset keeping cursorTime at cursorRatio of the view
      const maxPossibleOffset = Math.max(0, dur - nextVisible);
      const nextOffset = Math.max(0, Math.min(maxPossibleOffset, cursorTime - cursorRatio * nextVisible));

      onZoomChangeRef.current(nextZoom);
      onViewOffsetChangeRef.current(nextOffset);
      zoomRef.current = nextZoom;
      currentOffsetRef.current = nextOffset;
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', handleWheel);
    };
  }, []);

  // Coordinate math
  const timeToX = useCallback((t: number, width: number): number => {
    return ((t - currentOffset) / visibleDuration) * width;
  }, [currentOffset, visibleDuration]);

  const xToTime = useCallback((x: number, width: number): number => {
    return currentOffset + (x / width) * visibleDuration;
  }, [currentOffset, visibleDuration]);

  // Time Ruler: ticks + labels drawn in its own fixed-height strip above the waveform
  const drawRuler = useCallback(() => {
    const canvas = rulerCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvasDimensions.width;
    canvas.width = width * dpr;
    canvas.height = RULER_HEIGHT * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, RULER_HEIGHT);

    ctx.fillStyle = '#0b1120';
    ctx.fillRect(0, 0, width, RULER_HEIGHT);

    if (!audioBuffer || visibleDuration <= 0) return;

    const interval = pickRulerInterval(visibleDuration, width);
    const minorInterval = interval / 5;
    const firstMinor = Math.floor(currentOffset / minorInterval) * minorInterval;

    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    for (let t = firstMinor; t <= currentOffset + visibleDuration + minorInterval; t += minorInterval) {
      if (t < -minorInterval / 2) continue;
      const x = timeToX(Math.max(0, t), width);
      if (x < -2 || x > width + 2) continue;
      const isMajor = Math.abs(Math.round(t / interval) * interval - t) < minorInterval / 2;

      ctx.beginPath();
      ctx.moveTo(x, isMajor ? RULER_HEIGHT - 9 : RULER_HEIGHT - 5);
      ctx.lineTo(x, RULER_HEIGHT - 1);
      ctx.strokeStyle = isMajor ? '#64748b' : '#334155';
      ctx.lineWidth = 1;
      ctx.stroke();

      if (isMajor) {
        const label = interval < 1 ? `${t.toFixed(2)}s` : formatTime(t, false);
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(label, x + 3, 1);
      }
    }
  }, [canvasDimensions.width, currentOffset, visibleDuration, audioBuffer, timeToX]);

  useEffect(() => {
    drawRuler();
  }, [drawRuler]);

  // Snapping time to zero-crossing
  const snapToZeroCrossing = useCallback((time: number): number => {
    if (!audioBuffer) return time;
    const sampleRate = audioBuffer.sampleRate;
    const ch0 = audioBuffer.getChannelData(0);
    const targetSample = Math.round(time * sampleRate);
    const searchRange = Math.round(sampleRate * 0.05); // 50ms search
    const snappedSample = findZeroCrossing(ch0, targetSample, searchRange);
    return snappedSample / sampleRate;
  }, [audioBuffer]);

  // Cache stereo analysis independently of pointer movement and knob changes.
  const [silenceBusy, setSilenceBusy] = useState(false);
  const [silenceLevels, setSilenceLevels] = useState<ReturnType<typeof analyzeSilenceLevels>>([]);
  useEffect(() => {
    const controller = new AbortController();
    setSilenceLevels([]);
    setSilenceBusy(!!audioBuffer);
    if (!audioBuffer) return;
    analyzeSilenceLevelsChunked(audioBuffer, controller.signal, cropStart, autoSplitEnd).then(levels => {
      if (!controller.signal.aborted) { setSilenceLevels(levels); setSilenceBusy(false); }
    }).catch(() => {
      if (!controller.signal.aborted) {
        setAnalysisError('Unable to analyse audio. Try importing the file again.');
        setSilenceBusy(false);
        setAnalysisBusy(false);
        onAnalysisBusyChange?.(false);
      }
    });
    return () => controller.abort();
  }, [audioBuffer, cropStart, autoSplitEnd]);
  const gapCandidates = useMemo(() => findSilenceRegions(silenceLevels, noiseFloorDb, silenceDurationSec)
    .map(region => region.candidate), [silenceLevels, noiseFloorDb, silenceDurationSec]);
  const snapTimeToNoiseFloor = useCallback((time: number): number =>
    snapToSilenceCandidate(time, gapCandidates, snapAmountSec), [gapCandidates, snapAmountSec]);

  const snapEditTime = useCallback((time: number) => {
    let snapped = snapTimeToNoiseFloor(time);
    if (fadeSettings.zeroCrossing) snapped = snapToZeroCrossing(snapped);
    return snapped;
  }, [fadeSettings.zeroCrossing, snapTimeToNoiseFloor, snapToZeroCrossing]);

  // Render Loop: Waveform drawing
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const { width, height } = canvasDimensions;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, width, height);

    // Grid Lines
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    const gridDivs = 8;
    for (let i = 1; i < gridDivs; i++) {
      const gx = (i / gridDivs) * width;
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, height);
      ctx.stroke();
    }

    // Center divider between stereo lanes (also the zero line for mono audio)
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    if (!audioBuffer) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '600 14px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No audio loaded', width / 2, height / 2);
      return;
    }

    // Plot waveform
    const channels = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    const startSample = Math.round(currentOffset * audioBuffer.sampleRate);
    const endSample = Math.round((currentOffset + visibleDuration) * audioBuffer.sampleRate);
    const sampleCount = endSample - startSample;
    const displayMaxAmplitude = 2 / verticalZoom;

    for (let c = 0; c < channels; c++) {
      const channelHeight = height / channels;
      const centerY = channelHeight * c + channelHeight / 2;
      const amplitudeScale = channelHeight * 0.45 / displayMaxAmplitude;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, c * channelHeight, width, channelHeight);
      ctx.clip();

      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, centerY);
      ctx.lineTo(width, centerY);
      ctx.stroke();

      for (const dbfs of [0, -6, -12, -18]) {
        const offset = Math.pow(10, dbfs / 20) * amplitudeScale;
        ctx.strokeStyle = dbfs === 0 ? 'rgba(245, 158, 11, 0.45)' : 'rgba(148, 163, 184, 0.2)';
        ctx.lineWidth = dbfs === 0 ? 1 : 0.75;
        ctx.setLineDash(dbfs === 0 ? [3, 3] : [1, 4]);

        for (const polarity of [-1, 1]) {
          const guideY = centerY + polarity * offset;
          ctx.beginPath();
          ctx.moveTo(0, guideY);
          ctx.lineTo(width, guideY);
          ctx.stroke();

        }
      }
      ctx.setLineDash([]);
      ctx.restore();
    }

    const pyramid = pyramidRef.current;
    if (pyramid && pyramid[0]) {
      ctx.lineWidth = 1;

      for (let c = 0; c < channels; c++) {
        const channelHeight = height / channels;
        const centerY = channelHeight * c + channelHeight / 2;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, c * channelHeight, width, channelHeight);
        ctx.clip();
        const dataMins = pyramid[c].levels[0].min;
        const dataMaxs = pyramid[c].levels[0].max;
        const blockSize = pyramid[c].levels[0].blockSize;

        // Determine which level of peak pyramid to draw for lag-free resolution
        let levelIdx = 0;
        const samplesPerPixel = sampleCount / width;
        if (samplesPerPixel > 2048) levelIdx = 3;
        else if (samplesPerPixel > 512) levelIdx = 2;
        else if (samplesPerPixel > 128) levelIdx = 1;

        const activeLevel = pyramid[c].levels[levelIdx];
        const lvlBlockSize = activeLevel.blockSize;
        const mins = activeLevel.min;
        const maxs = activeLevel.max;

        const waveformPath = new Path2D();
        const fullScalePath = new Path2D();
        for (let x = 0; x < width; x++) {
          const t = xToTime(x, width);
          const sIdx = Math.round(t * audioBuffer.sampleRate);
          const bIdx = Math.floor(sIdx / lvlBlockSize);

          if (sIdx < analyzedSamples && bIdx >= 0 && bIdx < mins.length) {
            const minVal = mins[bIdx];
            const maxVal = maxs[bIdx];

            // Dynamic volume gain representation based on fade curves & crop bounds
            let fadeGain = 1.0;
            if (t < cropStart || t > cropEnd) {
              fadeGain = 0;
            } else {
              if (fadeSettings.fadeInEnabled && fadeSettings.fadeInMs > 0) {
                const fadeInSec = fadeSettings.fadeInMs / 1000;
                if (t < cropStart + fadeInSec) {
                  const pct = Math.max(0, Math.min(1, (t - cropStart) / fadeInSec));
                  fadeGain *= calculateFadeGain(pct, fadeSettings.fadeInCurve, fadeSettings.fadeInCurveNode, fadeSettings.fadeInCurveNodePosition);
                }
              }
              if (fadeSettings.fadeOutEnabled && fadeSettings.fadeOutMs > 0) {
                const fadeOutSec = fadeSettings.fadeOutMs / 1000;
                if (t > cropEnd - fadeOutSec) {
                  const pct = Math.max(0, Math.min(1, (cropEnd - t) / fadeOutSec));
                  fadeGain *= calculateFadeGain(pct, fadeSettings.fadeOutCurve, fadeSettings.fadeOutCurveNode, fadeSettings.fadeOutCurveNodePosition);
                }
              }
            }

            const minAmplitude = Math.max(-displayMaxAmplitude, Math.min(displayMaxAmplitude, minVal * fadeGain));
            const maxAmplitude = Math.max(-displayMaxAmplitude, Math.min(displayMaxAmplitude, maxVal * fadeGain));
            const amplitudeScale = channelHeight * 0.45 / displayMaxAmplitude;
            const yMin = centerY + minAmplitude * amplitudeScale;
            const yMax = centerY + maxAmplitude * amplitudeScale;
            const path = minVal <= -1 || maxVal >= 1 ? fullScalePath : waveformPath;

            path.moveTo(x, yMin);
            path.lineTo(x, yMax);
          }
        }
        ctx.strokeStyle = '#059669';
        ctx.stroke(waveformPath);
        ctx.strokeStyle = '#f87171';
        ctx.stroke(fullScalePath);
        ctx.restore();
      }
    }

    if (width > 120) {
      ctx.font = '8px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      for (let c = 0; c < channels; c++) {
        const channelHeight = height / channels;
        const centerY = channelHeight * c + channelHeight / 2;
        const channelTop = c * channelHeight;
        const zeroDbY = Math.max(channelTop + 10, centerY - channelHeight * 0.45 / displayMaxAmplitude);
        const labelX = Math.floor(width * 0.6);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, channelTop, width, channelHeight);
        ctx.clip();
        ctx.fillStyle = 'rgba(2, 6, 23, 0.85)';
        ctx.fillRect(labelX, zeroDbY - 10, 42, 10);
        ctx.fillStyle = '#fbbf24';
        ctx.fillText('0 dBFS', labelX + 2, zeroDbY - 1);
        ctx.restore();
      }
    }
  }, [canvasDimensions, currentOffset, visibleDuration, audioBuffer, xToTime, fadeSettings, cropStart, cropEnd, verticalZoom, analyzedSamples]);

  // Overlay Drawing: Markers, Fades, Crop braces, Selection bounds
  const drawOverlay = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const { width, height } = canvasDimensions;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    if (!audioBuffer) return;

    // 1. Draw Crop Boundaries
    ctx.fillStyle = 'rgba(2, 6, 23, 0.6)';
    const cropXStart = timeToX(cropStart, width);
    const cropXEnd = timeToX(cropEnd, width);

    if (cropXStart > 0) {
      ctx.fillRect(0, 0, cropXStart, height);
    }
    if (cropXEnd < width) {
      ctx.fillRect(cropXEnd, 0, width - cropXEnd, height);
    }

    // Crop Boundary Fine Lines
    ctx.strokeStyle = '#ef4444'; // Red-500
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    if (cropXStart >= 0 && cropXStart <= width) {
      ctx.beginPath(); ctx.moveTo(cropXStart, 0); ctx.lineTo(cropXStart, height); ctx.stroke();
    }
    if (cropXEnd >= 0 && cropXEnd <= width) {
      ctx.beginPath(); ctx.moveTo(cropXEnd, 0); ctx.lineTo(cropXEnd, height); ctx.stroke();
    }
    ctx.setLineDash([]);

    // 2. Selection Area Brace
    if (selection) {
      const selXStart = timeToX(selection.start, width);
      const selXEnd = timeToX(selection.end, width);
      const sx = Math.min(selXStart, selXEnd);
      const sw = Math.abs(selXEnd - selXStart);

      ctx.fillStyle = 'rgba(14, 165, 233, 0.15)'; // Sky selection
      ctx.fillRect(sx, 0, sw, height);

      // Selection edges
      ctx.strokeStyle = '#38bdf8'; // Sky-400
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(selXStart, 0); ctx.lineTo(selXStart, height);
      ctx.moveTo(selXEnd, 0); ctx.lineTo(selXEnd, height);
      ctx.stroke();

      // Draggable Bracket Ends [ ]
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(selXStart - 5, height / 2 - 12, 5, 24);
      ctx.fillRect(selXEnd, height / 2 - 12, 5, 24);
    }

    // 3. Draggable Volume Fade Envelopes (Visual overlays)
    if (fadeSettings.fadeInEnabled && cropXStart >= 0 && cropXStart <= width) {
      const fadeMs = fadeSettings.fadeInMs;
      const fadeSec = fadeMs / 1000;
      const fadeEndX = timeToX(cropStart + fadeSec, width);

      // Subtle gradient shading under fade curve
      if (fadeEndX > cropXStart + 2) {
        const grad = ctx.createLinearGradient(cropXStart, 0, fadeEndX, 0);
        grad.addColorStop(0, 'rgba(56, 189, 248, 0.04)');
        grad.addColorStop(1, 'rgba(56, 189, 248, 0.16)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(cropXStart, height);
        const fStep = Math.max(1, Math.round((fadeEndX - cropXStart) / 30));
        for (let px = cropXStart; px <= fadeEndX; px += fStep) {
          const pct = (px - cropXStart) / (fadeEndX - cropXStart);
          const gain = calculateFadeGain(pct, fadeSettings.fadeInCurve, fadeSettings.fadeInCurveNode, fadeSettings.fadeInCurveNodePosition);
          ctx.lineTo(px, height - gain * height);
        }
        ctx.lineTo(fadeEndX, height);
        ctx.closePath();
        ctx.fill();
      }

      // Curve line
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cropXStart, height);
      const fStep = Math.max(1, Math.round((fadeEndX - cropXStart) / 30));
      for (let px = cropXStart; px <= fadeEndX; px += fStep) {
        const pct = (px - cropXStart) / (fadeEndX - cropXStart);
        const gain = calculateFadeGain(pct, fadeSettings.fadeInCurve, fadeSettings.fadeInCurveNode, fadeSettings.fadeInCurveNodePosition);
        ctx.lineTo(px, height - gain * height);
      }
      ctx.lineTo(fadeEndX, 0);
      ctx.stroke();

      // Dashed vertical guide line down to waveform bottom
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(fadeEndX, 12);
      ctx.lineTo(fadeEndX, height);
      ctx.stroke();
      ctx.setLineDash([]);

      // Draggable fade node
      const isHovered = hoveredElement === 'fadeIn' || activeDrag?.type === 'fadeIn';
      ctx.fillStyle = isHovered ? '#38bdf8' : '#0284c7';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(fadeEndX, 10, isHovered ? 6 : 4.5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();

      const curveNodeX = cropXStart + (fadeEndX - cropXStart) * fadeSettings.fadeInCurveNodePosition;
      const curveNodeY = height - fadeSettings.fadeInCurveNode * height;
      ctx.fillStyle = activeDrag?.type === 'fadeInCurve' ? '#ffffff' : '#38bdf8';
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(curveNodeX, curveNodeY, activeDrag?.type === 'fadeInCurve' ? 7 : 5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();

      // Tooltip/badge while hovering or dragging
      if (isHovered && fadeEndX >= 0 && fadeEndX <= width) {
        const labelText = `Fade In: ${(fadeMs / 1000).toFixed(2)}s`;
        ctx.font = '10px ui-monospace, monospace';
        const txtWidth = ctx.measureText(labelText).width;
        ctx.fillStyle = 'rgba(2, 6, 23, 0.9)';
        ctx.fillRect(fadeEndX + 8, 4, txtWidth + 8, 16);
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1;
        ctx.strokeRect(fadeEndX + 8, 4, txtWidth + 8, 16);
        ctx.fillStyle = '#38bdf8';
        ctx.fillText(labelText, fadeEndX + 12, 16);
      }
    }

    if (fadeSettings.fadeOutEnabled && cropXEnd >= 0 && cropXEnd <= width) {
      const fadeMs = fadeSettings.fadeOutMs;
      const fadeSec = fadeMs / 1000;
      const fadeStartX = timeToX(cropEnd - fadeSec, width);

      // Subtle gradient shading under fade out curve
      if (cropXEnd > fadeStartX + 2) {
        const grad = ctx.createLinearGradient(fadeStartX, 0, cropXEnd, 0);
        grad.addColorStop(0, 'rgba(245, 158, 11, 0.16)');
        grad.addColorStop(1, 'rgba(245, 158, 11, 0.04)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(fadeStartX, 0);
        const fStep = Math.max(1, Math.round((cropXEnd - fadeStartX) / 30));
        for (let px = fadeStartX; px <= cropXEnd; px += fStep) {
          const pct = (px - fadeStartX) / (cropXEnd - fadeStartX);
          const gain = calculateFadeGain(1 - pct, fadeSettings.fadeOutCurve, fadeSettings.fadeOutCurveNode, fadeSettings.fadeOutCurveNodePosition);
          ctx.lineTo(px, height - gain * height);
        }
        ctx.lineTo(cropXEnd, height);
        ctx.lineTo(fadeStartX, height);
        ctx.closePath();
        ctx.fill();
      }

      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(fadeStartX, 0);
      const fStep = Math.max(1, Math.round((cropXEnd - fadeStartX) / 30));
      for (let px = fadeStartX; px <= cropXEnd; px += fStep) {
        const pct = (px - fadeStartX) / (cropXEnd - fadeStartX);
          const gain = calculateFadeGain(1 - pct, fadeSettings.fadeOutCurve, fadeSettings.fadeOutCurveNode, fadeSettings.fadeOutCurveNodePosition);
        ctx.lineTo(px, height - gain * height);
      }
      ctx.lineTo(cropXEnd, height);
      ctx.stroke();

      // Dashed vertical guide line down to waveform bottom
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(fadeStartX, 12);
      ctx.lineTo(fadeStartX, height);
      ctx.stroke();
      ctx.setLineDash([]);

      // Draggable fade node
      const isHovered = hoveredElement === 'fadeOut' || activeDrag?.type === 'fadeOut';
      ctx.fillStyle = isHovered ? '#f59e0b' : '#d97706';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(fadeStartX, 10, isHovered ? 6 : 4.5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();

      const curveNodeX = fadeStartX + (cropXEnd - fadeStartX) * (1 - fadeSettings.fadeOutCurveNodePosition);
      const curveNodeY = height - fadeSettings.fadeOutCurveNode * height;
      ctx.fillStyle = activeDrag?.type === 'fadeOutCurve' ? '#ffffff' : '#f59e0b';
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(curveNodeX, curveNodeY, activeDrag?.type === 'fadeOutCurve' ? 7 : 5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();

      // Tooltip/badge while hovering or dragging
      if (isHovered && fadeStartX >= 0 && fadeStartX <= width) {
        const labelText = `Fade Out: ${(fadeMs / 1000).toFixed(2)}s`;
        ctx.font = '10px ui-monospace, monospace';
        const txtWidth = ctx.measureText(labelText).width;
        ctx.fillStyle = 'rgba(2, 6, 23, 0.9)';
        ctx.fillRect(fadeStartX - txtWidth - 16, 4, txtWidth + 8, 16);
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 1;
        ctx.strokeRect(fadeStartX - txtWidth - 16, 4, txtWidth + 8, 16);
        ctx.fillStyle = '#f59e0b';
        ctx.fillText(labelText, fadeStartX - txtWidth - 12, 16);
      }
    }

    // Predicted boundaries are visual guides only; actual markers stay in front.
    if (processingOpen && previewTimes) {
      ctx.save();
      ctx.strokeStyle = '#fbbf24';
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 1;
      for (const time of previewTimes) {
        if (time <= cropStart + 0.01 || time >= autoSplitEnd - 0.01) continue;
        const x = timeToX(time, width);
        if (x < 0 || x > width) continue;

        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(x, 10);
        ctx.lineTo(x, height);
        ctx.stroke();

        // Hollow diamond distinguishes a prediction from a filled marker flag.
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x, 1);
        ctx.lineTo(x + 4, 5);
        ctx.lineTo(x, 9);
        ctx.lineTo(x - 4, 5);
        ctx.closePath();
        ctx.stroke();
      }
      ctx.restore();
    }

    // 4. Split Markers
    markers.forEach((m) => {
      const mx = timeToX(m.time, width);
      if (mx < 0 || mx > width) return;

      const isHovered = hoveredMarkerId === m.id;
      const isTargetedForRemoval = processingOpen && hoveredMarkerId === m.id;

      ctx.strokeStyle = isTargetedForRemoval ? '#f43f5e' : isHovered ? '#c084fc' : '#a855f7';
      ctx.lineWidth = isTargetedForRemoval ? 3 : isHovered ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.moveTo(mx, 0);
      ctx.lineTo(mx, height);
      ctx.stroke();

      // Flag top tag
      ctx.fillStyle = isTargetedForRemoval ? '#f43f5e' : isHovered ? '#c084fc' : '#a855f7';
      ctx.beginPath();
      ctx.moveTo(mx - 5, 0);
      ctx.lineTo(mx + 5, 0);
      ctx.lineTo(mx, 8);
      ctx.closePath();
      ctx.fill();

      // If targeted for removal, draw a crisp "-" symbol at top
      if (isTargetedForRemoval) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(mx - 3, 3, 6, 2);
      }
    });

    // 5. Draw Playhead marker
    const px = timeToX(currentTime, width);
    if (px >= 0 && px <= width) {
      ctx.strokeStyle = '#38bdf8'; // Cyan-400
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, height);
      ctx.stroke();

      // Arrow head at top
      ctx.fillStyle = '#38bdf8';
      ctx.beginPath();
      ctx.moveTo(px - 6, 0);
      ctx.lineTo(px + 6, 0);
      ctx.lineTo(px, 7);
      ctx.closePath();
      ctx.fill();
    }

    // 6. Hover guide
    if (hoverPosition && hoverTime !== null) {
      const hx = hoverPosition.x;
      const snappedHoverTime = processingOpen ? snapTimeToNoiseFloor(hoverTime) : snapEditTime(hoverTime);
      const snappedX = timeToX(snappedHoverTime, width);
      if (snapAmountSec > 0 && Math.abs(snappedX - hx) > 2 && snappedX >= 0 && snappedX <= width) {
        ctx.strokeStyle = '#67e8f9';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(snappedX, 0);
        ctx.lineTo(snappedX, height);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#67e8f9';
        ctx.beginPath();
        ctx.arc(snappedX, 9, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      if (processingOpen) {
        // Show purple preview line with top flag where marker will land
        ctx.strokeStyle = '#a855f7';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(hx, 0);
        ctx.lineTo(hx, height);
        ctx.stroke();

        ctx.fillStyle = '#a855f7';
        ctx.beginPath();
        ctx.moveTo(hx - 5, 0);
        ctx.lineTo(hx + 5, 0);
        ctx.lineTo(hx, 8);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.lineWidth = 0.75;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(hx, 0);
        ctx.lineTo(hx, height);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // 7. Radar-style ping when the cursor crosses onto a detected noise-floor snap point
    if (snapPingRef.current) {
      const PING_DURATION_MS = 550;
      const elapsed = performance.now() - snapPingRef.current.start;
      const t = Math.min(1, elapsed / PING_DURATION_MS);
      const pingX = snapPingRef.current.x;
      ctx.save();
      ctx.strokeStyle = `rgba(103, 232, 249, ${(1 - t) * 0.9})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pingX, 9, 4 + t * 22, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = `rgba(103, 232, 249, ${(1 - t) * 0.5})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(pingX, 9, 4 + t * 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }, [canvasDimensions, cropStart, cropEnd, selection, markers, currentTime, hoverPosition, hoverTime, hoveredMarkerId, fadeSettings, timeToX, snapEditTime, snapTimeToNoiseFloor, snapAmountSec, audioBuffer, processingOpen, previewTimes, autoSplitEnd]);

  // Trigger the overlay redraw whenever any of its inputs change
  useEffect(() => {
    drawOverlay();
  }, [drawOverlay]);

  // Runs a short requestAnimationFrame loop to animate the radar ping independently of React state
  const startSnapPing = useCallback((x: number) => {
    snapPingRef.current = { x, start: performance.now() };
    if (pingRafRef.current !== null) cancelAnimationFrame(pingRafRef.current);
    const PING_DURATION_MS = 550;
    const step = () => {
      if (!snapPingRef.current) return;
      drawOverlay();
      if (performance.now() - snapPingRef.current.start < PING_DURATION_MS) {
        pingRafRef.current = requestAnimationFrame(step);
      } else {
        snapPingRef.current = null;
        pingRafRef.current = null;
        drawOverlay();
      }
    };
    pingRafRef.current = requestAnimationFrame(step);
  }, [drawOverlay]);

  useEffect(() => {
    return () => {
      if (pingRafRef.current !== null) cancelAnimationFrame(pingRafRef.current);
    };
  }, []);

  // Minimap rendering
  useEffect(() => {
    const mini = minimapRef.current;
    if (!mini) return;
    const ctx = mini.getContext('2d');
    if (!ctx) return;

    const width = mini.width;
    const height = mini.height;

    // Background
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, width, height);

    if (!audioBuffer) {
      ctx.fillStyle = '#64748b';
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No audio loaded', width / 2, height / 2);
      return;
    }

    // Plot full-length mini waveform
    ctx.fillStyle = '#10b981';
    const level = pyramidRef.current?.[0]?.levels.at(-1);
    if (!level) return;
    const step = Math.ceil(level.min.length / width);
    for (let x = 0; x < width; x++) {
      const start = x * step;
      const end = Math.min(Math.ceil(analyzedSamples / level.blockSize), start + step);
      if (start >= end) continue;
      let min = 1.0;
      let max = -1.0;
      for (let i = start; i < end; i++) {
        min = Math.min(min, level.min[i]);
        max = Math.max(max, level.max[i]);
      }
      const t = (x / width) * duration;
      let fadeGain = 1.0;
      if (t < cropStart || t > cropEnd) {
        fadeGain = 0;
      } else {
        if (fadeSettings.fadeInEnabled && fadeSettings.fadeInMs > 0) {
          const fadeInSec = fadeSettings.fadeInMs / 1000;
          if (t < cropStart + fadeInSec) {
            const pct = Math.max(0, Math.min(1, (t - cropStart) / fadeInSec));
            fadeGain *= calculateFadeGain(pct, fadeSettings.fadeInCurve, fadeSettings.fadeInCurveNode, fadeSettings.fadeInCurveNodePosition);
          }
        }
        if (fadeSettings.fadeOutEnabled && fadeSettings.fadeOutMs > 0) {
          const fadeOutSec = fadeSettings.fadeOutMs / 1000;
          if (t > cropEnd - fadeOutSec) {
            const pct = Math.max(0, Math.min(1, (cropEnd - t) / fadeOutSec));
            fadeGain *= calculateFadeGain(pct, fadeSettings.fadeOutCurve, fadeSettings.fadeOutCurveNode, fadeSettings.fadeOutCurveNodePosition);
          }
        }
      }
      const yMin = (0.5 - min * fadeGain * 0.8) * height;
      const yMax = (0.5 - max * fadeGain * 0.8) * height;
      ctx.fillRect(x, yMin, 1.2, Math.max(1, yMax - yMin));
    }

    // Viewport window
    const viewWidthPct = visibleDuration / duration;
    const viewOffsetPct = currentOffset / duration;

    const vx = Math.max(0, viewOffsetPct * width);
    const vw = Math.max(8, Math.min(width - vx, viewWidthPct * width));
    const rightEdge = Math.min(width, vx + vw);

    // Viewport fill & outline
    ctx.fillStyle = minimapDrag ? 'rgba(56, 189, 248, 0.2)' : 'rgba(56, 189, 248, 0.08)';
    ctx.fillRect(vx, 0, vw, height);
    ctx.strokeStyle = minimapDrag ? '#38bdf8' : '#0284c7';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(vx, 0, vw, height);

    // Left and right resize edge handles / visual grips
    const handleW = 10;
    const rightHandleX = Math.max(vx, rightEdge - handleW - 2);
    // Left handle
    ctx.fillStyle = minimapHover === 'left' || minimapDrag?.mode === 'resizeLeft' ? '#38bdf8' : '#0369a1';
    ctx.fillRect(vx, 0, handleW, height);
    // Right handle
    ctx.fillStyle = minimapHover === 'right' || minimapDrag?.mode === 'resizeRight' ? '#38bdf8' : '#0369a1';
    ctx.fillRect(rightHandleX, 0, handleW, height);

    // Inner subtle vertical grip tick marks on edges if viewport is wide enough
    if (vw >= 16) {
      ctx.fillStyle = '#ffffff';
      // Left grip dots
      ctx.fillRect(vx + 1.5, height / 2 - 4, 1, 3);
      ctx.fillRect(vx + 1.5, height / 2 + 1, 1, 3);
      // Right grip dots
      ctx.fillRect(rightHandleX + handleW - 3, height / 2 - 4, 1, 3);
      ctx.fillRect(rightHandleX + handleW - 3, height / 2 + 1, 1, 3);
    }
  }, [audioBuffer, zoom, currentOffset, visibleDuration, duration, fadeSettings, cropStart, cropEnd, minimapDrag, minimapHover, analyzedSamples]);

  useEffect(() => {
    if (!audioBuffer || analyzedSamples !== audioBuffer.length || !analysisBusy || silenceBusy || importStatus) return;
    const frame = requestAnimationFrame(() => {
      setAnalysisBusy(false);
      onAnalysisBusyChange?.(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [audioBuffer, analyzedSamples, analysisBusy, silenceBusy, importStatus, onAnalysisBusyChange]);

  // Pointer move handler (computes hover hit tests)
  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const time = xToTime(x, canvasDimensions.width);
    setHoverTime(time);
    setHoverPosition({ x, y });

    // Radar ping: fire the moment the cursor crosses onto a detected noise-floor snap point
    if (snapAmountSec > 0 && audioBuffer) {
      const snappedX = timeToX(snapTimeToNoiseFloor(time), canvasDimensions.width);
      const isOverSnapPoint = gapCandidates.some(candidate => Math.abs(candidate - time) <= snapAmountSec) && Math.abs(snappedX - x) <= 2;
      if (isOverSnapPoint && !wasOverSnapPointRef.current) {
        startSnapPing(snappedX);
      }
      wasOverSnapPointRef.current = isOverSnapPoint;
    } else {
      wasOverSnapPointRef.current = false;
    }

    // Dragging active element logic
    if (activeDrag) {
      if (activeDrag.type === 'playhead') {
        let nextTime = Math.max(cropStart, Math.min(cropEnd, time));
        nextTime = snapEditTime(nextTime);
        onSeek(nextTime);
      } else if (activeDrag.type === 'marker' && activeDrag.id) {
        let nextTime = Math.max(cropStart, Math.min(autoSplitEnd, time));
        nextTime = snapTimeToNoiseFloor(nextTime);
        if (!markerMoveStartedRef.current && markers.some(marker => marker.id === activeDrag.id && marker.time !== nextTime)) {
          onMarkerMoveStart?.();
          markerMoveStartedRef.current = true;
        }
        onMarkerMove(activeDrag.id, nextTime);
      } else if (activeDrag.type === 'fadeIn') {
        const nextMs = Math.max(0, Math.round((time - cropStart) * 1000));
        onFadeSettingsChange({ ...fadeSettings, fadeInMs: nextMs });
      } else if (activeDrag.type === 'fadeOut') {
        const nextMs = Math.max(0, Math.round((cropEnd - time) * 1000));
        onFadeSettingsChange({ ...fadeSettings, fadeOutMs: nextMs });
      } else if (activeDrag.type === 'fadeInCurve') {
        const fadeEndX = timeToX(cropStart + fadeSettings.fadeInMs / 1000, canvasDimensions.width);
        const nextPosition = Math.max(0.05, Math.min(0.95, (x - timeToX(cropStart, canvasDimensions.width)) / (fadeEndX - timeToX(cropStart, canvasDimensions.width))));
        const nextNode = Math.max(0.05, Math.min(0.95, 1 - y / canvasDimensions.height));
        onFadeSettingsChange({ ...fadeSettings, fadeInCurveNode: nextNode, fadeInCurveNodePosition: nextPosition });
      } else if (activeDrag.type === 'fadeOutCurve') {
        const fadeStartX = timeToX(cropEnd - fadeSettings.fadeOutMs / 1000, canvasDimensions.width);
        const nextPosition = Math.max(0.05, Math.min(0.95, 1 - (x - fadeStartX) / (timeToX(cropEnd, canvasDimensions.width) - fadeStartX)));
        const nextNode = Math.max(0.05, Math.min(0.95, 1 - y / canvasDimensions.height));
        onFadeSettingsChange({ ...fadeSettings, fadeOutCurveNode: nextNode, fadeOutCurveNodePosition: nextPosition });
      } else if (activeDrag.type === 'selectionStart' && selection) {
        onSelectionChange({ ...selection, start: Math.max(0, Math.min(duration, snapEditTime(time))) });
      } else if (activeDrag.type === 'selectionEnd' && selection) {
        onSelectionChange({ ...selection, end: Math.max(0, Math.min(duration, snapEditTime(time))) });
      } else if (activeDrag.type === 'selectionMove' && selection && activeDrag.startTime !== undefined && activeDrag.startX !== undefined) {
        const dt = time - activeDrag.startTime;
        const curS = selection.start;
        const curE = selection.end;
        const span = curE - curS;

        let nextS = activeDrag.startX + dt;
        let nextE = nextS + span;

        if (nextS < 0) {
          nextS = 0; nextE = span;
        }
        if (nextE > duration) {
          nextE = duration; nextS = duration - span;
        }

        onSelectionChange({ start: nextS, end: nextE });
      } else if (activeDrag.type === 'selectionCreate' && activeDrag.startTime !== undefined) {
        if (activeDrag.startX !== undefined && Math.abs(x - activeDrag.startX) > 4) {
          const snappedTime = snapEditTime(time);
          const s = Math.min(activeDrag.startTime, snappedTime);
          const e = Math.max(activeDrag.startTime, snappedTime);
          onSelectionChange?.({ start: s, end: e });
        }
      }
      return;
    }

    // Hover detection when dragging is NOT active
    setHoveredElement(null);
    setHoveredMarkerId(null);

    // 1. Check Fade In handle
    if (fadeSettings.fadeInEnabled) {
      const cropXStart = timeToX(cropStart, canvasDimensions.width);
      const fEndX = timeToX(cropStart + fadeSettings.fadeInMs / 1000, canvasDimensions.width);
      const curveX = cropXStart + (fEndX - cropXStart) * fadeSettings.fadeInCurveNodePosition;
      const curveY = canvasDimensions.height - fadeSettings.fadeInCurveNode * canvasDimensions.height;
      if (Math.hypot(x - curveX, y - curveY) < 12) {
        setHoveredElement('fadeIn');
        return;
      }
      if ((Math.abs(x - fEndX) < 10 || (Math.abs(x - cropXStart) < 12 && fadeSettings.fadeInMs <= 50)) && y < 28) {
        setHoveredElement('fadeIn');
        return;
      }
    }

    // 2. Check Fade Out handle
    if (fadeSettings.fadeOutEnabled) {
      const cropXEnd = timeToX(cropEnd, canvasDimensions.width);
      const fStartX = timeToX(cropEnd - fadeSettings.fadeOutMs / 1000, canvasDimensions.width);
      const curveX = fStartX + (cropXEnd - fStartX) * (1 - fadeSettings.fadeOutCurveNodePosition);
      const curveY = canvasDimensions.height - fadeSettings.fadeOutCurveNode * canvasDimensions.height;
      if (Math.hypot(x - curveX, y - curveY) < 12) {
        setHoveredElement('fadeOut');
        return;
      }
      if ((Math.abs(x - fStartX) < 10 || (Math.abs(x - cropXEnd) < 12 && fadeSettings.fadeOutMs <= 50)) && y < 28) {
        setHoveredElement('fadeOut');
        return;
      }
    }

    // 3. Check selection brackets
    if (selection) {
      const selS_X = timeToX(selection.start, canvasDimensions.width);
      const selE_X = timeToX(selection.end, canvasDimensions.width);

      if (Math.abs(x - selS_X) < 7 && Math.abs(y - canvasDimensions.height / 2) < 20) {
        setHoveredElement('selectionStart');
        return;
      }
      if (Math.abs(x - selE_X) < 7 && Math.abs(y - canvasDimensions.height / 2) < 20) {
        setHoveredElement('selectionEnd');
        return;
      }
      const sx = Math.min(selS_X, selE_X);
      const ex = Math.max(selS_X, selE_X);
      if (x > sx && x < ex && y < 30) {
        setHoveredElement('selectionBar');
        return;
      }
    }

    // 4. Check split markers
    for (const m of markers) {
      const mx = timeToX(m.time, canvasDimensions.width);
      if (Math.abs(x - mx) < 5) {
        setHoveredElement('marker');
        setHoveredMarkerId(m.id);
        return;
      }
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return; // left click only
    const canvas = canvasRef.current;
    if (!canvas) return;

    markerMoveStartedRef.current = false;
    canvas.setPointerCapture(e.pointerId);

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const time = xToTime(x, canvasDimensions.width);

    pointerDownPositionRef.current = { x, y };

    if (fadeSettings.fadeInEnabled) {
      const cropXStart = timeToX(cropStart, canvasDimensions.width);
      const fadeEndX = timeToX(cropStart + fadeSettings.fadeInMs / 1000, canvasDimensions.width);
      const curveX = cropXStart + (fadeEndX - cropXStart) * fadeSettings.fadeInCurveNodePosition;
      const curveY = canvasDimensions.height - fadeSettings.fadeInCurveNode * canvasDimensions.height;
      if (Math.hypot(x - curveX, y - curveY) < 14) {
        setActiveDrag({ type: 'fadeInCurve' });
        return;
      }
    }

    if (fadeSettings.fadeOutEnabled) {
      const fadeStartX = timeToX(cropEnd - fadeSettings.fadeOutMs / 1000, canvasDimensions.width);
      const cropXEnd = timeToX(cropEnd, canvasDimensions.width);
      const curveX = fadeStartX + (cropXEnd - fadeStartX) * (1 - fadeSettings.fadeOutCurveNodePosition);
      const curveY = canvasDimensions.height - fadeSettings.fadeOutCurveNode * canvasDimensions.height;
      if (Math.hypot(x - curveX, y - curveY) < 14) {
        setActiveDrag({ type: 'fadeOutCurve' });
        return;
      }
    }

    // Hit actions
    if (
      hoveredElement === 'fadeIn' ||
      (fadeSettings.fadeInEnabled &&
        (Math.abs(x - timeToX(cropStart + fadeSettings.fadeInMs / 1000, canvasDimensions.width)) < 12 ||
          (Math.abs(x - timeToX(cropStart, canvasDimensions.width)) < 12 && fadeSettings.fadeInMs <= 50)) &&
        y < 28)
    ) {
      setActiveDrag({ type: 'fadeIn' });
      return;
    } else if (
      hoveredElement === 'fadeOut' ||
      (fadeSettings.fadeOutEnabled &&
        (Math.abs(x - timeToX(cropEnd - fadeSettings.fadeOutMs / 1000, canvasDimensions.width)) < 12 ||
          (Math.abs(x - timeToX(cropEnd, canvasDimensions.width)) < 12 && fadeSettings.fadeOutMs <= 50)) &&
        y < 28)
    ) {
      setActiveDrag({ type: 'fadeOut' });
      return;
    } else if (hoveredElement === 'selectionStart') {
      setActiveDrag({ type: 'selectionStart' });
    } else if (hoveredElement === 'selectionEnd') {
      setActiveDrag({ type: 'selectionEnd' });
    } else if (hoveredElement === 'selectionBar' && selection) {
      setActiveDrag({ type: 'selectionMove', startTime: time, startX: selection.start });
    } else if (hoveredElement === 'marker' && hoveredMarkerId) {
      setActiveDrag({ type: 'marker', id: hoveredMarkerId });
    } else {
      // Smart tool: Record drag start point; don't trigger playback until pointer release
      setActiveDrag({ type: 'selectionCreate', startTime: snapEditTime(time), startX: x });
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (canvas) {
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {}
    }

    const rect = canvas?.getBoundingClientRect();
    const downPosition = pointerDownPositionRef.current;
    pointerDownPositionRef.current = null;
    if (e.type === 'pointercancel') {
      setActiveDrag(null);
      return;
    }
    const moved = !!rect && !!downPosition && Math.hypot(
      e.clientX - rect.left - downPosition.x,
      e.clientY - rect.top - downPosition.y
    ) > 5;

    if (activeDrag?.type === 'selectionCreate' && activeDrag.startTime !== undefined) {
      const rect = canvas?.getBoundingClientRect();
      const x = rect ? e.clientX - rect.left : (activeDrag.startX ?? 0);
      const pixelDiff = Math.abs(x - (activeDrag.startX ?? 0));
      const endTime = xToTime(x, canvasDimensions.width);
      const timeDiff = Math.abs(endTime - activeDrag.startTime);

      if (pixelDiff <= 5 || timeDiff < 0.05) {
        // Clear the brace and seek/audition in one action, without a click delay.
        onWaveformClick(activeDrag.startTime);
      } else {
        // Drag selection complete!
        const selStart = Math.min(activeDrag.startTime, endTime);
        const selEnd = Math.max(activeDrag.startTime, endTime);
        onSelectionChange?.({ start: selStart, end: selEnd });

        // Detection selections are measured directly from the buffer, without auditioning.
        if (!processingOpen && onLoopSelection) {
          onLoopSelection(selStart, selEnd);
        } else if (!processingOpen && onPlaySelection) {
          onPlaySelection(selStart, selEnd);
        }
      }
    } else if (
      (activeDrag?.type === 'selectionStart' || activeDrag?.type === 'selectionEnd' || activeDrag?.type === 'selectionMove') &&
      selection && moved && !processingOpen
    ) {
      if (Math.abs(selection.end - selection.start) > 0.05) {
        const s = Math.min(selection.start, selection.end);
        const e = Math.max(selection.start, selection.end);
        if (onLoopSelection) {
          onLoopSelection(s, e);
        } else if (onPlaySelection) {
          onPlaySelection(s, e);
        }
      }
    }

    setActiveDrag(null);
  };

  const handleWaveformDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!processingOpen || !audioBuffer || e.button !== 0) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    onAddMarker(snapTimeToNoiseFloor(xToTime(e.clientX - rect.left, rect.width)));
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (!processingOpen || !audioBuffer) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const marker = markers.find(marker => Math.abs(timeToX(marker.time, rect.width) - x) <= 6);
    if (marker) {
      onRemoveMarker(marker.id);
      setHoveredMarkerId(null);
      setHoveredElement(null);
    }
  };

  // Zoom handlers
  const handleZoomIn = () => {
    const nextZ = Math.min(40, zoom + 1.5);
    onZoomChange(nextZ);
  };

  const handleZoomOut = () => {
    const nextZ = Math.max(1, zoom - 1.5);
    onZoomChange(nextZ);
    if (nextZ === 1) {
      onViewOffsetChange(0);
    }
  };

  const handleZoomFit = () => {
    onZoomChange(1);
    onViewOffsetChange(0);
  };

  const updateVerticalZoom = (nextZoom: number) => {
    const boundedZoom = Math.max(0.25, Math.min(64, nextZoom));
    verticalZoomRef.current = boundedZoom;
    setVerticalZoom(boundedZoom);
  };

  const handleVerticalZoomOut = () => {
    updateVerticalZoom(verticalZoomRef.current / 1.25);
  };

  const handleVerticalZoomReset = () => {
    updateVerticalZoom(1);
  };

  const handleVerticalZoomIn = () => {
    updateVerticalZoom(verticalZoomRef.current * 1.25);
  };

  const handleZoomCrop = () => {
    if (!audioBuffer || cropEnd - cropStart < 0.1) return;
    const nextZ = duration / (cropEnd - cropStart);
    onZoomChange(nextZ);
    onViewOffsetChange(cropStart);
  };

  // Minimap interactions (edge dragging to zoom in/out, inside dragging to slide, click to jump)
  const handleMinimapPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!audioBuffer) return;
    const mini = minimapRef.current;
    if (!mini) return;
    mini.setPointerCapture(e.pointerId);

    const rect = mini.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const width = rect.width;
    if (width <= 0) return;

    const viewWidthPct = visibleDuration / duration;
    const viewOffsetPct = currentOffset / duration;
    const vx = Math.max(0, viewOffsetPct * width);
    const vw = Math.max(8, Math.min(width - vx, viewWidthPct * width));

    const edgeTolerance = 24;
    const isNearLeft = Math.abs(x - vx) <= edgeTolerance;
    const rightEdge = Math.min(width, vx + vw);
    const isNearRight = x >= width - edgeTolerance || Math.abs(x - rightEdge) <= edgeTolerance;
    const isInside = x >= vx && x <= rightEdge;

    if (isNearLeft) {
      setMinimapDrag({
        mode: 'resizeLeft',
        startX: e.clientX,
        initialOffset: currentOffset,
        initialZoom: zoom,
        initialVisibleDuration: visibleDuration,
      });
    } else if (isNearRight) {
      setMinimapDrag({
        mode: 'resizeRight',
        startX: e.clientX,
        initialOffset: currentOffset,
        initialZoom: zoom,
        initialVisibleDuration: visibleDuration,
      });
    } else if (isInside) {
      setMinimapDrag({
        mode: 'slide',
        startX: e.clientX,
        initialOffset: currentOffset,
        initialZoom: zoom,
        initialVisibleDuration: visibleDuration,
      });
    } else {
      // Clicked outside overview box -> center viewport around clicked position
      const clickPct = Math.max(0, Math.min(1, x / width));
      const targetCenter = clickPct * duration;
      const halfVisible = visibleDuration / 2;
      const nextOffset = Math.max(0, Math.min(maxOffset, targetCenter - halfVisible));
      onViewOffsetChange(nextOffset);
      // Start sliding from this new position
      setMinimapDrag({
        mode: 'slide',
        startX: e.clientX,
        initialOffset: nextOffset,
        initialZoom: zoom,
        initialVisibleDuration: visibleDuration,
      });
    }
  };

  const handleMinimapPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!audioBuffer) return;
    const mini = minimapRef.current;
    if (!mini) return;
    const rect = mini.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const width = rect.width;
    if (width <= 0) return;

    // If currently dragging minimap
    if (minimapDrag) {
      const deltaPx = e.clientX - minimapDrag.startX;
      const deltaSec = (deltaPx / width) * duration;

      if (minimapDrag.mode === 'slide') {
        const nextOffset = Math.max(0, Math.min(maxOffset, minimapDrag.initialOffset + deltaSec));
        onViewOffsetChange(nextOffset);
      } else if (minimapDrag.mode === 'resizeLeft') {
        // Dragging left edge changes start offset and shrinks/expands visible duration
        const fixedRight = minimapDrag.initialOffset + minimapDrag.initialVisibleDuration;
        const proposedLeft = minimapDrag.initialOffset + deltaSec;
        const minVisibleDuration = duration / 60; // Max zoom limit ~60x
        const maxVisibleDuration = duration;      // Min zoom 1x

        const clampedStart = Math.max(0, Math.min(fixedRight - minVisibleDuration, proposedLeft));
        const newVisible = Math.min(maxVisibleDuration, Math.max(minVisibleDuration, fixedRight - clampedStart));
        const newZoom = Math.max(1, Math.min(60, duration / newVisible));

        onZoomChange(newZoom);
        onViewOffsetChange(clampedStart);
      } else if (minimapDrag.mode === 'resizeRight') {
        // Dragging right edge keeps offset constant and shrinks/expands visible duration
        const fixedLeft = minimapDrag.initialOffset;
        const proposedRight = fixedLeft + minimapDrag.initialVisibleDuration + deltaSec;
        const minVisibleDuration = duration / 60; // Max zoom limit ~60x
        const maxVisibleDuration = duration - fixedLeft;

        const clampedEnd = Math.max(fixedLeft + minVisibleDuration, Math.min(duration, proposedRight));
        const newVisible = clampedEnd - fixedLeft;
        const newZoom = Math.max(1, Math.min(60, duration / newVisible));

        onZoomChange(newZoom);
      }
      return;
    }

    // Hover hit test for edge handles vs inside slider
    const viewWidthPct = visibleDuration / duration;
    const viewOffsetPct = currentOffset / duration;
    const vx = Math.max(0, viewOffsetPct * width);
    const vw = Math.max(8, Math.min(width - vx, viewWidthPct * width));

    const edgeTolerance = 24;
    const rightEdge = Math.min(width, vx + vw);
    if (Math.abs(x - vx) <= edgeTolerance) {
      setMinimapHover('left');
    } else if (x >= width - edgeTolerance || Math.abs(x - rightEdge) <= edgeTolerance) {
      setMinimapHover('right');
    } else if (x >= vx && x <= vx + vw) {
      setMinimapHover('body');
    } else {
      setMinimapHover(null);
    }
  };

  const handleMinimapPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const mini = minimapRef.current;
    if (mini && mini.hasPointerCapture(e.pointerId)) {
      mini.releasePointerCapture(e.pointerId);
    }
    setMinimapDrag(null);
  };

  const handleMinimapPointerLeave = () => {
    if (!minimapDrag) {
      setMinimapHover(null);
    }
  };

  const handleMinimapDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || !audioBuffer) return;
    e.preventDefault();
    setMinimapDrag(null);
    setMinimapHover(null);
    handleZoomFit();
  };

  const cursorStyle = activeDrag
    ? 'cursor-grabbing'
    : hoveredElement === 'marker'
    ? 'cursor-ew-resize'
    : hoveredElement === 'fadeIn' || hoveredElement === 'fadeOut'
    ? 'cursor-ew-resize'
    : hoveredElement === 'selectionStart' || hoveredElement === 'selectionEnd'
    ? 'cursor-col-resize'
    : hoveredElement === 'selectionBar'
    ? 'cursor-grab'
    : 'cursor-default';

  const minimapCursor = minimapDrag
    ? minimapDrag.mode === 'slide'
      ? 'cursor-grabbing'
      : 'cursor-ew-resize'
    : minimapHover === 'left' || minimapHover === 'right'
    ? 'cursor-ew-resize'
    : minimapHover === 'body'
    ? 'cursor-grab'
    : 'cursor-pointer';

  const hasSelection = Boolean(selection && Math.abs(selection.end - selection.start) > 0.02);
  const selS = selection ? Math.min(selection.start, selection.end) : 0;
  const selE = selection ? Math.max(selection.start, selection.end) : 0;

  // Sample Noise Floor from active selection
  const handleSampleNoiseFloor = () => {
    if (!audioBuffer) return;
    if (!selection || Math.abs(selection.end - selection.start) < 0.02) {
      setFeedbackToast({
        text: 'Select a quiet region (e.g. run-in groove or silence between tracks) on the waveform first.',
        type: 'warning',
      });
      setTimeout(() => setFeedbackToast(null), 4500);
      return;
    }
    const measured = measureNoiseFloorDb(audioBuffer, selection.start, selection.end);
    setAppliedPreview(null);
    setNoiseFloorDb(measured.suggestedThresholdDb);
    setThresholdFlashKey((k) => k + 1);
  };

  // Run Auto-Split using sampled noise floor and drop duration
  const handleTriggerAutoSplit = () => {
    if (!onAutoSplit) return;
    const count = onAutoSplit(noiseFloorDb, silenceDurationSec);
    const cleared = { buffer: audioBuffer!, thresholdDb: noiseFloorDb, silenceDuration: silenceDurationSec,
      start: cropStart, end: autoSplitEnd, times: [] };
    setAppliedPreview(cleared);
    setAutoSplitPreview(cleared);
    if (typeof count === 'number') {
      if (count > 0) {
        setFeedbackToast({
          text: `Auto-Split created ${count} split ${count === 1 ? 'marker' : 'markers'} (${count + 1} tracks) at detected silence gaps!`,
          type: 'success',
        });
      } else {
        setFeedbackToast({
          text: `No silence gaps below ${noiseFloorDb.toFixed(1)} dB for ${silenceDurationSec.toFixed(2)}s were found. Try raising the threshold or lowering the duration.`,
          type: 'info',
        });
      }
      setTimeout(() => setFeedbackToast(null), 5500);
    }
  };

  // Scan for Anomalous Peaks in active scope (selection or whole audio)
  const handleScanAnomalousPeaks = useCallback(
    (customThresh?: number, customScope?: 'selection' | 'all') => {
      if (!audioBuffer) return;
      const thresh = customThresh !== undefined ? customThresh : peakThresholdDb;
      const scope = customScope !== undefined ? customScope : (selection ? peakScope : 'all');

      const range =
        scope === 'selection' && selection
          ? { startSec: selection.start, endSec: selection.end }
          : undefined;

      setIsProcessingPeaks(true);
      if (peakScanTimerRef.current) clearTimeout(peakScanTimerRef.current);
      peakScanTimerRef.current = setTimeout(() => {
        const result = analyzeAnomalousPeaks(audioBuffer, thresh, range);
        setPeakAnalysis(result);
        setIsProcessingPeaks(false);

        if (result.peaksCount === 0) {
          setFeedbackToast({
            text: `No anomalous peaks found above ${thresh.toFixed(1)} dB in ${scope === 'selection' ? 'selection' : 'track'}. (Max peak: ${result.trueMaxPeakDb.toFixed(1)} dB).`,
            type: 'info',
          });
        } else {
          setFeedbackToast({
            text: `Detected ${result.peaksCount} anomalous peak spike${result.peaksCount > 1 ? 's' : ''} (max: ${result.trueMaxPeakDb.toFixed(1)} dB, nominal music: ${result.nominalProgramPeakDb.toFixed(1)} dB).`,
            type: 'warning',
          });
        }
        setTimeout(() => setFeedbackToast(null), 4500);
      }, 20);
    },
    [audioBuffer, peakThresholdDb, peakScope, selection]
  );

  // Auto-suggest threshold based on nominal music level
  const handleAutoSuggestThreshold = () => {
    if (!audioBuffer) return;
    const scope = selection ? peakScope : 'all';
    const range =
      scope === 'selection' && selection
        ? { startSec: selection.start, endSec: selection.end }
        : undefined;

    const initialAnalysis = analyzeAnomalousPeaks(audioBuffer, -1.0, range);
    let suggestedThresh = -3.0;
    if (initialAnalysis.nominalProgramPeakDb > -50) {
      suggestedThresh = Math.min(
        initialAnalysis.trueMaxPeakDb - 0.5,
        Math.max(-18.0, initialAnalysis.nominalProgramPeakDb + 2.5)
      );
    }
    suggestedThresh = Math.round(suggestedThresh * 2) / 2;
    setPeakThresholdDb(suggestedThresh);

    const suggestedCeiling = Math.min(
      suggestedThresh - 1.5,
      Math.max(-18.0, initialAnalysis.nominalProgramPeakDb)
    );
    setPeakTargetCeilingDb(Math.round(suggestedCeiling * 2) / 2);

    setPeakAnalysis(null);
  };

  // Execute anomalous peak reduction
  const handleExecuteReducePeaks = (alsoNormalise = false) => {
    if (!audioBuffer || !onApplyDePop) return;
    setIsProcessingPeaks(true);

    const scope = selection && peakScope === 'selection' ? 'selection' : 'all';
    const range =
      scope === 'selection' && selection
        ? { startSec: selection.start, endSec: selection.end }
        : undefined;

    setTimeout(() => {
      const result = reduceAnomalousPeaks(audioBuffer, {
        thresholdDb: peakThresholdDb,
        targetCeilingDb: peakTargetCeilingDb,
        scopeRange: range,
        kneeMs: 2.5,
      });
      setIsProcessingPeaks(false);

      if (result.peaksReducedCount > 0 && result.repairedBuffer) {
        onApplyDePop(
          result.repairedBuffer,
          `Reduce ${result.peaksReducedCount} Anomalous Peaks to ${peakTargetCeilingDb.toFixed(1)} dB`
        );
        setShowPeakTamerPopover(false);
        setPeakAnalysis(null);

        if (alsoNormalise) {
          onNormalise(normaliseTargetDb);
          setFeedbackToast({
            text: `Tamed ${result.peaksReducedCount} anomalous peaks down to ${peakTargetCeilingDb.toFixed(1)} dB and normalised audio to ${normaliseTargetDb.toFixed(1)} dB (+${result.headroomGainedDb.toFixed(1)} dB headroom gained)!`,
            type: 'success',
          });
        } else {
          setFeedbackToast({
            text: `Tamed ${result.peaksReducedCount} anomalous peaks! True peak reduced from ${result.originalMaxPeakDb.toFixed(1)} dB to ${result.newMaxPeakDb.toFixed(1)} dB (+${result.headroomGainedDb.toFixed(1)} dB headroom gained).`,
            type: 'success',
          });
        }
      } else {
        setFeedbackToast({
          text: `No peaks exceeded target ceiling ${peakTargetCeilingDb.toFixed(1)} dB in the selected scope.`,
          type: 'info',
        });
      }
      setTimeout(() => setFeedbackToast(null), 5500);
    }, 25);
  };

  // Opening or changing settings invalidates results; only Scan Peaks starts a scan.
  useEffect(() => {
    setPeakAnalysis(null);
    setIsProcessingPeaks(false);
    return () => {
      if (peakScanTimerRef.current) clearTimeout(peakScanTimerRef.current);
    };
  }, [showPeakTamerPopover, audioBuffer, peakThresholdDb, peakScope, selection?.start, selection?.end]);

  return (
    <div className="gap-2 select-none flex flex-col h-full min-w-0 min-h-0 overflow-hidden" ref={containerRef}>
      {/* Editing controls and compact timing readouts share the toolbar. */}
      <div aria-label="Waveform editing toolbar" className="order-2 flex flex-wrap items-end gap-2 bg-slate-900/60 border border-slate-700/70 px-2 py-1 rounded-xl text-xs shrink-0">
          {/* Selection actions */}
          <div className="flex flex-col items-start gap-1.5 px-2 py-1 shrink-0">
            <span className="text-[10px] font-bold uppercase tracking-wider text-sky-400">Selection</span>
            <div className="flex items-center gap-1">
              <TooltipButton
                onClick={() => {
                  if (onLoopSelection) onLoopSelection(selS, selE);
                  else if (onPlaySelection) onPlaySelection(selS, selE);
                }}
                disabled={!hasSelection}
                isActive={isLooping && isPlaying}
                activeClass="bg-emerald-500/25 text-emerald-300 border-emerald-500/50"
                icon={<Repeat className="w-3.5 h-3.5 text-emerald-400" />}
                label="Loop and play the selected region"
              />
              <TooltipButton
                onClick={() => onCropToSelection?.(selS, selE)}
                disabled={!hasSelection}
                activeClass="bg-sky-600 text-white border-sky-500"
                icon={<Crop className="w-3.5 h-3.5" />}
                label="Crop to Selection (Ctrl+T): Keep the selected region and discard everything outside it"
              />
              <TooltipButton
                onClick={() => onCutSelection?.(selS, selE)}
                disabled={!hasSelection}
                activeClass="bg-rose-600 text-white border-rose-500"
                icon={<Scissors className="w-3.5 h-3.5" />}
                label="Cut Selection (Del / Backspace): Remove the selected region and splice the remaining audio"
              />
              {onUndo && (
                <TooltipButton
                  onClick={onUndo}
                  disabled={!canUndo}
                  icon={<RotateCcw className="w-3.5 h-3.5 text-slate-300" />}
                  label="Undo last audio edit"
                />
              )}
            </div>
          </div>

          {/* View toggles */}
          <div className="flex flex-col items-start gap-1.5 px-2 py-1 shrink-0">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">View</span>
            <div className="flex items-center gap-1">
              <TooltipButton
                onClick={() => onFollowPlayheadChange(!followPlayhead)}
                isActive={followPlayhead}
                icon={(
                  <svg aria-hidden="true" viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1.5 12h1.2c1.5 0 1.5-3.5 3-3.5s1.5 7 3 7 1.5-8.5 3-8.5" />
                    <path d="M13.2 2v20" />
                    <path d="M13.2 9.5h4.2V6.7L23 12l-5.6 5.3v-2.8h-4.2z" fill="currentColor" stroke="none" />
                  </svg>
                )}
                label={`Auto-Scroll Follow Playhead (${followPlayhead ? 'ON' : 'OFF'})`}
              />
              <TooltipButton
                onClick={() => onFadeSettingsChange({ ...fadeSettings, zeroCrossing: !fadeSettings.zeroCrossing })}
                isActive={fadeSettings.zeroCrossing}
                icon={(
                  <svg aria-hidden="true" viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M2 22 22 2" />
                  </svg>
                )}
                label={`Zero-Crossing Snapping (${fadeSettings.zeroCrossing ? 'Active' : 'OFF'})`}
              />
              <TooltipButton
                onClick={() => onAutoPreviewOnClickChange(!autoPreviewOnClick)}
                isActive={autoPreviewOnClick}
                icon={<Volume2 className="w-3.5 h-3.5" />}
                label={`Audition on Click (${autoPreviewOnClick ? 'ON' : 'OFF'})`}
              />
            </div>
          </div>

          <dl aria-label="Playback timing" className="ml-auto grid shrink-0 grid-cols-[auto_auto] items-baseline gap-x-2 gap-y-1 self-center rounded border border-slate-800 bg-slate-950 px-2 py-1">
            <dt className="text-[8px] font-bold tracking-wide text-slate-500" title="Playback position">POS</dt>
            <dd className="min-w-[9ch] text-right font-mono text-[12px] font-semibold tabular-nums text-emerald-300">
              {formatTime(currentTime, true)}
            </dd>
            <dt className="text-[8px] font-bold tracking-wide text-slate-500" title="Recording length">LEN</dt>
            <dd className="text-right font-mono text-[12px] font-semibold tabular-nums text-sky-300">
              {audioBuffer ? formatTime(audioBuffer.duration) : '--:--'}
            </dd>
          </dl>

      </div>

      {processingPanelContainer && createPortal(
        <div aria-label="Tools" className="tools-panel absolute inset-x-[9px] top-1 bottom-[7.5px] flex min-w-0 flex-col gap-1.5">
          <div className="flex shrink-0 items-center gap-2">
          <span className="shrink-0 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Tools</span>
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto custom-scrollbar">
            <button
              type="button"
              onClick={() => {
                setProcessingOpen((open) => !open);
                setShowPeakTamerPopover(false);
                setShowNormalisePopover(false);
              }}
              aria-expanded={processingOpen}
              className={`px-2 py-1 rounded-md border text-[11px] font-semibold transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${processingOpen ? 'bg-amber-600 text-white border-amber-500 shadow-sm' : 'bg-slate-950 text-slate-300 border-slate-800 hover:border-slate-700'}`}
            >
              Splitter
            </button>
            <button
              type="button"
              onClick={() => {
                const nextState = !showPeakTamerPopover;
                setShowPeakTamerPopover(nextState);
                if (nextState) {
                  setProcessingOpen(false);
                  setShowNormalisePopover(false);
                }
              }}
              aria-expanded={showPeakTamerPopover}
              className={`px-2 py-1 rounded-md border text-[11px] font-semibold transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${showPeakTamerPopover ? 'bg-amber-600 text-white border-amber-500 shadow-sm' : 'bg-slate-950 text-slate-300 border-slate-800 hover:border-slate-700'}`}
            >
              Peak Tamer
            </button>
            <button
              type="button"
              onClick={() => {
                const nextState = !showNormalisePopover;
                setShowNormalisePopover(nextState);
                if (nextState) {
                  setProcessingOpen(false);
                  setShowPeakTamerPopover(false);
                }
              }}
              aria-expanded={showNormalisePopover}
              className={`px-2 py-1 rounded-md border text-[11px] font-semibold transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${showNormalisePopover ? 'bg-amber-600 text-white border-amber-500 shadow-sm' : 'bg-slate-950 text-slate-300 border-slate-800 hover:border-slate-700'}`}
            >
              Normalise
            </button>
          </div>
          <span className="ml-auto shrink-0 text-[8px] text-slate-500">Shift + Knob = Fine</span>
          </div>

          {/* Category controls stay inside the fixed Tools panel. */}
          {(processingOpen || showPeakTamerPopover || showNormalisePopover) && (
            <div aria-label="Active tool controls" className="min-h-0 flex-1 overflow-auto text-xs select-none custom-scrollbar">
              {processingOpen && (
                <div id="processing-detection-controls" className="tools-detection">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-1.5">
                    <div className="flex items-center space-x-1.5 text-slate-200 font-bold text-[11px]">
                      <Activity className="w-3.5 h-3.5 text-amber-400" />
                      <span>Splitter</span>
                    </div>
                    <button
                      type="button"
                      aria-label="Close splitter"
                      onClick={() => setProcessingOpen(false)}
                      className="text-slate-400 hover:text-white p-0.5 cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>

                  <div className="detection-detect text-slate-400" title="Analyse the waveform and preview proposed split points using the current settings.">
                    <span>Detect</span>
                  <button
                    type="button"
                    onClick={handleSampleNoiseFloor}
                    disabled={!audioBuffer}
                    aria-label="Sample noise floor from selection"
                    className="detection-sample flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Analyse the waveform and preview proposed split points using the current settings."
                  >
                    <Ear aria-hidden="true" className="h-3 w-3" />
                  </button>
                  </div>

                  <div title="Audio below this level is treated as silence when detecting gaps." className="detection-noise text-slate-400">
                    <span title="Audio below this level is treated as silence when detecting gaps.">Noise floor</span>
                    <div className="flex items-center gap-1">
                      <RotaryKnob size={18} step={0.5} fineStep={0.1} value={noiseFloorDb} min={-96} max={0} onChange={setNoiseFloorDb} title="Noise floor" formatValue={(v) => `${v.toFixed(1)} dB`} />
                      <output aria-label="Noise floor in dB" className="detection-value text-amber-300">{noiseFloorDb.toFixed(1)} dB</output>
                    </div>
                  </div>
                  <div title="Minimum silence duration required before a split is proposed." className="detection-duration text-slate-400">
                    <span title="Minimum silence duration required before a split is proposed.">Gap</span>
                    <span className="flex items-center gap-1">
                      <RotaryKnob size={18} step={0.1} fineStep={0.01} value={silenceDurationSec} min={0.1} max={10} onChange={setSilenceDurationSec} title="Minimum silence" formatValue={(v) => `${v.toFixed(2)} sec`} />
                      <output aria-label="Minimum silence in seconds" className="detection-value text-slate-200">{silenceDurationSec.toFixed(2)} s</output>
                    </span>
                  </div>
                  <div title="How close marker placement snaps to a detected split point." className="detection-snap text-slate-400">
                    <span title="How close marker placement snaps to a detected split point.">Snap</span>
                    <span className="flex items-center gap-1">
                      <RotaryKnob size={18} value={snapAmountSec} min={0} max={0.5} onChange={setSnapAmountSec} title="Snap" formatValue={(v) => (v <= 0 ? 'Off' : `${Math.round(v * 1000)}ms`)} />
                      <output className="font-mono tabular-nums text-sky-300">{snapAmountSec <= 0 ? 'Off' : `${Math.round(snapAmountSec * 1000)} ms`}</output>
                    </span>
                  </div>
                  <div aria-label="Split markers" className="detection-markers">
                    <button type="button" aria-label="Undo last marker action" title="Undo last marker action" disabled={!canUndoMarkers} onClick={onMarkerUndo} className="rounded border border-slate-700 bg-slate-950 text-slate-300 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">Undo</button>
                    {onClearMarkers && <button type="button" aria-label="Clear all split markers" title="Clear all split markers" disabled={markers.length === 0} onClick={onClearMarkers} className="rounded border border-slate-700 bg-slate-950 text-slate-400 hover:text-rose-300 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">Clear All</button>}
                  </div>
                  <div className="detection-preview">
                  <output aria-label="Auto-split preview" aria-live="polite" aria-busy={!!audioBuffer && previewTimes === null} title="Dashed amber lines on the waveform show predicted split positions. Press Apply to apply them." className="font-mono tabular-nums text-slate-300">
                    {!audioBuffer ? 'Load audio to preview slices' : previewTimes === null ? 'Calculating slices…' : (
                      <>
                        <span className="text-amber-300">{previewTimes.length} auto-{previewTimes.length === 1 ? 'split' : 'splits'}</span>
                        <span className="text-sky-300">{previewSliceCount} {previewSliceCount === 1 ? 'slice' : 'slices'}</span>
                        {previewTimes.length === 0 && markers.length > 0 && <span>Existing markers kept</span>}
                      </>
                    )}
                  </output>
                  <button type="button" onClick={handleTriggerAutoSplit} disabled={!audioBuffer || !onAutoSplit} className="rounded border border-amber-500/30 bg-amber-500/10 text-amber-300 font-semibold hover:bg-amber-500/20 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
                    Apply
                  </button>
                  </div>
                </div>
              )}

              {showPeakTamerPopover && (
                <div className="tools-peak-tamer">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-1.5">
                    <div className="flex items-center space-x-1.5 text-slate-200 font-bold text-[11px]">
                      <AudioWaveform className="w-3.5 h-3.5 text-amber-400" />
                      <span>Peak Tamer</span>
                    </div>
                    <button
                      type="button"
                      aria-label="Close peak tamer"
                      onClick={() => setShowPeakTamerPopover(false)}
                      className="text-slate-400 hover:text-white p-0.5 cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>

                  {/* Scope selector if selection active */}
                  {selection && (
                    <div className="tools-peak-scope space-y-1">
                      <div className="text-[9px] text-slate-400 font-semibold uppercase tracking-wider">
                        Target Range:
                      </div>
                      <div className="grid grid-cols-2 gap-1 bg-slate-900 p-0.5 rounded-lg border border-slate-800">
                        <button
                          type="button"
                          onClick={() => {
                            setPeakScope('selection');
                          }}
                          className={`py-1 px-1.5 text-center truncate rounded text-[10px] font-semibold transition cursor-pointer ${
                            peakScope === 'selection'
                              ? 'bg-amber-600 text-white shadow-xs'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                          title={`Selection: ${formatTime(selection.start)} - ${formatTime(selection.end)}`}
                        >
                          Selection ({formatTime(selection.start)} - {formatTime(selection.end)})
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setPeakScope('all');
                          }}
                          className={`py-1 px-1.5 text-center truncate rounded text-[10px] font-semibold transition cursor-pointer ${
                            peakScope === 'all'
                              ? 'bg-amber-600 text-white shadow-xs'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          Entire Track
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Measured Audio Peak Profile */}
                  {peakAnalysis && (
                    <div className="tools-peak-results p-2 rounded-lg bg-slate-900/90 border border-slate-800 space-y-1 text-[10px]">
                      <div className="grid grid-cols-2 gap-2 text-[10px] pb-1 border-b border-slate-800">
                        <div>
                          <span className="text-slate-400 block text-[9px]">Max Peak in Scope:</span>
                          <span className="font-mono font-bold text-slate-200">
                            {peakAnalysis.trueMaxPeakDb > -90 ? `${peakAnalysis.trueMaxPeakDb.toFixed(1)} dB` : '-∞'}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-400 block text-[9px]">Nominal Program (99%):</span>
                          <span className="font-mono font-bold text-emerald-400">
                            {peakAnalysis.nominalProgramPeakDb > -90 ? `${peakAnalysis.nominalProgramPeakDb.toFixed(1)} dB` : '-∞'}
                          </span>
                        </div>
                      </div>

                      <div className="flex justify-between items-center pt-0.5">
                        <span className="text-slate-400">Anomalous Peaks Found:</span>
                        <span className={`font-bold font-mono ${peakAnalysis.peaksCount > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
                          {peakAnalysis.peaksCount} {peakAnalysis.peaksCount === 1 ? 'spike' : 'spikes'}
                        </span>
                      </div>

                      {peakAnalysis.peaksCount > 0 && (
                        <div className="flex justify-between items-center text-emerald-400">
                          <span>Normalisation Headroom Gain:</span>
                          <span className="font-bold font-mono">
                            +{Math.max(0, peakAnalysis.trueMaxPeakDb - peakTargetCeilingDb).toFixed(1)} dB
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Controls: Outlier Threshold and Reduction Target */}
                  <div className="tools-peak-settings space-y-2 bg-slate-900/60 p-2 rounded-lg border border-slate-800">
                    {/* Threshold Slider */}
                    <div className="space-y-1">
                      <div className="flex justify-between items-center text-[10px]">
                        <span className="text-slate-300 font-medium">Threshold</span>
                        <div className="flex items-center space-x-1.5">
                          <button
                            type="button"
                            onClick={handleAutoSuggestThreshold}
                            disabled={!audioBuffer}
                            className="px-1.5 py-0.5 bg-slate-800 hover:bg-slate-700 text-amber-300 rounded text-[9px] font-mono cursor-pointer border border-slate-700"
                            title="Auto-suggest threshold based on nominal music level"
                          >
                            Auto
                          </button>
                          <span className="text-amber-400 font-mono font-bold">{peakThresholdDb.toFixed(1)} dB</span>
                        </div>
                      </div>
                      <input
                        aria-label="Peak threshold in dB"
                        type="range"
                        min="-24"
                        max="0"
                        step="0.5"
                        value={peakThresholdDb}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value);
                          setPeakThresholdDb(val);
                        }}
                        className="w-full accent-amber-500 cursor-pointer h-1.5 bg-slate-800 rounded"
                      />
                    </div>

                    {/* Target Ceiling Slider */}
                    <div className="space-y-1 pt-1 border-t border-slate-800/80">
                      <div className="flex justify-between items-center text-[10px]">
                        <span className="text-slate-300 font-medium">Ceiling</span>
                        <span className="text-emerald-400 font-mono font-bold">{peakTargetCeilingDb.toFixed(1)} dB</span>
                      </div>
                      <input
                        aria-label="Peak ceiling in dB"
                        type="range"
                        min="-24"
                        max="0"
                        step="0.5"
                        value={peakTargetCeilingDb}
                        onChange={(e) => setPeakTargetCeilingDb(parseFloat(e.target.value))}
                        className="w-full accent-emerald-500 cursor-pointer h-1.5 bg-slate-800 rounded"
                      />
                    </div>
                  </div>

                  {/* Detected Peaks List (if any) */}
                  {peakAnalysis && peakAnalysis.detectedPeaks.length > 0 && (
                    <div className="tools-peak-list space-y-1">
                      <div className="text-[9px] text-slate-400 font-semibold uppercase tracking-wider flex justify-between">
                        <span>Detected Anomalous Peaks ({peakAnalysis.detectedPeaks.length})</span>
                        <span>Click to seek</span>
                      </div>
                      <div className="max-h-24 overflow-y-auto space-y-1 pr-0.5 custom-scrollbar">
                        {peakAnalysis.detectedPeaks.slice(0, 6).map((p, idx) => (
                          <div
                            key={p.id}
                            className="flex justify-between items-center bg-slate-900/90 px-2 py-1 rounded border border-slate-800 text-[10px]"
                          >
                            <span className="text-slate-300">
                              <span className="text-amber-400 font-bold mr-1">#{idx + 1}</span>
                              <span className="font-mono">{formatTime(p.timeSec)}</span>
                              <span className="text-slate-500 ml-1">({p.peakDb.toFixed(1)} dB)</span>
                            </span>
                            <button
                              type="button"
                              onClick={() => onSeek(p.timeSec)}
                              className="px-1.5 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-[9px] cursor-pointer"
                            >
                              Seek
                            </button>
                          </div>
                        ))}
                        {peakAnalysis.detectedPeaks.length > 6 && (
                          <div className="text-[9px] text-center text-slate-500">
                            + {peakAnalysis.detectedPeaks.length - 6} more peaks detected
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="tools-peak-actions space-y-1.5 pt-0.5">
                    <button
                      type="button"
                      onClick={() => handleScanAnomalousPeaks()}
                      disabled={!audioBuffer || isProcessingPeaks}
                      className="w-full py-1.5 bg-slate-850 hover:bg-slate-800 text-slate-200 rounded font-semibold text-[10px] transition cursor-pointer border border-slate-700"
                    >
                      {isProcessingPeaks ? 'Scanning Peaks...' : 'Scan Peaks'}
                    </button>

                    <button
                      type="button"
                      onClick={() => handleExecuteReducePeaks(false)}
                      disabled={isProcessingPeaks || !peakAnalysis || peakAnalysis.peaksCount === 0}
                      className={`w-full py-1.5 rounded font-bold text-[10px] tracking-wider transition cursor-pointer border ${
                        !peakAnalysis || peakAnalysis.peaksCount === 0
                          ? 'bg-slate-800 text-slate-500 border-slate-700 cursor-not-allowed'
                          : 'bg-amber-600 hover:bg-amber-500 text-white border-amber-500/30'
                      }`}
                    >
                      Reduce Peaks
                    </button>

                    <button
                      type="button"
                      onClick={() => handleExecuteReducePeaks(true)}
                      disabled={isProcessingPeaks || !peakAnalysis || peakAnalysis.peaksCount === 0}
                      className={`w-full py-1.5 rounded font-bold text-[10px] tracking-wider transition cursor-pointer border ${
                        !peakAnalysis || peakAnalysis.peaksCount === 0
                          ? 'bg-slate-800 text-slate-500 border-slate-700 cursor-not-allowed'
                          : 'bg-emerald-600 hover:bg-emerald-500 text-white border-emerald-500/30'
                      }`}
                      title="Attenuates anomalous peaks then immediately normalises entire audio to target gain"
                    >
                      Reduce & Normalise ({normaliseTargetDb.toFixed(1)} dB)
                    </button>
                  </div>
                </div>
              )}

              {showNormalisePopover && (
                <div className="tools-normalise">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-1.5">
                    <div className="flex items-center space-x-1.5 text-slate-200 font-bold text-[11px]">
                      <UnfoldVertical className="w-3.5 h-3.5 text-amber-400" />
                      <span>Normalise</span>
                    </div>
                    <button type="button" onClick={() => setShowNormalisePopover(false)} aria-label="Close normalise" className="text-slate-400 hover:text-white p-0.5 cursor-pointer">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="flex justify-between items-center text-slate-300 font-semibold text-[11px]">
                    <span>Normalise Target:</span>
                    <span className="text-amber-400 font-mono font-bold">{normaliseTargetDb.toFixed(1)} dB</span>
                  </div>
                  <input
                    aria-label="Normalise target in dB"
                    type="range"
                    min="-6"
                    max="0"
                    step="0.1"
                    value={normaliseTargetDb}
                    onChange={(e) => setNormaliseTargetDb(parseFloat(e.target.value))}
                    className="w-full accent-emerald-500 cursor-pointer h-1.5 bg-slate-800 rounded"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      onNormalise(normaliseTargetDb);
                      setShowNormalisePopover(false);
                    }}
                    disabled={!audioBuffer}
                    className="w-full py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded font-bold text-[10px] tracking-wider transition cursor-pointer border border-emerald-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    APPLY NORMALISATION
                  </button>
                </div>
              )}
            </div>
          )}
        </div>,
        processingPanelContainer
      )}

      {/* 1. Main Waveform Canvas Container (fills remaining height dynamically) */}
      <div className="order-4 flex flex-col flex-1 min-h-0 rounded-xl overflow-hidden border border-slate-800 bg-slate-950 shadow-inner">
        {/* Slim readout strip keeps the waveform itself unobstructed. */}
        <div aria-label="Waveform readouts" className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-800/70 bg-slate-900/40 px-2 py-0.5 text-[10px] leading-4 select-none">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className="text-[8px] uppercase tracking-wider text-slate-500">Region</span>
            <span className="truncate font-mono tabular-nums text-sky-400">
              {hasSelection ? `${formatTime(selS, true)} – ${formatTime(selE, true)}` : 'None'}
            </span>
          </div>
          <div className="flex shrink-0 items-baseline gap-1.5">
            <span className="text-[8px] uppercase tracking-wider text-slate-500">Noise Floor</span>
            <span key={thresholdFlashKey} className={`font-mono tabular-nums text-amber-400 ${thresholdFlashKey > 0 ? 'flash-once' : ''}`}>
              {noiseFloorDb.toFixed(1)} dB
            </span>
          </div>
        </div>
        {/* Fixed-height time ruler; never resizes with panel toggles so the waveform stays put. */}
        <div className="shrink-0 border-b border-slate-800/70" style={{ height: `${RULER_HEIGHT}px` }}>
          <canvas
            ref={rulerCanvasRef}
            className="block w-full h-full select-none pointer-events-none"
            style={{ height: `${RULER_HEIGHT}px` }}
          />
        </div>
        <div className="relative flex-1 min-h-0" ref={canvasContainerRef}>
        {(importStatus || analysisBusy || importError || analysisError) && (
          <div role="status" className="pointer-events-none absolute left-3 right-3 top-3 z-30 rounded border border-slate-700 bg-slate-950/90 px-3 py-2 text-xs text-slate-200 shadow">
            {importStatus ? `${importStatus.stage} ${importStatus.name}...${importStatus.progress !== undefined ? ` ${Math.floor(importStatus.progress * 100)}%` : ''}`
              : analysisBusy ? `Building waveform... ${Math.floor(analyzedSamples / Math.max(1, audioBuffer?.length ?? 1) * 100)}%`
              : importError || analysisError}
            {(importStatus?.progress === undefined && importStatus) && <span className="ml-2 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-sky-300" />}
          </div>
        )}
        {/* Feedback Notification Toast (floats over the canvas; never shifts layout) */}
        {feedbackToast && (
          <div
            className={`absolute top-3 left-3 right-3 z-20 flex items-center justify-between px-3 py-1.5 rounded-lg border text-xs font-semibold animate-fade-in backdrop-blur-xs ${
              feedbackToast.type === 'success'
                ? 'bg-emerald-950/90 border-emerald-800/80 text-emerald-300'
                : feedbackToast.type === 'warning'
                ? 'bg-amber-950/90 border-amber-800/80 text-amber-300'
                : 'bg-sky-950/90 border-sky-800/80 text-sky-300'
            }`}
          >
            <div className="flex items-center gap-2">
              <Activity className="w-3.5 h-3.5 shrink-0" />
              <span>{feedbackToast.text}</span>
            </div>
            <button
              type="button"
              onClick={() => setFeedbackToast(null)}
              className="text-slate-400 hover:text-white p-0.5 cursor-pointer ml-2"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onContextMenu={handleContextMenu}
          onDoubleClick={handleWaveformDoubleClick}
          className={`w-full block touch-none ${cursorStyle} ${audioBuffer ? '' : 'pointer-events-none'}`}
          style={{ height: `${canvasDimensions.height}px` }}
          title={processingOpen ? "Double-click to add a split marker; right-click a marker to remove it; drag markers to adjust" : "Click to clear selection and seek; scroll to zoom at cursor; Shift+scroll to adjust waveform height"}
        />
        <canvas
          ref={overlayCanvasRef}
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ height: `${canvasDimensions.height}px` }}
        />

        {/* Hover Time Tooltip (Sleek HUD Style, only shows timestamp by default to avoid clutter) */}
        {hoverTime !== null && hoverPosition && (
          <div
            className="absolute pointer-events-none -top-1 bg-slate-900 text-slate-200 border border-slate-800 px-2.5 py-0.5 rounded-md text-[10px] font-mono shadow-xl transform -translate-x-1/2 z-10 flex items-center gap-1.5"
            style={{ left: `${hoverPosition.x}px` }}
          >
            <span className="text-emerald-400 font-bold">{formatTime(hoverTime, true)}</span>
            {hoveredElement === 'selectionStart' || hoveredElement === 'selectionEnd' ? (
              <span className="text-sky-400 text-[9px] font-sans px-1 bg-sky-500/10 rounded border border-sky-500/20">Bracket</span>
            ) : hoveredElement === 'selectionBar' ? (
              <span className="text-sky-400 text-[9px] font-sans px-1 bg-sky-500/10 rounded border border-sky-500/20">Selection</span>
            ) : hoveredElement === 'marker' ? (
              <span className="text-purple-400 text-[9px] font-sans px-1 bg-purple-500/10 rounded border border-purple-500/20">Marker</span>
            ) : hoveredElement === 'fadeIn' ? (
              <span className="text-sky-400 text-[9px] font-sans px-1 bg-sky-500/10 rounded border border-sky-500/20">Fade In</span>
            ) : hoveredElement === 'fadeOut' ? (
              <span className="text-amber-400 text-[9px] font-sans px-1 bg-sky-500/10 rounded border border-sky-500/20">Fade Out</span>
            ) : null}
          </div>
        )}

        {/* Independent horizontal zoom row */}
        <div className="absolute bottom-3 right-11 flex items-center gap-0.5">
          <button
            type="button"
            onClick={handleZoomIn}
            className="w-6 h-6 flex items-center justify-center rounded bg-slate-950/75 text-slate-300 hover:bg-slate-800 hover:text-white transition cursor-pointer"
            title="Zoom horizontal in"
            aria-label="Zoom horizontal in"
          >
            <ZoomIn className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={handleZoomFit}
            className="w-6 h-6 flex items-center justify-center rounded bg-slate-950/75 text-slate-300 hover:bg-slate-800 hover:text-white transition cursor-pointer"
            title="Reset horizontal zoom to fit the full track"
            aria-label="Reset horizontal zoom"
          >
            <RotateCcw className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={handleZoomOut}
            className="w-6 h-6 flex items-center justify-center rounded bg-slate-950/75 text-slate-300 hover:bg-slate-800 hover:text-white transition cursor-pointer"
            title="Zoom horizontal out"
            aria-label="Zoom horizontal out"
          >
            <ZoomOut className="w-3 h-3" />
          </button>
        </div>

        {/* Independent vertical zoom stack, aligned to the waveform edge */}
        <div className="absolute right-1 top-1/2 -translate-y-1/2 flex flex-col items-center gap-1">
          <button
            type="button"
            onClick={handleVerticalZoomIn}
            className="w-7 h-7 flex items-center justify-center rounded bg-slate-950/75 text-slate-300 hover:bg-slate-800 hover:text-white transition cursor-pointer"
            title="Zoom waveform vertically in"
            aria-label="Zoom waveform vertically in"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleVerticalZoomReset}
            className="w-7 h-7 flex items-center justify-center rounded bg-slate-950/75 text-amber-300 hover:bg-slate-800 hover:text-white transition cursor-pointer"
            title="Reset vertical zoom"
            aria-label="Reset vertical zoom"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleVerticalZoomOut}
            className="w-7 h-7 flex items-center justify-center rounded bg-slate-950/75 text-slate-300 hover:bg-slate-800 hover:text-white transition cursor-pointer"
            title="Zoom waveform vertically out"
            aria-label="Zoom waveform vertically out"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
        </div>

      </div>

      </div>

      {/* 2. Minimap Overview & Navigation Bar */}
      <div className="order-5 relative w-full bg-slate-900 p-0 rounded-lg border border-slate-800 flex-shrink-0 overflow-hidden">
        <canvas
          ref={minimapRef}
          width={800}
          height={26}
          onPointerDown={handleMinimapPointerDown}
          onPointerMove={handleMinimapPointerMove}
          onPointerUp={handleMinimapPointerUp}
          onPointerCancel={handleMinimapPointerUp}
          onPointerLeave={handleMinimapPointerLeave}
          onDoubleClick={handleMinimapDoubleClick}
          className={`block w-full h-6.5 rounded bg-slate-950 touch-none select-none ${audioBuffer ? '' : 'pointer-events-none'}`}
          style={{ cursor: minimapCursor }}
          title="Double-click to reset to 1.0x • Drag edges to zoom • Drag inside to slide • Scroll waveform to zoom at cursor • Shift+scroll to adjust height"
        />
        <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-mono text-slate-400 bg-slate-950/75 px-1.5 py-0.5 rounded">
          {zoom.toFixed(1)}x zoom • {formatTime(visibleDuration)} visible
        </div>
      </div>

    </div>
  );
};
