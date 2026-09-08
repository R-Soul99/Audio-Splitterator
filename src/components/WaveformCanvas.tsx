import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Marker, FadeSettings, FadeCurve, TimeSelection } from '../types';
import { formatTime, calculateFadeGain } from '../utils/audioProcessing';
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  BookmarkPlus,
  Zap,
  Sliders,
  Volume2,
  MousePointer,
  Sparkles,
  MoveHorizontal,
  ChevronLeft,
  ChevronRight,
  Navigation,
  ScanLine,
  Crop,
  Scissors,
  Play,
  X,
} from 'lucide-react';

interface WaveformCanvasProps {
  audioBuffer: AudioBuffer;
  currentTime: number;
  cropStart: number;
  cropEnd: number;
  markers: Marker[];
  zoom: number; // 1 to 50
  viewOffsetSec: number;
  fadeSettings: FadeSettings;
  isPlaying: boolean;
  selection?: TimeSelection | null;
  onSelectionChange?: (selection: TimeSelection | null) => void;
  onCropToSelection?: (start: number, end: number) => void;
  onCutSelection?: (start: number, end: number) => void;
  onPlaySelection?: (start: number, end: number) => void;
  onSeek: (time: number) => void;
  onPreviewStart?: (time: number) => void;
  onCropChange: (start: number, end: number) => void;
  onMarkerMove: (id: string, newTime: number) => void;
  onAddMarker: (time: number) => void;
  onRemoveMarker?: (id: string) => void;
  onZoomChange: (zoom: number) => void;
  onViewOffsetChange: (offset: number) => void;
  onFadeSettingsChange: (settings: FadeSettings) => void;
}

