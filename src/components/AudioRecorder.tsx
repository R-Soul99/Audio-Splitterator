import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Square,
  Pause,
  Play,
  MicOff,
  Radio,
  BookmarkPlus,
  Ear,
} from 'lucide-react';
import { RotaryKnob } from './RotaryKnob';
import { useKnobDrag } from '../hooks/useKnobDrag';
import { AudioDeviceOption } from '../types';
import { formatTime } from '../utils/audioProcessing';
import { combinedStereoLevelDb } from '../utils/recordingDisplay';

interface AudioRecorderProps {
  onRecordingComplete: (audioBuffer: AudioBuffer, defaultName: string, artist?: string, album?: string, markerTimes?: number[]) => void;
  isRecordingActive: boolean;
  setIsRecordingActive: (active: boolean) => void;
  onClearRecording?: () => void;
  hasLoadedAudio?: boolean;
  isStandbyMode?: boolean;
  onWakeAudioEngine?: () => void;
}

// Needle sweep uses the full digital input range, but gives the important upper
// levels more physical travel so quiet signals still move the needle smoothly.
const vuAngle = (db: number) => {
  const value = Math.max(-60, Math.min(3, db));

  if (value <= -20) {
    // -60 .. -20 dBFS => -55 .. -30 degrees
    return -55 + ((value + 60) / 40) * 25;
  }

  if (value <= 0) {
    // -20 .. 0 dBFS => -30 .. +40 degrees
    return -30 + ((value + 20) / 20) * 70;
  }

  // 0 .. +3 dBFS => +40 .. +55 degrees
  return 40 + (value / 3) * 15;
};
const VU_PIVOT = { x: 220, y: 230 };
const polar = (radius: number, angleDeg: number) => {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: VU_PIVOT.x + radius * Math.sin(rad), y: VU_PIVOT.y - radius * Math.cos(rad) };
};

interface VuMeterProps {
  label: string;
  peakDb: number;
  peakHoldDb: number;
  onResetPeak: (e?: React.MouseEvent) => void;
  hidden?: boolean;
}

const VuMeter: React.FC<VuMeterProps> = ({ label, peakDb, peakHoldDb, onResetPeak, hidden }) => {
  const ticks = [
    -60, -55, -50, -45, -40, -35, -30, -25, -20,
    -18, -16, -14, -12, -10, -8, -6, -4, -2, 0, 1, 2, 3,
  ];
  const labelled = [-60, -40, -20, -12, -6, 0, 3];
  const redStart = polar(156, vuAngle(0));
  const redEnd = polar(156, vuAngle(3));
  return (
    <div className={`flex min-w-0 flex-col items-center gap-3 ${hidden ? 'invisible' : ''}`}>
      <div
        onClick={onResetPeak}
        className={`flex h-9 w-36 shrink-0 cursor-pointer items-center justify-center gap-2 rounded border bg-slate-950 font-mono text-[12px] font-bold transition hover:border-slate-500 ${
          peakHoldDb >= -0.05
            ? 'border-red-500/40 text-red-400'
            : peakHoldDb > -12
            ? 'border-amber-500/40 text-amber-400'
            : 'border-emerald-500/30 text-emerald-400'
        }`}
        title="Click peak to reset"
      >
        <span className={`h-2.5 w-2.5 rounded-full border ${peakHoldDb >= -0.05 ? 'border-red-300 bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)]' : 'border-slate-600 bg-slate-800'}`} />
        <span>{peakHoldDb >= 0 ? 'CLIP' : peakHoldDb <= -60 ? '-∞' : peakHoldDb.toFixed(1)}</span>
      </div>
      <svg viewBox="0 0 440 246" className="w-full max-w-[440px]" role="img" aria-label={`${label} level meter`}>
        <path d="M 6 244 V 230 A 214 214 0 0 1 434 230 V 244 Z" fill="#18211f" stroke="#475569" strokeWidth="3" />
        <path d="M 70 230 A 150 150 0 0 1 370 230" fill="none" stroke="rgba(148,163,184,0.35)" strokeWidth="1.5" />
        {ticks.map((db) => {
          const major = labelled.includes(db);
          const a = polar(major ? 128 : 138, vuAngle(db));
          const b = polar(150, vuAngle(db));
          return <line key={db} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={db >= 0 ? '#f87171' : '#94a3b8'} strokeWidth={major ? 2 : 1} opacity={major ? 0.9 : 0.55} />;
        })}
        <path d={`M ${redStart.x} ${redStart.y} A 156 156 0 0 1 ${redEnd.x} ${redEnd.y}`} fill="none" stroke="#f87171" strokeWidth="4" opacity="0.8" />
        {labelled.map((db) => {
          const p = polar(108, vuAngle(db));
          return (
            <text key={db} x={p.x} y={p.y} textAnchor="middle" dominantBaseline="middle" fontSize="14" fontFamily="ui-monospace, monospace" fill={db >= 0 ? '#fca5a5' : '#94a3b8'}>
              {db > 0 ? `+${db}` : db}
            </text>
          );
        })}
        <g style={{ transform: `rotate(${vuAngle(peakDb)}deg)`, transformOrigin: `${VU_PIVOT.x}px ${VU_PIVOT.y}px`, transition: 'transform 75ms ease-out' }}>
          <line x1={VU_PIVOT.x} y1={VU_PIVOT.y} x2={VU_PIVOT.x} y2={VU_PIVOT.y - 166} stroke="#f87171" strokeWidth="3" strokeLinecap="round" style={{ filter: 'drop-shadow(0 0 4px rgba(248,113,113,0.8))' }} />
        </g>
        <circle cx={VU_PIVOT.x} cy={VU_PIVOT.y} r="10" fill="#334155" stroke="#cbd5e1" strokeWidth="2" />
      </svg>
      <span className="font-mono text-base font-bold tracking-wide text-slate-200">{label}</span>
    </div>
  );
};

interface VerticalToggleProps {
  topLabel: string;
  bottomLabel: string;
  isTop: boolean;
  onToggle: () => void;
  disabled?: boolean;
  title?: string;
}

const VerticalToggle: React.FC<VerticalToggleProps> = ({ topLabel, bottomLabel, isTop, onToggle, disabled, title }) => (
  <div className="flex flex-col items-center gap-1.5">
    <span className={`text-[11px] font-bold uppercase tracking-wider ${isTop ? 'text-slate-100' : 'text-slate-500'}`}>{topLabel}</span>
    <button
      type="button"
      role="switch"
      aria-checked={isTop}
      aria-label={title}
      title={title}
      disabled={disabled}
      onClick={onToggle}
      className="relative h-14 w-8 cursor-pointer rounded-full border border-slate-600 bg-slate-950 shadow-[inset_0_2px_6px_rgba(0,0,0,0.8)] transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className={`absolute left-1/2 h-6 w-6 -translate-x-1/2 rounded-full border border-slate-300 bg-gradient-to-b from-slate-200 to-slate-500 shadow transition-all duration-150 ${isTop ? 'top-1' : 'bottom-1'}`} />
    </button>
    <span className={`text-[11px] font-bold uppercase tracking-wider ${isTop ? 'text-slate-500' : 'text-slate-100'}`}>{bottomLabel}</span>
  </div>
);

