import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Square,
  Pause,
  Play,
  Volume2,
  VolumeX,
  Radio,
  Settings,
  AlertCircle,
  CheckCircle2,
  Activity,
  Trash2,
  Zap,
  RotateCcw,
  Tag,
} from 'lucide-react';
import { AudioDeviceOption } from '../types';
import { formatTime } from '../utils/audioProcessing';

interface AudioRecorderProps {
  onRecordingComplete: (audioBuffer: AudioBuffer, defaultName: string, artist?: string, album?: string) => void;
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
  const [artist, setArtist] = useState<string>('');
  const [album, setAlbum] = useState<string>('');

  const [devices, setDevices] = useState<AudioDeviceOption[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [channelMode, setChannelMode] = useState<'stereo' | 'mono'>('stereo');
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [durationSec, setDurationSec] = useState<number>(0);

  // Independent Live Monitoring State
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

  // Input Preamp Boost (+dB) for quiet record decks / turntables
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
      let tempStream: MediaStream | null = null;
      try {
        tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {}

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

    const dbL = maxL > 0 ? 20 * Math.log10(maxL) : -60;
    const dbR = maxR > 0 ? 20 * Math.log10(maxR) : -60;

    const clampedDbL = Math.max(-60, dbL);
    const clampedDbR = Math.max(-60, dbR);

    setLeftPeakDb(clampedDbL);
    setRightPeakDb(clampedDbR);

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
        ctx.fillStyle = '#020617';
        ctx.fillRect(0, 0, width, height);

        ctx.strokeStyle = '#1e293b';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();

        ctx.lineWidth = 1.5;
        ctx.strokeStyle = isRecordingRef.current ? (isPausedRef.current ? '#f59e0b' : '#ef4444') : '#10b981';
        ctx.beginPath();

        const step = Math.ceil(bufferL.length / width);
        for (let x = 0; x < width; x++) {
          const sampleIdx = x * step;
          const val = sampleIdx < bufferL.length ? bufferL[sampleIdx] : 0;
          const y = (0.5 - val * 0.48) * height;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
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

        const inputGain = audioCtx.createGain();
        const initialLinearGain = Math.pow(10, inputBoostDbRef.current / 20);
        inputGain.gain.setValueAtTime(initialLinearGain, audioCtx.currentTime);
        inputGainNodeRef.current = inputGain;
        source.connect(inputGain);

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

    analyserNodeLeftRef.current = null;
    analyserNodeRightRef.current = null;
    sourceNodeRef.current = null;
    inputGainNodeRef.current = null;
    monitorGainNodeRef.current = null;

    setLeftPeakDb(-60);
    setRightPeakDb(-60);
    setIsMonitoringActive(false);
  };

  useEffect(() => {
    startMonitoringStream();
  }, [startMonitoringStream]);

  const handleDeviceChange = (newDeviceId: string) => {
    setSelectedDeviceId(newDeviceId);
    startMonitoringStream(newDeviceId, channelMode);
  };

  const handleModeChange = (newMode: 'stereo' | 'mono') => {
    setChannelMode(newMode);
    startMonitoringStream(selectedDeviceId, newMode);
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

  const startRecording = async () => {
    handleResetPeak();
    recordedChunksLeftRef.current = [];
    recordedChunksRightRef.current = [];
    totalRecordedSamplesRef.current = 0;
    pausedDurationRef.current = 0;
    setDurationSec(0);

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

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const defaultName = album.trim() ? album.trim() : `Soundcard_Recording_${timestamp}`;
    onRecordingComplete(finalBuffer, defaultName, artist, album);
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

  return (
    <div className="flex flex-col items-center justify-center space-y-6 max-w-xl mx-auto py-2 select-none h-full min-h-0">
      
      {/* 1. Artist / Album Metadata Fields */}
      <div className="grid grid-cols-2 gap-3 w-full bg-slate-950/40 p-4 rounded-xl border border-slate-900/60 flex-shrink-0">
        <div className="space-y-1 text-left">
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
            <Tag className="w-3 h-3 text-emerald-400" />
            <span>Artist Name</span>
          </label>
          <input
            type="text"
            value={artist}
            onChange={(e) => setArtist(e.target.value)}
            disabled={isRecording}
            className="w-full bg-slate-900 border border-slate-800 focus:border-emerald-500/50 rounded px-2.5 py-1.5 text-xs font-semibold text-slate-200 focus:outline-none placeholder-slate-600 disabled:opacity-40"
            placeholder="Artist / Band name..."
          />
        </div>
        <div className="space-y-1 text-left">
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
            <Tag className="w-3 h-3 text-emerald-400" />
            <span>Album / Recording Name</span>
          </label>
          <input
            type="text"
            value={album}
            onChange={(e) => setAlbum(e.target.value)}
            disabled={isRecording}
            className="w-full bg-slate-900 border border-slate-800 focus:border-emerald-500/50 rounded px-2.5 py-1.5 text-xs font-semibold text-slate-200 focus:outline-none placeholder-slate-600 disabled:opacity-40"
            placeholder="Album / Vinyl side title..."
          />
        </div>
      </div>

      {/* 2. Vertically Centered squared VU meters flanked by sliders */}
      <div className="flex-1 min-h-0 flex items-center justify-center space-x-6 bg-slate-950/20 p-6 rounded-2xl border border-slate-900/40 w-full select-none">
        
        {/* Left Vertical Boost Slider */}
        <div className="flex flex-col items-center space-y-1.5 h-44">
          <span className="text-[9px] font-mono text-slate-500 uppercase">Gain</span>
          <span className="text-[9px] font-mono font-bold text-amber-400">+{inputBoostDb.toFixed(0)}dB</span>
          <input
            type="range"
            min="0"
            max="36"
            step="1"
            value={inputBoostDb}
            disabled={isRecording}
            onChange={(e) => setInputBoostDb(parseFloat(e.target.value))}
            className="h-28 accent-amber-500 cursor-pointer disabled:opacity-40 [writing-mode:vertical-lr]"
            style={{ writingMode: 'vertical-lr' }}
            title="Preamp input boost gain"
          />
          <span className="text-[8px] font-mono text-slate-500">BOOST</span>
        </div>

        {/* Meters Chamber (Squared off) */}
        <div className="flex items-center gap-3 bg-slate-900/60 p-4 border border-slate-800">
          {/* L meter */}
          <div className="flex flex-col items-center space-y-1">
            <button
              type="button"
              onClick={handleResetLeftPeak}
              className="w-8 py-0.5 text-[9px] font-mono font-bold text-center border bg-slate-950 border-slate-850 hover:border-slate-700 text-slate-300"
              title="Click peak to reset"
            >
              {leftPeakHoldDb >= 0 ? 'CLIP' : leftPeakHoldDb <= -60 ? '-∞' : `${leftPeakHoldDb.toFixed(1)}`}
            </button>
            <div className="relative w-6 h-36 bg-slate-950 border border-slate-800 overflow-hidden flex flex-col justify-end p-0.5 rounded-none">
              <div
                className="w-full transition-all duration-75 ease-out relative rounded-none"
                style={{
                  height: `${dbToHeightPercent(leftPeakDb)}%`,
                  background:
                    'linear-gradient(to top, #10b981 0%, #10b981 75%, #f59e0b 75%, #f59e0b 95%, #ef4444 95%, #ef4444 100%)',
                }}
              />
              {leftPeakHoldDb > -60 && (
                <div
                  className={`absolute left-0 right-0 h-0.5 z-30 ${leftPeakHoldDb >= 0 ? 'bg-red-400' : 'bg-white'}`}
                  style={{ bottom: `${Math.min(99, dbToHeightPercent(leftPeakHoldDb))}%` }}
                />
              )}
            </div>
            <span className="text-[10px] font-bold font-mono text-slate-400">L</span>
          </div>

          {/* Central DB Scale labels */}
          <div className="flex flex-col justify-between h-36 text-[9px] font-mono text-slate-400 text-center px-1 font-semibold leading-none py-1 select-none">
            <span className="text-red-400 font-bold">+3</span>
            <span className="text-red-400 font-bold">0</span>
            <span className="text-amber-400">-3</span>
            <span className="text-amber-400">-6</span>
            <span className="text-emerald-400">-12</span>
            <span className="text-emerald-400">-18</span>
            <span className="text-slate-500">-24</span>
            <span className="text-slate-500">-36</span>
            <span className="text-slate-600">-48</span>
            <span className="text-slate-700">-60</span>
          </div>

          {/* R meter */}
          {channelMode === 'stereo' && (
            <div className="flex flex-col items-center space-y-1">
              <button
                type="button"
                onClick={handleResetRightPeak}
                className="w-8 py-0.5 text-[9px] font-mono font-bold text-center border bg-slate-950 border-slate-850 hover:border-slate-700 text-slate-300"
                title="Click peak to reset"
              >
                {rightPeakHoldDb >= 0 ? 'CLIP' : rightPeakHoldDb <= -60 ? '-∞' : `${rightPeakHoldDb.toFixed(1)}`}
              </button>
              <div className="relative w-6 h-36 bg-slate-950 border border-slate-800 overflow-hidden flex flex-col justify-end p-0.5 rounded-none">
                <div
                  className="w-full transition-all duration-75 ease-out relative rounded-none"
                  style={{
                    height: `${dbToHeightPercent(rightPeakDb)}%`,
                    background:
                      'linear-gradient(to top, #10b981 0%, #10b981 75%, #f59e0b 75%, #f59e0b 95%, #ef4444 95%, #ef4444 100%)',
                  }}
                />
                {rightPeakHoldDb > -60 && (
                  <div
                    className={`absolute left-0 right-0 h-0.5 z-30 ${rightPeakHoldDb >= 0 ? 'bg-red-400' : 'bg-white'}`}
                    style={{ bottom: `${Math.min(99, dbToHeightPercent(rightPeakHoldDb))}%` }}
                  />
                )}
              </div>
              <span className="text-[10px] font-bold font-mono text-slate-400">R</span>
            </div>
          )}
        </div>

        {/* Right Vertical Monitor fader (Headphone/output monitor, always functional) */}
        <div className="flex flex-col items-center space-y-1.5 h-44">
          <span className="text-[9px] font-mono text-slate-500 uppercase">Monitor</span>
          <span className="text-[9px] font-mono font-bold text-emerald-400">
            {monitoringAudioOutput ? `${Math.round(monitorVolume * 100)}%` : 'MUTED'}
          </span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={monitorVolume}
            disabled={!monitoringAudioOutput}
            onChange={(e) => setMonitorVolume(parseFloat(e.target.value))}
            className="h-28 accent-emerald-500 cursor-pointer disabled:opacity-40 [writing-mode:vertical-lr]"
            style={{ writingMode: 'vertical-lr' }}
            title="Monitoring output volume"
          />
          <button
            type="button"
            onClick={() => setMonitoringAudioOutput(!monitoringAudioOutput)}
            className={`text-[8px] font-mono px-1 py-0.5 rounded cursor-pointer transition border ${
              monitoringAudioOutput ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-slate-800 text-slate-400'
            }`}
          >
            {monitoringAudioOutput ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      {/* 3. Oscilloscope display */}
      <div className="w-full bg-slate-950 p-2.5 border border-slate-900 rounded-xl relative flex flex-col justify-between h-[100px] flex-shrink-0 select-none">
        <canvas ref={liveCanvasRef} width={450} height={70} className="w-full h-[70px] bg-slate-950 block" />
        <div className="flex items-center justify-between text-[9px] font-mono text-slate-500 pt-1">
          <span>Click peak readout above to reset clip flags</span>
          <span className="flex items-center gap-1">
            <span className={`w-1.5 h-1.5 rounded-full ${clipped ? 'bg-red-500 animate-ping' : isMonitoringActive ? 'bg-emerald-500' : 'bg-slate-700'}`} />
            <span className={clipped ? 'text-red-400 font-bold' : 'text-slate-400'}>{clipped ? 'CLIP' : 'SIGNAL OK'}</span>
          </span>
        </div>
      </div>

      {/* 4. Giant glowing Record button flanked by Stop and Pause */}
      <div className="flex items-center justify-center space-x-10 py-2.5 flex-shrink-0 w-full select-none">
        {/* Stop squared button */}
        <button
          type="button"
          disabled={!isRecording}
          onClick={stopRecording}
          className="w-11 h-11 rounded-md bg-slate-950 border border-slate-850 hover:bg-slate-800 flex flex-col items-center justify-center text-slate-400 hover:text-red-400 transition cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed shadow"
        >
          <Square className="w-4 h-4 fill-current" />
          <span className="text-[8px] font-bold font-mono tracking-wider uppercase pt-0.5">STOP</span>
        </button>

        {/* Circular RECORD button */}
        <button
          type="button"
          onClick={isRecording ? stopRecording : startRecording}
          className={`w-20 h-20 rounded-full border-4 border-slate-950 select-none flex items-center justify-center text-white font-bold tracking-widest text-[10px] uppercase cursor-pointer transition-all duration-300 ${
            isRecording
              ? 'bg-red-700 shadow-[0_0_25px_rgba(239,68,68,0.7)] animate-pulse'
              : 'bg-red-600 hover:bg-red-500 shadow-[0_0_20px_rgba(239,68,68,0.3)] hover:shadow-[0_0_30px_rgba(239,68,68,0.5)]'
          }`}
          title={isRecording ? "Stop Recording" : "Start Recording"}
        >
          <span>RECORD</span>
        </button>

        {/* Pause squared button */}
        <button
          type="button"
          disabled={!isRecording}
          onClick={togglePause}
          className={`w-11 h-11 rounded-md border transition cursor-pointer flex flex-col items-center justify-center shadow ${
            isPaused
              ? 'bg-amber-600/20 border-amber-500/40 text-amber-400 hover:bg-amber-600/30'
              : 'bg-slate-950 border-slate-850 hover:bg-slate-800 text-slate-400 hover:text-slate-200'
          } disabled:opacity-30 disabled:cursor-not-allowed`}
        >
          {isPaused ? <Play className="w-4 h-4 fill-current" /> : <Pause className="w-4 h-4" />}
          <span className="text-[8px] font-bold font-mono tracking-wider uppercase pt-0.5">{isPaused ? 'RESUME' : 'PAUSE'}</span>
        </button>
      </div>

      {/* 5. Device select and monitoring toggle */}
      <div className="flex items-center justify-center space-x-3 text-xs w-full max-w-sm flex-shrink-0 select-none">
        <select
          value={selectedDeviceId}
          onChange={(e) => handleDeviceChange(e.target.value)}
          disabled={isRecording}
          className="flex-1 bg-slate-950 border border-slate-850 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 font-semibold focus:outline-none focus:border-emerald-500/50 disabled:opacity-50 cursor-pointer"
        >
          {devices.length === 0 && <option value="">Default Audio Input</option>}
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              Source: {d.label}
            </option>
          ))}
        </select>

        {/* Monitor Toggle Switch */}
        <label className="flex items-center space-x-2 cursor-pointer bg-slate-950 px-3 py-1.5 rounded-lg border border-slate-850 hover:border-slate-700 transition">
          <input
            type="checkbox"
            checked={isMonitoringActive}
            disabled={isRecording}
            onChange={() => isMonitoringActive ? stopMonitoringStream() : startMonitoringStream()}
            className="rounded accent-emerald-500 w-3.5 h-3.5 cursor-pointer disabled:opacity-40"
          />
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Monitor Input</span>
        </label>
      </div>

      {/* 6. Active Rec status detail text at bottom */}
      <div className="text-[10px] font-mono text-slate-500 flex items-center justify-center gap-1 flex-shrink-0 select-none">
        {isRecording ? (
          <span className="text-red-400 animate-pulse font-semibold uppercase tracking-wider">
            CAPTURING: {formatTime(durationSec, true)}
          </span>
        ) : (
          <span>Ready to capture direct soundcard audio</span>
        )}
      </div>

    </div>
  );
};