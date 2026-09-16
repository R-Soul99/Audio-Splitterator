import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Marker, FadeSettings, FadeCurve, TimeSelection } from '../types';
import { formatTime, calculateFadeGain, findZeroCrossing } from '../utils/audioProcessing';
import {
  ZoomIn,
  ZoomOut,
  BookmarkPlus,
  Zap,
  Sliders,
  Volume2,
  Navigation,
  ScanLine,
  Crop,
  Scissors,
  Play,
  Pause,
  X,
  SlidersHorizontal,
  RotateCcw,
  Repeat,
  ArrowLeftToLine,
  ArrowRightFromLine,
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
  onZoomChange: (zoom: number) => void;
  onViewOffsetChange: (offset: number) => void;
  onFadeSettingsChange: (settings: FadeSettings) => void;
  onNormalise: (targetPeakDb: number) => void; // UK spelling!
}

// Compact, uniform size icon button with 0.5s delayed HTML tooltip
interface TooltipButtonProps {
  onClick: (e: React.MouseEvent) => void;
  icon: React.ReactNode;
  label: string;
  isActive?: boolean;
  activeClass?: string;
  disabled?: boolean;
}

const TooltipButton: React.FC<TooltipButtonProps> = ({
  onClick,
  icon,
  label,
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
    <div className="relative inline-block" onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className={`w-9 h-9 flex items-center justify-center rounded-md border text-slate-300 font-semibold transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
          isActive
            ? activeClass
            : 'bg-slate-950 hover:bg-slate-800 border-slate-800 hover:border-slate-700'
        }`}
      >
        {icon}
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
  onZoomChange,
  onViewOffsetChange,
  onFadeSettingsChange,
  onNormalise,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const minimapRef = useRef<HTMLCanvasElement | null>(null);

  const [canvasDimensions, setCanvasDimensions] = useState({ width: 600, height: 180 });
  const [activeTool, setActiveTool] = useState<'smart' | 'marker'>('smart');
  const [autoPreviewOnClick, setAutoPreviewOnClick] = useState<boolean>(true);
  const [followPlayhead, setFollowPlayhead] = useState<boolean>(true);

  // Popover States
  const [showCurveDropdown, setShowCurveDropdown] = useState<boolean>(false);
  const [showNormalisePopover, setShowNormalisePopover] = useState<boolean>(false);
  const [normaliseTargetDb, setNormaliseTargetDb] = useState<number>(-0.5);

  // Dragging States
  const [activeDrag, setActiveDrag] = useState<{
    type: 'playhead' | 'marker' | 'fadeIn' | 'fadeOut' | 'selectionStart' | 'selectionEnd' | 'selectionMove' | 'selectionCreate';
    id?: string;
    startX?: number;
    startTime?: number;
  } | null>(null);

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

            const yMin = centerY + minVal * (channelHeight * 0.45);
            const yMax = centerY + maxVal * (channelHeight * 0.45);

            ctx.moveTo(x, yMin);
            ctx.lineTo(x, yMax);
          }
        }
        ctx.stroke();
      }
    }
  }, [canvasDimensions, currentOffset, visibleDuration, audioBuffer, xToTime]);

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

      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cropXStart, height);

      const fStep = Math.max(1, Math.round((fadeEndX - cropXStart) / 25));
      for (let px = cropXStart; px <= fadeEndX; px += fStep) {
        const pct = (px - cropXStart) / (fadeEndX - cropXStart);
        const gain = calculateFadeGain(pct, fadeSettings.fadeInCurve);
        ctx.lineTo(px, height - gain * height);
      }
      ctx.lineTo(fadeEndX, height - 1.0 * height);
      ctx.stroke();

      // Draggable fade nodes
      ctx.fillStyle = '#38bdf8';
      ctx.beginPath();
      ctx.arc(fadeEndX, 0, 5, 0, 2 * Math.PI);
      ctx.fill();
    }

    if (fadeSettings.fadeOutEnabled && cropXEnd >= 0 && cropXEnd <= width) {
      const fadeMs = fadeSettings.fadeOutMs;
      const fadeSec = fadeMs / 1000;
      const fadeStartX = timeToX(cropEnd - fadeSec, width);

      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(fadeStartX, 0);

      const fStep = Math.max(1, Math.round((cropXEnd - fadeStartX) / 25));
      for (let px = fadeStartX; px <= cropXEnd; px += fStep) {
        const pct = (px - fadeStartX) / (cropXEnd - fadeStartX);
        const gain = calculateFadeGain(1 - pct, fadeSettings.fadeOutCurve);
        ctx.lineTo(px, height - gain * height);
      }
      ctx.lineTo(cropXEnd, height);
      ctx.stroke();

      // Draggable fade nodes
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath();
      ctx.arc(fadeStartX, 0, 5, 0, 2 * Math.PI);
      ctx.fill();
    }

    // 4. Split Markers
    markers.forEach((m) => {
      const mx = timeToX(m.time, width);
      if (mx < 0 || mx > width) return;

      const isHovered = hoveredMarkerId === m.id;

      ctx.strokeStyle = isHovered ? '#c084fc' : '#a855f7'; // Purple-400 vs Purple-500
      ctx.lineWidth = isHovered ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.moveTo(mx, 0);
      ctx.lineTo(mx, height);
      ctx.stroke();

      // Flag top tag
      ctx.fillStyle = isHovered ? '#c084fc' : '#a855f7';
      ctx.beginPath();
      ctx.moveTo(mx - 5, 0);
      ctx.lineTo(mx + 5, 0);
      ctx.lineTo(mx, 8);
      ctx.closePath();
      ctx.fill();
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
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 0.75;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(hx, 0);
      ctx.lineTo(hx, height);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [canvasDimensions, cropStart, cropEnd, selection, markers, currentTime, hoverPosition, hoverTime, hoveredMarkerId, fadeSettings, timeToX]);

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
    ctx.fillStyle = '#047857'; // Emerald-700
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
      const yMin = (0.5 - min * 0.48) * height;
      const yMax = (0.5 - max * 0.48) * height;
      ctx.fillRect(x, yMin, 1.2, Math.max(1, yMax - yMin));
    }

    // Viewport window
    const viewWidthPct = visibleDuration / duration;
    const viewOffsetPct = currentOffset / duration;

    ctx.fillStyle = 'rgba(56, 189, 248, 0.15)'; // viewport highlight
    ctx.strokeStyle = '#0284c7';
    ctx.lineWidth = 1.5;

    const vx = viewOffsetPct * width;
    const vw = viewWidthPct * width;
    ctx.fillRect(vx, 0, vw, height);
    ctx.strokeRect(vx, 0, vw, height);
  }, [audioBuffer, zoom, currentOffset, visibleDuration, duration]);

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
        if (fadeSettings.zeroCrossing) {
          nextTime = snapToZeroCrossing(nextTime);
        }
        onSeek(nextTime);
      } else if (activeDrag.type === 'marker' && activeDrag.id) {
        let nextTime = Math.max(cropStart, Math.min(cropEnd, time));
        if (fadeSettings.zeroCrossing) {
          nextTime = snapToZeroCrossing(nextTime);
        }
        onMarkerMove(activeDrag.id, nextTime);
      } else if (activeDrag.type === 'fadeIn') {
        const nextMs = Math.max(1, Math.round((time - cropStart) * 1000));
        onFadeSettingsChange({ ...fadeSettings, fadeInMs: nextMs });
      } else if (activeDrag.type === 'fadeOut') {
        const nextMs = Math.max(1, Math.round((cropEnd - time) * 1000));
        onFadeSettingsChange({ ...fadeSettings, fadeOutMs: nextMs });
      } else if (activeDrag.type === 'selectionStart' && selection) {
        onSelectionChange({ ...selection, start: Math.max(0, Math.min(duration, time)) });
      } else if (activeDrag.type === 'selectionEnd' && selection) {
        onSelectionChange({ ...selection, end: Math.max(0, Math.min(duration, time)) });
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
          const s = Math.min(activeDrag.startTime, time);
          const e = Math.max(activeDrag.startTime, time);
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
      const fEndX = timeToX(cropStart + fadeSettings.fadeInMs / 1000, canvasDimensions.width);
      if (Math.abs(x - fEndX) < 7 && y < 20) {
        setHoveredElement('fadeIn');
        return;
      }
    }

    // 2. Check Fade Out handle
    if (fadeSettings.fadeOutEnabled) {
      const fStartX = timeToX(cropEnd - fadeSettings.fadeOutMs / 1000, canvasDimensions.width);
      if (Math.abs(x - fStartX) < 7 && y < 20) {
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

    // Hit actions
    if (hoveredElement === 'fadeIn') {
      setActiveDrag({ type: 'fadeIn' });
    } else if (hoveredElement === 'fadeOut') {
      setActiveDrag({ type: 'fadeOut' });
    } else if (hoveredElement === 'selectionStart') {
      setActiveDrag({ type: 'selectionStart' });
    } else if (hoveredElement === 'selectionEnd') {
      setActiveDrag({ type: 'selectionEnd' });
    } else if (hoveredElement === 'selectionBar' && selection) {
      setActiveDrag({ type: 'selectionMove', startTime: time, startX: selection.start });
    } else if (hoveredElement === 'marker' && hoveredMarkerId) {
      setActiveDrag({ type: 'marker', id: hoveredMarkerId });
    } else {
      // General canvas click
      if (activeTool === 'marker') {
        let markerTime = time;
        if (fadeSettings.zeroCrossing) {
          markerTime = snapToZeroCrossing(markerTime);
        }
        onAddMarker(markerTime);
      } else {
        // Smart tool: Record drag start point; don't trigger playback until pointer release
        setActiveDrag({ type: 'selectionCreate', startTime: time, startX: x });
      }
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

  const handleDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const time = xToTime(x, canvasDimensions.width);

    let markerTime = time;
    if (fadeSettings.zeroCrossing) {
      markerTime = snapToZeroCrossing(markerTime);
    }
    onAddMarker(markerTime);
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

  // Minimap interactions
  const handleMinimapPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const mini = minimapRef.current;
    if (!mini) return;
    const rect = mini.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const clickPct = x / mini.width;
    const targetCenter = clickPct * duration;

    const halfVisible = visibleDuration / 2;
    const nextOffset = Math.max(0, Math.min(maxOffset, targetCenter - halfVisible));
    onViewOffsetChange(nextOffset);
  };

  const handleMinimapPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.buttons !== 1) return;
    const mini = minimapRef.current;
    if (!mini) return;
    const rect = mini.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const clickPct = x / mini.width;
    const targetCenter = clickPct * duration;

    const halfVisible = visibleDuration / 2;
    const nextOffset = Math.max(0, Math.min(maxOffset, targetCenter - halfVisible));
    onViewOffsetChange(nextOffset);
  };

  const cursorStyle = activeDrag ? 'cursor-grabbing' : 'cursor-default';
  const minimapCursor = 'cursor-pointer';

  const hasSelection = Boolean(selection && Math.abs(selection.end - selection.start) > 0.02);
  const selS = selection ? Math.min(selection.start, selection.end) : 0;
  const selE = selection ? Math.max(selection.start, selection.end) : 0;
  const selLen = selE - selS;

  return (
    <div className="space-y-2 select-none flex flex-col h-full min-h-0" ref={containerRef}>
      {/* 0. Selection Action HUD (Appears when a region is selected) */}
      {hasSelection && (
        <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-900/95 border border-sky-500/40 px-3 py-1.5 rounded-xl text-xs shadow-lg backdrop-blur-xs flex-shrink-0 animate-fade-in">
          <div className="flex items-center space-x-2">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-sky-500/15 text-sky-300 font-mono font-bold text-xs border border-sky-500/30">
              <span className="w-2 h-2 rounded-full bg-sky-400 animate-pulse" />
              <span>Selection: {formatTime(selS, true)} – {formatTime(selE, true)}</span>
              <span className="text-slate-400 font-normal">({formatTime(selLen, true)})</span>
            </span>
          </div>

          <div className="flex items-center flex-wrap gap-1.5">
            {/* Loop Selection */}
            <button
              type="button"
              onClick={() => {
                if (onLoopSelection) {
                  onLoopSelection(selS, selE);
                } else if (onPlaySelection) {
                  onPlaySelection(selS, selE);
                }
              }}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold transition cursor-pointer border ${
                isLooping && isPlaying
                  ? 'bg-emerald-500/25 text-emerald-300 border-emerald-500/50 shadow-sm'
                  : 'bg-slate-800 hover:bg-slate-750 text-slate-200 border-slate-700'
              }`}
              title="Loop and play this selected region"
            >
              <Repeat className="w-3.5 h-3.5 text-emerald-400" />
              <span>{isLooping && isPlaying ? 'Looping Section' : 'Loop Section'}</span>
            </button>

            {/* Crop to Selection */}
            <button
              type="button"
              onClick={() => onCropToSelection?.(selS, selE)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold transition cursor-pointer border border-sky-500 shadow-sm"
              title="Crop to Selection: Keep this selection and discard outside audio (Ctrl+T)"
            >
              <Crop className="w-3.5 h-3.5" />
              <span>Crop to Selection</span>
            </button>

            {/* Cut Selection */}
            <button
              type="button"
              onClick={() => onCutSelection?.(selS, selE)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold transition cursor-pointer border border-rose-500 shadow-sm"
              title="Cut Selection: Delete this section and splice the rest together (Del / Backspace)"
            >
              <Scissors className="w-3.5 h-3.5" />
              <span>Cut Selection</span>
            </button>

            {/* Trim Start */}
            {onTrimStart && (
              <button
                type="button"
                onClick={onTrimStart}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-750 text-slate-200 text-xs font-semibold transition cursor-pointer border border-slate-700"
                title="Trim Start: Delete unnecessary audio from 0:00 up to selection start"
              >
                <ArrowLeftToLine className="w-3.5 h-3.5 text-amber-400" />
                <span>Trim Before Start</span>
              </button>
            )}

            {/* Trim End */}
            {onTrimEnd && (
              <button
                type="button"
                onClick={onTrimEnd}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-750 text-slate-200 text-xs font-semibold transition cursor-pointer border border-slate-700"
                title="Trim End: Delete unnecessary audio from selection end to track end"
              >
                <ArrowRightFromLine className="w-3.5 h-3.5 text-amber-400" />
                <span>Trim After End</span>
              </button>
            )}

            {/* Clear Selection */}
            <button
              type="button"
              onClick={() => onSelectionChange?.(null)}
              className="p-1 rounded-md bg-slate-800 hover:bg-slate-750 text-slate-400 hover:text-slate-200 border border-slate-700 transition cursor-pointer"
              title="Clear Selection (Escape)"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* 1. Main Waveform Canvas Container (fills remaining height dynamically) */}
      <div className="flex-1 min-h-0 relative rounded-xl overflow-hidden border border-slate-800 bg-slate-950 shadow-inner" ref={canvasContainerRef}>
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onDoubleClick={handleDoubleClick}
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

        {/* Playhead HUD Timecode Overlay inside bottom of canvas */}
        <div className="absolute bottom-3 left-3 bg-slate-950/85 border border-slate-800/80 px-2.5 py-1 rounded text-xs font-mono font-bold text-sky-400 pointer-events-none select-none backdrop-blur-xs">
          PLAYHEAD: {formatTime(currentTime, true)}
        </div>
      </div>

      {/* 2. Minimap Overview & Navigation Bar */}
      <div className="flex items-center space-x-2.5 bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-800 flex-shrink-0">
        <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider w-16 shrink-0">
          Overview:
        </span>
        <canvas
          ref={minimapRef}
          width={800}
          height={26}
          onPointerDown={handleMinimapPointerDown}
          onPointerMove={handleMinimapPointerMove}
          onPointerUp={handleMinimapPointerDown}
          className="w-full h-6.5 rounded bg-slate-950 border border-slate-800"
          style={{ cursor: minimapCursor }}
          title="Drag inside to slide • Click to jump view"
        />
        <div className="text-[10px] font-mono text-slate-400 shrink-0">
          {zoom.toFixed(1)}x zoom • {formatTime(visibleDuration)} visible
        </div>
      </div>

      {/* 3. Sleek, DAW Under-Waveform Toolbar (0.5s Hover delayed tooltips) */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-xl text-xs flex-shrink-0 relative">
        <div className="flex items-center flex-wrap gap-1.5">
          {/* Zoom Controls */}
          <TooltipButton
            onClick={handleZoomIn}
            icon={<ZoomIn className="w-3.5 h-3.5" />}
            label="Zoom In Waveform"
          />
          <TooltipButton
            onClick={handleZoomOut}
            icon={<ZoomOut className="w-3.5 h-3.5" />}
            label="Zoom Out Waveform"
          />
          <TooltipButton
            onClick={handleZoomFit}
            icon={<ScanLine className="w-3.5 h-3.5" />}
            label="Zoom to Fit Entire Audio File"
          />

          <div className="h-5 w-px bg-slate-800 mx-0.5" />

          {/* Curve foldout dropdown */}
          <div className="relative">
            <TooltipButton
              onClick={() => setShowCurveDropdown(!showCurveDropdown)}
              isActive={showCurveDropdown}
              icon={<Sliders className="w-3.5 h-3.5" />}
              label="Select Volume Fade Curve"
            />
            {showCurveDropdown && (
              <div className="absolute bottom-full left-0 mb-2 p-1 bg-slate-950 border border-slate-800 rounded shadow-2xl flex flex-col space-y-0.5 z-50 w-32 animate-fade-in">
                {(['scurve', 'logarithmic', 'linear'] as FadeCurve[]).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => {
                      onFadeSettingsChange({ ...fadeSettings, fadeInCurve: c, fadeOutCurve: c });
                      setShowCurveDropdown(false);
                    }}
                    className={`px-3 py-1.5 text-left text-[11px] font-semibold transition cursor-pointer capitalize hover:bg-slate-850 rounded-sm ${
                      fadeSettings.fadeInCurve === c ? 'text-emerald-400 font-bold' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {c === 'scurve' ? 'S-Curve' : c}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Audition on Click */}
          <TooltipButton
            onClick={() => setAutoPreviewOnClick(!autoPreviewOnClick)}
            isActive={autoPreviewOnClick}
            icon={<Volume2 className="w-3.5 h-3.5" />}
            label={`Audition on Click (${autoPreviewOnClick ? 'ON' : 'OFF'})`}
          />

          {/* Marker Tool */}
          <TooltipButton
            onClick={() => setActiveTool(activeTool === 'marker' ? 'smart' : 'marker')}
            isActive={activeTool === 'marker'}
            activeClass="bg-purple-600 text-white border-purple-500 shadow-sm"
            icon={<BookmarkPlus className="w-3.5 h-3.5" />}
            label="Marker Tool (Click waveform to drop split markers)"
          />

          {/* Zero Crossing Snapping Toggle */}
          <TooltipButton
            onClick={() => onFadeSettingsChange({ ...fadeSettings, zeroCrossing: !fadeSettings.zeroCrossing })}
            isActive={fadeSettings.zeroCrossing}
            icon={<Zap className="w-3.5 h-3.5" />}
            label={`Zero-Crossing Snapping (${fadeSettings.zeroCrossing ? 'Active' : 'OFF'})`}
          />

          {/* Follow Playhead */}
          <TooltipButton
            onClick={() => setFollowPlayhead(!followPlayhead)}
            isActive={followPlayhead}
            icon={<Navigation className="w-3.5 h-3.5" />}
            label={`Auto-Scroll Follow Playhead (${followPlayhead ? 'ON' : 'OFF'})`}
          />

          <div className="h-5 w-px bg-slate-800 mx-0.5" />

          {/* Dedicated Trim & Crop Buttons in Toolbar */}
          {onTrimStart && (
            <TooltipButton
              onClick={onTrimStart}
              icon={<ArrowLeftToLine className="w-3.5 h-3.5 text-amber-400" />}
              label="Trim Start: Delete unnecessary audio before playhead / selection start"
            />
          )}

          {onTrimEnd && (
            <TooltipButton
              onClick={onTrimEnd}
              icon={<ArrowRightFromLine className="w-3.5 h-3.5 text-amber-400" />}
              label="Trim End: Delete unnecessary audio after playhead / selection end"
            />
          )}

          <TooltipButton
            onClick={() => {
              if (selection) {
                onCropToSelection?.(selS, selE);
              }
            }}
            disabled={!hasSelection}
            icon={<Crop className="w-3.5 h-3.5 text-sky-400" />}
            label="Crop to Selection (Ctrl+T): Discard audio outside selection"
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
          />

          {onUndo && (
            <TooltipButton
              onClick={onUndo}
              disabled={!canUndo}
              icon={<RotateCcw className="w-3.5 h-3.5 text-slate-300" />}
              label="Undo Audio Edit (Ctrl+Z)"
            />
          )}
        </div>

        {/* Right: Normalise popup popover */}
        <div className="relative">
          <TooltipButton
            onClick={() => setShowNormalisePopover(!showNormalisePopover)}
            isActive={showNormalisePopover}
            activeClass="bg-amber-600 text-white border-amber-500 shadow-sm"
            icon={<SlidersHorizontal className="w-3.5 h-3.5" />}
            label="Normalise Peak Gain (UK English)"
          />
          {showNormalisePopover && (
            <div className="absolute bottom-full right-0 mb-2 p-3 bg-slate-950 border border-slate-800 rounded shadow-2xl text-xs space-y-2 w-48 z-50 animate-fade-in select-none">
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
      </div>
    </div>
  );
};