export const WaveformCanvas: React.FC<WaveformCanvasProps> = ({
  audioBuffer,
  currentTime,
  cropStart,
  cropEnd,
  markers,
  zoom,
  viewOffsetSec,
  fadeSettings,
  isPlaying,
  selection,
  onSelectionChange,
  onCropToSelection,
  onCutSelection,
  onPlaySelection,
  onSeek,
  onPreviewStart,
  onCropChange,
  onMarkerMove,
  onAddMarker,
  onRemoveMarker,
  onZoomChange,
  onViewOffsetChange,
  onFadeSettingsChange,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const minimapRef = useRef<HTMLCanvasElement | null>(null);

  // Selection handling (controlled with internal fallback)
  const [internalSelection, setInternalSelection] = useState<TimeSelection | null>(null);
  const currentSelection = selection !== undefined ? selection : internalSelection;
  const handleSelectionChange = useCallback(
    (newSel: TimeSelection | null) => {
      setInternalSelection(newSel);
      onSelectionChange?.(newSel);
    },
    [onSelectionChange]
  );

  // Tools & modes: 'smart' combines single-click to move playhead + drag to create selection brace
  const [activeTool, setActiveTool] = useState<'smart' | 'marker'>('smart');
  const [autoPreviewOnClick, setAutoPreviewOnClick] = useState<boolean>(true);
  const [followPlayhead, setFollowPlayhead] = useState<boolean>(true);

  // Synchronized refs for fresh event listener access
  const zoomRef = useRef(zoom);
  const viewOffsetRef = useRef(viewOffsetSec);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  useEffect(() => {
    viewOffsetRef.current = viewOffsetSec;
  }, [viewOffsetSec]);

  // Interaction dragging states
  type DragTarget =
    | { type: 'playhead' }
    | { type: 'cropStart' }
    | { type: 'cropEnd' }
    | { type: 'fadeIn' }
    | { type: 'fadeOut' }
    | { type: 'marker'; id: string }
    | { type: 'pan'; startX: number; startOffset: number }
    | { type: 'minimapWindow'; startX: number; startOffset: number }
    | { type: 'minimapLeftEdge'; originalOffset: number; originalVisible: number }
    | { type: 'minimapRightEdge'; originalOffset: number; originalVisible: number }
    | { type: 'potentialDrag'; startX: number; startY: number; originTime: number }
    | { type: 'selectionCreate'; originTime: number }
    | { type: 'selectionStart'; currentEnd: number }
    | { type: 'selectionEnd'; currentStart: number }
    | { type: 'selectionMove'; startHoverTime: number; originalStart: number; originalEnd: number }
    | null;

  const [activeDrag, setActiveDrag] = useState<DragTarget>(null);
  const [minimapCursor, setMinimapCursor] = useState<string>('pointer');
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverPosition, setHoverPosition] = useState<{ x: number; y: number } | null>(null);
  const [hoveredElement, setHoveredElement] = useState<string | null>(null);
  const [canvasDimensions, setCanvasDimensions] = useState<{ width: number; height: number }>({
    width: 800,
    height: 250,
  });

  const duration = audioBuffer.duration;
  const numChannels = audioBuffer.numberOfChannels;

  // Visible duration in seconds based on zoom
  const visibleDuration = duration / Math.max(1, zoom);
  const maxOffset = Math.max(0, duration - visibleDuration);
  const safeViewOffset = Math.min(maxOffset, Math.max(0, viewOffsetSec));

  // Convert time to canvas X coordinate
  const timeToX = useCallback(
    (time: number, width: number) => {
      if (visibleDuration <= 0) return 0;
      return ((time - safeViewOffset) / visibleDuration) * width;
    },
    [safeViewOffset, visibleDuration]
  );

  // Convert canvas X coordinate to time in seconds
  const xToTime = useCallback(
    (x: number, width: number) => {
      if (width <= 0) return 0;
      const frac = Math.max(0, Math.min(1, x / width));
      return safeViewOffset + frac * visibleDuration;
    },
    [safeViewOffset, visibleDuration]
  );

  // Resize observer to keep canvas sharp and responsive
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width } = entry.contentRect;
        if (width > 50) {
          setCanvasDimensions({ width: Math.floor(width), height: 250 });
        }
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Precomputed Multi-Resolution Peak Pyramid for fast, zero-lag rendering
  interface PeakLevel {
    blockSize: number;
    min: Float32Array;
    max: Float32Array;
  }
  interface ChannelPyramid {
    levels: PeakLevel[];
  }

  const pyramidsRef = useRef<ChannelPyramid[]>([]);
  const peaksRef = useRef<{ min: Float32Array; max: Float32Array }[]>([]);

  useEffect(() => {
    const totalSamples = audioBuffer.length;
    if (totalSamples === 0) return;

    const channelsData: Float32Array[] = [];
    for (let c = 0; c < numChannels; c++) {
      channelsData.push(audioBuffer.getChannelData(c));
    }

    const computedPyramids: ChannelPyramid[] = [];
    const computedPeaks: { min: Float32Array; max: Float32Array }[] = [];

    // Level 0: base decimated peaks (blockSize = 64 samples ~1.45ms)
    const b0Size = 64;
    const numB0 = Math.ceil(totalSamples / b0Size);
    // Level 1: blockSize = 512 samples (~11.6ms, 8x Level 0)
    const factor1 = 8;
    const numB1 = Math.ceil(numB0 / factor1);
    // Level 2: blockSize = 2048 samples (~46.4ms, 4x Level 1)
    const factor2 = 4;
    const numB2 = Math.ceil(numB1 / factor2);

    for (let c = 0; c < numChannels; c++) {
      const data = channelsData[c];

      // 1. Compute Level 0 (fast single-pass over data)
      const min0 = new Float32Array(numB0);
      const max0 = new Float32Array(numB0);
      for (let b = 0; b < numB0; b++) {
        const start = b * b0Size;
        const end = Math.min(totalSamples, start + b0Size);
        let minV = data[start] || 0;
        let maxV = data[start] || 0;
        for (let s = start + 1; s < end; s++) {
          const val = data[s];
          if (val < minV) minV = val;
          else if (val > maxV) maxV = val;
        }
        min0[b] = minV;
        max0[b] = maxV;
      }

      // 2. Compute Level 1 (from Level 0)
      const min1 = new Float32Array(numB1);
      const max1 = new Float32Array(numB1);
      for (let b = 0; b < numB1; b++) {
        const start = b * factor1;
        const end = Math.min(numB0, start + factor1);
        let minV = min0[start] || 0;
        let maxV = max0[start] || 0;
        for (let s = start + 1; s < end; s++) {
          const mn = min0[s];
          const mx = max0[s];
          if (mn < minV) minV = mn;
          if (mx > maxV) maxV = mx;
        }
        min1[b] = minV;
        max1[b] = maxV;
      }

      // 3. Compute Level 2 (from Level 1)
      const min2 = new Float32Array(numB2);
      const max2 = new Float32Array(numB2);
      for (let b = 0; b < numB2; b++) {
        const start = b * factor2;
        const end = Math.min(numB1, start + factor2);
        let minV = min1[start] || 0;
        let maxV = max1[start] || 0;
        for (let s = start + 1; s < end; s++) {
          const mn = min1[s];
          const mx = max1[s];
          if (mn < minV) minV = mn;
          if (mx > maxV) maxV = mx;
        }
        min2[b] = minV;
        max2[b] = maxV;
      }

      computedPyramids.push({
        levels: [
          { blockSize: b0Size, min: min0, max: max0 },
          { blockSize: b0Size * factor1, min: min1, max: max1 },
          { blockSize: b0Size * factor1 * factor2, min: min2, max: max2 },
        ],
      });

      // Provide minimap overview array (Level 1 for crisp, high-res overview)
      computedPeaks.push({ min: min1, max: max1 });
    }

    pyramidsRef.current = computedPyramids;
    peaksRef.current = computedPeaks;
  }, [audioBuffer, numChannels]);

  // Main canvas render
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width, height } = canvasDimensions;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = '#090d16';
    ctx.fillRect(0, 0, width, height);

    // Draw Grid & Time Ruler (top 24px)
    const rulerHeight = 24;
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, width, rulerHeight);
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, rulerHeight);
    ctx.lineTo(width, rulerHeight);
    ctx.stroke();

    // Determine grid time interval
    let timeStep = 5;
    if (visibleDuration <= 0.5) timeStep = 0.05;
    else if (visibleDuration <= 1) timeStep = 0.1;
    else if (visibleDuration <= 2.5) timeStep = 0.25;
    else if (visibleDuration <= 5) timeStep = 0.5;
    else if (visibleDuration <= 15) timeStep = 1;
    else if (visibleDuration <= 30) timeStep = 2;
    else if (visibleDuration <= 60) timeStep = 5;
    else if (visibleDuration <= 300) timeStep = 15;
    else if (visibleDuration <= 900) timeStep = 30;
    else timeStep = 60;

    const firstTickTime = Math.floor(safeViewOffset / timeStep) * timeStep;
    ctx.font = '10px ui-monospace, SFMono-Regular, monospace';
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'center';

    for (let t = firstTickTime; t <= safeViewOffset + visibleDuration; t += timeStep) {
      if (t < 0 || t > duration) continue;
      const x = timeToX(t, width);

      // Ruler tick
      ctx.strokeStyle = '#334155';
      ctx.beginPath();
      ctx.moveTo(x, 14);
      ctx.lineTo(x, rulerHeight);
      ctx.stroke();

      // Vertical subtle grid line in waveform area
      ctx.strokeStyle = '#131c2e';
      ctx.beginPath();
      ctx.moveTo(x, rulerHeight);
      ctx.lineTo(x, height);
      ctx.stroke();

      // Timestamp text
      ctx.fillText(formatTime(t, visibleDuration < 5), x, 11);
    }

    // Waveform Area
    const waveAreaTop = rulerHeight;
    const waveAreaHeight = height - rulerHeight;
    const channelHeight = waveAreaHeight / numChannels;

    // Render channels (Left / Right or Mono)
    const sampleRate = audioBuffer.sampleRate;
    const startSample = Math.floor(safeViewOffset * sampleRate);
    const endSample = Math.ceil((safeViewOffset + visibleDuration) * sampleRate);
    const viewSamples = Math.max(1, endSample - startSample);

    const fadeInSec = (fadeSettings.fadeInMs || 0) / 1000;
    const fadeOutSec = (fadeSettings.fadeOutMs || 0) / 1000;
    const cropStartX = timeToX(cropStart, width);
    const cropEndX = timeToX(cropEnd, width);
    const fadeInEndX = timeToX(cropStart + fadeInSec, width);
    const fadeOutStartX = timeToX(cropEnd - fadeOutSec, width);

    for (let c = 0; c < numChannels; c++) {
      const chData = audioBuffer.getChannelData(c);
      const chTop = waveAreaTop + c * channelHeight;
      const chMid = chTop + channelHeight / 2;

      // Channel baseline
      ctx.strokeStyle = '#1e293b';
      ctx.beginPath();
      ctx.moveTo(0, chMid);
      ctx.lineTo(width, chMid);
      ctx.stroke();

      // Channel label badge (L / R)
      ctx.fillStyle = '#475569';
      ctx.font = 'bold 9px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(c === 0 ? (numChannels > 1 ? 'LEFT' : 'MONO') : 'RIGHT', 8, chTop + 14);

      // Render waveform bars with volume fade envelope applied
      const samplesPerPixel = viewSamples / width;

      // When zoomed in very close (samples per pixel < 2), draw connecting lines
      if (samplesPerPixel < 2) {
        ctx.strokeStyle = '#10b981';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let x = 0; x < width; x++) {
          const sampleIdx = Math.floor(startSample + x * samplesPerPixel);
          if (sampleIdx >= 0 && sampleIdx < chData.length) {
            const val = chData[sampleIdx];
            const t = xToTime(x, width);
            let fg = 1.0;
            if (fadeSettings.fadeInEnabled && fadeInSec > 0 && t >= cropStart && t < cropStart + fadeInSec) {
              const frac = (t - cropStart) / fadeInSec;
              fg = calculateFadeGain(frac, fadeSettings.fadeInCurve);
            } else if (fadeSettings.fadeOutEnabled && fadeOutSec > 0 && t <= cropEnd && t > cropEnd - fadeOutSec) {
              const frac = (cropEnd - t) / fadeOutSec;
              fg = calculateFadeGain(frac, fadeSettings.fadeOutCurve);
            }
            const y = chMid - (val * fg) * (channelHeight * 0.46);
            if (x === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      } else {
        // Vertical min/max bars with fade attenuation (O(1) lookups via Multi-Level Peak Pyramid)
        const pyramid = pyramidsRef.current[c];
        const hasPyramid = pyramid && pyramid.levels && pyramid.levels.length > 0;

        // Choose appropriate pyramid LOD based on samplesPerPixel
        let lvl: PeakLevel | null = null;
        if (hasPyramid) {
          if (samplesPerPixel > 1024 && pyramid.levels[2]) {
            lvl = pyramid.levels[2]; // Level 2: blockSize 2048 (~46ms)
          } else if (samplesPerPixel > 128 && pyramid.levels[1]) {
            lvl = pyramid.levels[1]; // Level 1: blockSize 512 (~11ms)
          } else if (samplesPerPixel > 16 && pyramid.levels[0]) {
            lvl = pyramid.levels[0]; // Level 0: blockSize 64 (~1.4ms)
          }
        }

        // Luminous DAW-grade gradient: crisp crests with depth in the body
        const chTopPos = waveAreaTop + c * channelHeight;
        const waveGrad = ctx.createLinearGradient(0, chTopPos, 0, chTopPos + channelHeight);
        waveGrad.addColorStop(0, '#34d399');    // bright emerald-400 at crests
        waveGrad.addColorStop(0.3, '#10b981');  // emerald-500
        waveGrad.addColorStop(0.5, '#059669');  // deeper emerald-600 towards center
        waveGrad.addColorStop(0.7, '#10b981');  // emerald-500
        waveGrad.addColorStop(1, '#34d399');    // bright emerald-400 at trough
        ctx.fillStyle = waveGrad;

        for (let x = 0; x < width; x++) {
          const sStart = Math.floor(startSample + x * samplesPerPixel);
          const sEnd = Math.min(chData.length, Math.floor(startSample + (x + 1) * samplesPerPixel));
          let minV = 0;
          let maxV = 0;

          if (lvl) {
            const bSize = lvl.blockSize;
            const bStart = Math.max(0, Math.floor(sStart / bSize));
            const bEnd = Math.min(lvl.min.length, Math.max(bStart + 1, Math.ceil(sEnd / bSize)));

            minV = lvl.min[bStart] || 0;
            maxV = lvl.max[bStart] || 0;
            for (let b = bStart + 1; b < bEnd; b++) {
              const mn = lvl.min[b];
              const mx = lvl.max[b];
              if (mn < minV) minV = mn;
              if (mx > maxV) maxV = mx;
            }
          } else {
            for (let s = sStart; s < sEnd; s++) {
              const val = chData[s];
              if (val < minV) minV = val;
              if (val > maxV) maxV = val;
            }
          }

          const t = xToTime(x, width);
          let fg = 1.0;
          if (fadeSettings.fadeInEnabled && fadeInSec > 0 && t >= cropStart && t < cropStart + fadeInSec) {
            const frac = (t - cropStart) / fadeInSec;
            fg = calculateFadeGain(frac, fadeSettings.fadeInCurve);
          } else if (fadeSettings.fadeOutEnabled && fadeOutSec > 0 && t <= cropEnd && t > cropEnd - fadeOutSec) {
            const frac = (cropEnd - t) / fadeOutSec;
            fg = calculateFadeGain(frac, fadeSettings.fadeOutCurve);
          }

          const y1 = chMid - (maxV * fg) * (channelHeight * 0.46);
          const y2 = chMid - (minV * fg) * (channelHeight * 0.46);
          const barHeight = Math.max(1, y2 - y1);
          ctx.fillRect(x, y1, 1, barHeight);
        }
      }
    }

    // Crop Shading (Dim regions outside In & Out bounds)
    // Left dimmed region (before cropStart)
    if (cropStartX > 0) {
      ctx.fillStyle = 'rgba(2, 6, 23, 0.75)';
      ctx.fillRect(0, rulerHeight, cropStartX, waveAreaHeight);
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      ctx.strokeRect(0, rulerHeight, cropStartX, waveAreaHeight);
    }

    // Right dimmed region (after cropEnd)
    if (cropEndX < width) {
      ctx.fillStyle = 'rgba(2, 6, 23, 0.75)';
      ctx.fillRect(cropEndX, rulerHeight, width - cropEndX, waveAreaHeight);
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      ctx.strokeRect(cropEndX, rulerHeight, width - cropEndX, waveAreaHeight);
    }

    // =========================================================================
    // DRAW VOLUME FADE CURVES (From Channel Bottom to Top as shown in screenshot)
    // =========================================================================

    // 1. Draw Fade In Volume Curve & Shading
    if (fadeSettings.fadeInEnabled && fadeInSec > 0 && fadeInEndX > cropStartX) {
      for (let c = 0; c < numChannels; c++) {
        const chTop = waveAreaTop + c * channelHeight;
        const chBottom = chTop + channelHeight;
        const pad = 2;
        const usableHeight = channelHeight - pad * 2;

        ctx.save();
        // A. Subtle translucent gradient fill under the curve
        const grad = ctx.createLinearGradient(0, chTop, 0, chBottom);
        grad.addColorStop(0, 'rgba(56, 189, 248, 0.14)');
        grad.addColorStop(1, 'rgba(56, 189, 248, 0.02)');
        ctx.fillStyle = grad;

        ctx.beginPath();
        ctx.moveTo(cropStartX, chBottom - pad);

        for (let x = cropStartX; x <= fadeInEndX; x += 1) {
          const frac = (x - cropStartX) / Math.max(1, fadeInEndX - cropStartX);
          const gain = calculateFadeGain(frac, fadeSettings.fadeInCurve);
          const y = (chBottom - pad) - gain * usableHeight;
          ctx.lineTo(x, y);
        }

        ctx.lineTo(fadeInEndX, chBottom - pad);
        ctx.closePath();
        ctx.fill();

        // B. Dark contrast under-stroke to make the line pop
        ctx.strokeStyle = 'rgba(2, 6, 23, 0.9)';
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        for (let x = cropStartX; x <= fadeInEndX; x += 1) {
          const frac = (x - cropStartX) / Math.max(1, fadeInEndX - cropStartX);
          const gain = calculateFadeGain(frac, fadeSettings.fadeInCurve);
          const y = (chBottom - pad) - gain * usableHeight;
          if (x === cropStartX) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // C. Clean, smooth foreground curve line (Electric Sky)
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
      }

      // Vertical guideline at end of fade in
      ctx.save();
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(fadeInEndX, waveAreaTop);
      ctx.lineTo(fadeInEndX, waveAreaTop + waveAreaHeight);
      ctx.stroke();

      // Top draggable DAW Handle at (fadeInEndX, waveAreaTop)
      ctx.fillStyle = '#38bdf8';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(fadeInEndX - 6, waveAreaTop + 1, 12, 16, 2);
      ctx.fill();
      ctx.stroke();

      // Grip lines on handle
      ctx.strokeStyle = '#0369a1';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(fadeInEndX - 2, waveAreaTop + 4);
      ctx.lineTo(fadeInEndX - 2, waveAreaTop + 13);
      ctx.moveTo(fadeInEndX + 2, waveAreaTop + 4);
      ctx.lineTo(fadeInEndX + 2, waveAreaTop + 13);
      ctx.stroke();

      // Fade-In millisecond tag near handle
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 10px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`${fadeSettings.fadeInMs} ms`, fadeInEndX + 8, waveAreaTop + 13);
      ctx.restore();
    }

    // 2. Draw Fade Out Volume Curve & Shading
    if (fadeSettings.fadeOutEnabled && fadeOutSec > 0 && cropEndX > fadeOutStartX) {
      for (let c = 0; c < numChannels; c++) {
        const chTop = waveAreaTop + c * channelHeight;
        const chBottom = chTop + channelHeight;
        const pad = 2;
        const usableHeight = channelHeight - pad * 2;

        ctx.save();
        // A. Subtle translucent gradient fill under the curve
        const grad = ctx.createLinearGradient(0, chTop, 0, chBottom);
        grad.addColorStop(0, 'rgba(245, 158, 11, 0.14)');
        grad.addColorStop(1, 'rgba(245, 158, 11, 0.02)');
        ctx.fillStyle = grad;

        ctx.beginPath();
        ctx.moveTo(fadeOutStartX, chBottom - pad);

        for (let x = fadeOutStartX; x <= cropEndX; x += 1) {
          const frac = (cropEndX - x) / Math.max(1, cropEndX - fadeOutStartX);
          const gain = calculateFadeGain(frac, fadeSettings.fadeOutCurve);
          const y = (chBottom - pad) - gain * usableHeight;
          ctx.lineTo(x, y);
        }

        ctx.lineTo(cropEndX, chBottom - pad);
        ctx.closePath();
        ctx.fill();

        // B. Dark contrast under-stroke to make the line pop
        ctx.strokeStyle = 'rgba(2, 6, 23, 0.9)';
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        for (let x = fadeOutStartX; x <= cropEndX; x += 1) {
          const frac = (cropEndX - x) / Math.max(1, cropEndX - fadeOutStartX);
          const gain = calculateFadeGain(frac, fadeSettings.fadeOutCurve);
          const y = (chBottom - pad) - gain * usableHeight;
          if (x === fadeOutStartX) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // C. Clean, smooth foreground curve line (Amber)
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
      }

      // Vertical guideline at start of fade out
      ctx.save();
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(fadeOutStartX, waveAreaTop);
      ctx.lineTo(fadeOutStartX, waveAreaTop + waveAreaHeight);
      ctx.stroke();

      // Top draggable DAW Handle at (fadeOutStartX, waveAreaTop)
      ctx.fillStyle = '#f59e0b';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(fadeOutStartX - 6, waveAreaTop + 1, 12, 16, 2);
      ctx.fill();
      ctx.stroke();

      // Grip lines on handle
      ctx.strokeStyle = '#78350f';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(fadeOutStartX - 2, waveAreaTop + 4);
      ctx.lineTo(fadeOutStartX - 2, waveAreaTop + 13);
      ctx.moveTo(fadeOutStartX + 2, waveAreaTop + 4);
      ctx.lineTo(fadeOutStartX + 2, waveAreaTop + 13);
      ctx.stroke();

      // Fade-Out millisecond tag near handle
      ctx.fillStyle = '#f59e0b';
      ctx.font = 'bold 10px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`${fadeSettings.fadeOutMs} ms`, fadeOutStartX - 8, waveAreaTop + 13);
      ctx.restore();
    }

    // 3. Screenshot-style DAW timing badge in top-left corner
    if (fadeSettings.fadeInEnabled && fadeInSec > 0 && audioBuffer) {
      const sampleCount = Math.round((fadeSettings.fadeInMs / 1000) * audioBuffer.sampleRate);
      ctx.save();
      ctx.fillStyle = 'rgba(2, 6, 23, 0.88)';
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      const boxWidth = 96;
      const boxHeight = 18;
      ctx.beginPath();
      ctx.roundRect(8, rulerHeight + 5, boxWidth, boxHeight, 3);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${fadeSettings.fadeInMs} ms  ${sampleCount}`, 8 + boxWidth / 2, rulerHeight + 17);
      ctx.restore();
    }

    // Draw Crop In Boundary Handle (Green)
    if (cropStartX >= -20 && cropStartX <= width + 20) {
      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cropStartX, rulerHeight);
      ctx.lineTo(cropStartX, height);
      ctx.stroke();

      // Flag handle at ruler top
      ctx.fillStyle = '#10b981';
      ctx.beginPath();
      ctx.roundRect(cropStartX - 1, rulerHeight - 19, 52, 17, 3);
      ctx.fill();
      ctx.fillStyle = '#022c22';
      ctx.font = 'bold 9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('IN CROP', cropStartX + 25, rulerHeight - 7);
    }

    // Draw Crop Out Boundary Handle (Amber)
    if (cropEndX >= -20 && cropEndX <= width + 20) {
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cropEndX, rulerHeight);
      ctx.lineTo(cropEndX, height);
      ctx.stroke();

      // Flag handle at ruler top
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath();
      ctx.roundRect(cropEndX - 59, rulerHeight - 19, 58, 17, 3);
      ctx.fill();
      ctx.fillStyle = '#451a03';
      ctx.font = 'bold 9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('OUT CROP', cropEndX - 30, rulerHeight - 7);
    }

    // Draw Split Markers (Purple/Cyan dashed lines with badges)
    markers.forEach((marker, idx) => {
      const mx = timeToX(marker.time, width);
      if (mx >= -30 && mx <= width + 30) {
        // Vertical dashed line
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = '#a855f7';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(mx, rulerHeight);
        ctx.lineTo(mx, height);
        ctx.stroke();
        ctx.restore();

        // Flag badge
        ctx.fillStyle = '#a855f7';
        ctx.beginPath();
        const badgeWidth = 46;
        ctx.roundRect(mx - badgeWidth / 2, rulerHeight + 6, badgeWidth, 16, 3);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 9px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`M${idx + 1}`, mx, rulerHeight + 17);
      }
    });
  }, [
    canvasDimensions,
    audioBuffer,
    cropStart,
    cropEnd,
    markers,
    zoom,
    safeViewOffset,
    visibleDuration,
    duration,
    numChannels,
    timeToX,
    fadeSettings,
  ]);

  // Keep overlay canvas matching device pixel dimensions
  useEffect(() => {
    const overlay = overlayCanvasRef.current;
    if (!overlay) return;
    const { width, height } = canvasDimensions;
    const dpr = window.devicePixelRatio || 1;
    overlay.width = width * dpr;
    overlay.height = height * dpr;
  }, [canvasDimensions]);

  // Dedicated high-performance Real-Time Playhead & Marker Overlay Render Loop
  useEffect(() => {
    const overlay = overlayCanvasRef.current;
    if (!overlay) return;
    const ctx = overlay.getContext('2d');
    if (!ctx) return;

    const { width, height } = canvasDimensions;
    const dpr = window.devicePixelRatio || 1;

    // Reset transform matrix and clear entire overlay canvas cleanly
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    ctx.scale(dpr, dpr);

    const rulerHeight = 24;
    const playheadX = timeToX(currentTime, width);

    // Render Selection Brace (Region shading, draggable brackets, connecting rail bar)
    if (currentSelection && Math.abs(currentSelection.end - currentSelection.start) > 0.001) {
      const sStart = Math.min(currentSelection.start, currentSelection.end);
      const sEnd = Math.max(currentSelection.start, currentSelection.end);
      const selStartX = timeToX(sStart, width);
      const selEndX = timeToX(sEnd, width);
      const selSpan = sEnd - sStart;
      const waveHeight = height - rulerHeight;

      ctx.save();

      // 1. Shaded Selection Region Fill
      const grad = ctx.createLinearGradient(0, rulerHeight, 0, height);
      grad.addColorStop(0, 'rgba(14, 165, 233, 0.28)');
      grad.addColorStop(0.5, 'rgba(56, 189, 248, 0.16)');
      grad.addColorStop(1, 'rgba(14, 165, 233, 0.24)');
      ctx.fillStyle = grad;
      ctx.fillRect(selStartX, rulerHeight, Math.max(1, selEndX - selStartX), waveHeight);

      // Clipped hatched subtle diagonal stripes
      ctx.save();
      ctx.beginPath();
      ctx.rect(selStartX, rulerHeight, Math.max(1, selEndX - selStartX), waveHeight);
      ctx.clip();
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.12)';
      ctx.lineWidth = 1;
      const stripeInterval = 20;
      for (let sx = selStartX - height; sx <= selEndX + height; sx += stripeInterval) {
        ctx.beginPath();
        ctx.moveTo(sx, rulerHeight);
        ctx.lineTo(sx + waveHeight, height);
        ctx.stroke();
      }
      ctx.restore();

      // Top and bottom horizontal boundary outlines
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(selStartX, rulerHeight);
      ctx.lineTo(selEndX, rulerHeight);
      ctx.moveTo(selStartX, height - 1);
      ctx.lineTo(selEndX, height - 1);
      ctx.stroke();

      // 2. Connecting Horizontal Brace Rail Bar
      const braceBarY = rulerHeight + 1;
      const braceBarHeight = 17;
      const braceBarWidth = Math.max(8, selEndX - selStartX);
      const isBarActive = hoveredElement === 'selectionBar' || activeDrag?.type === 'selectionMove';
      ctx.fillStyle = isBarActive ? 'rgba(2, 132, 199, 0.95)' : 'rgba(2, 132, 199, 0.8)';
      ctx.strokeStyle = isBarActive ? '#7dd3fc' : '#38bdf8';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(selStartX, braceBarY, braceBarWidth, braceBarHeight, 3);
      ctx.fill();
      ctx.stroke();

      // Grip marks on the brace bar
      const midX = (selStartX + selEndX) / 2;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(midX - 6, braceBarY + 4);
      ctx.lineTo(midX - 6, braceBarY + 13);
      ctx.moveTo(midX - 2, braceBarY + 4);
      ctx.lineTo(midX - 2, braceBarY + 13);
      ctx.moveTo(midX + 2, braceBarY + 4);
      ctx.lineTo(midX + 2, braceBarY + 13);
      ctx.moveTo(midX + 6, braceBarY + 4);
      ctx.lineTo(midX + 6, braceBarY + 13);
      ctx.stroke();

      if (braceBarWidth >= 90) {
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 9px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`↔ ${selSpan.toFixed(2)}s (DRAG)`, midX, braceBarY + 12);
      }

      // 3. Left Brace Bracket [
      const isLeftActive = hoveredElement === 'selectionStart' || activeDrag?.type === 'selectionStart';
      ctx.strokeStyle = isLeftActive ? '#38bdf8' : '#0284c7';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(selStartX + 9, rulerHeight);
      ctx.lineTo(selStartX, rulerHeight);
      ctx.lineTo(selStartX, height);
      ctx.lineTo(selStartX + 9, height);
      ctx.stroke();

      // Left Bracket Flag in ruler
      const lbWidth = 62;
      const lbLeft = Math.max(2, selStartX - lbWidth);
      ctx.fillStyle = isLeftActive ? '#0284c7' : '#0369a1';
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(lbLeft, 2, lbWidth, 19, 3);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`[ ${formatTime(sStart, false)}`, lbLeft + lbWidth / 2, 14.5);

      // 4. Right Brace Bracket ]
      const isRightActive = hoveredElement === 'selectionEnd' || activeDrag?.type === 'selectionEnd';
      ctx.strokeStyle = isRightActive ? '#38bdf8' : '#0284c7';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(selEndX - 9, rulerHeight);
      ctx.lineTo(selEndX, rulerHeight);
      ctx.lineTo(selEndX, height);
      ctx.lineTo(selEndX - 9, height);
      ctx.stroke();

      // Right Bracket Flag in ruler
      const rbWidth = 62;
      const rbLeft = Math.min(width - rbWidth - 2, selEndX);
      ctx.fillStyle = isRightActive ? '#0284c7' : '#0369a1';
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(rbLeft, 2, rbWidth, 19, 3);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${formatTime(sEnd, false)} ]`, rbLeft + rbWidth / 2, 14.5);

      ctx.restore();
    }

    // Render Real-Time Playhead Marker
    if (playheadX >= -10 && playheadX <= width + 10) {
      // 1. Soft glowing neon cyan aura
      ctx.save();
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(playheadX, rulerHeight);
      ctx.lineTo(playheadX, height);
      ctx.stroke();

      // 2. High-visibility solid cyan line
      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, height);
      ctx.stroke();

      // 3. Crisp white center core line
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, height);
      ctx.stroke();

      // 4. Live Scrubber Badge in top ruler with exact real-time timecode
      const timeStr = formatTime(currentTime, true);
      ctx.font = 'bold 9.5px ui-monospace, SFMono-Regular, monospace';
      const textWidth = ctx.measureText(timeStr).width;
      const badgeWidth = Math.max(70, textWidth + 14);
      const badgeHeight = 18;
      const badgeLeft = Math.max(2, Math.min(width - badgeWidth - 2, playheadX - badgeWidth / 2));
      const badgeTop = 2;

      // Scrubber pill badge background
      ctx.fillStyle = isPlaying ? '#0284c7' : '#0369a1';
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(badgeLeft, badgeTop, badgeWidth, badgeHeight, 4);
      ctx.fill();
      ctx.stroke();

      // Downward pointer arrowhead dipping into waveform
      ctx.fillStyle = '#38bdf8';
      ctx.beginPath();
      ctx.moveTo(playheadX - 5, badgeTop + badgeHeight);
      ctx.lineTo(playheadX + 5, badgeTop + badgeHeight);
      ctx.lineTo(playheadX, rulerHeight + 4);
      ctx.closePath();
      ctx.fill();

      // Live position text inside badge
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.fillText(timeStr, badgeLeft + badgeWidth / 2, badgeTop + 12.5);

      // 5. Bottom caliper foot tab
      ctx.fillStyle = '#38bdf8';
      ctx.beginPath();
      ctx.roundRect(playheadX - 6, height - 6, 12, 6, 2);
      ctx.fill();

      ctx.restore();
    }

    // 6. Hover cursor guideline (when hovering and not dragging playhead)
    if (hoverPosition && hoverTime !== null && activeDrag?.type !== 'playhead') {
      const hx = hoverPosition.x;
      if (hx >= 0 && hx <= width && Math.abs(hx - playheadX) > 8) {
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(hx, rulerHeight);
        ctx.lineTo(hx, height);
        ctx.stroke();
        ctx.restore();
      }
    }
  }, [
    canvasDimensions,
    currentTime,
    currentSelection,
    duration,
    safeViewOffset,
    visibleDuration,
    timeToX,
    isPlaying,
    hoverPosition,
    hoverTime,
    hoveredElement,
    activeDrag,
  ]);

  // Follow Playhead auto-scroll during playback when zoomed in
  useEffect(() => {
    if (isPlaying && followPlayhead && zoom > 1) {
      if (currentTime > safeViewOffset + visibleDuration * 0.88 || currentTime < safeViewOffset) {
        const targetOffset = Math.max(0, Math.min(maxOffset, currentTime - visibleDuration * 0.2));
        onViewOffsetChange(targetOffset);
      }
    }
  }, [currentTime, isPlaying, followPlayhead, zoom, safeViewOffset, visibleDuration, maxOffset, onViewOffsetChange]);

  // Minimap / Overview canvas render
  useEffect(() => {
    const mini = minimapRef.current;
    if (!mini) return;
    const ctx = mini.getContext('2d');
    if (!ctx) return;

    const width = mini.width;
    const height = mini.height;

    // Background
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, width, height);

    // Peaks summary (multi-resolution decimation without aliasing)
    if (peaksRef.current.length > 0) {
      const peakData = peaksRef.current[0];
      const count = peakData.max.length;

      const miniGrad = ctx.createLinearGradient(0, 0, 0, height);
      miniGrad.addColorStop(0, '#34d399');
      miniGrad.addColorStop(0.5, '#059669');
      miniGrad.addColorStop(1, '#34d399');
      ctx.fillStyle = miniGrad;

      for (let i = 0; i < width; i++) {
        const startIdx = Math.floor((i / width) * count);
        const endIdx = Math.min(count, Math.max(startIdx + 1, Math.ceil(((i + 1) / width) * count)));
        let maxV = 0;
        let minV = 0;
        for (let p = startIdx; p < endIdx; p++) {
          const mx = peakData.max[p] || 0;
          const mn = peakData.min[p] || 0;
          if (mx > maxV) maxV = mx;
          if (mn < minV) minV = mn;
        }
        const midY = height / 2;
        const yTop = midY - maxV * (height * 0.44);
        const yBottom = midY - minV * (height * 0.44);
        const barH = Math.max(1, yBottom - yTop);
        ctx.fillRect(i, yTop, 1, barH);
      }
    }

    // Crop bounds highlight
    const miniCropStartX = (cropStart / duration) * width;
    const miniCropEndX = (cropEnd / duration) * width;
    ctx.fillStyle = 'rgba(16, 185, 129, 0.15)';
    ctx.fillRect(miniCropStartX, 0, miniCropEndX - miniCropStartX, height);

    // Selection brace highlight on minimap
    if (currentSelection && Math.abs(currentSelection.end - currentSelection.start) > 0.001) {
      const sStart = Math.min(currentSelection.start, currentSelection.end);
      const sEnd = Math.max(currentSelection.start, currentSelection.end);
      const miniSelStartX = (sStart / duration) * width;
      const miniSelEndX = (sEnd / duration) * width;
      ctx.fillStyle = 'rgba(56, 189, 248, 0.45)';
      ctx.fillRect(miniSelStartX, 0, Math.max(2, miniSelEndX - miniSelStartX), height);
      ctx.strokeStyle = '#38bdf8';
      ctx.strokeRect(miniSelStartX, 0, Math.max(2, miniSelEndX - miniSelStartX), height);
    }

    // Viewport window box
    const viewStartX = (safeViewOffset / duration) * width;
    const viewWidth = Math.max(8, (visibleDuration / duration) * width);
    const viewEndX = viewStartX + viewWidth;

    // Interior shading
    ctx.fillStyle = 'rgba(56, 189, 248, 0.18)';
    ctx.fillRect(viewStartX, 1, viewWidth, height - 2);

    // Box outline
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(viewStartX, 1, viewWidth, height - 2);

    // Draggable Left Edge Handle Bar & Pip
    ctx.fillStyle = '#38bdf8';
    ctx.fillRect(viewStartX - 1.5, 1, 3, height - 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(viewStartX - 0.5, height / 2 - 3, 1.5, 6);

    // Draggable Right Edge Handle Bar & Pip
    ctx.fillStyle = '#38bdf8';
    ctx.fillRect(viewEndX - 1.5, 1, 3, height - 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(viewEndX - 0.5, height / 2 - 3, 1.5, 6);

    // Playhead on minimap
    const miniPlayX = (currentTime / duration) * width;
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(miniPlayX, 0);
    ctx.lineTo(miniPlayX, height);
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(miniPlayX, 3, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }, [audioBuffer, cropStart, cropEnd, currentTime, duration, safeViewOffset, visibleDuration]);

  // Pointer Down Handler
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const clickedTime = xToTime(x, canvasDimensions.width);

    canvas.setPointerCapture(e.pointerId);

    // Fade handles coordinates
    const fadeInSec = (fadeSettings.fadeInMs || 0) / 1000;
    const fadeOutSec = (fadeSettings.fadeOutMs || 0) / 1000;
    const fadeInEndX = timeToX(cropStart + fadeInSec, canvasDimensions.width);
    const fadeOutStartX = timeToX(cropEnd - fadeOutSec, canvasDimensions.width);

    // 1. Hit test Fade In Handle (top 45px area near fadeInEndX)
    if (y <= 50 && Math.abs(x - fadeInEndX) <= 14) {
      setActiveDrag({ type: 'fadeIn' });
      return;
    }

    // 2. Hit test Fade Out Handle (top 45px area near fadeOutStartX)
    if (y <= 50 && Math.abs(x - fadeOutStartX) <= 14) {
      setActiveDrag({ type: 'fadeOut' });
      return;
    }

    // 3. Hit test Selection Brace Brackets & Rail Bar (if active selection exists)
    if (currentSelection && Math.abs(currentSelection.end - currentSelection.start) > 0.001) {
      const sStart = Math.min(currentSelection.start, currentSelection.end);
      const sEnd = Math.max(currentSelection.start, currentSelection.end);
      const selStartX = timeToX(sStart, canvasDimensions.width);
      const selEndX = timeToX(sEnd, canvasDimensions.width);
      const rulerHeight = 24;

      // Hit test Left Brace Bracket handle
      if (Math.abs(x - selStartX) <= 14) {
        setActiveDrag({ type: 'selectionStart', currentEnd: sEnd });
        return;
      }

      // Hit test Right Brace Bracket handle
      if (Math.abs(x - selEndX) <= 14) {
        setActiveDrag({ type: 'selectionEnd', currentStart: sStart });
        return;
      }

      // Hit test Top Brace Rail Bar (allows repositioning entire selection span)
      if (y >= rulerHeight && y <= rulerHeight + 22 && x >= Math.min(selStartX, selEndX) && x <= Math.max(selStartX, selEndX)) {
        setActiveDrag({
          type: 'selectionMove',
          startHoverTime: clickedTime,
          originalStart: sStart,
          originalEnd: sEnd,
        });
        return;
      }
    }

    // 4. Hit test Crop Start boundary handle
    const cropStartX = timeToX(cropStart, canvasDimensions.width);
    if (Math.abs(x - cropStartX) <= 14) {
      setActiveDrag({ type: 'cropStart' });
      return;
    }

    // 5. Hit test Crop End boundary handle
    const cropEndX = timeToX(cropEnd, canvasDimensions.width);
    if (Math.abs(x - cropEndX) <= 14) {
      setActiveDrag({ type: 'cropEnd' });
      return;
    }

    // 6. Hit test Split Markers
    for (const m of markers) {
      const mx = timeToX(m.time, canvasDimensions.width);
      if (Math.abs(x - mx) <= 14) {
        setActiveDrag({ type: 'marker', id: m.id });
        return;
      }
    }

    // 7. Middle click or Alt-click: Pan
    if (e.button === 1 || e.altKey) {
      setActiveDrag({ type: 'pan', startX: x, startOffset: safeViewOffset });
      return;
    }

    // 8. Timeline Ruler (top 24px): Clicking or dragging directly scrubs the playhead
    if (y <= 24) {
      onSeek(clickedTime);
      if (autoPreviewOnClick && onPreviewStart) {
        onPreviewStart(clickedTime);
      }
      setActiveDrag({ type: 'playhead' });
      return;
    }

    // 9. If Marker Tool is active: Click places a marker!
    if (activeTool === 'marker') {
      onAddMarker(clickedTime);
      return;
    }

    // 10. Smart Selection & Seek Control (DAW Style):
    // If Shift is pressed and an existing selection exists, expand/extend the selection range
    if (e.shiftKey && currentSelection) {
      const anchor = Math.min(currentSelection.start, currentSelection.end);
      setActiveDrag({ type: 'selectionCreate', originTime: anchor });
      handleSelectionChange({
        start: Math.min(anchor, clickedTime),
        end: Math.max(anchor, clickedTime),
      });
      return;
    }

    // Otherwise initiate potential drag:
    // - If pointer moves >= 4px: dynamically sculpts the Selection Brace range
    // - If pointer released without moving >= 4px: single click moves playhead & auditions preview
    setActiveDrag({
      type: 'potentialDrag',
      startX: x,
      startY: y,
      originTime: clickedTime,
    });
  };

  // Pointer Move Handler
  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const currentHoverTime = xToTime(x, canvasDimensions.width);

    setHoverTime(currentHoverTime);
    setHoverPosition({ x, y });

    // Detect hovered element for cursor styling
    const fadeInSec = (fadeSettings.fadeInMs || 0) / 1000;
    const fadeOutSec = (fadeSettings.fadeOutMs || 0) / 1000;
    const fadeInEndX = timeToX(cropStart + fadeInSec, canvasDimensions.width);
    const fadeOutStartX = timeToX(cropEnd - fadeOutSec, canvasDimensions.width);
    const cropStartX = timeToX(cropStart, canvasDimensions.width);
    const cropEndX = timeToX(cropEnd, canvasDimensions.width);

    let nearMarker = false;
    for (const m of markers) {
      const mx = timeToX(m.time, canvasDimensions.width);
      if (Math.abs(x - mx) <= 16) {
        nearMarker = true;
        break;
      }
    }

    if (currentSelection && Math.abs(currentSelection.end - currentSelection.start) > 0.001) {
      const sStart = Math.min(currentSelection.start, currentSelection.end);
      const sEnd = Math.max(currentSelection.start, currentSelection.end);
      const selStartX = timeToX(sStart, canvasDimensions.width);
      const selEndX = timeToX(sEnd, canvasDimensions.width);
      const rulerHeight = 24;

      if (Math.abs(x - selStartX) <= 14) {
        setHoveredElement('selectionStart');
      } else if (Math.abs(x - selEndX) <= 14) {
        setHoveredElement('selectionEnd');
      } else if (y >= rulerHeight && y <= rulerHeight + 22 && x >= Math.min(selStartX, selEndX) && x <= Math.max(selStartX, selEndX)) {
        setHoveredElement('selectionBar');
      } else if (y <= 50 && Math.abs(x - fadeInEndX) <= 14) {
        setHoveredElement('fadeIn');
      } else if (y <= 50 && Math.abs(x - fadeOutStartX) <= 14) {
        setHoveredElement('fadeOut');
      } else if (Math.abs(x - cropStartX) <= 12) {
        setHoveredElement('cropStart');
      } else if (Math.abs(x - cropEndX) <= 12) {
        setHoveredElement('cropEnd');
      } else if (nearMarker) {
        setHoveredElement('marker');
      } else {
        setHoveredElement(null);
      }
    } else {
      if (y <= 50 && Math.abs(x - fadeInEndX) <= 14) {
        setHoveredElement('fadeIn');
      } else if (y <= 50 && Math.abs(x - fadeOutStartX) <= 14) {
        setHoveredElement('fadeOut');
      } else if (Math.abs(x - cropStartX) <= 12) {
        setHoveredElement('cropStart');
      } else if (Math.abs(x - cropEndX) <= 12) {
        setHoveredElement('cropEnd');
      } else if (nearMarker) {
        setHoveredElement('marker');
      } else {
        setHoveredElement(null);
      }
    }

    if (!activeDrag) return;

    if (activeDrag.type === 'potentialDrag') {
      const dist = Math.hypot(x - activeDrag.startX, y - activeDrag.startY);
      // Exceeded drag threshold: immediately transition into Selection Brace creation!
      if (dist >= 4) {
        setActiveDrag({ type: 'selectionCreate', originTime: activeDrag.originTime });
        const s = Math.min(activeDrag.originTime, currentHoverTime);
        const e = Math.max(activeDrag.originTime, currentHoverTime);
        handleSelectionChange({
          start: Math.max(0, s),
          end: Math.min(duration, e),
        });
      }
      return;
    }

    if (activeDrag.type === 'selectionCreate') {
      const s = Math.min(activeDrag.originTime, currentHoverTime);
      const e = Math.max(activeDrag.originTime, currentHoverTime);
      handleSelectionChange({
        start: Math.max(0, s),
        end: Math.min(duration, e),
      });
    } else if (activeDrag.type === 'playhead') {
      const clamped = Math.max(0, Math.min(duration, currentHoverTime));
      onSeek(clamped);
    } else if (activeDrag.type === 'selectionStart') {
      const newStart = Math.max(0, Math.min(activeDrag.currentEnd - 0.05, currentHoverTime));
      handleSelectionChange({
        start: newStart,
        end: activeDrag.currentEnd,
      });
    } else if (activeDrag.type === 'selectionEnd') {
      const newEnd = Math.min(duration, Math.max(activeDrag.currentStart + 0.05, currentHoverTime));
      handleSelectionChange({
        start: activeDrag.currentStart,
        end: newEnd,
      });
    } else if (activeDrag.type === 'selectionMove') {
      const dt = currentHoverTime - activeDrag.startHoverTime;
      const span = activeDrag.originalEnd - activeDrag.originalStart;
      let newStart = activeDrag.originalStart + dt;
      let newEnd = activeDrag.originalEnd + dt;
      if (newStart < 0) {
        newStart = 0;
        newEnd = span;
      }
      if (newEnd > duration) {
        newEnd = duration;
        newStart = Math.max(0, duration - span);
      }
      handleSelectionChange({
        start: newStart,
        end: newEnd,
      });
    } else if (activeDrag.type === 'cropStart') {
      const newStart = Math.max(0, Math.min(cropEnd - 0.05, currentHoverTime));
      onCropChange(newStart, cropEnd);
    } else if (activeDrag.type === 'cropEnd') {
      const newEnd = Math.min(duration, Math.max(cropStart + 0.05, currentHoverTime));
      onCropChange(cropStart, newEnd);
    } else if (activeDrag.type === 'fadeIn') {
      // Dragging Fade-In handle: moves between cropStart and cropEnd
      const rawMs = Math.round((currentHoverTime - cropStart) * 1000);
      const clampedMs = Math.max(0, Math.min(5000, rawMs));
      onFadeSettingsChange({
        ...fadeSettings,
        fadeInEnabled: clampedMs > 0,
        fadeInMs: clampedMs,
      });
    } else if (activeDrag.type === 'fadeOut') {
      // Dragging Fade-Out handle: moves between cropStart and cropEnd
      const rawMs = Math.round((cropEnd - currentHoverTime) * 1000);
      const clampedMs = Math.max(0, Math.min(5000, rawMs));
      onFadeSettingsChange({
        ...fadeSettings,
        fadeOutEnabled: clampedMs > 0,
        fadeOutMs: clampedMs,
      });
    } else if (activeDrag.type === 'marker') {
      const newTime = Math.max(0, Math.min(duration, currentHoverTime));
      onMarkerMove(activeDrag.id, newTime);
    } else if (activeDrag.type === 'pan') {
      const deltaX = x - activeDrag.startX;
      const deltaTime = (deltaX / canvasDimensions.width) * visibleDuration;
      const newOffset = Math.max(0, Math.min(maxOffset, activeDrag.startOffset - deltaTime));
      onViewOffsetChange(newOffset);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (canvasRef.current && canvasRef.current.hasPointerCapture(e.pointerId)) {
      canvasRef.current.releasePointerCapture(e.pointerId);
    }

    if (activeDrag?.type === 'potentialDrag') {
      // Single Click: move playhead to clicked spot and preview!
      onSeek(activeDrag.originTime);
      if (autoPreviewOnClick && onPreviewStart) {
        onPreviewStart(activeDrag.originTime);
      }
      // Single click on waveform dismisses/clears any active selection
      handleSelectionChange(null);
    } else if (activeDrag?.type === 'selectionCreate') {
      if (currentSelection && Math.abs(currentSelection.end - currentSelection.start) < 0.02) {
        // Negligible drag (<20ms): clear selection and move playhead
        handleSelectionChange(null);
        onSeek(activeDrag.originTime);
        if (autoPreviewOnClick && onPreviewStart) {
          onPreviewStart(activeDrag.originTime);
        }
      } else if (currentSelection) {
        // Selection Brace established: position playhead at start of selection
        const start = Math.min(currentSelection.start, currentSelection.end);
        onSeek(start);
      }
    }

    setActiveDrag(null);
  };

  // Native Wheel Event Listener for smooth Scrollwheel Zooming:
  // - Holding Ctrl or Alt (or trackpad pinch): Zooms centered on mouse cursor
  // - Holding Shift: Pans waveform left/right
  // - Without Ctrl/Alt/Shift: Passes through naturally so the user can scroll the page!
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onNativeWheel = (e: WheelEvent) => {
      // 1. Shift + Wheel: Horizontal pan
      if (e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        const currentZoom = zoomRef.current;
        const currentOffset = viewOffsetRef.current;
        const currentVisible = duration / Math.max(1, currentZoom);
        const panTime = (e.deltaY / 100) * (currentVisible * 0.1);
        const newOffset = Math.max(0, Math.min(duration - currentVisible, currentOffset + panTime));
        onViewOffsetChange(newOffset);
        return;
      }

      // 2. Only zoom when Ctrl, Alt, or Meta is held (or trackpad pinch zoom which sets ctrlKey: true)
      // This prevents accidental zooming when simply scrolling past the waveform on the page!
      if (!e.ctrlKey && !e.altKey && !e.metaKey) {
        return;
      }

      // Intercept wheel event and perform smooth cursor-centered zoom
      e.preventDefault();
      e.stopPropagation();

      const rect = container.getBoundingClientRect();
      const mouseX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const currentWidth = canvasDimensions.width || rect.width;

      const currentZoom = zoomRef.current;
      const currentOffset = viewOffsetRef.current;

      const currentVisible = duration / Math.max(1, currentZoom);
      const frac = mouseX / currentWidth;
      const mouseTime = currentOffset + frac * currentVisible;

      // Determine zoom direction and factor
      const zoomFactor = e.deltaY < 0 ? 1.25 : 0.8;
      const targetZoom = Math.max(1, Math.min(50, currentZoom * zoomFactor));

      if (Math.abs(targetZoom - currentZoom) < 0.001) return;

      const newVisible = duration / targetZoom;
      const newOffset = Math.max(0, Math.min(duration - newVisible, mouseTime - frac * newVisible));

      onZoomChange(targetZoom);
      onViewOffsetChange(newOffset);
    };

    container.addEventListener('wheel', onNativeWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', onNativeWheel);
    };
  }, [canvasDimensions.width, duration, onZoomChange, onViewOffsetChange]);

  // Double Click: Add split marker
  const handleDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const time = xToTime(x, canvasDimensions.width);
    onAddMarker(time);
  };

  // Right Click: Delete accidental/unwanted marker near cursor
  const handleContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;

    // Find closest marker to click position
    let closestMarker: Marker | null = null;
    let minPixelDist = Infinity;

    for (const m of markers) {
      const mx = timeToX(m.time, canvasDimensions.width);
      const dist = Math.abs(x - mx);
      if (dist < minPixelDist) {
        minPixelDist = dist;
        closestMarker = m;
      }
    }

    // If right-clicked within 28px of a marker line or ruler flag
    if (closestMarker && minPixelDist <= 28 && onRemoveMarker) {
      onRemoveMarker(closestMarker.id);
    }
  };

  // Minimap click, edge-resize to zoom, or window-drag to pan viewport
  const handleMinimapPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const mini = minimapRef.current;
    if (!mini) return;
    const rect = mini.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const viewStartX = (safeViewOffset / duration) * rect.width;
    const viewWidth = Math.max(8, (visibleDuration / duration) * rect.width);
    const viewEndX = viewStartX + viewWidth;
    const edgeHitDist = 8; // 8px hit-target for resizing overview edges

    mini.setPointerCapture(e.pointerId);

    // 1. Hit-test Left Edge of overview box -> Resize left edge to zoom in/out
    if (Math.abs(x - viewStartX) <= edgeHitDist) {
      setActiveDrag({
        type: 'minimapLeftEdge',
        originalOffset: safeViewOffset,
        originalVisible: visibleDuration,
      });
      setMinimapCursor('ew-resize');
      return;
    }

    // 2. Hit-test Right Edge of overview box -> Resize right edge to zoom in/out
    if (Math.abs(x - viewEndX) <= edgeHitDist) {
      setActiveDrag({
        type: 'minimapRightEdge',
        originalOffset: safeViewOffset,
        originalVisible: visibleDuration,
      });
      setMinimapCursor('ew-resize');
      return;
    }

    // 3. Inside overview box -> Slide/pan viewport window
    if (x >= viewStartX && x <= viewEndX) {
      setActiveDrag({ type: 'minimapWindow', startX: x, startOffset: safeViewOffset });
      setMinimapCursor('grabbing');
      return;
    }

    // 4. Clicked outside overview box -> Center viewport on clicked timestamp
    const frac = x / rect.width;
    const targetCenterTime = frac * duration;
    const newOffset = Math.max(0, Math.min(maxOffset, targetCenterTime - visibleDuration / 2));
    onViewOffsetChange(newOffset);
    setActiveDrag({ type: 'minimapWindow', startX: x, startOffset: newOffset });
    setMinimapCursor('grabbing');
  };

  const handleMinimapPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const mini = minimapRef.current;
    if (!mini) return;
    const rect = mini.getBoundingClientRect();
    const x = e.clientX - rect.left;

    // A. Active drag actions
    if (activeDrag) {
      if (activeDrag.type === 'minimapLeftEdge') {
        const timeAtCursor = (x / rect.width) * duration;
        const rightEdgeTime = activeDrag.originalOffset + activeDrag.originalVisible;
        const minVisible = duration / 50; // max zoom 50x
        const maxVisible = duration; // 1x
        const newOffset = Math.max(0, Math.min(rightEdgeTime - minVisible, timeAtCursor));
        const newVisible = Math.max(minVisible, Math.min(maxVisible, rightEdgeTime - newOffset));
        const newZoom = Math.max(1, Math.min(50, duration / newVisible));
        onZoomChange(newZoom);
        onViewOffsetChange(newOffset);
        setMinimapCursor('ew-resize');
        return;
      }

      if (activeDrag.type === 'minimapRightEdge') {
        const timeAtCursor = (x / rect.width) * duration;
        const leftEdgeTime = safeViewOffset;
        const minVisible = duration / 50;
        const maxVisible = duration - leftEdgeTime;
        const newVisible = Math.max(minVisible, Math.min(maxVisible, timeAtCursor - leftEdgeTime));
        const newZoom = Math.max(1, Math.min(50, duration / newVisible));
        onZoomChange(newZoom);
        setMinimapCursor('ew-resize');
        return;
      }

      if (activeDrag.type === 'minimapWindow') {
        const deltaPixels = x - activeDrag.startX;
        const deltaTime = (deltaPixels / rect.width) * duration;
        const newOffset = Math.max(0, Math.min(maxOffset, activeDrag.startOffset + deltaTime));
        onViewOffsetChange(newOffset);
        setMinimapCursor('grabbing');
        return;
      }
      return;
    }

    // B. Hover state: dynamically switch cursor between ew-resize, grab, and pointer
    const viewStartX = (safeViewOffset / duration) * rect.width;
    const viewWidth = Math.max(8, (visibleDuration / duration) * rect.width);
    const viewEndX = viewStartX + viewWidth;
    const edgeHitDist = 8;

    if (Math.abs(x - viewStartX) <= edgeHitDist || Math.abs(x - viewEndX) <= edgeHitDist) {
      setMinimapCursor('ew-resize');
    } else if (x > viewStartX && x < viewEndX) {
      setMinimapCursor('grab');
    } else {
      setMinimapCursor('pointer');
    }
  };

  const handleMinimapPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (minimapRef.current && minimapRef.current.hasPointerCapture(e.pointerId)) {
      minimapRef.current.releasePointerCapture(e.pointerId);
    }
    if (
      activeDrag &&
      (activeDrag.type === 'minimapWindow' ||
        activeDrag.type === 'minimapLeftEdge' ||
        activeDrag.type === 'minimapRightEdge')
    ) {
      setActiveDrag(null);
      setMinimapCursor('pointer');
    }
  };

  // Zoom helpers
  const handleZoomIn = () => {
    const newZoom = Math.min(50, zoom * 1.4);
    const newVisible = duration / newZoom;
    const newOffset = Math.max(0, Math.min(duration - newVisible, currentTime - newVisible / 2));
    onZoomChange(newZoom);
    onViewOffsetChange(newOffset);
  };

  const handleZoomOut = () => {
    const newZoom = Math.max(1, zoom / 1.4);
    const newVisible = duration / newZoom;
    const newOffset = Math.max(0, Math.min(duration - newVisible, currentTime - newVisible / 2));
    onZoomChange(newZoom);
    onViewOffsetChange(newOffset);
  };

  const handleZoomFit = () => {
    onZoomChange(1);
    onViewOffsetChange(0);
  };

  const handleZoomCrop = () => {
    const cropSpan = Math.max(0.2, cropEnd - cropStart);
    const targetZoom = Math.max(1, Math.min(50, duration / cropSpan));
    onZoomChange(targetZoom);
    onViewOffsetChange(cropStart);
  };

  // Dynamic cursor style based on hover and active tool
  let cursorStyle = 'cursor-crosshair';
  if (hoveredElement === 'fadeIn' || hoveredElement === 'fadeOut') {
    cursorStyle = 'cursor-ew-resize';
  } else if (
    hoveredElement === 'cropStart' ||
    hoveredElement === 'cropEnd' ||
    hoveredElement === 'selectionStart' ||
    hoveredElement === 'selectionEnd'
  ) {
    cursorStyle = 'cursor-col-resize';
  } else if (hoveredElement === 'selectionBar' || activeDrag?.type === 'selectionMove') {
    cursorStyle = activeDrag?.type === 'selectionMove' ? 'cursor-grabbing' : 'cursor-grab';
  } else if (activeDrag?.type === 'selectionCreate') {
    cursorStyle = 'cursor-col-resize';
  } else if (activeTool === 'marker') {
    cursorStyle = 'cursor-copy';
  }

  return (
    <div className="space-y-2 select-none" ref={containerRef}>
      {/* Top Waveform Header: Visual Fade Settings, Zoom & Marker Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-900 border border-slate-800 px-4 py-2 rounded-xl text-xs">
        {/* Left: Mode tools & Preview click toggle */}
        <div className="flex items-center space-x-2">
          {/* Smart Tool: Click to Seek, Drag to Select */}
          <button
            type="button"
            onClick={() => setActiveTool('smart')}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg font-semibold transition cursor-pointer border ${
              activeTool === 'smart'
                ? 'bg-sky-600 text-white border-sky-500 shadow-sm'
                : 'bg-slate-950 hover:bg-slate-800 text-slate-300 border-slate-800'
            }`}
            title="Smart Tool: Single click to move playhead, drag to create selection brace"
          >
            <ScanLine className="w-3.5 h-3.5 text-sky-200" />
            <span>Smart Tool</span>
          </button>

          {/* Audition on Click Toggle */}
          <button
            type="button"
            onClick={() => setAutoPreviewOnClick(!autoPreviewOnClick)}
            className={`flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg font-semibold transition cursor-pointer border ${
              autoPreviewOnClick
                ? 'bg-emerald-600/20 text-emerald-300 border-emerald-500/40 hover:bg-emerald-600/30'
                : 'bg-slate-950 hover:bg-slate-800 text-slate-400 border-slate-800'
            }`}
            title="Audition audio from clicked position when single clicking"
          >
            <Volume2 className="w-3.5 h-3.5" />
            <span>Audition on Click: {autoPreviewOnClick ? 'ON' : 'OFF'}</span>
          </button>

          {/* Marker Tool Toggle */}
          <button
            type="button"
            onClick={() => setActiveTool(activeTool === 'marker' ? 'smart' : 'marker')}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg font-semibold transition cursor-pointer border ${
              activeTool === 'marker'
                ? 'bg-purple-600 text-white border-purple-500 shadow-sm'
                : 'bg-slate-950 hover:bg-slate-800 text-slate-300 border-slate-800'
            }`}
            title="Click waveform anywhere to drop split markers (or double-click anytime)"
          >
            <BookmarkPlus className="w-3.5 h-3.5 text-purple-300" />
            <span>Marker Tool</span>
          </button>

          {/* Zero Crossing Switch */}
          <label className="flex items-center space-x-1.5 cursor-pointer bg-slate-950 px-2.5 py-1.5 rounded-lg border border-slate-800 hover:border-slate-700 transition">
            <input
              type="checkbox"
              checked={fadeSettings.zeroCrossing}
              onChange={(e) => onFadeSettingsChange({ ...fadeSettings, zeroCrossing: e.target.checked })}
              className="rounded accent-emerald-500 w-3.5 h-3.5 cursor-pointer"
            />
            <div className="flex items-center space-x-1 text-[11px] font-semibold text-slate-200">
              <Zap className="w-3 h-3 text-amber-400" />
              <span>Zero-Crossing</span>
            </div>
          </label>

          {/* Real-time Playhead Position Readout */}
          <div className="flex items-center space-x-2 bg-slate-950 px-2.5 py-1.5 rounded-lg border border-slate-800">
            <div
              className={`w-2 h-2 rounded-full ${
                isPlaying ? 'bg-emerald-400 animate-pulse' : 'bg-sky-400'
              }`}
            />
            <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">Playhead:</span>
            <span className="text-xs font-mono font-bold text-sky-300">{formatTime(currentTime, true)}</span>
          </div>

          {/* Follow Playhead Auto-Scroll Toggle */}
          <button
            type="button"
            onClick={() => setFollowPlayhead(!followPlayhead)}
            className={`flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold transition cursor-pointer border ${
              followPlayhead
                ? 'bg-sky-500/20 text-sky-300 border-sky-500/40'
                : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200'
            }`}
            title="Auto-scroll view to follow real-time playhead marker during playback"
          >
            <Navigation className="w-3.5 h-3.5 text-sky-400" />
            <span>Follow Playhead: {followPlayhead ? 'ON' : 'OFF'}</span>
          </button>
        </div>

        {/* Center: Draggable Fade Curve Shapes & Presets */}
        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-1.5 bg-slate-950 px-2.5 py-1 rounded-lg border border-slate-800">
            <Sliders className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-[11px] font-medium text-slate-400">Curve:</span>
            <button
              type="button"
              onClick={() =>
                onFadeSettingsChange({
                  ...fadeSettings,
                  fadeInCurve: 'scurve',
                  fadeOutCurve: 'scurve',
                })
              }
              className={`px-2 py-0.5 rounded text-[10px] font-semibold transition cursor-pointer ${
                fadeSettings.fadeInCurve === 'scurve'
                  ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Smooth S-Curve natural volume transition"
            >
              S-Curve
            </button>
            <button
              type="button"
              onClick={() =>
                onFadeSettingsChange({
                  ...fadeSettings,
                  fadeInCurve: 'logarithmic',
                  fadeOutCurve: 'logarithmic',
                })
              }
              className={`px-2 py-0.5 rounded text-[10px] font-semibold transition cursor-pointer ${
                fadeSettings.fadeInCurve === 'logarithmic'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Logarithmic natural perceptual volume decay"
            >
              Logarithmic
            </button>
            <button
              type="button"
              onClick={() =>
                onFadeSettingsChange({
                  ...fadeSettings,
                  fadeInCurve: 'linear',
                  fadeOutCurve: 'linear',
                })
              }
              className={`px-2 py-0.5 rounded text-[10px] font-semibold transition cursor-pointer ${
                fadeSettings.fadeInCurve === 'linear'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Linear straight volume slope"
            >
              Linear
            </button>
          </div>

          {/* Quick Fade Presets */}
          <div className="hidden lg:flex items-center space-x-1 bg-slate-950 px-2 py-1 rounded-lg border border-slate-800">
            <span className="text-[10px] text-slate-400 font-mono pr-1">Fade Presets:</span>
            {[10, 25, 50, 100, 250].map((ms) => (
              <button
                key={ms}
                type="button"
                onClick={() =>
                  onFadeSettingsChange({
                    ...fadeSettings,
                    fadeInEnabled: true,
                    fadeInMs: ms,
                    fadeOutEnabled: true,
                    fadeOutMs: ms,
                  })
                }
                className={`px-1.5 py-0.5 rounded text-[10px] font-mono transition cursor-pointer ${
                  fadeSettings.fadeInMs === ms
                    ? 'bg-emerald-500 text-slate-950 font-bold'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                }`}
              >
                {ms}ms
              </button>
            ))}
          </div>
        </div>

        {/* Right: Zoom controls */}
        <div className="flex items-center space-x-2 bg-slate-950 px-2.5 py-1 rounded-lg border border-slate-800">
          <button
            type="button"
            onClick={handleZoomOut}
            className="text-slate-400 hover:text-slate-200 p-1 cursor-pointer transition"
            title="Zoom Out (-)"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <input
            type="range"
            min="1"
            max="40"
            step="0.5"
            value={zoom}
            onChange={(e) => onZoomChange(parseFloat(e.target.value))}
            className="w-16 accent-emerald-500 h-1.5 bg-slate-800 rounded cursor-pointer"
            title="Zoom multiplier"
          />
          <button
            type="button"
            onClick={handleZoomIn}
            className="text-slate-400 hover:text-slate-200 p-1 cursor-pointer transition"
            title="Zoom In (+)"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleZoomFit}
            className="text-slate-400 hover:text-emerald-400 px-1.5 py-0.5 rounded text-[10px] font-mono border-l border-slate-800 pl-2 cursor-pointer transition"
            title="Fit Entire Track (1x)"
          >
            Fit
          </button>
          <button
            type="button"
            onClick={handleZoomCrop}
            className="text-slate-400 hover:text-emerald-400 px-1.5 py-0.5 rounded text-[10px] font-mono cursor-pointer transition"
            title="Zoom to Cropped Span"
          >
            Crop
          </button>
          <span
            className="hidden sm:inline-flex items-center text-[10px] text-slate-400 font-mono pl-2 border-l border-slate-800"
            title="Rotate mouse scroll wheel over waveform to zoom in and out"
          >
            Wheel: Zoom
          </span>
        </div>
      </div>

      {/* Active Selection Brace Action Toolbar */}
      {currentSelection && Math.abs(currentSelection.end - currentSelection.start) > 0.001 && (
        <div className="flex flex-wrap items-center justify-between gap-2.5 bg-sky-950/80 border border-sky-500/50 px-4 py-2 rounded-xl text-xs backdrop-blur-sm shadow-md">
          <div className="flex items-center space-x-2.5">
            <span className="flex items-center space-x-1.5 font-bold text-sky-200">
              <ScanLine className="w-4 h-4 text-sky-400" />
              <span>Selection Brace:</span>
            </span>
            <div className="flex items-center space-x-1.5 font-mono text-[11px] bg-slate-950/90 px-2.5 py-1 rounded-lg border border-sky-900/60 text-slate-200">
              <span className="text-sky-300 font-semibold">{formatTime(Math.min(currentSelection.start, currentSelection.end), true)}</span>
              <span className="text-slate-500">→</span>
              <span className="text-sky-300 font-semibold">{formatTime(Math.max(currentSelection.start, currentSelection.end), true)}</span>
              <span className="text-sky-400 font-semibold ml-1">
                ({Math.abs(currentSelection.end - currentSelection.start).toFixed(2)}s)
              </span>
            </div>
            <span className="hidden lg:inline-block text-[11px] text-slate-400">
              • Drag left/right bracket [ ] handles or top rail bar
            </span>
          </div>

          <div className="flex items-center space-x-2">
            {/* Play Selection */}
            {onPlaySelection && (
              <button
                type="button"
                onClick={() => onPlaySelection(Math.min(currentSelection.start, currentSelection.end), Math.max(currentSelection.start, currentSelection.end))}
                className="flex items-center space-x-1 px-2.5 py-1 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white font-semibold transition cursor-pointer border border-emerald-500/50 shadow-sm"
                title="Play only the selected audio region"
              >
                <Play className="w-3 h-3 fill-current" />
                <span>Play Selection</span>
              </button>
            )}

            {/* Crop to Selection (Keep Selection, discard outside) */}
            {onCropToSelection && (
              <button
                type="button"
                onClick={() => onCropToSelection(Math.min(currentSelection.start, currentSelection.end), Math.max(currentSelection.start, currentSelection.end))}
                className="flex items-center space-x-1 px-2.5 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold transition cursor-pointer border border-sky-400/50 shadow-sm"
                title="Crop waveform to keep ONLY this selected area (discard rest)"
              >
                <Crop className="w-3.5 h-3.5" />
                <span>Crop To Selection</span>
              </button>
            )}

            {/* Cut / Remove Selection (Delete selection, splice rest) */}
            {onCutSelection && (
              <button
                type="button"
                onClick={() => onCutSelection(Math.min(currentSelection.start, currentSelection.end), Math.max(currentSelection.start, currentSelection.end))}
                className="flex items-center space-x-1 px-2.5 py-1 rounded-lg bg-rose-700 hover:bg-rose-600 text-white font-semibold transition cursor-pointer border border-rose-500/50 shadow-sm"
                title="Cut / delete this selected section from the audio and splice the rest"
              >
                <Scissors className="w-3.5 h-3.5" />
                <span>Cut Selection</span>
              </button>
            )}

            {/* Clear Selection */}
            <button
              type="button"
              onClick={() => handleSelectionChange(null)}
              className="p-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition cursor-pointer border border-slate-700"
              title="Clear selection brace"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Main Waveform Canvas Container */}
      <div className="relative rounded-xl overflow-hidden border border-slate-800 bg-slate-950 shadow-inner">
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

        {/* Hover Time Tooltip & Quick Actions */}
        {hoverTime !== null && hoverPosition && (
          <div
            className="absolute pointer-events-none -top-1 bg-slate-900 text-slate-200 border border-slate-700 px-2.5 py-0.5 rounded-md text-[10px] font-mono shadow-xl transform -translate-x-1/2 z-10 flex items-center gap-1.5"
            style={{ left: `${hoverPosition.x}px` }}
          >
            <span>{formatTime(hoverTime, true)}</span>
            {activeTool === 'marker' ? (
              <span className="text-purple-400 font-sans font-bold">[Click to Place Marker]</span>
            ) : hoveredElement === 'selectionStart' || hoveredElement === 'selectionEnd' ? (
              <span className="text-sky-300 font-sans font-bold">[Drag Selection Bracket]</span>
            ) : hoveredElement === 'selectionBar' ? (
              <span className="text-sky-300 font-sans font-bold">[Drag to Move Selection]</span>
            ) : hoveredElement === 'marker' ? (
              <span className="text-purple-300 font-sans font-bold">[Right-click to Delete Marker]</span>
            ) : hoveredElement === 'fadeIn' ? (
              <span className="text-sky-400 font-sans font-bold">[Drag Fade-In]</span>
            ) : hoveredElement === 'fadeOut' ? (
              <span className="text-amber-400 font-sans font-bold">[Drag Fade-Out]</span>
            ) : (
              <span className="text-sky-300 font-sans font-semibold">[Click: Move Playhead • Drag: Select Range]</span>
            )}
          </div>
        )}

        {/* Visual Tip Overlays for Draggable Fades & Markers */}
        <div className="absolute top-7 left-3 pointer-events-none text-[10px] text-slate-300 font-mono flex items-center gap-1.5 bg-slate-950/80 px-2.5 py-0.5 rounded border border-slate-800/80 backdrop-blur-xs">
          <ScanLine className="w-3 h-3 text-sky-400" />
          <span className="text-sky-300 font-medium">Click: Seek • Drag: Select Range</span>
          <span className="text-slate-500">•</span>
          <span className="text-slate-300">Double-click: Add Marker</span>
          <span className="text-slate-500">•</span>
          <span className="text-rose-300">Right-click: Delete Marker</span>
        </div>
      </div>

      {/* Minimap Overview & Navigation Bar */}
      <div className="flex items-center space-x-2.5 bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-800">
        <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider w-16 shrink-0">
          Overview:
        </span>
        <canvas
          ref={minimapRef}
          width={800}
          height={26}
          onPointerDown={handleMinimapPointerDown}
          onPointerMove={handleMinimapPointerMove}
          onPointerUp={handleMinimapPointerUp}
          className="w-full h-6.5 rounded bg-slate-950 border border-slate-800"
          style={{ cursor: minimapCursor }}
          title="Drag edges to zoom in/out • Drag inside to slide • Click to jump"
        />
        <div className="text-[10px] font-mono text-slate-400 shrink-0">
          {zoom.toFixed(1)}x zoom • {formatTime(visibleDuration)} visible
        </div>
      </div>
    </div>
  );
};