export const AudioRecorder: React.FC<AudioRecorderProps> = ({
  onRecordingComplete,
  isRecordingActive,
  setIsRecordingActive,
  onClearRecording,
  hasLoadedAudio = false,
  isStandbyMode = false,
  onWakeAudioEngine,
}) => {
  const [devices, setDevices] = useState<AudioDeviceOption[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [channelMode, setChannelMode] = useState<'stereo' | 'mono'>('stereo');
  const [recordingSampleRate, setRecordingSampleRate] = useState<number>(44100);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [durationSec, setDurationSec] = useState<number>(0);
  const [recordingMarkerCount, setRecordingMarkerCount] = useState<number>(0);
  const [markerFlashKey, setMarkerFlashKey] = useState<number>(0);

  // Independent Live Monitoring State
  const [isMonitoringActive, setIsMonitoringActive] = useState<boolean>(false);
  const [monitoringAudioOutput, setMonitoringAudioOutput] = useState<boolean>(false);
  const [monitorVolume, setMonitorVolume] = useState<number>(0.7);
  const monitoringAudioOutputRef = useRef(monitoringAudioOutput);
  const monitorVolumeRef = useRef(monitorVolume);
  monitoringAudioOutputRef.current = monitoringAudioOutput;
  monitorVolumeRef.current = monitorVolume;
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [showReplaceRecordingDialog, setShowReplaceRecordingDialog] = useState<boolean>(false);

  // Metering state
  const [leftPeakDb, setLeftPeakDb] = useState<number>(-60);
  const [rightPeakDb, setRightPeakDb] = useState<number>(-60);
  const [leftPeakHoldDb, setLeftPeakHoldDb] = useState<number>(-60);
  const [rightPeakHoldDb, setRightPeakHoldDb] = useState<number>(-60);
  const [clipped, setClipped] = useState<boolean>(false);
  const smoothedPeakDbRef = useRef<{ left: number; right: number }>({ left: -60, right: -60 });

  // Input Preamp Boost (+dB) for quiet record decks / turntables
  const [inputBoostDb, setInputBoostDb] = useState<number>(0);
  const inputBoostDbRef = useRef<number>(0);
  const inputGainNodeRef = useRef<GainNode | null>(null);
  const [targetDbfs, setTargetDbfs] = useState(-6);
  const targetDbfsRef = useRef(targetDbfs);
  targetDbfsRef.current = targetDbfs;
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [calibrationFeedback, setCalibrationFeedback] = useState('');
  const calibrationHoldRef = useRef(false);
  const calibrationPeakRef = useRef(0);
  const calibrationProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { dragging: gainDragging, fineAdjusting: gainFineAdjusting, ...gainDragHandlers } = useKnobDrag({ value: inputBoostDb, min: 0, max: 36, sensitivity: 0.28, step: 1, fineStep: 0.1, disabled: isRecording || isCalibrating, onChange: setInputBoostDb });
  const { dragging: monitorDragging, fineAdjusting: monitorFineAdjusting, ...monitorDragHandlers } = useKnobDrag({ value: monitorVolume, min: 0, max: 1, sensitivity: 0.0078, step: 0.01, disabled: !monitoringAudioOutput, onChange: setMonitorVolume });
  const beginCalibration = () => {
    if (!isMonitoringActive || isRecording || !calibrationProcessorRef.current) return;
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    calibrationPeakRef.current = 0;
    calibrationHoldRef.current = true;
    setIsCalibrating(true);
    setCalibrationFeedback('LISTENING');
  };
  const finishCalibration = (cancelled = false) => {
    if (!calibrationHoldRef.current) return;
    calibrationHoldRef.current = false;
    setIsCalibrating(false);
    const peak = calibrationPeakRef.current;
    if (cancelled) setCalibrationFeedback('');
    else if (peak <= 0.000001) setCalibrationFeedback('NO SIGNAL');
    else {
      const requiredGainDb = targetDbfsRef.current - 20 * Math.log10(peak);
      const gain = Math.round(Math.max(0, Math.min(36, requiredGainDb)) * 10) / 10;
      setInputBoostDb(gain);
      setCalibrationFeedback(requiredGainDb < 0 ? 'INPUT HOT' : `SET +${gain.toFixed(1)} dB`);
    }
    feedbackTimerRef.current = setTimeout(() => setCalibrationFeedback(''), 2500);
  };

  // Audio Context & stream refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const monitorGainNodeRef = useRef<GainNode | null>(null);
  const analyserNodeLeftRef = useRef<AnalyserNode | null>(null);
  const analyserNodeRightRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // Pre-allocated static buffers to avoid Garbage Collection sweeps in requestAnimationFrame
  const bufferLeftRef = useRef<Float32Array | null>(null);
  const bufferRightRef = useRef<Float32Array | null>(null);

  // Peak hold ref for fast synchronous tracking
  const peakHoldRef = useRef<{ left: number; right: number }>({ left: -60, right: -60 });

  // Sample buffers
  const recordedChunksLeftRef = useRef<Float32Array[]>([]);
  const recordedChunksRightRef = useRef<Float32Array[]>([]);
  const totalRecordedSamplesRef = useRef<number>(0);
  const recordingMarkerTimesRef = useRef<number[]>([]);
  // Scrolling waveform position (write-index space, not wall-clock) for each dropped marker.
  const recordingMarkerWriteIndicesRef = useRef<number[]>([]);
  const recordingStartTimeRef = useRef<number>(0);
  const pausedDurationRef = useRef<number>(0);
  const pauseStartTimeRef = useRef<number>(0);
  const liveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const recordingWaveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const recordingWaveformLeftHistoryRef = useRef<Float32Array>(new Float32Array(1600));
  const recordingWaveformRightHistoryRef = useRef<Float32Array>(new Float32Array(1600));
  const recordingWaveformWriteIndexRef = useRef<number>(0);

  const isRecordingRef = useRef<boolean>(false);
  const isPausedRef = useRef<boolean>(false);

  // Proportional scaling factor tracking
  const [scale, setScale] = useState<number>(1);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    isRecordingRef.current = isRecording;
    isPausedRef.current = isPaused;
  }, [isRecording, isPaused]);

  // Handle proportional scale calculations
  const calculateScale = useCallback(() => {
    if (containerRef.current) {
      const parent = containerRef.current.parentElement;
      if (parent) {
        const pWidth = parent.clientWidth;
        const pHeight = parent.clientHeight;

        // Base pro-audio console design targets (the ideal scale dimensions)
        const baseWidth = 1500;
        const baseHeight = 800;

        // Compute the fitting aspect scale ratio
        const scaleX = pWidth / baseWidth;
        const scaleY = pHeight / baseHeight;
        const newScale = Math.min(scaleX, scaleY);

        setScale(newScale);
      }
    }
  }, []);

  useEffect(() => {
    window.addEventListener('resize', calculateScale);
    // Initial delay trigger for accurate rendering calculation
    const t = setTimeout(calculateScale, 60);

    let resizeObserver: ResizeObserver | null = null;
    if (containerRef.current && containerRef.current.parentElement) {
      resizeObserver = new ResizeObserver(() => {
        calculateScale();
      });
      resizeObserver.observe(containerRef.current.parentElement);
    }

    return () => {
      window.removeEventListener('resize', calculateScale);
      clearTimeout(t);
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
    };
  }, [calculateScale]);

  // Load audio input devices
  const loadDevices = useCallback(async () => {
    try {
      if (!navigator?.mediaDevices?.enumerateDevices) {
        return;
      }
      let tempStream: MediaStream | null = null;
      if (!isStandbyMode) {
        try {
          tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch {}
      }

      const allDevices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      if (tempStream) {
        tempStream.getTracks().forEach((t) => t.stop());
      }

      const audioInputs = allDevices
        .filter((d) => d.kind === 'audioinput')
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Soundcard Input ${i + 1}`,
          groupId: d.groupId,
        }));

      setDevices(audioInputs);
      if (audioInputs.length > 0) {
        setSelectedDeviceId((prev) => {
          if (prev && audioInputs.some((d) => d.deviceId === prev)) {
            return prev;
          }
          return audioInputs[0].deviceId;
        });
      } else {
        setSelectedDeviceId('');
      }
    } catch {}
  }, []);

  useEffect(() => {
    loadDevices();
    navigator.mediaDevices.addEventListener('devicechange', loadDevices);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', loadDevices);
    };
  }, [loadDevices]);

  // Handle monitoring gain changes
  useEffect(() => {
    if (monitorGainNodeRef.current) {
      monitorGainNodeRef.current.gain.value = monitoringAudioOutput ? monitorVolume : 0;
    }
  }, [monitoringAudioOutput, monitorVolume]);

  // Handle live input preamp boost gain changes
  useEffect(() => {
    inputBoostDbRef.current = inputBoostDb;
    if (inputGainNodeRef.current && audioContextRef.current) {
      const linearGain = Math.pow(10, inputBoostDb / 20);
      try {
        inputGainNodeRef.current.gain.setTargetAtTime(linearGain, audioContextRef.current.currentTime, 0.015);
      } catch {
        inputGainNodeRef.current.gain.value = linearGain;
      }
    }
  }, [inputBoostDb]);

  // Clean up all audio nodes on unmount
  useEffect(() => {
    return () => {
      calibrationHoldRef.current = false;
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
      calibrationProcessorRef.current?.disconnect();
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close();
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  // VU Meter and mini-waveform animation loop
  const updateMeterLoop = useCallback(() => {
    if (!analyserNodeLeftRef.current) return;

    const analyserL = analyserNodeLeftRef.current;
    const analyserR = analyserNodeRightRef.current;

    // Reuse pre-allocated Left Buffer
    if (!bufferLeftRef.current || bufferLeftRef.current.length !== analyserL.fftSize) {
      bufferLeftRef.current = new Float32Array(analyserL.fftSize);
    }
    const bufferL = bufferLeftRef.current;
    analyserL.getFloatTimeDomainData(bufferL);

    let maxL = 0;
    let sumSquaresL = 0;
    for (let i = 0; i < bufferL.length; i++) {
      const absVal = Math.abs(bufferL[i]);
      if (absVal > maxL) maxL = absVal;
      sumSquaresL += bufferL[i] * bufferL[i];
    }
    const rmsL = Math.sqrt(sumSquaresL / Math.max(1, bufferL.length));

    let maxR = maxL;
    let rmsR = rmsL;
    if (analyserR) {
      // Reuse pre-allocated Right Buffer
      if (!bufferRightRef.current || bufferRightRef.current.length !== analyserR.fftSize) {
        bufferRightRef.current = new Float32Array(analyserR.fftSize);
      }
      const bufferR = bufferRightRef.current;
      analyserR.getFloatTimeDomainData(bufferR);
      maxR = 0;
      let sumSquaresR = 0;
      for (let i = 0; i < bufferR.length; i++) {
        const absVal = Math.abs(bufferR[i]);
        if (absVal > maxR) maxR = absVal;
        sumSquaresR += bufferR[i] * bufferR[i];
      }
      rmsR = Math.sqrt(sumSquaresR / Math.max(1, bufferR.length));
    }

    if (calibrationHoldRef.current && calibrationPeakRef.current > 0) setCalibrationFeedback(`PEAK ${(20 * Math.log10(calibrationPeakRef.current)).toFixed(1)}`);

    const dbL = maxL > 0 ? 20 * Math.log10(maxL) : -60;
    const dbR = maxR > 0 ? 20 * Math.log10(maxR) : -60;
    const rmsDbL = rmsL > 0 ? 20 * Math.log10(rmsL) : -60;
    const rmsDbR = rmsR > 0 ? 20 * Math.log10(rmsR) : -60;

    const clampedDbL = Math.max(-60, dbL);
    const clampedDbR = Math.max(-60, dbR);

    // Keep the VU needles responsive on attack, with a subtle slower release.
    const smoothPeak = (previous: number, target: number) => {
      const coefficient = target >= previous ? 0.58 : 0.12;
      return previous + (target - previous) * coefficient;
    };
    const smoothedLeft = smoothPeak(smoothedPeakDbRef.current.left, clampedDbL);
    const smoothedRight = smoothPeak(smoothedPeakDbRef.current.right, clampedDbR);
    smoothedPeakDbRef.current = { left: smoothedLeft, right: smoothedRight };
    setLeftPeakDb(smoothedLeft);
    setRightPeakDb(smoothedRight);

    if (clampedDbL > peakHoldRef.current.left) {
      peakHoldRef.current.left = clampedDbL;
      setLeftPeakHoldDb(clampedDbL);
    }
    if (clampedDbR > peakHoldRef.current.right) {
      peakHoldRef.current.right = clampedDbR;
      setRightPeakHoldDb(clampedDbR);
    }

    if (dbL >= -0.05 || dbR >= -0.05) {
      setClipped(true);
    }

    // Draw live oscilloscope on mini-canvas
    if (liveCanvasRef.current) {
      const cvs = liveCanvasRef.current;
      const ctx = cvs.getContext('2d');
      if (ctx) {
        const width = cvs.width;
        const height = cvs.height;
        const bg = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, width / 2);
        bg.addColorStop(0, '#052e2b');
        bg.addColorStop(1, '#03110f');
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, width, height);

        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(52, 211, 153, 0.14)';
        ctx.beginPath();
        for (let i = 1; i < 8; i++) {
          ctx.moveTo((width * i) / 8, 0);
          ctx.lineTo((width * i) / 8, height);
          ctx.moveTo(0, (height * i) / 8);
          ctx.lineTo(width, (height * i) / 8);
        }
        ctx.stroke();

        ctx.strokeStyle = 'rgba(52, 211, 153, 0.4)';
        ctx.beginPath();
        ctx.moveTo(width / 2, 0);
        ctx.lineTo(width / 2, height);
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();

        ctx.lineWidth = 2;
        ctx.strokeStyle = '#34d399';
        ctx.shadowColor = '#34d399';
        ctx.shadowBlur = 8;
        ctx.beginPath();

        const len = bufferL.length;
        for (let x = 0; x < width; x++) {
          const sampleIdx = Math.floor((x / width) * len);
          const val = sampleIdx < len ? bufferL[sampleIdx] : 0;
          const y = (0.5 - val * 0.48) * height;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    }

    if (recordingWaveformCanvasRef.current) {
      const waveformCanvas = recordingWaveformCanvasRef.current;
      const waveformCtx = waveformCanvas.getContext('2d');
      if (waveformCtx) {
        const waveformWidth = waveformCanvas.width;
        const waveformHeight = waveformCanvas.height;
        if (isRecordingRef.current && !isPausedRef.current) {
          const writeIndex = recordingWaveformWriteIndexRef.current;
          recordingWaveformLeftHistoryRef.current[writeIndex % recordingWaveformLeftHistoryRef.current.length] = Math.max(-60, Math.min(6, rmsDbL));
          recordingWaveformRightHistoryRef.current[writeIndex % recordingWaveformRightHistoryRef.current.length] = Math.max(-60, Math.min(6, rmsDbR));
          recordingWaveformWriteIndexRef.current = writeIndex + 1;
        }

        const horizontalScale = waveformWidth / Math.max(1, waveformCanvas.clientWidth);
        const plotLeft = 26 * horizontalScale;
        const plotRight = waveformWidth - 42 * horizontalScale;
        const plotTop = 30;
        const plotBottom = waveformHeight - 8;
        const laneHeight = plotBottom - plotTop;
        const dbToY = (db: number, laneTop: number) => laneTop + ((6 - Math.max(-60, Math.min(6, db))) / 66) * laneHeight;

        waveformCtx.fillStyle = '#020617';
        waveformCtx.fillRect(0, 0, waveformWidth, waveformHeight);

        const channels = [
          { name: 'Σ', level: combinedStereoLevelDb(rmsDbL, rmsDbR), laneTop: plotTop },
        ];
        const guideLevels = [6, 0, -6, -12, -18, -24, -30, -36, -42, -48, -54, -60];

        for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
          const channel = channels[channelIndex];
          const laneBottom = channel.laneTop + laneHeight;
          for (const dbfs of guideLevels) {
            const y = dbToY(dbfs, channel.laneTop);
            waveformCtx.strokeStyle = dbfs === 0
              ? 'rgba(245, 158, 11, 0.65)'
              : dbfs === 6
              ? 'rgba(248, 113, 113, 0.5)'
              : 'rgba(148, 163, 184, 0.2)';
            waveformCtx.lineWidth = dbfs === 0 || dbfs === 6 ? 1.5 : 1;
            waveformCtx.setLineDash(dbfs === 0 || dbfs === 6 ? [4, 4] : [2, 5]);
            waveformCtx.beginPath();
            waveformCtx.moveTo(plotLeft, Math.min(laneBottom, y));
            waveformCtx.lineTo(plotRight, Math.min(laneBottom, y));
            waveformCtx.stroke();
          }

          waveformCtx.setLineDash([]);
          waveformCtx.strokeStyle = '#334155';
          waveformCtx.lineWidth = 1;
          waveformCtx.beginPath();
          waveformCtx.moveTo(plotLeft, laneBottom);
          waveformCtx.lineTo(plotRight, laneBottom);
          waveformCtx.stroke();
        }
        waveformCtx.setLineDash([]);

        const labelWidth = waveformCanvas.clientWidth;
        waveformCtx.save();
        waveformCtx.scale(horizontalScale, 1);
        waveformCtx.font = '8px ui-monospace, monospace';
        waveformCtx.textAlign = 'left';
        waveformCtx.textBaseline = 'middle';
        const channelLabels = [
          { name: 'Σ', laneTop: plotTop },
        ];
        for (const channel of channelLabels) {
          waveformCtx.fillStyle = '#cbd5e1';
          waveformCtx.textBaseline = 'top';
          waveformCtx.fillText(channel.name, 8, channel.laneTop + 2);
          waveformCtx.textAlign = 'left';
          waveformCtx.textBaseline = 'middle';
          for (const dbfs of [0, -12, -24, -36, -48, -60]) {
            const y = dbToY(dbfs, channel.laneTop);
            const x = plotRight / horizontalScale + 4;
            waveformCtx.fillStyle = 'rgba(2, 6, 23, 0.9)';
            waveformCtx.fillRect(x - 2, y - 5, 34, 10);
            waveformCtx.fillStyle = dbfs === 0 ? '#fbbf24' : dbfs === 6 ? '#f87171' : '#94a3b8';
            waveformCtx.fillText(dbfs > 0 ? `+${dbfs}` : String(dbfs), x, y);
          }
        }
        waveformCtx.textAlign = 'right';
        waveformCtx.textBaseline = 'top';
        waveformCtx.fillStyle = rmsDbL >= 0 || rmsDbR >= 0 ? '#f87171' : '#34d399';
        waveformCtx.fillText(`L ${rmsDbL.toFixed(1)}  R ${rmsDbR.toFixed(1)} dBFS`, labelWidth - 6, 3);
        waveformCtx.restore();

        const count = Math.min(
          recordingWaveformWriteIndexRef.current,
          recordingWaveformLeftHistoryRef.current.length,
          Math.floor((plotRight - plotLeft) / 3)
        );
        if (count > 0) {
          const firstIndex = recordingWaveformWriteIndexRef.current - count;
          waveformCtx.lineWidth = 2;
          for (const channel of channels) {
            waveformCtx.strokeStyle = channel.level >= 0 ? '#f87171' : '#10b981';
            waveformCtx.beginPath();
            for (let i = 0; i < count; i++) {
              const x = plotRight - (count - 1 - i) * 3;
              const index = (firstIndex + i) % recordingWaveformLeftHistoryRef.current.length;
              const dbfs = combinedStereoLevelDb(recordingWaveformLeftHistoryRef.current[index], recordingWaveformRightHistoryRef.current[index]);
              const y = dbToY(dbfs, channel.laneTop);
              if (i === 0) waveformCtx.moveTo(x, y);
              else waveformCtx.lineTo(x, y);
            }
            waveformCtx.stroke();
          }

          // Marker drop lines: positioned in write-index space so they scroll with the waveform
          // and vanish off the left edge exactly like the audio data they tag.
          const firstVisibleIndex = recordingWaveformWriteIndexRef.current - count;
          waveformCtx.font = '8px ui-monospace, monospace';
          for (let m = 0; m < recordingMarkerWriteIndicesRef.current.length; m++) {
            const markerIndex = recordingMarkerWriteIndicesRef.current[m];
            const i = markerIndex - firstVisibleIndex;
            if (i < 0 || i >= count) continue;
            const x = plotRight - (count - 1 - i) * 3;

            waveformCtx.strokeStyle = 'rgba(245, 158, 11, 0.85)';
            waveformCtx.lineWidth = 1.5;
            waveformCtx.setLineDash([3, 2]);
            waveformCtx.beginPath();
            waveformCtx.moveTo(x, plotTop - 10);
            waveformCtx.lineTo(x, plotBottom);
            waveformCtx.stroke();
            waveformCtx.setLineDash([]);

            const label = formatTime(recordingMarkerTimesRef.current[m] ?? 0, false);
            const labelWidth2 = waveformCtx.measureText(label).width;
            const labelX = Math.min(Math.max(x - labelWidth2 / 2, plotLeft), plotRight - labelWidth2);
            waveformCtx.fillStyle = '#f59e0b';
            waveformCtx.beginPath();
            waveformCtx.moveTo(x, plotTop - 10);
            waveformCtx.lineTo(x - 4, plotTop - 16);
            waveformCtx.lineTo(x + 4, plotTop - 16);
            waveformCtx.closePath();
            waveformCtx.fill();
            waveformCtx.fillStyle = 'rgba(2, 6, 23, 0.9)';
            waveformCtx.fillRect(labelX - 2, plotTop - 28, labelWidth2 + 4, 10);
            waveformCtx.fillStyle = '#fbbf24';
            waveformCtx.textAlign = 'left';
            waveformCtx.textBaseline = 'top';
            waveformCtx.fillText(label, labelX, plotTop - 27);
          }
        }
      }
    }

    if (isRecordingRef.current && !isPausedRef.current && audioContextRef.current) {
      const now = performance.now();
      const elapsed = (now - recordingStartTimeRef.current - pausedDurationRef.current) / 1000;
      setDurationSec(Math.max(0, elapsed));
    }

    animationFrameRef.current = requestAnimationFrame(updateMeterLoop);
  }, []);

  // Initialize live monitoring stream
  const startMonitoringStream = useCallback(
    async (deviceId?: string, mode?: 'stereo' | 'mono', sampleRate?: number) => {
      if (isStandbyMode) {
        setIsMonitoringActive(false);
        return;
      }

      if (!navigator?.mediaDevices?.getUserMedia) {
        setIsMonitoringActive(false);
        setDeviceError('Audio input not supported');
        return;
      }

      try {
        const devId = deviceId !== undefined ? deviceId : selectedDeviceId;
        const chMode = mode !== undefined ? mode : channelMode;
        const targetSampleRate = sampleRate !== undefined ? sampleRate : recordingSampleRate;
        const isStereo = chMode === 'stereo';

        // A device/rate change invalidates an in-progress measurement.
        calibrationHoldRef.current = false;
        setIsCalibrating(false);
        setCalibrationFeedback('');
        calibrationProcessorRef.current?.disconnect();
        calibrationProcessorRef.current = null;

        if (mediaStreamRef.current) {
          mediaStreamRef.current.getTracks().forEach((t) => t.stop());
          mediaStreamRef.current = null;
        }

        let stream: MediaStream | null = null;
        try {
          const constraints: MediaStreamConstraints = {
            audio: {
              deviceId: devId ? { ideal: devId } : undefined,
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
              channelCount: isStereo ? 2 : 1,
            },
          };
          stream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch {
          try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          } catch {
            setIsMonitoringActive(false);
            setDeviceError('No audio input device detected or access denied.');
            return;
          }
        }

        if (!stream) {
          setIsMonitoringActive(false);
          return;
        }

        mediaStreamRef.current = stream;
        setDeviceError(null);

        let audioCtx = audioContextRef.current;
        // Dynamically recreate AudioContext if sample rate changed or closed
        if (!audioCtx || audioCtx.state === 'closed' || audioCtx.sampleRate !== targetSampleRate) {
          if (audioCtx && audioCtx.state !== 'closed') {
            await audioCtx.close().catch(() => {});
          }
          const CtxClass = window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

          audioCtx = new CtxClass({ sampleRate: targetSampleRate });
          audioContextRef.current = audioCtx;
        }

        if (audioCtx.state === 'suspended') {
          await audioCtx.resume().catch(() => {});
        }

        const source = audioCtx.createMediaStreamSource(stream);
        sourceNodeRef.current = source;

        const inputGain = audioCtx.createGain();
        const initialLinearGain = Math.pow(10, inputBoostDbRef.current / 20);
        inputGain.gain.setValueAtTime(initialLinearGain, audioCtx.currentTime);
        inputGainNodeRef.current = inputGain;
        source.connect(inputGain);

        // Capture every raw input block before boost; output is silent and never recorded.
        const calibrationProcessor = audioCtx.createScriptProcessor(2048, isStereo ? 2 : 1, 1);
        calibrationProcessor.onaudioprocess = (event) => {
          event.outputBuffer.getChannelData(0).fill(0);
          if (!calibrationHoldRef.current) return;
          let peak = calibrationPeakRef.current;
          for (let channel = 0; channel < event.inputBuffer.numberOfChannels; channel++) {
            const samples = event.inputBuffer.getChannelData(channel);
            for (let index = 0; index < samples.length; index++) peak = Math.max(peak, Math.abs(samples[index]));
          }
          calibrationPeakRef.current = peak;
        };
        source.connect(calibrationProcessor);
        calibrationProcessor.connect(audioCtx.destination);
        calibrationProcessorRef.current = calibrationProcessor;

        const splitter = audioCtx.createChannelSplitter(2);
        inputGain.connect(splitter);

        const analyserL = audioCtx.createAnalyser();
        analyserL.fftSize = 1024;
        splitter.connect(analyserL, 0);
        analyserNodeLeftRef.current = analyserL;

        const analyserR = audioCtx.createAnalyser();
        analyserR.fftSize = 1024;
        if (isStereo) splitter.connect(analyserR, 1);
        else splitter.connect(analyserR, 0);
        analyserNodeRightRef.current = analyserR;

        const monitorGain = audioCtx.createGain();
        monitorGain.gain.value = monitoringAudioOutputRef.current ? monitorVolumeRef.current : 0;
        inputGain.connect(monitorGain);
        monitorGain.connect(audioCtx.destination);
        monitorGainNodeRef.current = monitorGain;

        setIsMonitoringActive(true);

        if (!animationFrameRef.current) {
          animationFrameRef.current = requestAnimationFrame(updateMeterLoop);
        }
      } catch {
        setIsMonitoringActive(false);
        setDeviceError('Could not start live monitoring');
      }
    },
    [selectedDeviceId, channelMode, recordingSampleRate, updateMeterLoop, isStandbyMode]
  );

  const stopMonitoringStream = () => {
    if (isRecording) return;

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    calibrationHoldRef.current = false;
    setIsCalibrating(false);
    setCalibrationFeedback('');
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    calibrationProcessorRef.current?.disconnect();
    calibrationProcessorRef.current = null;
    analyserNodeLeftRef.current = null;
    analyserNodeRightRef.current = null;
    sourceNodeRef.current = null;
    inputGainNodeRef.current = null;
    monitorGainNodeRef.current = null;

    setLeftPeakDb(-60);
    setRightPeakDb(-60);
    smoothedPeakDbRef.current = { left: -60, right: -60 };
    setIsMonitoringActive(false);
  };

  useEffect(() => {
    if (isStandbyMode) {
      stopMonitoringStream();
    } else {
      startMonitoringStream();
    }
  }, [isStandbyMode, startMonitoringStream]);

  const handleDeviceChange = (newDeviceId: string) => {
    setSelectedDeviceId(newDeviceId);
    if (!isStandbyMode) {
      startMonitoringStream(newDeviceId, channelMode, recordingSampleRate);
    }
  };

  const handleModeChange = (newMode: 'stereo' | 'mono') => {
    setChannelMode(newMode);
    if (!isStandbyMode) {
      startMonitoringStream(selectedDeviceId, newMode, recordingSampleRate);
    }
  };

  const handleSampleRateChange = (newRate: number) => {
    setRecordingSampleRate(newRate);
    if (!isStandbyMode) {
      startMonitoringStream(selectedDeviceId, channelMode, newRate);
    }
  };

  const handleResetLeftPeak = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    peakHoldRef.current.left = leftPeakDb;
    setLeftPeakHoldDb(leftPeakDb);
    if (leftPeakDb < 0 && rightPeakHoldDb < 0) setClipped(false);
  };

  const handleResetRightPeak = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    peakHoldRef.current.right = rightPeakDb;
    setRightPeakHoldDb(rightPeakDb);
    if (rightPeakDb < 0 && leftPeakHoldDb < 0) setClipped(false);
  };

  const handleResetPeak = () => {
    peakHoldRef.current = { left: leftPeakDb, right: rightPeakDb };
    setLeftPeakHoldDb(leftPeakDb);
    setRightPeakHoldDb(rightPeakDb);
    if (leftPeakDb < 0 && rightPeakDb < 0) setClipped(false);
  };

  const startRecording = async (confirmedReplacement = false) => {
    if (hasLoadedAudio && !confirmedReplacement) {
      setShowReplaceRecordingDialog(true);
      return;
    }

    handleResetPeak();
    smoothedPeakDbRef.current = { left: -60, right: -60 };
    recordedChunksLeftRef.current = [];
    recordedChunksRightRef.current = [];
    totalRecordedSamplesRef.current = 0;
    recordingMarkerTimesRef.current = [];
    recordingMarkerWriteIndicesRef.current = [];
    setRecordingMarkerCount(0);
    pausedDurationRef.current = 0;
    setDurationSec(0);
    recordingWaveformLeftHistoryRef.current.fill(-60);
    recordingWaveformRightHistoryRef.current.fill(-60);
    recordingWaveformWriteIndexRef.current = 0;
    if (recordingWaveformCanvasRef.current) {
      const waveformCtx = recordingWaveformCanvasRef.current.getContext('2d');
      if (waveformCtx) {
        waveformCtx.fillStyle = '#020617';
        waveformCtx.fillRect(0, 0, recordingWaveformCanvasRef.current.width, recordingWaveformCanvasRef.current.height);
      }
    }

    try {
      if (!mediaStreamRef.current || !audioContextRef.current || !sourceNodeRef.current) {
        await startMonitoringStream();
      }

      const audioCtx = audioContextRef.current;
      const source = sourceNodeRef.current;
      if (!audioCtx || !source) throw new Error('Audio context or source not available');

      if (audioCtx.state === 'suspended') await audioCtx.resume();

      const isStereo = channelMode === 'stereo';
      const bufferSize = 4096;
      const processor = audioCtx.createScriptProcessor(bufferSize, isStereo ? 2 : 1, isStereo ? 2 : 1);
      processorNodeRef.current = processor;

      processor.onaudioprocess = (e) => {
        for (let ch = 0; ch < e.outputBuffer.numberOfChannels; ch++) {
          e.outputBuffer.getChannelData(ch).fill(0);
        }

        if (!isRecordingRef.current || isPausedRef.current) return;

        const inputBuffer = e.inputBuffer;
        const leftChannel = inputBuffer.getChannelData(0);
        recordedChunksLeftRef.current.push(new Float32Array(leftChannel));

        if (isStereo) {
          const rightChannel = inputBuffer.numberOfChannels > 1 ? inputBuffer.getChannelData(1) : leftChannel;
          recordedChunksRightRef.current.push(new Float32Array(rightChannel));
        }

        totalRecordedSamplesRef.current += leftChannel.length;
      };

      const recordSource = inputGainNodeRef.current || source;
      recordSource.connect(processor);
      processor.connect(audioCtx.destination);

      isRecordingRef.current = true;
      isPausedRef.current = false;
      recordingStartTimeRef.current = performance.now();

      setIsRecording(true);
      setIsPaused(false);
      setIsRecordingActive(true);
    } catch (err) {
      console.error('Failed to start recording:', err);
      alert('Could not access soundcard. Please check browser permissions.');
    }
  };

  const togglePause = () => {
    if (!isRecording) return;
    if (isPaused) {
      pausedDurationRef.current += performance.now() - pauseStartTimeRef.current;
      setIsPaused(false);
      isPausedRef.current = false;
    } else {
      pauseStartTimeRef.current = performance.now();
      setIsPaused(true);
      isPausedRef.current = true;
    }
  };

  const dropRecordingMarker = useCallback(() => {
    const audioContext = audioContextRef.current;
    if (!isRecordingRef.current || isPausedRef.current || !audioContext) return;

    const markerTime = totalRecordedSamplesRef.current / audioContext.sampleRate;
    if (markerTime <= 0 || recordingMarkerTimesRef.current.some((time) => Math.abs(time - markerTime) < 0.05)) {
      return;
    }

    recordingMarkerTimesRef.current = [...recordingMarkerTimesRef.current, markerTime];
    recordingMarkerWriteIndicesRef.current = [...recordingMarkerWriteIndicesRef.current, recordingWaveformWriteIndexRef.current];
    setRecordingMarkerCount(recordingMarkerTimesRef.current.length);
    setMarkerFlashKey((k) => k + 1);
  }, []);

  useEffect(() => {
    const handleRecordingShortcut = (event: KeyboardEvent) => {
      if (event.code !== 'KeyM' || event.ctrlKey || event.metaKey || event.altKey || !isRecordingRef.current) return;
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      ) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat && !isPausedRef.current) dropRecordingMarker();
    };

    window.addEventListener('keydown', handleRecordingShortcut, true);
    return () => window.removeEventListener('keydown', handleRecordingShortcut, true);
  }, [dropRecordingMarker]);

  const stopRecording = async () => {
    if (!isRecording) return;

    setIsRecording(false);
    setIsPaused(false);
    isRecordingRef.current = false;
    isPausedRef.current = false;
    setIsRecordingActive(false);

    if (processorNodeRef.current) {
      processorNodeRef.current.disconnect();
      processorNodeRef.current = null;
    }

    const audioCtx = audioContextRef.current;
    if (!audioCtx) return;

    const sampleRate = audioCtx.sampleRate;
    const isStereo = channelMode === 'stereo';
    const totalSamples = totalRecordedSamplesRef.current;

    if (totalSamples === 0) {
      alert('No audio captured.');
      return;
    }

    const mergedLeft = new Float32Array(totalSamples);
    let offset = 0;
    for (const chunk of recordedChunksLeftRef.current) {
      mergedLeft.set(chunk, offset);
      offset += chunk.length;
    }

    let mergedRight: Float32Array | null = null;
    if (isStereo) {
      mergedRight = new Float32Array(totalSamples);
      offset = 0;
      for (const chunk of recordedChunksRightRef.current) {
        mergedRight.set(chunk, offset);
        offset += chunk.length;
      }
    }

    const finalBuffer = audioCtx.createBuffer(isStereo ? 2 : 1, totalSamples, sampleRate);
    finalBuffer.copyToChannel(mergedLeft, 0);
    if (isStereo && mergedRight) {
      finalBuffer.copyToChannel(mergedRight, 1);
    }

    const defaultName = 'Recording';
    onRecordingComplete(finalBuffer, defaultName, '', '', recordingMarkerTimesRef.current);
  };

  const dbToHeightPercent = (db: number) => {
    if (db <= -60) return 0;
    if (db >= 3) return 100;
    if (db <= -12) {
      return ((db + 60) / 48) * 75;
    } else if (db <= 0) {
      return 75 + ((db + 12) / 12) * 20;
    } else {
      return 95 + (db / 3) * 5;
    }
  };

  const dbToNeedleAngle = (db: number) => {
    const normalized = Math.max(0, Math.min(1, (db + 20) / 23));
    return -55 + normalized * 110;
  };

  return (
    <div ref={containerRef} className="w-full h-full flex items-center justify-center overflow-hidden relative select-none">

      {/* Fixed-size console, scaled proportionally to fit the available space */}
      <div
        className="w-[1500px] h-[800px] shrink-0 flex flex-row gap-4 relative"
        style={{
          transform: `scale(${scale})`,
          transformOrigin: 'center center',
        }}
      >
        {/* LEFT PANEL: waveform + scope on top, transport + level meters below */}
        <div className="flex-1 min-w-0 h-full grid grid-rows-[9fr_10fr] gap-4 rounded-xl border border-slate-700/60 bg-slate-900/10 p-4 shadow-[inset_0_0_0_1px_rgba(148,163,184,0.04)]">
          {/* Top row */}
          <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_305px] gap-4">
            {/* Recording waveform */}
            <div className="relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-slate-700/60 bg-slate-950/80 p-4">
              <div className="relative">
                <canvas aria-label="Combined recording waveform" ref={recordingWaveformCanvasRef} width={1000} height={220} className="block h-[220px] w-full bg-slate-950" />
                <span className="pointer-events-none absolute left-2 top-0 font-mono text-xs font-bold tracking-wider text-slate-300">RECORDING WAVEFORM</span>
              </div>

              <div className="mt-auto flex shrink-0 items-stretch gap-3 pt-3">
                <div className="flex min-w-0 flex-1 items-center justify-between rounded border border-slate-700 bg-black/85 px-4 py-3 shadow-inner">
                  <div className="flex items-center gap-3">
                    <span className={`h-3 w-3 rounded-full ${isRecording ? (isPaused ? 'bg-amber-400' : 'animate-pulse bg-red-500') : 'bg-slate-700'}`} />
                    <span className={`font-mono text-[12px] font-bold uppercase tracking-[0.22em] ${isRecording ? (isPaused ? 'text-amber-300' : 'text-red-400') : 'text-slate-500'}`}>
                      {isRecording ? (isPaused ? 'Paused' : 'Rec') : 'Ready'}
                    </span>
                  </div>

                  <div className={`font-mono text-[30px] font-bold tracking-[0.16em] ${isRecording ? 'text-amber-200' : 'text-slate-500'}`}>
                    {formatTime(durationSec, true)}
                  </div>

                  <span className="flex items-center gap-1.5 font-mono text-[11px] font-bold tracking-wider">
                    <span className={`h-2.5 w-2.5 rounded-full ${isStandbyMode ? 'bg-amber-500' : clipped ? 'animate-ping bg-red-500' : isMonitoringActive ? 'bg-emerald-500' : 'bg-slate-700'}`} />
                    <span className={isStandbyMode ? 'text-amber-400' : clipped ? 'font-extrabold text-red-400' : 'text-slate-300'}>
                      {isStandbyMode ? 'STANDBY' : clipped ? 'CLIP' : 'SIGNAL OK'}
                    </span>
                  </span>
                </div>

                <button
                  type="button"
                  key={markerFlashKey}
                  onClick={dropRecordingMarker}
                  disabled={!isRecording || isPaused}
                  className={`flex w-[118px] shrink-0 items-center justify-center gap-2 rounded border border-amber-500/40 bg-amber-400/10 px-3 font-mono text-[12px] font-bold uppercase tracking-wider text-amber-300 transition hover:bg-amber-400/20 hover:text-amber-100 disabled:cursor-not-allowed disabled:opacity-35 ${markerFlashKey > 0 ? 'flash-once' : ''}`}
                  title={!isRecording ? 'Start recording to add a marker' : isPaused ? 'Resume recording to add a marker' : 'Add a marker at the current recording position (M)'}
                  aria-label="Add recording marker"
                >
                  <BookmarkPlus className="h-4 w-4" />
                  <span>Mark{recordingMarkerCount > 0 ? ` (${recordingMarkerCount})` : ''}</span>
                  <kbd className="rounded border border-amber-200/20 bg-slate-950/70 px-1 py-0.5 text-[9px] text-amber-100">M</kbd>
                </button>
              </div>

              {/* Standby Mode Overlay */}
              {isStandbyMode && (
                <div className="absolute inset-0 z-20 flex select-none flex-col items-center justify-center border border-amber-500/20 bg-slate-950/90 p-4 text-center backdrop-blur-[3px]">
                  <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full border border-amber-500/30 bg-amber-500/15 text-amber-400 shadow-[0_0_15px_rgba(245,158,11,0.2)]">
                    <MicOff className="h-5 w-5" />
                  </div>
                  <div className="mb-1 text-xs font-bold uppercase tracking-wider text-slate-200">
                    Preview Audio Engine in Standby
                  </div>
                  <p className="mb-3 max-w-sm text-[11px] leading-relaxed text-slate-400">
                    Microphone inputs and Web Audio outputs are released so this preview won't echo or clash with your local dev app.
                  </p>
                  <button
                    type="button"
                    onClick={onWakeAudioEngine}
                    className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-amber-500 px-3.5 py-1.5 text-xs font-bold text-slate-950 shadow-lg transition hover:bg-amber-400"
                  >
                    <Radio className="h-3.5 w-3.5" />
                    <span>Wake Audio Engine</span>
                  </button>
                </div>
              )}
            </div>

            {/* Oscilloscope */}
            <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-slate-700/60 bg-slate-950/80 p-3">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-300">Oscilloscope</span>
              <div className="relative h-[264px] w-[264px] overflow-hidden rounded-full border-[6px] border-slate-700 bg-slate-950 shadow-[inset_0_0_24px_rgba(0,0,0,0.85)]">
                <canvas ref={liveCanvasRef} width={264} height={264} className="block h-full w-full rounded-full" />
                <div className="pointer-events-none absolute inset-4 rounded-full border border-slate-600/50" />
              </div>
              <span className={`font-mono text-xs font-bold tracking-wider ${clipped ? 'text-red-400' : isMonitoringActive ? 'text-emerald-400' : 'text-slate-500'}`}>
                {isStandbyMode ? 'STANDBY' : clipped ? 'CLIP' : isMonitoringActive ? 'SIGNAL' : 'NO SIGNAL'}
              </span>
            </div>
          </div>

          {/* Bottom row */}
          <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_220px] gap-4">
            {/* Level meters */}
            <div className="flex min-w-0 flex-col rounded-xl border border-slate-700/60 bg-slate-950/80 p-4">
              <div className="flex items-center gap-4">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-300">Level Meters</span>
                <span className="h-px flex-1 bg-slate-700/60" />
              </div>
              <div className="relative grid min-h-0 flex-1 grid-cols-2 items-start gap-4 pt-4">
                <VuMeter label="L VU" peakDb={leftPeakDb} peakHoldDb={leftPeakHoldDb} onResetPeak={handleResetLeftPeak} />
                <div className="absolute left-1/2 top-5 z-10 flex -translate-x-1/2 flex-col items-center gap-1">
                  <button
                    type="button"
                    onClick={handleResetPeak}
                    className="flex h-10 w-24 cursor-pointer items-center justify-center rounded border border-slate-700 bg-slate-950 font-mono text-[11px] font-bold uppercase tracking-wider text-slate-300 transition hover:border-slate-500 hover:text-white"
                    title="Click to reset both peak holds"
                  >
                    RESET
                  </button>
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Peak meters</span>
                </div>
                <VuMeter label="R VU" peakDb={rightPeakDb} peakHoldDb={rightPeakHoldDb} onResetPeak={handleResetRightPeak} hidden={channelMode !== 'stereo'} />
              </div>
            </div>
            {/* Transport */}
            <div className="relative flex flex-col items-center rounded-xl border border-slate-700/60 bg-slate-950/80 p-3">
              <span className="absolute left-3 top-3 text-xs font-bold uppercase tracking-wider text-slate-300">Transport</span>
              <div className="flex h-full w-full flex-col items-center justify-center gap-5">
                <div className="flex flex-col items-center gap-1">
                  <button
                    type="button"
                    onKeyDown={(event) => { if (event.code === 'Space') event.stopPropagation(); }}
                    onClick={() => {
                      if (isStandbyMode) {
                        onWakeAudioEngine?.();
                      } else if (isRecording) {
                        togglePause();
                      } else {
                        startRecording();
                      }
                    }}
                    className={`flex h-[136px] w-[136px] shrink-0 cursor-pointer items-center justify-center rounded-full border-4 border-slate-950 transition-all duration-300 ${
                      isStandbyMode
                        ? 'bg-amber-600 shadow-[0_0_20px_rgba(245,158,11,0.35)] hover:bg-amber-500 hover:shadow-[0_0_30px_rgba(245,158,11,0.55)]'
                        : isRecording
                        ? isPaused
                          ? 'bg-amber-600 shadow-[0_0_20px_rgba(245,158,11,0.35)] hover:bg-amber-500'
                          : 'bg-red-700 shadow-[0_0_25px_rgba(239,68,68,0.7)] hover:bg-red-600'
                        : 'bg-red-600 shadow-[0_0_20px_rgba(239,68,68,0.3)] hover:bg-red-500 hover:shadow-[0_0_30px_rgba(239,68,68,0.5)]'
                    }`}
                    title={isStandbyMode ? 'Audio engine is sleeping in Standby. Click to wake and record.' : isRecording ? (isPaused ? 'Resume recording' : 'Pause recording') : 'Start Recording'}
                    aria-label={isStandbyMode ? 'Wake audio engine' : isRecording ? (isPaused ? 'Resume recording' : 'Pause recording') : 'Start recording'}
                  >
                    {isRecording ? (
                      isPaused ? <Play aria-hidden="true" className="h-11 w-11 fill-current text-white/90" /> : <Pause aria-hidden="true" className="h-11 w-11 fill-current text-white/90" />
                    ) : <span className="h-11 w-11 rounded-full bg-white/90" />}
                  </button>
                  <span className="text-[11px] font-bold uppercase tracking-wider text-red-500">{isStandbyMode ? 'WAKE' : isRecording ? (isPaused ? 'RESUME' : 'PAUSE') : 'RECORD'}</span>
                </div>

                <div className="flex flex-col items-center gap-1">
                  <button
                    type="button"
                    onKeyDown={(event) => { if (event.code === 'Space') event.stopPropagation(); }}
                    disabled={!isRecording}
                    onClick={stopRecording}
                    className="flex h-14 w-[76px] cursor-pointer items-center justify-center rounded-lg border border-slate-600 bg-slate-800/80 text-slate-200 shadow transition hover:bg-slate-700 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-40"
                    title="Stop recording"
                    aria-label="Stop recording"
                  >
                    <Square className="h-6 w-6 fill-current" />
                  </button>
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-300">Stop</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT PANEL: controls */}
        <div className="h-full w-[270px] shrink-0 rounded-xl border border-slate-700/60 bg-slate-900/10 p-4 shadow-[inset_0_0_0_1px_rgba(148,163,184,0.04)]">
          <div className="flex h-full flex-col rounded-xl border border-slate-700/60 bg-slate-950/80 px-4 py-4">
            <span className="border-b border-slate-700/60 pb-3 text-sm font-bold uppercase tracking-wider text-slate-200">Controls</span>

            <div className="space-y-2 border-b border-slate-700/60 py-4">
              <label htmlFor="input-device" className="block text-[11px] font-bold uppercase tracking-wider text-slate-300">Input</label>
              <select
                id="input-device"
                value={selectedDeviceId}
                onChange={(e) => handleDeviceChange(e.target.value)}
                disabled={isRecording}
                className="w-full cursor-pointer rounded border border-slate-600 bg-slate-950 px-2 py-2 text-xs font-semibold text-slate-200 focus:border-emerald-500/50 focus:outline-none disabled:opacity-50"
              >
                {devices.length === 0 && <option value="">Default Audio Input</option>}
                {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
              </select>
            </div>

            <div className="space-y-2 border-b border-slate-700/60 py-4">
              <span className="block text-[11px] font-bold uppercase tracking-wider text-slate-300">Monitor</span>
              <div className="flex items-center justify-center gap-10">
                <VerticalToggle
                  topLabel="On"
                  bottomLabel="Off"
                  isTop={monitoringAudioOutput}
                  title="Toggle monitor output"
                  onToggle={() => {
                    if (isStandbyMode) {
                      setMonitoringAudioOutput(true);
                      onWakeAudioEngine?.();
                      return;
                    }
                    setMonitoringAudioOutput((previous) => !previous);
                    if (!isMonitoringActive) startMonitoringStream();
                  }}
                />
                <div
                  className={`relative h-[68px] w-[68px] touch-none rounded-full border border-slate-700 bg-slate-950 shadow-inner ${!monitoringAudioOutput ? 'opacity-40' : 'cursor-ns-resize'} ${monitorFineAdjusting ? 'ring-1 ring-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.5)]' : ''}`}
                  title="Monitor volume"
                  {...monitorDragHandlers}
                >
                  <div className="absolute inset-1.5 rounded-full border-2 border-slate-700" style={{ background: `conic-gradient(from 225deg, #10b981 ${monitorVolume * 270}deg, #1e293b ${monitorVolume * 270}deg 270deg, transparent 270deg)` }}>
                    <div className="absolute left-1/2 top-1/2 h-5 w-0.5 origin-bottom rounded-full bg-emerald-300" style={{ transform: `translate(-50%, -100%) rotate(${-135 + monitorVolume * 270}deg)` }} />
                    <div className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-300" />
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 border-b border-slate-700/60 py-4">
              <div className="flex flex-col items-center gap-2 border-r border-slate-700/60 pr-2">
                <span className="text-center text-[10px] font-bold uppercase leading-tight tracking-wider text-slate-300">Sample rate (kHz)</span>
                <VerticalToggle
                  topLabel="44.1"
                  bottomLabel="48"
                  isTop={recordingSampleRate === 44100}
                  disabled={isRecording}
                  title="Toggle sample rate"
                  onToggle={() => handleSampleRateChange(recordingSampleRate === 44100 ? 48000 : 44100)}
                />
              </div>
              <div className="flex flex-col items-center gap-2 pl-2">
                <span className="text-center text-[10px] font-bold uppercase leading-tight tracking-wider text-slate-300">Channel mode</span>
                <VerticalToggle
                  topLabel="Stereo"
                  bottomLabel="Mono"
                  isTop={channelMode === 'stereo'}
                  disabled={isRecording}
                  title="Toggle stereo / mono"
                  onToggle={() => handleModeChange(channelMode === 'stereo' ? 'mono' : 'stereo')}
                />
              </div>
            </div>

            <div className="flex flex-1 flex-col pt-4">
              <div className="flex items-center justify-between"><span className="text-[11px] font-bold uppercase tracking-wider text-slate-300">Preamp</span><span className="text-[8px] text-slate-500">Shift + Knob = Fine</span></div>
              <div className="relative flex flex-1 flex-col items-center justify-center gap-1">
                <span className="text-[10px] text-slate-400">Gain</span>
                <div
                  className={`relative h-[124px] w-[124px] touch-none ${isRecording || isCalibrating ? 'opacity-40' : 'cursor-ns-resize'} ${gainFineAdjusting ? 'rounded-full ring-1 ring-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.5)]' : ''}`}
                  {...gainDragHandlers}
                  title="Preamp boost gain (drag up / down)"
                >
                  <svg viewBox="0 0 124 124" className="pointer-events-none absolute inset-0">
                    {Array.from({ length: 11 }, (_, i) => {
                      const a = ((-135 + i * 27) * Math.PI) / 180;
                      return <line key={i} x1={62 + 50 * Math.sin(a)} y1={62 - 50 * Math.cos(a)} x2={62 + 58 * Math.sin(a)} y2={62 - 58 * Math.cos(a)} stroke="#64748b" strokeWidth="2" />;
                    })}
                  </svg>
                  <div className="absolute inset-4 rounded-full border-2 border-slate-600 bg-slate-950 shadow-inner" style={{ background: `conic-gradient(from 225deg, #f59e0b ${(inputBoostDb / 36) * 270}deg, #1e293b ${(inputBoostDb / 36) * 270}deg 270deg, transparent 270deg)` }}>
                    <div className="absolute inset-2 rounded-full border border-slate-700 bg-slate-900" />
                    <div className="absolute left-1/2 top-1/2 h-8 w-1 origin-bottom rounded-full bg-amber-300" style={{ transform: `translate(-50%, -100%) rotate(${-135 + (inputBoostDb / 36) * 270}deg)` }} />
                    <div className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-300" />
                  </div>
                </div>
                <span className="font-mono text-base font-bold text-amber-400">+{inputBoostDb.toFixed(1)} dB</span>
                <div className="flex items-start justify-center gap-10">
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-[9px] uppercase text-slate-400">Detect</span>
                    <button type="button" aria-label="Detect preamp level" aria-pressed={isCalibrating} disabled={!isMonitoringActive || isRecording} title="Hold while playing a loud passage to set the preamp level automatically." className={`flex h-[26px] w-[26px] items-center justify-center rounded border touch-none select-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${isCalibrating ? 'bg-amber-500/20 border-amber-500 text-amber-300' : 'bg-slate-950 border-slate-700 text-slate-300'}`}
                      onPointerDown={(event) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); beginCalibration(); }}
                      onPointerUp={(event) => { finishCalibration(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
                      onPointerCancel={() => finishCalibration(true)} onLostPointerCapture={() => finishCalibration(true)}
                      onKeyDown={(event) => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); if (!event.repeat) beginCalibration(); } }}
                      onKeyUp={(event) => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); finishCalibration(); } }}
                      onBlur={() => finishCalibration(true)}>
                      <Ear aria-hidden="true" className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="flex flex-col items-center gap-1" title="Target peak level for automatic preamp calibration.">
                    <span className="text-[9px] uppercase text-slate-400">Target</span>
                    <RotaryKnob value={targetDbfs} min={-12} max={0} step={3} fineStep={0.5} size={26} title="Target peak level" onChange={setTargetDbfs} formatValue={(value) => `${value.toFixed(1)} dB`} />
                    <output className="font-mono text-[10px] text-amber-300">{targetDbfs.toFixed(1)} dB</output>
                  </div>
                </div>
                <output aria-live="polite" className="h-3 font-mono text-[9px] text-amber-300">{calibrationFeedback}</output>
              </div>
            </div>
          </div>
        </div>
      </div>

      {showReplaceRecordingDialog && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-sm">
          <div className="w-72 rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl">
            <h2 className="text-sm font-bold text-slate-100">Replace existing recording?</h2>
            <p className="mt-2 text-xs leading-relaxed text-slate-400">
              Starting a new recording will replace the audio currently loaded in the editor.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowReplaceRecordingDialog(false)}
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-bold text-slate-300 transition hover:border-slate-500 hover:text-slate-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowReplaceRecordingDialog(false);
                  startRecording(true);
                }}
                className="rounded-md border border-red-500/50 bg-red-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-red-500"
              >
                Replace
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
