import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Square,
  Pause,
  Play,
  Settings,
  MicOff,
  Radio,
} from 'lucide-react';
import { AudioDeviceOption } from '../types';
import { formatTime } from '../utils/audioProcessing';

interface AudioRecorderProps {
  onRecordingComplete: (audioBuffer: AudioBuffer, defaultName: string, artist?: string, album?: string) => void;
  isRecordingActive: boolean;
  setIsRecordingActive: (active: boolean) => void;
  onClearRecording?: () => void;
  hasLoadedAudio?: boolean;
  isStandbyMode?: boolean;
  onWakeAudioEngine?: () => void;
}

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

  // Pre-allocated static buffers to avoid Garbage Collection sweeps in requestAnimationFrame
  const bufferLeftRef = useRef<Float32Array | null>(null);
  const bufferRightRef = useRef<Float32Array | null>(null);

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
        const baseWidth = 940;
        const baseHeight = 735;
        
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
    for (let i = 0; i < bufferL.length; i++) {
      const absVal = Math.abs(bufferL[i]);
      if (absVal > maxL) maxL = absVal;
    }

    let maxR = maxL;
    if (analyserR) {
      // Reuse pre-allocated Right Buffer
      if (!bufferRightRef.current || bufferRightRef.current.length !== analyserR.fftSize) {
        bufferRightRef.current = new Float32Array(analyserR.fftSize);
      }
      const bufferR = bufferRightRef.current;
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

        const len = bufferL.length;
        for (let x = 0; x < width; x++) {
          const sampleIdx = Math.floor((x / width) * len);
          const val = sampleIdx < len ? bufferL[sampleIdx] : 0;
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
    [selectedDeviceId, channelMode, recordingSampleRate, monitoringAudioOutput, monitorVolume, updateMeterLoop, isStandbyMode]
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

    const defaultName = 'Recording';
    onRecordingComplete(finalBuffer, defaultName, '', '');
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
    <div ref={containerRef} className="w-full h-full flex items-center justify-center overflow-hidden relative select-none">
      
      {/* Rigid, centered hardware layout wrapper scaling proportionally with CSS transform scale */}
      <div
        className="w-[940px] h-[735px] shrink-0 flex flex-row gap-6 relative"
        style={{
          transform: `scale(${scale})`,
          transformOrigin: 'center center',
        }}
      >
        
        {/* LEFT INPUT SETTINGS RAIL (Fixed position, never moves or collapses) */}
        <div className="w-80 shrink-0 bg-slate-900/60 border border-slate-800 rounded-xl p-4 flex flex-col space-y-4">
          <div className="flex items-center space-x-2 border-b border-slate-800 pb-2">
            <Settings className="w-4 h-4 text-emerald-400" />
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">Input Configuration</h3>
          </div>

          {/* 1. Input Soundcard Device Selection */}
          <div className="space-y-1.5 text-left">
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
              Input Device
            </label>
            <select
              value={selectedDeviceId}
              onChange={(e) => handleDeviceChange(e.target.value)}
              disabled={isRecording}
              className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-xs text-slate-200 font-semibold focus:outline-none focus:border-emerald-500/50 disabled:opacity-50 cursor-pointer"
            >
              {devices.length === 0 && <option value="">Default Audio Input</option>}
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>

          {/* 2. Channel Mode Toggle (Stereo / Mono) */}
          <div className="space-y-1.5 text-left">
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
              Channel Mode
            </label>
            <div className="flex bg-slate-950 p-0.5 rounded border border-slate-850 text-xs">
              <button
                type="button"
                disabled={isRecording}
                onClick={() => handleModeChange('stereo')}
                className={`flex-1 py-1 px-2.5 rounded font-bold text-center cursor-pointer transition ${
                  channelMode === 'stereo'
                    ? 'bg-emerald-500 text-slate-950 shadow'
                    : 'text-slate-400 hover:text-slate-200'
                } disabled:opacity-50`}
              >
                Stereo
              </button>
              <button
                type="button"
                disabled={isRecording}
                onClick={() => handleModeChange('mono')}
                className={`flex-1 py-1 px-2.5 rounded font-bold text-center cursor-pointer transition ${
                  channelMode === 'mono'
                    ? 'bg-emerald-500 text-slate-950 shadow'
                    : 'text-slate-400 hover:text-slate-200'
                } disabled:opacity-50`}
              >
                Mono
              </button>
            </div>
          </div>

          {/* 3. Direct Sample Rate Capture Format */}
          <div className="space-y-1.5 text-left">
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
              Capture Format
            </label>
            <div className="flex bg-slate-950 p-0.5 rounded border border-slate-850 text-xs">
              <button
                type="button"
                disabled={isRecording}
                onClick={() => handleSampleRateChange(44100)}
                className={`flex-1 py-1.5 px-2.5 rounded font-bold text-center cursor-pointer transition ${
                  recordingSampleRate === 44100
                    ? 'bg-emerald-500 text-slate-950 shadow'
                    : 'text-slate-400 hover:text-slate-200'
                } disabled:opacity-50`}
              >
                44.1 kHz
              </button>
              <button
                type="button"
                disabled={isRecording}
                onClick={() => handleSampleRateChange(48000)}
                className={`flex-1 py-1.5 px-2.5 rounded font-bold text-center cursor-pointer transition ${
                  recordingSampleRate === 48000
                    ? 'bg-emerald-500 text-slate-950 shadow'
                    : 'text-slate-400 hover:text-slate-200'
                } disabled:opacity-50`}
              >
                48.0 kHz
              </button>
            </div>
          </div>

          {/* 4. Preamp Gain Boost Slider */}
          <div className="space-y-1.5 text-left">
            <div className="flex justify-between items-center text-[10px] font-bold text-slate-400 uppercase tracking-wider">
              <span>Preamp Boost</span>
              <span className="font-mono font-bold text-amber-400">+{inputBoostDb.toFixed(0)} dB</span>
            </div>
            <div className="bg-slate-950 p-2 rounded border border-slate-850 flex items-center">
              <input
                type="range"
                min="0"
                max="36"
                step="1"
                value={inputBoostDb}
                disabled={isRecording}
                onChange={(e) => setInputBoostDb(parseFloat(e.target.value))}
                className="w-full accent-amber-500 cursor-pointer disabled:opacity-40"
                title="Preamp input boost gain"
              />
            </div>
          </div>

          {/* 5. Monitor Control (Rearranged from monitorPanel_rearrange.png) */}
          <div className="space-y-1.5 text-left">
            <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider select-none shrink-0">
              <button
                type="button"
                disabled={isRecording}
                onClick={() => {
                  if (isStandbyMode) {
                    onWakeAudioEngine?.();
                    return;
                  }
                  isMonitoringActive ? stopMonitoringStream() : startMonitoringStream();
                }}
                className={`text-[10px] font-extrabold uppercase tracking-wider transition cursor-pointer ${
                  isStandbyMode
                    ? 'text-amber-400 hover:text-amber-300'
                    : monitoringAudioOutput
                    ? 'text-emerald-300 hover:text-emerald-200'
                    : 'text-red-400 hover:text-red-300'
                } disabled:opacity-45 disabled:cursor-not-allowed`}
                title={
                  isStandbyMode
                    ? 'Preview audio is in Standby. Click to wake engine.'
                    : isMonitoringActive
                    ? 'Disable Live Monitor'
                    : 'Enable Live Monitor'
                }
              >
                {isStandbyMode ? 'MONITOR (STANDBY)' : 'MONITOR'}
              </button>
              <span className="font-mono font-bold text-emerald-450">
                {isStandbyMode ? 'STANDBY' : monitoringAudioOutput ? `${Math.round(monitorVolume * 100)}%` : 'MUTED'}
              </span>
            </div>
            
            <div className="bg-slate-950 p-3 rounded border border-slate-850 flex items-center space-x-3 shrink-0">
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={monitorVolume}
                disabled={!monitoringAudioOutput}
                onChange={(e) => setMonitorVolume(parseFloat(e.target.value))}
                className="flex-1 accent-emerald-500 cursor-pointer disabled:opacity-40"
                title="Monitoring output volume"
              />
              <button
                type="button"
                onClick={() => setMonitoringAudioOutput(!monitoringAudioOutput)}
                className={`text-[10px] font-bold px-3 py-1.5 rounded cursor-pointer transition border shrink-0 uppercase tracking-wider font-mono ${
                  monitoringAudioOutput
                    ? 'bg-emerald-500 text-slate-950 border-emerald-500'
                    : 'bg-red-500/20 text-red-400 border-red-500/30'
                }`}
              >
                {monitoringAudioOutput ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>
        </div>

        {/* RIGHT/CENTER CONTENT: MAIN RECORDING CONSOLE (Symmetric, permanently fixed layout) */}
        <div className="flex-1 bg-slate-900/10 border border-slate-900 rounded-xl p-4 lg:p-6 flex flex-col items-center justify-between min-h-0 relative space-y-4">
          
          {/* 1. Large Oscilloscope along the top */}
          <div className="w-full bg-slate-950 p-3 border border-slate-900 rounded-xl relative flex flex-col justify-between h-56 shrink-0 overflow-hidden">
            <canvas ref={liveCanvasRef} width={1000} height={170} className="w-full h-[170px] bg-slate-950 block" />

            {/* Standby Mode Overlay */}
            {isStandbyMode && (
              <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-[3px] flex flex-col items-center justify-center p-4 z-20 text-center select-none border border-amber-500/20">
                <div className="w-10 h-10 rounded-full bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400 mb-2 shadow-[0_0_15px_rgba(245,158,11,0.2)]">
                  <MicOff className="w-5 h-5" />
                </div>
                <div className="text-xs font-bold text-slate-200 tracking-wider uppercase mb-1">
                  Preview Audio Engine in Standby
                </div>
                <p className="text-[11px] text-slate-400 max-w-sm mb-3 leading-relaxed">
                  Microphone inputs and Web Audio outputs are released so this preview won't echo or clash with your local dev app.
                </p>
                <button
                  type="button"
                  onClick={onWakeAudioEngine}
                  className="px-3.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-450 text-slate-950 font-bold text-xs flex items-center gap-1.5 transition cursor-pointer shadow-lg"
                >
                  <Radio className="w-3.5 h-3.5" />
                  <span>Wake Audio Engine</span>
                </button>
              </div>
            )}

            <div className="flex items-center justify-between text-[10px] font-mono text-slate-500 pt-2 px-1 shrink-0">
              <span className="font-bold tracking-wider">OSCILLOSCOPE SIGNAL FEED</span>
              <span className="flex items-center gap-1.5 font-bold tracking-wider">
                <span className={`w-2 h-2 rounded-full ${isStandbyMode ? 'bg-amber-500' : clipped ? 'bg-red-500 animate-ping' : isMonitoringActive ? 'bg-emerald-500' : 'bg-slate-700'}`} />
                <span className={isStandbyMode ? 'text-amber-400 font-bold' : clipped ? 'text-red-400 font-extrabold' : 'text-slate-400'}>
                  {isStandbyMode ? 'STANDBY' : clipped ? 'CLIP' : 'SIGNAL OK'}
                </span>
              </span>
            </div>
          </div>

          {/* 2. Vertically Centered Meters Chamber (placed underneath) */}
          <div className="flex-1 flex flex-col items-center justify-center w-full min-h-0">
            <div className="flex items-center justify-center gap-4 bg-slate-950/80 p-5 border border-slate-900/60 rounded-xl shadow-lg w-full max-w-sm">
              {/* L meter */}
              <div className="flex flex-col items-center space-y-1.5">
                <div
                  onClick={handleResetLeftPeak}
                  className={`w-14 h-7 flex items-center justify-center text-[10px] font-mono font-bold text-center border bg-slate-950 rounded cursor-pointer hover:border-slate-500 transition shrink-0 ${
                    leftPeakHoldDb >= -0.05
                      ? 'text-red-400 border-red-500/40'
                      : leftPeakHoldDb > -12
                      ? 'text-amber-400 border-amber-500/30'
                      : 'text-emerald-400 border-emerald-500/20'
                  }`}
                  title="Click peak to reset"
                >
                  {leftPeakHoldDb >= 0 ? 'CLIP' : leftPeakHoldDb <= -60 ? '-∞' : `${leftPeakHoldDb.toFixed(1)}`}
                </div>
                <div className="relative w-8 h-36 bg-slate-950 border border-slate-900 overflow-hidden flex flex-col justify-end p-0.5 rounded-sm">
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
                <span className="text-[10px] font-bold font-mono text-slate-400 pt-0.5">L</span>
              </div>

              {/* Central DB Scale labels with single integrated RESET button */}
              <div className="flex flex-col items-center space-y-1.5 shrink-0">
                <button
                  type="button"
                  onClick={handleResetPeak}
                  className="w-14 h-7 flex items-center justify-center border border-slate-900 bg-slate-950 text-slate-500 hover:text-slate-355 transition cursor-pointer font-mono font-bold text-[9px] uppercase tracking-wider shrink-0 rounded hover:border-slate-800"
                  title="Click to reset both peak holds"
                >
                  RESET
                </button>
                <div className="flex flex-col justify-between py-1 h-36 text-[9px] font-mono text-slate-455 text-center px-2 font-semibold leading-none select-none shrink-0">
                  <span className="text-red-400 font-bold">+3</span>
                  <span className="text-red-400 font-bold">0</span>
                  <span className="text-amber-400">-3</span>
                  <span className="text-amber-400">-6</span>
                  <span className="text-emerald-455 font-semibold">-12</span>
                  <span className="text-emerald-455 font-semibold">-18</span>
                  <span className="text-slate-550">-24</span>
                  <span className="text-slate-550 font-bold">-36</span>
                  <span className="text-slate-655">-48</span>
                  <span className="text-slate-700">-60</span>
                </div>
                <span className="text-[10px] font-bold font-mono text-transparent pt-0.5 select-none pointer-events-none shrink-0">C</span>
              </div>

              {/* R meter */}
              {channelMode === 'stereo' && (
                <div className="flex flex-col items-center space-y-1.5">
                  <div
                    onClick={handleResetRightPeak}
                    className={`w-14 h-7 flex items-center justify-center text-[10px] font-mono font-bold text-center border bg-slate-950 rounded cursor-pointer hover:border-slate-500 transition shrink-0 ${
                      rightPeakHoldDb >= -0.05
                        ? 'text-red-400 border-red-500/40'
                        : rightPeakHoldDb > -12
                        ? 'text-amber-400 border-amber-500/30'
                        : 'text-emerald-400 border-emerald-500/20'
                    }`}
                    title="Click peak to reset"
                  >
                    {rightPeakHoldDb >= 0 ? 'CLIP' : rightPeakHoldDb <= -60 ? '-∞' : `${rightPeakHoldDb.toFixed(1)}`}
                  </div>
                  <div className="relative w-8 h-36 bg-slate-950 border border-slate-900 overflow-hidden flex flex-col justify-end p-0.5 rounded-sm">
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
                  <span className="text-[10px] font-bold font-mono text-slate-400 pt-0.5">R</span>
                </div>
              )}
            </div>
          </div>

          {/* 3. Centered transport-like recording console controls */}
          <div className="flex items-center justify-center space-x-8 py-2 shrink-0 w-full">
            {/* Stop button */}
            <button
              type="button"
              disabled={!isRecording}
              onClick={stopRecording}
              className="w-12 h-12 rounded-lg bg-slate-950 border border-slate-855 hover:bg-slate-900 flex flex-col items-center justify-center text-slate-400 hover:text-red-400 transition cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed shadow"
            >
              <Square className="w-4 h-4 fill-current" />
              <span className="text-[8px] font-bold font-mono tracking-wider uppercase pt-1">STOP</span>
            </button>

            {/* Glowing Red RECORD button */}
            <button
              type="button"
              onClick={() => {
                if (isStandbyMode) {
                  onWakeAudioEngine?.();
                } else {
                  if (isRecording) {
                    stopRecording();
                  } else {
                    startRecording();
                  }
                }
              }}
              className={`w-20 h-20 rounded-full border-4 border-slate-950 flex flex-col items-center justify-center text-white font-bold tracking-widest text-xs uppercase cursor-pointer transition-all duration-300 ${
                isStandbyMode
                  ? 'bg-amber-600 hover:bg-amber-500 shadow-[0_0_20px_rgba(245,158,11,0.35)] hover:shadow-[0_0_30px_rgba(245,158,11,0.55)]'
                  : isRecording
                  ? 'bg-red-700 shadow-[0_0_25px_rgba(239,68,68,0.7)] animate-pulse'
                  : 'bg-red-600 hover:bg-red-500 shadow-[0_0_20px_rgba(239,68,68,0.3)] hover:shadow-[0_0_30px_rgba(239,68,68,0.5)]'
              }`}
              title={
                isStandbyMode
                  ? 'Audio engine is sleeping in Standby. Click to wake and record.'
                  : isRecording
                  ? 'Stop Recording'
                  : 'Start Recording'
              }
            >
              <span>{isStandbyMode ? 'WAKE' : 'RECORD'}</span>
              {isStandbyMode && (
                <span className="text-[7px] font-mono text-amber-200 uppercase tracking-tight">ENGINE</span>
              )}
            </button>

            {/* Pause/Resume button */}
            <button
              type="button"
              disabled={!isRecording}
              onClick={togglePause}
              className={`w-12 h-12 rounded-lg border transition cursor-pointer flex flex-col items-center justify-center shadow ${
                isPaused
                  ? 'bg-amber-600/20 border-amber-500/40 text-amber-400 hover:bg-amber-600/30'
                  : 'bg-slate-950 border-slate-850 hover:bg-slate-900 text-slate-400 hover:text-slate-200'
              } disabled:opacity-30 disabled:cursor-not-allowed`}
            >
              {isPaused ? <Play className="w-4 h-4 fill-current" /> : <Pause className="w-4 h-4" />}
              <span className="text-[8px] font-bold font-mono tracking-wider uppercase pt-1">{isPaused ? 'RESUME' : 'PAUSE'}</span>
            </button>
          </div>

          {/* Capturing Status Detail text at the bottom (only visible when recording) */}
          <div className="text-[10px] font-mono text-slate-400 shrink-0 select-none pb-1 font-medium min-h-[16px]">
            {isRecording && (
              <span className="text-red-500 animate-pulse font-bold uppercase tracking-wider flex items-center justify-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-red-500" />
                CAPTURING: {formatTime(durationSec, true)} @ {recordingSampleRate / 1000} kHz {channelMode === 'stereo' ? 'Stereo' : 'Mono'}
              </span>
            )}
          </div>

        </div>
      </div>
    </div>
  );
};
