import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { Marker, FadeSettings, TimeSelection } from '../types';
import {
  formatTime,
  calculateFadeGain,
  findZeroCrossing,
  measureNoiseFloorDb,
  analyzeAnomalousPeaks,
  reduceAnomalousPeaks,
  AnomalousPeakAnalysis,
  AnomalousPeakEvent,
} from '../utils/audioProcessing';
import {
  ZoomIn,
  ZoomOut,
  BookmarkPlus,
  BookmarkMinus,
  Zap,
  Volume2,
  Navigation,
  ScanLine,
  Crop,
  Scissors,
  Play,
  Pause,
  Square,
  X,
  SlidersHorizontal,
  RotateCcw,
  Repeat,
  Activity,
  Sparkles,
  Trash2,
  AudioWaveform,
  UnfoldVertical,
} from 'lucide-react';

interface WaveformCanvasProps {
  audioBuffer: AudioBuffer;
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
  onPlayPause?: () => void;
  onStop?: () => void;
  onSeek: (time: number) => void;
  onPreviewStart?: (time: number) => void;
  onSelectionChange?: (selection: TimeSelection | null) => void;
  onLoopSelection?: (start: number, end: number) => void;
  onCropToSelection?: (start: number, end: number) => void;
  onCutSelection?: (start: number, end: number) => void;
  onPlaySelection?: (start: number, end: number) => void;
  onTrimStart?: () => void;
  onTrimEnd?: () => void;
  onUndo?: () => void;
  onToggleLoop?: () => void;
  onCropChange?: (start: number, end: number) => void;
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
        className={`${compact || captionAbove ? 'w-6 h-6' : caption && !captionAbove ? 'h-9 px-2 gap-1.5' : 'w-9 h-9'} flex items-center justify-center rounded-md border text-slate-300 font-semibold transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
          isActive
            ? activeClass
            : 'bg-slate-950 hover:bg-slate-800 border-slate-800 hover:border-slate-700'
        }`}
      >
        {icon}
        {caption && !captionAbove && <span className="text-[9px] font-bold uppercase tracking-wider">{caption}</span>}
      </button>
      {showTooltip && (
        <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2.5 px-2.5 py-1.5 bg-slate-950 text-slate-200 border border-slate-850 text-[10px] font-medium font-sans rounded shadow-2xl whitespace-nowrap z-50 pointer-events-none">
          {label}
        </div>
      )}
    </div>
  );
};

