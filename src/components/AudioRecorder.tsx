import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Mic,
  Square,
  Pause,
  Play,
  Volume2,
  VolumeX,
  Radio,
  Settings,
  AlertCircle,
  Headphones,
  CheckCircle2,
  Activity,
  Trash2,
  Zap,
  RotateCcw,
} from 'lucide-react';
import { AudioDeviceOption } from '../types';
import { formatTime } from '../utils/audioProcessing';

interface AudioRecorderProps {
  onRecordingComplete: (audioBuffer: AudioBuffer, defaultName: string) => void;
  isRecordingActive: boolean;
  setIsRecordingActive: (active: boolean) => void;
  onClearRecording?: () => void;
  hasLoadedAudio?: boolean;
}

export const AudioRecorder: React.FC<AudioRecorderProps> = ({
  onRecordingComplete,
  isRecordingActive,
  setIsRecordingActive,
  onClearRecording,
  hasLoadedAudio = false,
}) => {
  const [devices, setDevices] = useState<AudioDeviceOption[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [channelMode, setChannelMode] = useState<'stereo' | 'mono'>('stereo');
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [durationSec, setDurationSec] = useState<number>(0);

  // Independent Live Monitoring State (works regardless of recording state)
  const [isMonitoringActive, setIsMonitoringActive] = useState<boolean>(false);
  const [monitoringAudioOutput, setMonitoringAudioOutput] = useState<boolean>(false);
  const [monitorVolume, setMonitorVolume] = useState<number>(0.7);
  const [deviceError, setDeviceError] = useState<string | null>(null);

  // Metering state
  const [leftPeakDb, setLeftPeakDb] = useState<number>(-60);
  const [rightPeakDb, setRightPeakDb] = useState<number>(-60);
  const [leftPeakHoldDb, setLeftPeakHoldDb] = useState<number>(-60);
  const [rightPeakHoldDb, setRightPeakHoldDb] = useState<number>(-60);
  const [clipped, setClipped] = useState<boolean>(false);

  // Input Preamp Boost (+dB) for quiet record decks / turntables without hardware gain
  const [inputBoostDb, setInputBoostDb] = useState<number>(0);
  const inputBoostDbRef = useRef<number>(0);
  const inputGainNodeRef = useRef<GainNode | null>(null);

  // Audio Context & stream refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const monitorGainNodeRef = useRef<GainNode | null>(null);
  const analyserNodeLeftRef = useRef<AnalyserNode | null>(null);
  const analyserNodeRightRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // Peak hold ref for fast synchronous tracking
  const peakHoldRef = useRef<{ left: number; right: number }>({ left: -60, right: -60 });

  // Sample buffers
  const recordedChunksLeftRef = useRef<Float32Array[]>([]);
  const recordedChunksRightRef = useRef<Float32Array[]>([]);
  const totalRecordedSamplesRef = useRef<number>(0);
  const recordingStartTimeRef = useRef<number>(0);
  const pausedDurationRef = useRef<number>(0);
  const pauseStartTimeRef = useRef<number>(0);
  const liveCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const isRecordingRef = useRef<boolean>(false);
  const isPausedRef = useRef<boolean>(false);

  useEffect(() => {
    isRecordingRef.current = isRecording;
    isPausedRef.current = isPaused;
  }, [isRecording, isPaused]);

  // Load audio input devices
  const loadDevices = useCallback(async () => {
    try {
      if (!navigator?.mediaDevices?.enumerateDevices) {
        return;
      }
      // Prompt permissions if needed to get friendly device names
      let tempStream: MediaStream | null = null;
      try {
        tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        // Permission not yet granted or no input device present
      }

      const allDevices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      if (tempStream) {
        tempStream.getTracks().forEach((t) => t.stop());
      }

      const audioInputs = allDevices
        .filter((d) => d.kind === 'audioinput')
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Soundcard / Audio Input ${i + 1}`,
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
    } catch {
      // Gracefully handle device enumeration issues
    }
  }, []);

  useEffect(() => {
    loadDevices();
    navigator.mediaDevices.addEventListener('devicechange', loadDevices);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', loadDevices);
    };
  }, [loadDevices]);

  // Handle headphone monitoring gain changes
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
    const bufferL = new Float32Array(analyserL.fftSize);
    analyserL.getFloatTimeDomainData(bufferL);

    let maxL = 0;
    for (let i = 0; i < bufferL.length; i++) {
      const absVal = Math.abs(bufferL[i]);
      if (absVal > maxL) maxL = absVal;
    }

    let maxR = maxL;
    if (analyserR) {
      const bufferR = new Float32Array(analyserR.fftSize);
      analyserR.getFloatTimeDomainData(bufferR);
      maxR = 0;
      for (let i = 0; i < bufferR.length; i++) {
        const absVal = Math.abs(bufferR[i]);
        if (absVal > maxR) maxR = absVal;
      }
    }

    // Convert linear to dBFS (0 dB is maximum full scale, values > 0 indicate clipping)
    const dbL = maxL > 0 ? 20 * Math.log10(maxL) : -60;
    const dbR = maxR > 0 ? 20 * Math.log10(maxR) : -60;

    const clampedDbL = Math.max(-60, dbL);
    const clampedDbR = Math.max(-60, dbR);

    setLeftPeakDb(clampedDbL);
    setRightPeakDb(clampedDbR);

    // Update Peak Hold
    if (clampedDbL > peakHoldRef.current.left) {
      peakHoldRef.current.left = clampedDbL;
      setLeftPeakHoldDb(clampedDbL);
    }
    if (clampedDbR > peakHoldRef.current.right) {
      peakHoldRef.current.right = clampedDbR;
      setRightPeakHoldDb(clampedDbR);
    }

    // Check clipping (> 0.0 dBFS or near threshold -0.05 dB)
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
        ctx.fillStyle = '#090d16';
        ctx.fillRect(0, 0, width, height);

        // Center line
        ctx.strokeStyle = '#1e293b';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();

        // Waveform line
        ctx.lineWidth = 1.5;
        if (isRecordingRef.current) {
          ctx.strokeStyle = isPausedRef.current ? '#f59e0b' : '#ef4444';
        } else {
          ctx.strokeStyle = '#10b981';
        }
        ctx.beginPath();

        const step = Math.ceil(bufferL.length / width);
        for (let x = 0; x < width; x++) {
          const sampleIdx = x * step;
          const val = sampleIdx < bufferL.length ? bufferL[sampleIdx] : 0;
          const y = (0.5 - val * 0.48) * height;
          if (x === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      }
    }

    // Update timer if active and not paused
    if (isRecordingRef.current && !isPausedRef.current && audioContextRef.current) {
      const now = performance.now();
      const elapsed = (now - recordingStartTimeRef.current - pausedDurationRef.current) / 1000;
      setDurationSec(Math.max(0, elapsed));
    }

    animationFrameRef.current = requestAnimationFrame(updateMeterLoop);
  }, []);

  // Initialize or start live input monitoring stream
  const startMonitoringStream = useCallback(
    async (deviceId?: string, mode?: 'stereo' | 'mono') => {
      if (!navigator?.mediaDevices?.getUserMedia) {
        setIsMonitoringActive(false);
        setDeviceError('Audio input not supported');
        return;
      }

      try {
        const devId = deviceId !== undefined ? deviceId : selectedDeviceId;
        const chMode = mode !== undefined ? mode : channelMode;
        const isStereo = chMode === 'stereo';

        // Stop existing stream if any
        if (mediaStreamRef.current) {
          mediaStreamRef.current.getTracks().forEach((t) => t.stop());
          mediaStreamRef.current = null;
        }

        let stream: MediaStream | null = null;

        // Try preferred device and stereo constraints first
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
          // If preferred device or advanced constraints fail, fallback to generic audio input
          try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          } catch {
            // No audio input device present or permission denied
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

        // Initialize AudioContext if needed
        let audioCtx = audioContextRef.current;
        if (!audioCtx || audioCtx.state === 'closed') {
          audioCtx = new (window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
          audioContextRef.current = audioCtx;
        }

        if (audioCtx.state === 'suspended') {
          await audioCtx.resume().catch(() => {});
        }

        const source = audioCtx.createMediaStreamSource(stream);
        sourceNodeRef.current = source;

        // Input Preamp / Gain Boost Node (scales input audio for quiet turntables/soundcard inputs)
        const inputGain = audioCtx.createGain();
        const initialLinearGain = Math.pow(10, inputBoostDbRef.current / 20);
        inputGain.gain.setValueAtTime(initialLinearGain, audioCtx.currentTime);
        inputGainNodeRef.current = inputGain;
        source.connect(inputGain);

        // Channel splitter for stereo metering (connected after input boost so meters reflect boosted level)
        const splitter = audioCtx.createChannelSplitter(2);
        inputGain.connect(splitter);

        const analyserL = audioCtx.createAnalyser();
        analyserL.fftSize = 1024;
        splitter.connect(analyserL, 0);
        analyserNodeLeftRef.current = analyserL;

        const analyserR = audioCtx.createAnalyser();
        analyserR.fftSize = 1024;
        if (isStereo) {
          splitter.connect(analyserR, 1);
        } else {
          splitter.connect(analyserR, 0);
        }
        analyserNodeRightRef.current = analyserR;

        // Headphone Monitoring Node (connected after input boost so user hears boosted audio in headphones)
        const monitorGain = audioCtx.createGain();
        monitorGain.gain.value = monitoringAudioOutput ? monitorVolume : 0;
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
    [selectedDeviceId, channelMode, monitoringAudioOutput, monitorVolume, updateMeterLoop]
  );

  // Stop live monitoring stream
  const stopMonitoringStream = () => {
    if (isRecording) return; // don't stop stream while actively recording

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

    analyserNodeLeftRef.current = null;
    analyserNodeRightRef.current = null;
    sourceNodeRef.current = null;
    inputGainNodeRef.current = null;
    monitorGainNodeRef.current = null;

    setLeftPeakDb(-60);
    setRightPeakDb(-60);
    setIsMonitoringActive(false);
  };

  // Automatically start input monitoring when component mounts or device changes
  useEffect(() => {
    startMonitoringStream();
  }, [startMonitoringStream]);

  // Handle device change
  const handleDeviceChange = (newDeviceId: string) => {
    setSelectedDeviceId(newDeviceId);
    startMonitoringStream(newDeviceId, channelMode);
  };

  // Handle channel mode change
  const handleModeChange = (newMode: 'stereo' | 'mono') => {
    setChannelMode(newMode);
    startMonitoringStream(selectedDeviceId, newMode);
  };

  // Reset Left channel Peak Hold back to current live monitoring level
  const handleResetLeftPeak = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    peakHoldRef.current.left = leftPeakDb;
    setLeftPeakHoldDb(leftPeakDb);
    if (leftPeakDb < 0 && rightPeakHoldDb < 0) {
      setClipped(false);
    }
  };

  // Reset Right channel Peak Hold back to current live monitoring level
  const handleResetRightPeak = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    peakHoldRef.current.right = rightPeakDb;
    setRightPeakHoldDb(rightPeakDb);
    if (rightPeakDb < 0 && leftPeakHoldDb < 0) {
      setClipped(false);
    }
  };

  // Reset both Peak Holds back to current live monitoring levels
  const handleResetPeak = () => {
    peakHoldRef.current = { left: leftPeakDb, right: rightPeakDb };
    setLeftPeakHoldDb(leftPeakDb);
    setRightPeakHoldDb(rightPeakDb);
    if (leftPeakDb < 0 && rightPeakDb < 0) {
      setClipped(false);
    }
  };

  // Start soundcard recording
  const startRecording = async () => {
    handleResetPeak();
    recordedChunksLeftRef.current = [];
    recordedChunksRightRef.current = [];
    totalRecordedSamplesRef.current = 0;
    pausedDurationRef.current = 0;
    setDurationSec(0);

    try {
      // Ensure monitoring stream and AudioContext are active
      if (!mediaStreamRef.current || !audioContextRef.current || !sourceNodeRef.current) {
        await startMonitoringStream();
      }

      const audioCtx = audioContextRef.current;
      const source = sourceNodeRef.current;
      if (!audioCtx || !source) {
        throw new Error('Audio context or source not available');
      }

      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      const isStereo = channelMode === 'stereo';
      const bufferSize = 4096;
      const processor = audioCtx.createScriptProcessor(bufferSize, isStereo ? 2 : 1, isStereo ? 2 : 1);
      processorNodeRef.current = processor;

      processor.onaudioprocess = (e) => {
        // Prevent processor from bleeding unmonitored audio into speakers
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

      // Connect boosted input gain node to recorder
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
      alert('Could not access soundcard or microphone. Please check browser permissions.');
    }
  };

  // Pause or Resume
  const togglePause = () => {
    if (!isRecording) return;
    if (isPaused) {
      // Resuming
      pausedDurationRef.current += performance.now() - pauseStartTimeRef.current;
      setIsPaused(false);
      isPausedRef.current = false;
    } else {
      // Pausing
      pauseStartTimeRef.current = performance.now();
      setIsPaused(true);
      isPausedRef.current = true;
    }
  };

  // Stop recording and create AudioBuffer, keeping live monitoring running
  const stopRecording = async () => {
    if (!isRecording) return;

    setIsRecording(false);
    setIsPaused(false);
    isRecordingRef.current = false;
    isPausedRef.current = false;
    setIsRecordingActive(false);

    // Disconnect recording processor
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

    // Merge chunks into complete audio buffer
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

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const defaultName = `Soundcard_Recording_${timestamp}`;
    onRecordingComplete(finalBuffer, defaultName);
  };

  // Convert dBFS (-60 to +3 dB) to meter fill height percentage
  // -60 dB -> 0%
  // -12 dB -> 75%
  // 0 dB   -> 95%
  // +3 dB  -> 100%
  const dbToHeightPercent = (db: number) => {
    if (db <= -60) return 0;
    if (db >= 3) return 100;
    if (db <= -12) {
      // -60 to -12 dB maps to 0% - 75%
      return ((db + 60) / 48) * 75;
    } else if (db <= 0) {
      // -12 to 0 dB maps to 75% - 95%
      return 75 + ((db + 12) / 12) * 20;
    } else {
      // 0 to +3 dB maps to 95% - 100%
      return 95 + (db / 3) * 5;
    }
  };

  // Max peak between channels
  const currentMaxPeak = Math.max(leftPeakDb, rightPeakDb);
  const currentMaxPeakHold = Math.max(leftPeakHoldDb, rightPeakHoldDb);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg space-y-4">
      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-4">
        <div className="flex items-center space-x-3">
          <div
            className={`w-4 h-4 rounded-full flex items-center justify-center ${
              isRecording
                ? isPaused
                  ? 'bg-amber-500 animate-pulse'
                  : 'bg-red-500 animate-ping'
                : isMonitoringActive
                ? 'bg-emerald-500 shadow-sm shadow-emerald-500/50'
                : 'bg-slate-700'
            }`}
          />
          <div>
            <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
              <span>Soundcard Audio Capture</span>
              {isRecording ? (
                <span
                  className={`text-xs px-2 py-0.5 rounded font-mono uppercase font-bold ${
                    isPaused ? 'bg-amber-500/20 text-amber-300' : 'bg-red-500/20 text-red-400 animate-pulse'
                  }`}
                >
                  {isPaused ? 'Paused' : 'Recording'}
                </span>
              ) : isMonitoringActive ? (
                <span className="text-[11px] px-2 py-0.5 rounded font-mono font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
                  <Activity className="w-3 h-3 text-emerald-400 animate-pulse" />
                  <span>Live Input Monitoring Active</span>
                </span>
              ) : (
                <span className="text-[11px] px-2 py-0.5 rounded font-mono font-medium bg-slate-800 text-slate-400 border border-slate-700 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3 text-amber-400" />
                  <span>{deviceError || 'Input Monitoring Standby'}</span>
                </span>
              )}
            </h2>
            <p className="text-xs text-slate-400">
              High-fidelity direct PCM capture with continuous level metering prior to recording
            </p>
          </div>
        </div>

        {/* Action Controls & Timer */}
        <div className="flex items-center space-x-3">
          {/* Big Timer */}
          <div className="flex items-center space-x-2 bg-slate-950 px-3.5 py-1.5 rounded-lg border border-slate-800">
            <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">Rec Time:</span>
            <span className="font-mono text-lg font-bold text-emerald-400 tracking-wider">
              {formatTime(durationSec, true)}
            </span>
          </div>

          {/* Clear Current Recording (Clean Slate) Button */}
          {hasLoadedAudio && onClearRecording && (
            <button
              type="button"
              onClick={onClearRecording}
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-red-950/40 text-slate-300 hover:text-red-300 border border-slate-700 hover:border-red-800/50 text-xs font-semibold transition cursor-pointer"
              title="Clear current recording to start with a clean slate"
            >
              <Trash2 className="w-3.5 h-3.5 text-red-400" />
              <span>Clear Slate</span>
            </button>
          )}
        </div>
      </div>

      {/* Device, Mode, Headphone Monitor & Input Preamp Boost */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 bg-slate-950/70 p-3.5 rounded-xl border border-slate-800/80">
        {/* Device selector */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
            <Radio className="w-3.5 h-3.5 text-emerald-400" />
            <span>Audio Device / Soundcard</span>
          </label>
          <select
            value={selectedDeviceId}
            onChange={(e) => handleDeviceChange(e.target.value)}
            disabled={isRecording}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
          >
            {devices.length === 0 && <option value="">Default Audio Input</option>}
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
        </div>

        {/* Channel mode */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
            <Settings className="w-3.5 h-3.5 text-emerald-400" />
            <span>Channel Mode</span>
          </label>
          <div className="grid grid-cols-2 gap-1.5 bg-slate-950 p-1 rounded-lg border border-slate-800">
            <button
              type="button"
              disabled={isRecording}
              onClick={() => handleModeChange('stereo')}
              className={`text-xs py-1 rounded font-medium transition cursor-pointer ${
                channelMode === 'stereo'
                  ? 'bg-slate-800 text-emerald-400 font-semibold shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              } disabled:opacity-50`}
            >
              Stereo (2 Ch)
            </button>
            <button
              type="button"
              disabled={isRecording}
              onClick={() => handleModeChange('mono')}
              className={`text-xs py-1 rounded font-medium transition cursor-pointer ${
                channelMode === 'mono'
                  ? 'bg-slate-800 text-emerald-400 font-semibold shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              } disabled:opacity-50`}
            >
              Mono (1 Ch)
            </button>
          </div>
        </div>

        {/* Headphone monitoring */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
              <Headphones className="w-3.5 h-3.5 text-emerald-400" />
              <span>Headphone Monitor</span>
            </label>
            <button
              type="button"
              onClick={() => setMonitoringAudioOutput(!monitoringAudioOutput)}
              className={`text-[11px] font-medium px-2 py-0.5 rounded cursor-pointer transition ${
                monitoringAudioOutput
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                  : 'bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-700'
              }`}
              title="Listen to input signal through headphones (use headphones to prevent feedback)"
            >
              {monitoringAudioOutput ? 'Output ON' : 'Output Muted'}
            </button>
          </div>
          <div className="flex items-center space-x-2 pt-1">
            {monitoringAudioOutput ? (
              <Volume2 className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <VolumeX className="w-3.5 h-3.5 text-slate-500" />
            )}
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={monitorVolume}
              disabled={!monitoringAudioOutput}
              onChange={(e) => setMonitorVolume(parseFloat(e.target.value))}
              className="w-full accent-emerald-500 h-1.5 bg-slate-800 rounded-lg cursor-pointer disabled:opacity-40"
              title="Monitor output volume"
            />
            <span className="text-[11px] font-mono text-slate-400 w-8 text-right">
              {Math.round(monitorVolume * 100)}%
            </span>
          </div>
        </div>

        {/* Input Preamp Boost (+dB) for quiet record decks / turntables without hardware gain */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
              <Zap className={`w-3.5 h-3.5 ${inputBoostDb > 0 ? 'text-amber-400' : 'text-slate-400'}`} />
              <span>Input Boost / Preamp</span>
            </label>
            <div className="flex items-center gap-1.5">
              <span
                className={`text-[11px] font-mono font-bold px-1.5 py-0.5 rounded transition ${
                  inputBoostDb > 0
                    ? inputBoostDb >= 24
                      ? 'bg-amber-500/25 text-amber-300 border border-amber-500/40 shadow-xs'
                      : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                    : 'bg-slate-800 text-slate-400'
                }`}
              >
                {inputBoostDb > 0 ? `+${inputBoostDb.toFixed(1)} dB` : '0.0 dB (Unity)'}
              </span>
              {inputBoostDb > 0 && (
                <button
                  type="button"
                  onClick={() => setInputBoostDb(0)}
                  className="text-[10px] text-slate-400 hover:text-slate-200 p-0.5 rounded hover:bg-slate-800 transition cursor-pointer"
                  title="Reset boost to 0 dB unity gain"
                >
                  <RotateCcw className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center space-x-2 pt-1">
            <span className="text-[10px] font-mono text-slate-500">0dB</span>
            <input
              type="range"
              min="0"
              max="36"
              step="0.5"
              value={inputBoostDb}
              onChange={(e) => setInputBoostDb(parseFloat(e.target.value))}
              className="w-full accent-amber-500 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
              title={`Input Gain Boost: +${inputBoostDb.toFixed(1)} dB (${Math.pow(10, inputBoostDb / 20).toFixed(1)}× gain)`}
            />
            <span className="text-[10px] font-mono text-slate-500">+36dB</span>
          </div>

          {/* Quick preset buttons */}
          <div className="grid grid-cols-5 gap-1 pt-0.5">
            {[
              { label: '0dB', val: 0, title: 'Line Level / Unity (1.0×)' },
              { label: '+6dB', val: 6, title: '+6 dB Boost (2.0×)' },
              { label: '+12dB', val: 12, title: '+12 dB Boost (4.0×)' },
              { label: '+18dB', val: 18, title: '+18 dB Deck Line (7.9×)' },
              { label: '+24dB', val: 24, title: '+24 dB Phono Low (15.8×)' },
            ].map((p) => (
              <button
                key={p.val}
                type="button"
                onClick={() => setInputBoostDb(p.val)}
                className={`text-[10px] py-0.5 rounded font-mono transition cursor-pointer text-center ${
                  Math.abs(inputBoostDb - p.val) < 0.25
                    ? 'bg-amber-500/30 text-amber-200 font-bold border border-amber-500/50 shadow-xs'
                    : 'bg-slate-900 text-slate-400 hover:text-slate-200 hover:bg-slate-800 border border-slate-800'
                }`}
                title={p.title}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between text-[10px] text-slate-400 pt-0.5">
            <span className="font-mono">
              Gain: <strong className="text-slate-300">{Math.pow(10, inputBoostDb / 20).toFixed(1)}×</strong>
            </span>
            <span className="text-amber-400/90 font-medium">Turntable Preamp</span>
          </div>
        </div>
      </div>

      {/* Main Metering Section: Vertical VU Meters + Live Oscilloscope */}
      <div className="bg-slate-950 p-4 rounded-xl border border-slate-800/80 grid grid-cols-1 md:grid-cols-12 gap-5 items-center">
        {/* Left column: Precision Vertical VU Meters */}
        <div className="md:col-span-5 flex flex-col space-y-2">
          {/* Header */}
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-mono font-semibold text-slate-300 tracking-wider">
              INPUT METERS (dBFS)
            </span>
            <div className="flex items-center space-x-2">
              {inputBoostDb > 0 && (
                <span className="text-[10px] font-mono font-bold text-amber-400 bg-amber-500/15 px-1.5 py-0.5 rounded border border-amber-500/30">
                  PREAMP +{inputBoostDb.toFixed(1)}dB
                </span>
              )}
              <span className="text-[10px] font-mono text-slate-500">
                Click peak to reset
              </span>
            </div>
          </div>

          {/* Vertical Meter Chamber */}
          <div
            className="flex items-center justify-center gap-3 bg-slate-900/80 p-3 rounded-xl border border-slate-800/90 select-none hover:border-slate-700 transition"
          >
            {/* Decibel scale labels (Left side) */}
            <div className="flex flex-col items-end space-y-1.5">
              <span className="text-[9px] font-mono text-slate-500 py-0.5 select-none">PEAK</span>
              <div className="flex flex-col justify-between h-40 text-[9px] font-mono text-slate-400 text-right pr-1 py-0.5 select-none">
                <span className="text-red-400 font-bold leading-none">+3</span>
                <span className="text-red-400 font-bold leading-none">0 dB</span>
                <span className="text-amber-400 leading-none">-3</span>
                <span className="text-amber-400 leading-none">-6</span>
                <span className="text-amber-400 leading-none">-12</span>
                <span className="text-emerald-400 leading-none">-18</span>
                <span className="text-emerald-400 leading-none">-24</span>
                <span className="text-slate-500 leading-none">-36</span>
                <span className="text-slate-500 leading-none">-48</span>
                <span className="text-slate-600 leading-none">-60</span>
              </div>
            </div>

            {/* Left Vertical Meter Bar */}
            <div className="flex flex-col items-center space-y-1.5">
              {/* L Independent Peak Readout */}
              <button
                type="button"
                onClick={handleResetLeftPeak}
                className={`w-9 py-0.5 px-0.5 rounded text-[10px] font-mono font-bold text-center transition cursor-pointer border select-none ${
                  leftPeakHoldDb >= 0
                    ? 'bg-red-500/25 text-red-300 border-red-500/50 animate-pulse'
                    : leftPeakHoldDb > -3
                    ? 'bg-amber-500/15 text-amber-300 border-amber-500/30 hover:border-amber-400'
                    : 'bg-slate-950 text-slate-300 border-slate-800 hover:border-slate-700 hover:text-emerald-400'
                }`}
                title="Left Peak: Click to reset back to monitoring"
              >
                {leftPeakHoldDb >= 0 ? 'CLIP' : leftPeakHoldDb <= -60 ? '-∞' : `${leftPeakHoldDb.toFixed(1)}`}
              </button>

              <div className="relative w-7 h-40 bg-slate-950 rounded-md border border-slate-800 overflow-hidden flex flex-col justify-end p-0.5">
                {/* 0dB Clip Threshold Marker Line */}
                <div
                  className="absolute left-0 right-0 border-t border-red-500/80 z-20 pointer-events-none"
                  style={{ bottom: '95%' }}
                />
                {/* -12dB Transition Marker Line */}
                <div
                  className="absolute left-0 right-0 border-t border-amber-500/40 z-20 pointer-events-none"
                  style={{ bottom: '75%' }}
                />

                {/* Meter Active Fill with Green, Yellow, Red thresholds */}
                <div
                  className="w-full rounded-sm transition-all duration-75 ease-out relative"
                  style={{
                    height: `${dbToHeightPercent(leftPeakDb)}%`,
                    background:
                      'linear-gradient(to top, #10b981 0%, #10b981 75%, #f59e0b 75%, #f59e0b 95%, #ef4444 95%, #ef4444 100%)',
                  }}
                />

                {/* Peak Hold Line */}
                {leftPeakHoldDb > -60 && (
                  <div
                    className={`absolute left-0 right-0 h-0.5 z-30 ${
                      leftPeakHoldDb >= 0 ? 'bg-red-400 shadow-sm shadow-red-400' : 'bg-white'
                    }`}
                    style={{ bottom: `${Math.min(99, dbToHeightPercent(leftPeakHoldDb))}%` }}
                  />
                )}
              </div>
              <span className="text-[10px] font-bold font-mono text-slate-300">L</span>
              <span className="text-[9px] font-mono text-slate-400">
                {leftPeakDb <= -60 ? '-∞' : `${leftPeakDb.toFixed(1)}`}
              </span>
            </div>

            {/* Right Vertical Meter Bar (or mirror for mono) */}
            {channelMode === 'stereo' && (
              <div className="flex flex-col items-center space-y-1.5">
                {/* R Independent Peak Readout */}
                <button
                  type="button"
                  onClick={handleResetRightPeak}
                  className={`w-9 py-0.5 px-0.5 rounded text-[10px] font-mono font-bold text-center transition cursor-pointer border select-none ${
                    rightPeakHoldDb >= 0
                      ? 'bg-red-500/25 text-red-300 border-red-500/50 animate-pulse'
                      : rightPeakHoldDb > -3
                      ? 'bg-amber-500/15 text-amber-300 border-amber-500/30 hover:border-amber-400'
                      : 'bg-slate-950 text-slate-300 border-slate-800 hover:border-slate-700 hover:text-emerald-400'
                  }`}
                  title="Right Peak: Click to reset back to monitoring"
                >
                  {rightPeakHoldDb >= 0 ? 'CLIP' : rightPeakHoldDb <= -60 ? '-∞' : `${rightPeakHoldDb.toFixed(1)}`}
                </button>

                <div className="relative w-7 h-40 bg-slate-950 rounded-md border border-slate-800 overflow-hidden flex flex-col justify-end p-0.5">
                  {/* 0dB Clip Threshold Marker Line */}
                  <div
                    className="absolute left-0 right-0 border-t border-red-500/80 z-20 pointer-events-none"
                    style={{ bottom: '95%' }}
                  />
                  {/* -12dB Transition Marker Line */}
                  <div
                    className="absolute left-0 right-0 border-t border-amber-500/40 z-20 pointer-events-none"
                    style={{ bottom: '75%' }}
                  />

                  {/* Meter Active Fill with Green, Yellow, Red thresholds */}
                  <div
                    className="w-full rounded-sm transition-all duration-75 ease-out relative"
                    style={{
                      height: `${dbToHeightPercent(rightPeakDb)}%`,
                      background:
                        'linear-gradient(to top, #10b981 0%, #10b981 75%, #f59e0b 75%, #f59e0b 95%, #ef4444 95%, #ef4444 100%)',
                    }}
                  />

                  {/* Peak Hold Line */}
                  {rightPeakHoldDb > -60 && (
                    <div
                      className={`absolute left-0 right-0 h-0.5 z-30 ${
                        rightPeakHoldDb >= 0 ? 'bg-red-400 shadow-sm shadow-red-400' : 'bg-white'
                      }`}
                      style={{ bottom: `${Math.min(99, dbToHeightPercent(rightPeakHoldDb))}%` }}
                    />
                  )}
                </div>
                <span className="text-[10px] font-bold font-mono text-slate-300">R</span>
                <span className="text-[9px] font-mono text-slate-400">
                  {rightPeakDb <= -60 ? '-∞' : `${rightPeakDb.toFixed(1)}`}
                </span>
              </div>
            )}

            {/* Legend & Info Guide */}
            <div className="ml-2 flex flex-col justify-between h-40 text-[10px] text-slate-400 border-l border-slate-800/80 pl-2.5 py-1">
              <div className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 rounded-sm bg-red-500" />
                <span className="text-red-300 font-semibold">&gt; 0dB Clip</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 rounded-sm bg-amber-500" />
                <span className="text-amber-300 font-medium">-12 to 0dB</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 rounded-sm bg-emerald-500" />
                <span className="text-emerald-300 font-medium">Safe Level</span>
              </div>
              <span className="text-[9px] text-slate-500 italic mt-auto">Click meter to reset peak hold</span>
            </div>
          </div>
        </div>

        {/* Right column: Live Oscilloscope & Audio Status */}
        <div className="md:col-span-7 flex flex-col justify-between h-full space-y-2">
          <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono">
            <span className="font-semibold text-slate-300 flex items-center gap-1.5">
              <span>LIVE OSCILLOSCOPE MONITOR</span>
              {inputBoostDb > 0 && (
                <span className="text-amber-400 text-[10px] font-normal">
                  ({Math.pow(10, inputBoostDb / 20).toFixed(1)}× boost active)
                </span>
              )}
            </span>
            <span className="text-emerald-400 font-semibold">
              {isRecording ? (isPaused ? 'RECORDING PAUSED' : 'RECORDING ACTIVE') : 'LIVE INPUT STREAMING'}
            </span>
          </div>

          <canvas
            ref={liveCanvasRef}
            width={460}
            height={130}
            className="w-full h-[132px] rounded-lg border border-slate-800 bg-slate-900 block shadow-inner"
          />

          <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1">
            <span>
              Sample Rate:{' '}
              <strong className="text-slate-200">
                {audioContextRef.current ? `${audioContextRef.current.sampleRate} Hz` : '48000 Hz'}
              </strong>
            </span>
            <span className="flex items-center gap-1">
              <span
                className={`w-2 h-2 rounded-full ${
                  clipped ? 'bg-red-500 animate-ping' : isMonitoringActive ? 'bg-emerald-500' : 'bg-slate-600'
                }`}
              />
              <span className={clipped ? 'text-red-400 font-bold' : 'text-slate-300'}>
                {clipped ? 'Clipping Detected (Over 0dBFS)' : 'Signal Nominal'}
              </span>
            </span>
          </div>
        </div>
      </div>

      {/* Primary Action Buttons */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
        <div className="flex items-center space-x-2.5">
          {!isRecording ? (
            <button
              type="button"
              onClick={startRecording}
              className="flex items-center space-x-2 px-5 py-2.5 rounded-lg bg-red-600 hover:bg-red-500 text-white font-semibold text-xs transition shadow-md shadow-red-950/50 cursor-pointer"
            >
              <div className="w-2.5 h-2.5 rounded-full bg-white animate-ping" />
              <span>Start Recording</span>
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={togglePause}
                className={`flex items-center space-x-2 px-4 py-2.5 rounded-lg font-semibold text-xs transition cursor-pointer border ${
                  isPaused
                    ? 'bg-amber-600 hover:bg-amber-500 text-white border-amber-500 shadow-md shadow-amber-950/40'
                    : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
                }`}
              >
                {isPaused ? <Play className="w-3.5 h-3.5 fill-current" /> : <Pause className="w-3.5 h-3.5" />}
                <span>{isPaused ? 'Resume' : 'Pause'}</span>
              </button>

              <button
                type="button"
                onClick={stopRecording}
                className="flex items-center space-x-2 px-5 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs transition shadow-md shadow-emerald-950/40 cursor-pointer"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                <span>Stop & Edit Waveform</span>
              </button>
            </>
          )}

          {/* Toggle Live Monitoring Stream Button */}
          {!isRecording && (
            <button
              type="button"
              onClick={() => {
                if (isMonitoringActive) {
                  stopMonitoringStream();
                } else {
                  startMonitoringStream();
                }
              }}
              className={`px-3 py-2 rounded-lg text-xs font-semibold border transition cursor-pointer ${
                isMonitoringActive
                  ? 'bg-slate-800 text-slate-300 hover:bg-slate-700 border-slate-700'
                  : 'bg-emerald-600/20 text-emerald-300 border-emerald-500/40 hover:bg-emerald-600/30'
              }`}
            >
              {isMonitoringActive ? 'Mute Live Meters' : 'Start Live Monitoring'}
            </button>
          )}
        </div>

        {/* Helpful status note */}
        <div className="text-xs text-slate-400 flex items-center gap-1.5">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>Levels monitored in real time • Stop generates editable waveform & fades</span>
        </div>
      </div>
    </div>
  );
};