export const WaveformCanvas: React.FC<WaveformCanvasProps> = ({
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
  onPlayPause,
  onStop,
  onSeek,
  onPreviewStart,
  onSelectionChange,
  onLoopSelection,
  onCropToSelection,
  onCutSelection,
  onPlaySelection,
  onTrimStart,
  onTrimEnd,
  onUndo,
  onToggleLoop,
  onCropChange,
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
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const minimapRef = useRef<HTMLCanvasElement | null>(null);

  const [canvasDimensions, setCanvasDimensions] = useState({ width: 600, height: 180 });
  const [markerTool, setMarkerTool] = useState<'none' | 'add' | 'remove'>('none');
  const [autoPreviewOnClick, setAutoPreviewOnClick] = useState<boolean>(true);
  const [followPlayhead, setFollowPlayhead] = useState<boolean>(true);

  // Popover States
  const [showNormalisePopover, setShowNormalisePopover] = useState<boolean>(false);
  const [normaliseTargetDb, setNormaliseTargetDb] = useState<number>(-0.5);

  // Anomalous Peak Tamer States
  const [showPeakTamerPopover, setShowPeakTamerPopover] = useState<boolean>(false);
  const [peakThresholdDb, setPeakThresholdDb] = useState<number>(-3.0);
  const [peakTargetCeilingDb, setPeakTargetCeilingDb] = useState<number>(-6.0);
  const [peakScope, setPeakScope] = useState<'selection' | 'all'>('selection');
  const [peakAnalysis, setPeakAnalysis] = useState<AnomalousPeakAnalysis | null>(null);
  const [isProcessingPeaks, setIsProcessingPeaks] = useState<boolean>(false);

  // Noise Floor & Auto-Split States
  const [noiseFloorDb, setNoiseFloorDb] = useState<number>(-45.0);
  const [snapToNoiseFloor, setSnapToNoiseFloor] = useState<boolean>(true);
  const [silenceDurationSec, setSilenceDurationSec] = useState<number>(1.0);
  const [showNoiseFloorPopover, setShowNoiseFloorPopover] = useState<boolean>(false);
  const [measuredPeakDb, setMeasuredPeakDb] = useState<number | null>(null);
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

  // Compute nearest marker for cursor when in remove ('-') mode
  const nearestMarkerId = useMemo(() => {
    if (markerTool !== 'remove' || hoverTime === null || markers.length === 0) return null;
    let nearest = markers[0];
    let minDist = Math.abs(markers[0].time - hoverTime);
    for (let i = 1; i < markers.length; i++) {
      const dist = Math.abs(markers[i].time - hoverTime);
      if (dist < minDist) {
        minDist = dist;
        nearest = markers[i];
      }
    }
    return nearest.id;
  }, [markerTool, hoverTime, markers]);

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

  const duration = audioBuffer.duration;
  const visibleDuration = duration / Math.max(1, zoom);
  const maxOffset = Math.max(0, duration - visibleDuration);
  const currentOffset = Math.max(0, Math.min(maxOffset, viewOffsetSec));

  // Compute Peaks once
  useEffect(() => {
    const channels = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    const computedPyramids: ChannelPyramid[] = [];

    for (let c = 0; c < channels; c++) {
      const data = audioBuffer.getChannelData(c);
      const levels: PeakLevel[] = [];
      const blocks = [32, 128, 512, 2048];

      for (const blockSize of blocks) {
        const numBlocks = Math.ceil(length / blockSize);
        const mins = new Float32Array(numBlocks);
        const maxs = new Float32Array(numBlocks);

        for (let b = 0; b < numBlocks; b++) {
          const start = b * blockSize;
          const end = Math.min(length, start + blockSize);
          let min = 1.0;
          let max = -1.0;
          for (let i = start; i < end; i++) {
            const v = data[i];
            if (v < min) min = v;
            if (v > max) max = v;
          }
          mins[b] = min;
          maxs[b] = max;
        }
        levels.push({ blockSize, min: mins, max: maxs });
      }
      computedPyramids.push({ levels });
    }
    pyramidRef.current = computedPyramids;
  }, [audioBuffer]);

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

  // Ctrl + Mouse Wheel zoom centered on cursor
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheel = (e: WheelEvent) => {
      // Check for Ctrl key (or Meta key on macOS)
      if (!e.ctrlKey && !e.metaKey) return;

      // Prevent native browser page zoom
      e.preventDefault();

      const rect = canvas.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const width = rect.width;
      if (width <= 0) return;

      const dur = durationRef.current;
      const currZoom = zoomRef.current;
      const currOffset = currentOffsetRef.current;
      const currVisible = dur / Math.max(1, currZoom);

      // Time at cursor before zoom
      const cursorRatio = Math.max(0, Math.min(1, cursorX / width));
      const cursorTime = currOffset + cursorRatio * currVisible;

      // Calculate zoom factor: deltaY < 0 means scroll up (zoom in), deltaY > 0 means scroll down (zoom out)
      const zoomFactor = e.deltaY < 0 ? 1.25 : 1 / 1.25;
      const nextZoom = Math.max(1, Math.min(60, currZoom * zoomFactor));

      if (nextZoom === currZoom) return;

      // New visible duration
      const nextVisible = dur / nextZoom;
      // New offset keeping cursorTime at cursorRatio of the view
      const maxPossibleOffset = Math.max(0, dur - nextVisible);
      const nextOffset = Math.max(0, Math.min(maxPossibleOffset, cursorTime - cursorRatio * nextVisible));

      onZoomChangeRef.current(nextZoom);
      onViewOffsetChangeRef.current(nextOffset);
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

  // Snapping time to zero-crossing
  const snapToZeroCrossing = useCallback((time: number): number => {
    const sampleRate = audioBuffer.sampleRate;
    const ch0 = audioBuffer.getChannelData(0);
    const targetSample = Math.round(time * sampleRate);
    const searchRange = Math.round(sampleRate * 0.05); // 50ms search
    const snappedSample = findZeroCrossing(ch0, targetSample, searchRange);
    return snappedSample / sampleRate;
  }, [audioBuffer]);

  const snapTimeToNoiseFloor = useCallback((time: number): number => {
    if (!snapToNoiseFloor || !audioBuffer) return time;

    const channel = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    const targetSample = Math.max(0, Math.min(channel.length - 1, Math.round(time * sampleRate)));
    const searchSamples = Math.round(sampleRate * 0.45);
    const windowSamples = Math.max(32, Math.round(sampleRate * 0.012));
    const threshold = Math.pow(10, noiseFloorDb / 20);
    let bestSample = targetSample;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let offset = -searchSamples; offset <= searchSamples; offset += windowSamples) {
      const center = Math.max(0, Math.min(channel.length - 1, targetSample + offset));
      const start = Math.max(0, center - Math.floor(windowSamples / 2));
      const end = Math.min(channel.length, start + windowSamples);
      let sumSquares = 0;
      for (let i = start; i < end; i++) sumSquares += channel[i] * channel[i];
      const rms = Math.sqrt(sumSquares / Math.max(1, end - start));
      if (rms <= threshold && Math.abs(offset) < bestDistance) {
        bestSample = center;
        bestDistance = Math.abs(offset);
      }
    }

    return bestDistance <= searchSamples ? bestSample / sampleRate : time;
  }, [audioBuffer, noiseFloorDb, snapToNoiseFloor]);

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

    // Horizontal Zero Centerline
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    // Plot waveform
    const channels = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    const startSample = Math.round(currentOffset * audioBuffer.sampleRate);
    const endSample = Math.round((currentOffset + visibleDuration) * audioBuffer.sampleRate);
    const sampleCount = endSample - startSample;

    const pyramid = pyramidRef.current;
    if (pyramid && pyramid[0]) {
      ctx.strokeStyle = '#059669'; // Emerald-600
      ctx.lineWidth = 1;

      for (let c = 0; c < channels; c++) {
        const channelHeight = height / channels;
        const centerY = channelHeight * c + channelHeight / 2;
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

        ctx.beginPath();
        for (let x = 0; x < width; x++) {
          const t = xToTime(x, width);
          const sIdx = Math.round(t * audioBuffer.sampleRate);
          const bIdx = Math.floor(sIdx / lvlBlockSize);

          if (bIdx >= 0 && bIdx < mins.length) {
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

            const visualGain = 1.35;
            const yMin = centerY + minVal * fadeGain * (channelHeight * 0.45) * visualGain;
            const yMax = centerY + maxVal * fadeGain * (channelHeight * 0.45) * visualGain;

            ctx.moveTo(x, yMin);
            ctx.lineTo(x, yMax);
          }
        }
        ctx.stroke();
      }
    }
  }, [canvasDimensions, currentOffset, visibleDuration, audioBuffer, xToTime, fadeSettings, cropStart, cropEnd]);

  // Overlay Drawing: Markers, Fades, Crop braces, Selection bounds
  useEffect(() => {
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

    // 4. Split Markers
    markers.forEach((m) => {
      const mx = timeToX(m.time, width);
      if (mx < 0 || mx > width) return;

      const isHovered = hoveredMarkerId === m.id;
      const isTargetedForRemoval = markerTool === 'remove' && nearestMarkerId === m.id;

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
      const snappedHoverTime = snapEditTime(hoverTime);
      const snappedX = timeToX(snappedHoverTime, width);
      if (snapToNoiseFloor && Math.abs(snappedX - hx) > 2 && snappedX >= 0 && snappedX <= width) {
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
      if (markerTool === 'add') {
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
  }, [canvasDimensions, cropStart, cropEnd, selection, markers, currentTime, hoverPosition, hoverTime, hoveredMarkerId, fadeSettings, timeToX, markerTool, nearestMarkerId, snapEditTime, snapToNoiseFloor]);

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

    // Plot full-length mini waveform
    ctx.fillStyle = '#10b981';
    const rawData = audioBuffer.getChannelData(0);
    const step = Math.ceil(rawData.length / width);
    for (let x = 0; x < width; x++) {
      const start = x * step;
      const end = Math.min(rawData.length, start + step);
      let min = 1.0;
      let max = -1.0;
      for (let i = start; i < end; i++) {
        const v = rawData[i];
        if (v < min) min = v;
        if (v > max) max = v;
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
  }, [audioBuffer, zoom, currentOffset, visibleDuration, duration, fadeSettings, cropStart, cropEnd, minimapDrag, minimapHover]);

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

    // Dragging active element logic
    if (activeDrag) {
      if (activeDrag.type === 'playhead') {
        let nextTime = Math.max(cropStart, Math.min(cropEnd, time));
        nextTime = snapEditTime(nextTime);
        onSeek(nextTime);
      } else if (activeDrag.type === 'marker' && activeDrag.id) {
        let nextTime = Math.max(cropStart, Math.min(cropEnd, time));
        nextTime = snapEditTime(nextTime);
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

    canvas.setPointerCapture(e.pointerId);

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const time = xToTime(x, canvasDimensions.width);

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
    } else if (markerTool === 'remove') {
      // In '-' mode, each click removes the nearest marker to cursor
      if (markers.length > 0) {
        let nearest = markers[0];
        let minDist = Math.abs(markers[0].time - time);
        for (let i = 1; i < markers.length; i++) {
          const d = Math.abs(markers[i].time - time);
          if (d < minDist) {
            minDist = d;
            nearest = markers[i];
          }
        }
        onRemoveMarker(nearest.id);
      }
    } else if (markerTool === 'add') {
      // In '+' mode, each click adds a marker
      let markerTime = time;
      markerTime = snapEditTime(markerTime);
      onAddMarker(markerTime);
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

    if (activeDrag?.type === 'selectionCreate' && activeDrag.startTime !== undefined) {
      const rect = canvas?.getBoundingClientRect();
      const x = rect ? e.clientX - rect.left : (activeDrag.startX ?? 0);
      const pixelDiff = Math.abs(x - (activeDrag.startX ?? 0));
      const endTime = xToTime(x, canvasDimensions.width);
      const timeDiff = Math.abs(endTime - activeDrag.startTime);

      if (pixelDiff <= 5 || timeDiff < 0.05) {
        // Single Click: Clear selection, seek playhead, preview if enabled
        const clickTime = activeDrag.startTime;
        onSelectionChange?.(null);
        if (autoPreviewOnClick && onPreviewStart) {
          onPreviewStart(clickTime);
        } else {
          onSeek(clickTime);
        }
      } else {
        // Drag selection complete!
        const selStart = Math.min(activeDrag.startTime, endTime);
        const selEnd = Math.max(activeDrag.startTime, endTime);
        onSelectionChange?.({ start: selStart, end: selEnd });

        // User requirement: Automatically loop and play that section!
        if (onLoopSelection) {
          onLoopSelection(selStart, selEnd);
        } else if (onPlaySelection) {
          onPlaySelection(selStart, selEnd);
        }
      }
    } else if (
      (activeDrag?.type === 'selectionStart' || activeDrag?.type === 'selectionEnd' || activeDrag?.type === 'selectionMove') &&
      selection
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

  const handleContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (hoveredElement === 'marker' && hoveredMarkerId) {
      onRemoveMarker(hoveredMarkerId);
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

  const handleZoomCrop = () => {
    if (cropEnd - cropStart < 0.1) return;
    const nextZ = duration / (cropEnd - cropStart);
    onZoomChange(nextZ);
    onViewOffsetChange(cropStart);
  };

  // Minimap interactions (edge dragging to zoom in/out, inside dragging to slide, click to jump)
  const handleMinimapPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
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

  const cursorStyle = activeDrag
    ? 'cursor-grabbing'
    : markerTool === 'add'
    ? 'cursor-crosshair'
    : markerTool === 'remove'
    ? 'cursor-pointer'
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
    if (!selection || Math.abs(selection.end - selection.start) < 0.02) {
      setFeedbackToast({
        text: 'Select a quiet region (e.g. run-in groove or silence between tracks) on the waveform first.',
        type: 'warning',
      });
      setTimeout(() => setFeedbackToast(null), 4500);
      return;
    }
    const measured = measureNoiseFloorDb(audioBuffer, selection.start, selection.end);
    setNoiseFloorDb(measured.suggestedThresholdDb);
    setMeasuredPeakDb(measured.peakDb);
    setFeedbackToast({
      text: `Noise Floor Sampled! Peak: ${measured.peakDb.toFixed(1)} dB → Threshold set to ${measured.suggestedThresholdDb.toFixed(1)} dB`,
      type: 'success',
    });
    setTimeout(() => setFeedbackToast(null), 5000);
  };

  // Run Auto-Split using sampled noise floor and drop duration
  const handleTriggerAutoSplit = () => {
    if (!onAutoSplit) return;
    const count = onAutoSplit(noiseFloorDb, silenceDurationSec);
    if (typeof count === 'number') {
      if (count > 0) {
        setFeedbackToast({
          text: `Auto-Split created ${count} split ${count === 1 ? 'marker' : 'markers'} (${count + 1} tracks) at detected silence gaps!`,
          type: 'success',
        });
      } else {
        setFeedbackToast({
          text: `No silence gaps below ${noiseFloorDb.toFixed(1)} dB for ${silenceDurationSec.toFixed(1)}s were found. Try raising the threshold or lowering the duration.`,
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
      setTimeout(() => {
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

    handleScanAnomalousPeaks(suggestedThresh, scope);
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

  // Auto-scan when opening Peak Tamer popover
  useEffect(() => {
    if (showPeakTamerPopover && audioBuffer) {
      handleScanAnomalousPeaks();
    }
  }, [showPeakTamerPopover]);

  return (
    <div className="space-y-2 select-none flex flex-col h-full min-w-0 min-h-0 overflow-hidden" ref={containerRef}>
      {/* 1. Precision Audio Editing Toolbar (placed at top, between Recording Name bar and Waveform) */}
      <div className="order-2 flex items-center justify-between gap-1 bg-slate-900 border border-slate-800 px-2 py-1 rounded-xl text-xs flex-shrink-0 relative overflow-hidden">
        <div className="flex items-end flex-nowrap gap-1 min-w-0 w-full">
          {/* Markers Section */}
          <div className="order-4 relative flex items-center space-x-0.5 bg-slate-950/60 p-0.5 rounded-lg border border-slate-800/80 shrink-0 pt-2">
            <span className="absolute left-1 top-0 text-[7px] font-bold uppercase tracking-wider text-purple-400">Markers</span>
            {/* Add Marker (+) Toggle */}
            <TooltipButton
              onClick={() => setMarkerTool(markerTool === 'add' ? 'none' : 'add')}
              isActive={markerTool === 'add'}
              activeClass="bg-purple-600 text-white border-purple-500 shadow-sm"
              icon={<BookmarkPlus className="w-3.5 h-3.5" />}
              label="Add Marker (+) Toggle - Click waveform to place split markers"
              caption="Add"
              captionAbove
            />

            {/* Remove Marker (-) Toggle */}
            <TooltipButton
              onClick={() => setMarkerTool(markerTool === 'remove' ? 'none' : 'remove')}
              isActive={markerTool === 'remove'}
              activeClass="bg-rose-600 text-white border-rose-500 shadow-sm"
              icon={<BookmarkMinus className="w-3.5 h-3.5" />}
              label="Remove Marker (-) Toggle - Click waveform to remove nearest marker to cursor"
              caption="Remove"
              captionAbove
            />

            {/* Clear All Markers */}
            {onClearMarkers && (
              <TooltipButton
                onClick={onClearMarkers}
                disabled={markers.length === 0}
                icon={<Trash2 className={`w-3.5 h-3.5 ${markers.length > 0 ? 'text-slate-400 hover:text-rose-400' : 'text-slate-600'}`} />}
                label={markers.length > 0 ? `Clear All Split Markers (${markers.length})` : 'No markers to clear'}
                caption="Clear"
                captionAbove
              />
            )}
          </div>

          <div className="order-4 h-5 w-px bg-slate-800 mx-0.5" />

          {/* Noise Floor & Auto-Split Section */}
          <div className="order-3 relative h-12 flex items-center space-x-1 bg-slate-950/60 px-1.5 py-1 rounded-lg border border-slate-800/80 shrink-0 pt-2">
            <span className="absolute left-1 top-0 text-[7px] font-bold uppercase tracking-wider text-amber-400">Detection</span>
            {/* Sample Noise Floor Button (icon only) */}
            <TooltipButton
              onClick={handleSampleNoiseFloor}
              isActive={hasSelection}
              activeClass="bg-amber-600 text-white border-amber-500 shadow-sm"
              icon={<Activity className="w-3.5 h-3.5" />}
              label={
                hasSelection
                  ? 'Click to sample noise floor from active selection'
                  : 'Select a quiet region on the waveform first, then click to sample noise floor'
              }
              caption="Sample"
              captionAbove
              compact
            />

            {/* Noise Floor Threshold Pill & Popover */}
            <div className="relative flex flex-col items-center gap-0.5">
              <span className="text-[8px] font-bold uppercase tracking-wider text-slate-500">Threshold</span>
              <button
                type="button"
                onClick={() => setShowNoiseFloorPopover(!showNoiseFloorPopover)}
                className={`h-6 flex items-center gap-1 px-2 rounded-md text-[10px] font-mono font-bold transition cursor-pointer border ${
                  showNoiseFloorPopover
                    ? 'bg-amber-600 text-white border-amber-500'
                    : 'bg-slate-800/90 text-amber-400 border-slate-700 hover:border-slate-600'
                }`}
                title="Click to adjust noise floor threshold dB"
              >
                <span>{noiseFloorDb.toFixed(1)} dB</span>
              </button>

              {showNoiseFloorPopover && (
                <div className="absolute top-full left-0 mt-2 p-3 bg-slate-950 border border-slate-800 rounded-xl shadow-2xl text-xs space-y-2.5 w-60 z-50 animate-fade-in select-none">
                  <div className="flex justify-between items-center text-slate-300 font-semibold text-[11px]">
                    <span>Silence Threshold:</span>
                    <span className="text-amber-400 font-mono font-bold">{noiseFloorDb.toFixed(1)} dB</span>
                  </div>
                  <input
                    type="range"
                    min="-80"
                    max="-20"
                    step="0.5"
                    value={noiseFloorDb}
                    onChange={(e) => setNoiseFloorDb(parseFloat(e.target.value))}
                    className="w-full accent-amber-500 cursor-pointer h-1.5 bg-slate-800 rounded"
                  />
                  <div className="flex justify-between text-[9px] text-slate-400 font-mono">
                    <span>-80 dB (Quieter)</span>
                    <span>-20 dB (Louder)</span>
                  </div>
                  {measuredPeakDb !== null && (
                    <div className="text-[10px] text-slate-400 pt-1.5 border-t border-slate-800 flex justify-between">
                      <span>Sampled selection peak:</span>
                      <span className="font-mono text-slate-200">{measuredPeakDb.toFixed(1)} dB</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex flex-col items-center gap-0.5">
              <span className="text-[8px] font-bold uppercase tracking-wider text-slate-500">Snap</span>
              <button
                type="button"
                onClick={() => setSnapToNoiseFloor((enabled) => !enabled)}
                className={`w-6 h-6 px-1 rounded-md border text-[9px] font-bold uppercase tracking-wider transition cursor-pointer ${
                  snapToNoiseFloor
                    ? 'bg-sky-600 text-white border-sky-500'
                    : 'bg-slate-800/90 text-slate-400 border-slate-700 hover:text-slate-200'
                }`}
                title={`Snap manual edits to nearby audio below ${noiseFloorDb.toFixed(1)} dB (${snapToNoiseFloor ? 'on' : 'off'})`}
                aria-pressed={snapToNoiseFloor}
              >
                ON
              </button>
            </div>

            {/* Silence Duration Dropdown */}
            <div className="flex flex-col items-center gap-0.5 pl-1 border-l border-slate-800">
              <span className="text-[8px] text-slate-500 font-bold uppercase tracking-wider">Gap</span>
              <select
                value={silenceDurationSec}
                onChange={(e) => setSilenceDurationSec(parseFloat(e.target.value))}
                className="h-6 bg-slate-800 border border-slate-700 text-slate-200 font-mono text-[10px] rounded px-1 cursor-pointer focus:outline-none focus:border-emerald-500"
                title="Minimum duration of silence required to trigger an auto-split marker"
              >
                <option value="0.3">0.3s</option>
                <option value="0.5">0.5s</option>
                <option value="0.8">0.8s</option>
                <option value="1.0">1.0s</option>
                <option value="1.2">1.2s</option>
                <option value="1.5">1.5s</option>
                <option value="2.0">2.0s</option>
                <option value="2.5">2.5s</option>
                <option value="3.0">3.0s</option>
              </select>
            </div>

            {/* Auto-Split Action Button */}
            <div className="flex flex-col items-center gap-0.5">
              <span className="text-[8px] font-bold uppercase tracking-wider text-slate-500">Split</span>
              <button
                type="button"
                onClick={handleTriggerAutoSplit}
                className="flex items-center justify-center w-6 h-6 rounded-md bg-purple-600 hover:bg-purple-500 text-white transition cursor-pointer border border-purple-500/50 shadow-sm"
                title={`Detect where level drops to ${noiseFloorDb.toFixed(1)} dB for at least ${silenceDurationSec.toFixed(1)}s and place markers`}
                aria-label="Run automatic split detection"
              >
                <Sparkles className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Selection actions: permanent console controls beside detection */}
          <div className="order-1 relative h-12 flex items-start gap-1 bg-slate-950/60 px-1.5 py-1 rounded-lg border border-sky-500/25 shrink-0 pt-2">
            <div className="flex items-start gap-1 pr-1 border-r border-slate-800">
              <span className="text-[7px] font-bold uppercase tracking-wider text-sky-400">Selection</span>
              <span className="text-[9px] font-mono text-slate-400 whitespace-nowrap">
                {hasSelection ? `${formatTime(selS, true)} - ${formatTime(selE, true)}` : 'None'}
              </span>
            </div>
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
              caption="Loop"
              captionAbove
              compact
            />
            <TooltipButton
              onClick={() => onCropToSelection?.(selS, selE)}
              disabled={!hasSelection}
              activeClass="bg-sky-600 text-white border-sky-500"
              icon={<Crop className="w-3.5 h-3.5" />}
              label="Keep the selected region and discard everything outside it"
              caption="Crop"
              captionAbove
              compact
            />
            <TooltipButton
              onClick={() => onCutSelection?.(selS, selE)}
              disabled={!hasSelection}
              activeClass="bg-rose-600 text-white border-rose-500"
              icon={<Scissors className="w-3.5 h-3.5" />}
              label="Delete the selected region and splice the remaining audio"
              caption="Cut"
              captionAbove
              compact
            />
          </div>

          <div className="order-1 h-5 w-px bg-slate-800 mx-0.5" />

          {/* Edit Actions: Crop, Cut, Undo */}
          <div className="order-2 flex items-center space-x-1">
            <TooltipButton
              onClick={() => {
                if (selection) {
                  onCropToSelection?.(selS, selE);
                }
              }}
              disabled={!hasSelection}
              icon={<Crop className="w-3.5 h-3.5 text-sky-400" />}
              label="Crop to Selection (Ctrl+T): Discard audio outside selection"
              caption="Crop"
              captionAbove
            />

            <TooltipButton
              onClick={() => {
                if (selection) {
                  onCutSelection?.(selS, selE);
                }
              }}
              disabled={!hasSelection}
              icon={<Scissors className="w-3.5 h-3.5 text-rose-400" />}
              label="Cut Selection (Del / Backspace): Remove selected audio and splice"
              caption="Cut"
              captionAbove
            />

            {onUndo && (
              <TooltipButton
                onClick={onUndo}
                disabled={!canUndo}
                icon={<RotateCcw className="w-3.5 h-3.5 text-slate-300" />}
                label="Undo Audio Edit (Ctrl+Z)"
                caption="Undo"
                captionAbove
              />
            )}
          </div>

          <div className="order-2 h-5 w-px bg-slate-800 mx-0.5" />

          {/* Normalise, Curve, Peak Tamer */}

          {/* Normalise Peak Gain */}
          <div className="order-2 relative">
            <TooltipButton
              onClick={() => {
                setShowNormalisePopover(!showNormalisePopover);
                if (showPeakTamerPopover) setShowPeakTamerPopover(false);
              }}
              isActive={showNormalisePopover}
              activeClass="bg-amber-600 text-white border-amber-500 shadow-sm"
              icon={<UnfoldVertical className="w-3.5 h-3.5" />}
              label="Normalise Peak Gain"
              caption="Level"
              captionAbove
            />
            {showNormalisePopover && (
              <div className="absolute top-full right-0 mt-2 p-3 bg-slate-950 border border-slate-800 rounded shadow-2xl text-xs space-y-2 w-48 z-50 animate-fade-in select-none">
                <div className="flex justify-between items-center text-slate-300 font-semibold text-[11px]">
                  <span>Normalise Target:</span>
                  <span className="text-amber-400 font-mono font-bold">{normaliseTargetDb.toFixed(1)} dB</span>
                </div>
                <input
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
                  className="w-full py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded font-bold text-[10px] tracking-wider transition cursor-pointer border border-emerald-500/30"
                >
                  APPLY NORMALISATION
                </button>
              </div>
            )}
          </div>

          {/* Anomalous Peak Tamer */}
          <div className="order-2 relative">
            <TooltipButton
              onClick={() => {
                const nextState = !showPeakTamerPopover;
                setShowPeakTamerPopover(nextState);
                if (showNormalisePopover) setShowNormalisePopover(false);
              }}
              isActive={showPeakTamerPopover}
              activeClass="bg-amber-600 text-white border-amber-500 shadow-sm"
              icon={<AudioWaveform className="w-3.5 h-3.5" />}
              label="Anomalous Peak Tamer (Detect & Reduce Outlier Spikes)"
              caption="Repair"
              captionAbove
            />
            {showPeakTamerPopover && (
              <div className="absolute top-full right-0 mt-2 p-3 bg-slate-950 border border-slate-800 rounded-xl shadow-2xl text-xs space-y-2.5 w-80 z-50 animate-fade-in select-none">
                <div className="flex items-center justify-between border-b border-slate-800 pb-1.5">
                  <div className="flex items-center space-x-1.5 text-slate-200 font-bold text-[11px]">
                    <AudioWaveform className="w-3.5 h-3.5 text-amber-400" />
                    <span>Anomalous Peak Tamer</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowPeakTamerPopover(false)}
                    className="text-slate-400 hover:text-white p-0.5 cursor-pointer"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>

                <p className="text-[10px] text-slate-400 leading-tight">
                  Identifies anomalously high peak spikes (such as vinyl clicks or rogue transients) and smoothly attenuates them down to the musical program level to reclaim normalisation headroom.
                </p>

                {/* Scope selector if selection active */}
                {selection && (
                  <div className="space-y-1">
                    <div className="text-[9px] text-slate-400 font-semibold uppercase tracking-wider">
                      Target Range:
                    </div>
                    <div className="grid grid-cols-2 gap-1 bg-slate-900 p-0.5 rounded-lg border border-slate-800">
                      <button
                        type="button"
                        onClick={() => {
                          setPeakScope('selection');
                          handleScanAnomalousPeaks(peakThresholdDb, 'selection');
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
                          handleScanAnomalousPeaks(peakThresholdDb, 'all');
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
                  <div className="p-2 rounded-lg bg-slate-900/90 border border-slate-800 space-y-1 text-[10px]">
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
                <div className="space-y-2 bg-slate-900/60 p-2 rounded-lg border border-slate-800">
                  {/* Threshold Slider */}
                  <div className="space-y-1">
                    <div className="flex justify-between items-center text-[10px]">
                      <span className="text-slate-300 font-medium">Flag peaks exceeding:</span>
                      <div className="flex items-center space-x-1.5">
                        <button
                          type="button"
                          onClick={handleAutoSuggestThreshold}
                          className="px-1.5 py-0.5 bg-slate-800 hover:bg-slate-700 text-amber-300 rounded text-[9px] font-mono cursor-pointer border border-slate-700"
                          title="Auto-suggest threshold based on nominal music level"
                        >
                          Auto
                        </button>
                        <span className="text-amber-400 font-mono font-bold">{peakThresholdDb.toFixed(1)} dB</span>
                      </div>
                    </div>
                    <input
                      type="range"
                      min="-24"
                      max="0"
                      step="0.5"
                      value={peakThresholdDb}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        setPeakThresholdDb(val);
                        handleScanAnomalousPeaks(val);
                      }}
                      className="w-full accent-amber-500 cursor-pointer h-1.5 bg-slate-800 rounded"
                    />
                  </div>

                  {/* Target Ceiling Slider */}
                  <div className="space-y-1 pt-1 border-t border-slate-800/80">
                    <div className="flex justify-between items-center text-[10px]">
                      <span className="text-slate-300 font-medium">Reduce anomalous peaks down to:</span>
                      <span className="text-emerald-400 font-mono font-bold">{peakTargetCeilingDb.toFixed(1)} dB</span>
                    </div>
                    <input
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
                  <div className="space-y-1">
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
                <div className="space-y-1.5 pt-0.5">
                  <button
                    type="button"
                    onClick={() => handleScanAnomalousPeaks()}
                    disabled={isProcessingPeaks}
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
                    REDUCE ANOMALOUS PEAKS
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
                    REDUCE & NORMALISE ({normaliseTargetDb.toFixed(1)} dB)
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 2. Feedback Notification Toast */}
      {feedbackToast && (
        <div
          className={`order-3 flex items-center justify-between px-3 py-1.5 rounded-lg border text-xs font-semibold animate-fade-in flex-shrink-0 ${
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

      {/* 1. Main Waveform Canvas Container (fills remaining height dynamically) */}
      <div className="order-4 flex-1 min-h-0 relative rounded-xl overflow-hidden border border-slate-800 bg-slate-950 shadow-inner" ref={canvasContainerRef}>
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onContextMenu={handleContextMenu}
          className={`w-full block touch-none ${cursorStyle}`}
          style={{ height: `${canvasDimensions.height}px` }}
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
            {markerTool === 'add' ? (
              <span className="text-purple-400 text-[9px] font-sans px-1 bg-purple-500/10 rounded border border-purple-500/20 font-bold">+ Add Marker</span>
            ) : markerTool === 'remove' ? (
              <span className="text-rose-400 text-[9px] font-sans px-1 bg-rose-500/10 rounded border border-rose-500/20 font-bold">- Remove Nearest</span>
            ) : hoveredElement === 'selectionStart' || hoveredElement === 'selectionEnd' ? (
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

        {/* Playhead HUD Timecode Overlay inside bottom of canvas */}
        <div className="absolute bottom-3 left-3 bg-slate-950/85 border border-slate-800/80 px-2.5 py-1.5 rounded text-xs font-mono font-bold pointer-events-none select-none backdrop-blur-xs flex items-center gap-2">
          <span className="text-sky-400">PLAYHEAD: {formatTime(currentTime, true)}</span>
          <span className="text-slate-700">|</span>
          <span className="text-slate-200">Length: {formatTime(audioBuffer.duration)}</span>
          <span className="text-slate-700 hidden sm:inline">|</span>
          <span className="text-slate-200 hidden sm:inline">Rate: {audioBuffer.sampleRate} Hz</span>
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
          className="block w-full h-6.5 rounded bg-slate-950 touch-none select-none"
          style={{ cursor: minimapCursor }}
          title="Drag edges to zoom • Drag inside to slide • Click to jump view"
        />
        <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-mono text-slate-400 bg-slate-950/75 px-1.5 py-0.5 rounded">
          {zoom.toFixed(1)}x zoom • {formatTime(visibleDuration)} visible
        </div>
      </div>

      {/* 3. DAW Transport & Zoom Toolbar (at bottom) */}
      <div className="order-6 flex flex-wrap items-center justify-between gap-2 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-xl text-xs flex-shrink-0 relative">
        <div className="flex items-center flex-wrap gap-1.5">
          {/* Transport Controls (Symbol only, no text explanations) */}
          {onPlayPause && (
            <TooltipButton
              onClick={onPlayPause}
              isActive={isPlaying}
              activeClass="bg-emerald-600 text-white border-emerald-500 shadow-sm"
              icon={
                isPlaying ? (
                  <Pause className="w-3.5 h-3.5 fill-current" />
                ) : (
                  <Play className="w-3.5 h-3.5 fill-current text-slate-200" />
                )
              }
              label={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
              caption={isPlaying ? 'Pause' : 'Play'}
            />
          )}

          {onStop && (
            <TooltipButton
              onClick={onStop}
              icon={<Square className="w-3 h-3 fill-current text-slate-300" />}
              label="Stop Playback"
              caption="Stop"
            />
          )}

          {onToggleLoop && (
            <TooltipButton
              onClick={onToggleLoop}
              isActive={isLooping}
              activeClass="bg-emerald-600 text-white border-emerald-500 shadow-sm"
              icon={<Repeat className="w-3.5 h-3.5" />}
              label={`Loop Playback (${isLooping ? 'ON' : 'OFF'})`}
              caption="Loop"
            />
          )}

          <div className="h-5 w-px bg-slate-800 mx-0.5" />

          {/* Zoom Controls */}
          <TooltipButton
            onClick={handleZoomIn}
            icon={<ZoomIn className="w-3.5 h-3.5" />}
            label="Zoom In (Ctrl + Scroll Up)"
            caption="Zoom +"
          />
          <TooltipButton
            onClick={handleZoomOut}
            icon={<ZoomOut className="w-3.5 h-3.5" />}
            label="Zoom Out (Ctrl + Scroll Down)"
            caption="Zoom -"
          />
          <TooltipButton
            onClick={handleZoomFit}
            icon={<ScanLine className="w-3.5 h-3.5" />}
            label="Zoom to Fit Entire Audio File"
            caption="Fit"
          />

          <div className="h-5 w-px bg-slate-800 mx-0.5" />

          {/* Follow Playhead */}
          <TooltipButton
            onClick={() => setFollowPlayhead(!followPlayhead)}
            isActive={followPlayhead}
            icon={<Navigation className="w-3.5 h-3.5" />}
            label={`Auto-Scroll Follow Playhead (${followPlayhead ? 'ON' : 'OFF'})`}
          />

          <div className="h-5 w-px bg-slate-800 mx-0.5" />

          {/* Zero Crossing Snapping Toggle */}
          <TooltipButton
            onClick={() => onFadeSettingsChange({ ...fadeSettings, zeroCrossing: !fadeSettings.zeroCrossing })}
            isActive={fadeSettings.zeroCrossing}
            icon={<Zap className="w-3.5 h-3.5" />}
            label={`Zero-Crossing Snapping (${fadeSettings.zeroCrossing ? 'Active' : 'OFF'})`}
          />

          {/* Audition on Click */}
          <TooltipButton
            onClick={() => setAutoPreviewOnClick(!autoPreviewOnClick)}
            isActive={autoPreviewOnClick}
            icon={<Volume2 className="w-3.5 h-3.5" />}
            label={`Audition on Click (${autoPreviewOnClick ? 'ON' : 'OFF'})`}
          />
        </div>

      </div>
    </div>
  );
};