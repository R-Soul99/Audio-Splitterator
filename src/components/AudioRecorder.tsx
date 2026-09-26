import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Square,
  Pause,
  Play,
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
  const knobDragRef = useRef<{ startY: number; startValue: number } | null>(null);
  const monitorKnobDragRef = useRef<{ startY: number; startValue: number } | null>(null);

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
  const recordingWaveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const recordingWaveformHistoryRef = useRef<Float32Array>(new Float32Array(1600));
  const recordingWaveformWriteIndexRef = useRef<number>(0);
  const recordingWaveformPreviousAmplitudeRef = useRef<number>(0);

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

    if (recordingWaveformCanvasRef.current) {
      const waveformCanvas = recordingWaveformCanvasRef.current;
      const waveformCtx = waveformCanvas.getContext('2d');
      if (waveformCtx) {
        const waveformWidth = waveformCanvas.width;
        const waveformHeight = waveformCanvas.height;
        if (isRecordingRef.current && !isPausedRef.current) {
          const history = recordingWaveformHistoryRef.current;
          const writeIndex = recordingWaveformWriteIndexRef.current;
          const averageAmplitude = bufferL.reduce((sum, value) => sum + Math.abs(value), 0) / Math.max(1, bufferL.length);
          history[writeIndex % history.length] = Math.min(1, averageAmplitude * 2.5);
          recordingWaveformWriteIndexRef.current = writeIndex + 1;
          const amplitude = history[writeIndex % history.length];
          const previousY = waveformHeight / 2 - recordingWaveformPreviousAmplitudeRef.current * waveformHeight * 0.42;
          const nextY = waveformHeight / 2 - amplitude * waveformHeight * 0.42;

          // Shift the established trace left and draw only the newest slice at the right edge.
          waveformCtx.drawImage(waveformCanvas, -3, 0);
          waveformCtx.fillStyle = '#020617';
          waveformCtx.fillRect(waveformWidth - 3, 0, 3, waveformHeight);
          waveformCtx.strokeStyle = '#10b981';
          waveformCtx.lineWidth = 2;
          waveformCtx.beginPath();
          waveformCtx.moveTo(waveformWidth - 3, previousY);
          waveformCtx.lineTo(waveformWidth, nextY);
          waveformCtx.stroke();
          recordingWaveformPreviousAmplitudeRef.current = amplitude;
        } else if (recordingWaveformWriteIndexRef.current === 0) {
          waveformCtx.fillStyle = '#020617';
          waveformCtx.fillRect(0, 0, waveformWidth, waveformHeight);
          waveformCtx.strokeStyle = '#1e293b';
          waveformCtx.lineWidth = 1;
          waveformCtx.beginPath();
          waveformCtx.moveTo(0, waveformHeight / 2);
          waveformCtx.lineTo(waveformWidth, waveformHeight / 2);
          waveformCtx.stroke();
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
    pausedDurationRef.current = 0;
    setDurationSec(0);
    recordingWaveformHistoryRef.current.fill(0);
    recordingWaveformWriteIndexRef.current = 0;
    recordingWaveformPreviousAmplitudeRef.current = 0;
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

  const dbToNeedleAngle = (db: number) => {
    const normalized = Math.max(0, Math.min(1, (db + 20) / 23));
    return -55 + normalized * 110;
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
        
        {/* FULL-WIDTH RECORDING CONSOLE */}
        <div className="w-full h-full shrink-0 overflow-hidden bg-slate-900/10 border border-slate-700/60 rounded-xl p-5 flex flex-col items-center justify-start min-h-0 relative gap-3 shadow-[inset_0_0_0_1px_rgba(148,163,184,0.04)]">
          {/* Compact hardware control strip */}
          <div className="absolute bottom-5 left-5 z-10 grid w-[340px] grid-cols-[1fr_auto] items-end gap-3 bg-slate-950/90 border border-slate-700/60 rounded-xl p-3 shadow-[inset_0_1px_0_rgba(148,163,184,0.04)]">
            <div className="w-full space-y-1">
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">Input</label>
              <select
                value={selectedDeviceId}
                onChange={(e) => handleDeviceChange(e.target.value)}
                disabled={isRecording}
                className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1.5 text-xs text-slate-200 font-semibold focus:outline-none focus:border-emerald-500/50 disabled:opacity-50 cursor-pointer"
              >
                {devices.length === 0 && <option value="">Default Audio Input</option>}
                {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
              </select>
            </div>
            <div className="flex flex-col items-center gap-1 border-l border-slate-800 pl-3 shrink-0">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Monitor</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={isRecording}
                  onClick={() => {
                    if (isStandbyMode) {
                      onWakeAudioEngine?.();
                      return;
                    }
                    setMonitoringAudioOutput((previous) => !previous);
                    if (!isMonitoringActive) startMonitoringStream();
                  }}
                  className={`relative w-7 h-12 rounded-full border transition cursor-pointer disabled:opacity-40 ${monitoringAudioOutput ? 'bg-emerald-500/20 border-emerald-500/50' : 'bg-slate-900 border-slate-700'}`}
                  title="Toggle monitor output"
                  aria-label="Toggle monitor output"
                >
                  <span className={`absolute left-1/2 -translate-x-1/2 w-4 h-4 rounded-full border transition-all ${monitoringAudioOutput ? 'top-1 bg-emerald-300 border-emerald-200' : 'bottom-1 bg-slate-500 border-slate-400'}`} />
                </button>
                <div
                  className={`relative w-11 h-11 rounded-full bg-slate-950 border border-slate-800 shadow-inner touch-none ${!monitoringAudioOutput ? 'opacity-40' : ''}`}
                  onPointerDown={(e) => {
                    if (!monitoringAudioOutput) return;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    monitorKnobDragRef.current = { startY: e.clientY, startValue: monitorVolume };
                  }}
                  onPointerMove={(e) => {
                    if (!monitorKnobDragRef.current) return;
                    const deltaVolume = Math.round((monitorKnobDragRef.current.startY - e.clientY) * 0.0078 * 100) / 100;
                    setMonitorVolume(Math.max(0, Math.min(1, monitorKnobDragRef.current.startValue + deltaVolume)));
                  }}
                  onPointerUp={() => { monitorKnobDragRef.current = null; }}
                  onPointerCancel={() => { monitorKnobDragRef.current = null; }}
                >
                  <div className="absolute inset-1 rounded-full border-2 border-slate-700" style={{ background: `conic-gradient(from 225deg, #10b981 ${monitorVolume * 270}deg, #1e293b ${monitorVolume * 270}deg 270deg, transparent 270deg)` }}>
                    <div className="absolute left-1/2 top-1/2 w-0.5 h-4 origin-bottom rounded-full bg-emerald-300" style={{ transform: `translate(-50%, -100%) rotate(${-135 + monitorVolume * 270}deg)` }} />
                    <div className="absolute left-1/2 top-1/2 w-1.5 h-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-300" />
                  </div>
                </div>
              </div>
            </div>
          </div>
          
          {/* 1. Permanent recording waveform with a compact circular signal scope */}
          <div className="order-1 flex items-stretch gap-3 w-full h-56 shrink-0">
            <div className="flex-1 min-w-0 bg-slate-950 p-3 border border-slate-700/60 rounded-xl relative flex flex-col justify-between overflow-hidden shadow-[inset_0_1px_0_rgba(148,163,184,0.04)]">
              <canvas ref={recordingWaveformCanvasRef} width={1000} height={170} className="w-full h-[170px] bg-slate-950 block" />
              {isRecording && (
                <div className="absolute top-3 left-3 z-10 flex items-center gap-1.5 border border-dashed border-amber-400/80 bg-slate-950/90 px-2 py-1 text-[10px] font-mono font-bold uppercase tracking-wider text-red-500">
                  <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                  CAPTURING: {formatTime(durationSec, true)} @ {recordingSampleRate / 1000} kHz {channelMode === 'stereo' ? 'Stereo' : 'Mono'}
                </div>
              )}

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
                <span className="font-bold tracking-wider">RECORDING WAVEFORM</span>
                <span className="flex items-center gap-1.5 font-bold tracking-wider">
                  <span className={`w-2 h-2 rounded-full ${isStandbyMode ? 'bg-amber-500' : clipped ? 'bg-red-500 animate-ping' : isMonitoringActive ? 'bg-emerald-500' : 'bg-slate-700'}`} />
                  <span className={isStandbyMode ? 'text-amber-400 font-bold' : clipped ? 'text-red-400 font-extrabold' : 'text-slate-400'}>
                    {isStandbyMode ? 'STANDBY' : clipped ? 'CLIP' : 'SIGNAL OK'}
                  </span>
                </span>
              </div>
            </div>

            <div className="w-48 bg-slate-950/80 border border-slate-700/60 rounded-xl flex flex-col items-center justify-center gap-2 shadow-lg">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Signal</span>
              <div className="relative w-36 h-36 rounded-full border-4 border-slate-700 bg-slate-950 overflow-hidden shadow-[inset_0_0_18px_rgba(0,0,0,0.8)]">
                <canvas ref={liveCanvasRef} width={160} height={160} className="w-full h-full block rounded-full" />
                <div className="absolute inset-3 rounded-full border border-slate-700/70 pointer-events-none" />
              </div>
              <span className={`text-[10px] font-mono font-bold ${clipped ? 'text-red-400' : isMonitoringActive ? 'text-emerald-400' : 'text-slate-500'}`}>
                {isStandbyMode ? 'STANDBY' : clipped ? 'CLIP' : isMonitoringActive ? 'SIGNAL' : 'NO SIGNAL'}
              </span>
            </div>

          </div>

          {/* 2. Wide digital needle VU meters */}
          <div className="order-2 h-[320px] flex-none flex flex-col items-center justify-start pt-1 w-full shrink-0">
            <div className="flex items-start justify-center gap-5 bg-slate-950/80 p-5 border border-slate-700/60 rounded-xl shadow-lg w-full max-w-3xl">
              {/* L meter */}
              <div className="flex-1 min-w-0 flex flex-col items-center gap-2">
                  <div
                  onClick={handleResetLeftPeak}
                  className={`w-28 h-9 flex items-center justify-center gap-2 text-[11px] font-mono font-bold text-center border bg-slate-950 rounded cursor-pointer hover:border-slate-500 transition shrink-0 ${
                    leftPeakHoldDb >= -0.05
                      ? 'text-red-400 border-red-500/40'
                      : leftPeakHoldDb > -12
                      ? 'text-amber-400 border-amber-500/30'
                      : 'text-emerald-400 border-emerald-500/20'
                  }`}
                  title="Click peak to reset"
                >
                  <span className={`h-2.5 w-2.5 rounded-full border ${leftPeakHoldDb >= -0.05 ? 'bg-red-500 border-red-300 shadow-[0_0_8px_rgba(239,68,68,0.8)]' : 'bg-slate-800 border-slate-600'}`} />
                  <span>{leftPeakHoldDb >= 0 ? 'CLIP' : leftPeakHoldDb <= -60 ? '-∞' : `${leftPeakHoldDb.toFixed(1)}`}</span>
                </div>
                <div className="relative w-full max-w-[260px] h-36 overflow-hidden rounded-t-[140px] border-2 border-slate-700 bg-[#18211f] shadow-[inset_0_0_20px_rgba(0,0,0,0.8)]">
                  <div className="absolute inset-x-5 bottom-3 h-24 rounded-t-[120px] border-t border-slate-500/70" />
                  <div className="absolute inset-x-8 bottom-3 flex justify-between text-[9px] font-mono text-slate-400">
                    <span>-20</span><span>-12</span><span>-6</span><span>0</span><span>+3</span>
                  </div>
                  <div className="absolute left-1/2 bottom-3 h-28 w-0.5 origin-bottom rounded-full bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.8)] transition-transform duration-75 ease-out" style={{ transform: `translateX(-50%) rotate(${dbToNeedleAngle(leftPeakDb)}deg)` }} />
                  <div className="absolute left-1/2 bottom-1.5 h-3 w-3 -translate-x-1/2 rounded-full border border-slate-300 bg-slate-700" />
                </div>
                <span className="text-[11px] font-bold font-mono text-slate-300">L VU</span>
              </div>

              {/* Central reset between the two meter channels */}
              <div className="self-start flex flex-col items-center gap-3 shrink-0">
                <button
                  type="button"
                  onClick={handleResetPeak}
                  className="w-20 h-10 flex items-center justify-center border border-slate-800 bg-slate-950 text-slate-400 hover:text-slate-200 transition cursor-pointer font-mono font-bold text-[10px] uppercase tracking-wider shrink-0 rounded hover:border-slate-600"
                  title="Click to reset both peak holds"
                >
                  RESET
                </button>
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Preamp</span>
                <div
                  className={`relative mt-1 w-16 h-16 rounded-full bg-slate-950 border border-slate-800 shadow-inner touch-none ${isRecording ? 'opacity-40' : ''}`}
                  onPointerDown={(e) => {
                    if (isRecording) return;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    knobDragRef.current = { startY: e.clientY, startValue: inputBoostDb };
                  }}
                  onPointerMove={(e) => {
                    if (!knobDragRef.current) return;
                    const deltaDb = Math.round((knobDragRef.current.startY - e.clientY) * 0.28);
                    setInputBoostDb(Math.max(0, Math.min(36, knobDragRef.current.startValue + deltaDb)));
                  }}
                  onPointerUp={() => { knobDragRef.current = null; }}
                  onPointerCancel={() => { knobDragRef.current = null; }}
                  title="Preamp boost gain"
                >
                  <div className="absolute inset-1 rounded-full border-2 border-slate-700" style={{ background: `conic-gradient(from 225deg, #f59e0b ${(inputBoostDb / 36) * 270}deg, #1e293b ${(inputBoostDb / 36) * 270}deg 270deg, transparent 270deg)` }}>
                    <div className="absolute left-1/2 top-1/2 w-0.5 h-5 origin-bottom rounded-full bg-amber-300" style={{ transform: `translate(-50%, -100%) rotate(${-135 + (inputBoostDb / 36) * 270}deg)` }} />
                    <div className="absolute left-1/2 top-1/2 w-1.5 h-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-300" />
                  </div>
                </div>
                <span className="font-mono font-bold text-amber-400 text-[10px]">+{inputBoostDb.toFixed(0)} dB</span>
              </div>

              {/* R meter */}
              {channelMode === 'stereo' && (
                <div className="flex-1 min-w-0 flex flex-col items-center gap-2">
                  <div
                    onClick={handleResetRightPeak}
                    className={`w-28 h-9 flex items-center justify-center gap-2 text-[11px] font-mono font-bold text-center border bg-slate-950 rounded cursor-pointer hover:border-slate-500 transition shrink-0 ${
                      rightPeakHoldDb >= -0.05
                        ? 'text-red-400 border-red-500/40'
                        : rightPeakHoldDb > -12
                        ? 'text-amber-400 border-amber-500/30'
                        : 'text-emerald-400 border-emerald-500/20'
                    }`}
                    title="Click peak to reset"
                  >
                    <span className={`h-2.5 w-2.5 rounded-full border ${rightPeakHoldDb >= -0.05 ? 'bg-red-500 border-red-300 shadow-[0_0_8px_rgba(239,68,68,0.8)]' : 'bg-slate-800 border-slate-600'}`} />
                    <span>{rightPeakHoldDb >= 0 ? 'CLIP' : rightPeakHoldDb <= -60 ? '-∞' : `${rightPeakHoldDb.toFixed(1)}`}</span>
                  </div>
                    <div className="relative w-full max-w-[260px] h-36 overflow-hidden rounded-t-[140px] border-2 border-slate-700 bg-[#18211f] shadow-[inset_0_0_20px_rgba(0,0,0,0.8)]">
                      <div className="absolute inset-x-5 bottom-3 h-24 rounded-t-[120px] border-t border-slate-500/70" />
                      <div className="absolute inset-x-8 bottom-3 flex justify-between text-[9px] font-mono text-slate-400">
                        <span>-20</span><span>-12</span><span>-6</span><span>0</span><span>+3</span>
                      </div>
                      <div className="absolute left-1/2 bottom-3 h-28 w-0.5 origin-bottom rounded-full bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.8)] transition-transform duration-75 ease-out" style={{ transform: `translateX(-50%) rotate(${dbToNeedleAngle(rightPeakDb)}deg)` }} />
                      <div className="absolute left-1/2 bottom-1.5 h-3 w-3 -translate-x-1/2 rounded-full border border-slate-300 bg-slate-700" />
                  </div>
                    <span className="text-[11px] font-bold font-mono text-slate-300">R VU</span>
                </div>
              )}

            </div>
          </div>

          {/* 3. Centered transport-like recording console controls */}
          <div className="absolute inset-x-5 bottom-5 z-10 h-36">
            <div className="relative h-full w-full">
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
              className={`absolute left-1/2 top-1/2 w-32 h-32 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-slate-950 flex flex-col items-center justify-center text-white font-bold tracking-widest text-sm uppercase cursor-pointer transition-all duration-300 ${
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
              className={`absolute left-[calc(66.6667%_-_45px)] top-1/2 w-12 h-12 -translate-y-1/2 rounded-lg border transition cursor-pointer flex items-center justify-center shadow ${
                isPaused
                  ? 'bg-amber-600/20 border-amber-500/40 text-amber-400 hover:bg-amber-600/30'
                  : 'bg-slate-950 border-slate-850 hover:bg-slate-900 text-slate-400 hover:text-slate-200'
              } disabled:opacity-30 disabled:cursor-not-allowed`}
              title={isPaused ? 'Resume recording' : 'Pause recording'}
            >
              {isPaused ? <Play className="w-4 h-4 fill-current" /> : <Pause className="w-4 h-4" />}
            </button>

            {/* Stop button */}
            <button
              type="button"
              disabled={!isRecording}
              onClick={stopRecording}
              className="absolute left-[calc(83.3333%_-_105px)] top-1/2 w-12 h-12 -translate-y-1/2 rounded-lg bg-slate-950 border border-slate-855 hover:bg-slate-900 flex items-center justify-center text-slate-400 hover:text-red-400 transition cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed shadow"
              title="Stop recording"
            >
              <Square className="w-4 h-4 fill-current" />
            </button>
            </div>

            <div className="absolute right-0 top-1/2 flex -translate-y-1/2 items-end gap-3 rounded-xl border border-slate-700/60 bg-slate-950/90 p-3 shadow-[inset_0_1px_0_rgba(148,163,184,0.04)]">
              <div className="w-16 space-y-1">
                <span className="block text-center text-[10px] font-bold uppercase tracking-wider text-slate-400">kHz</span>
                <div className="flex flex-col rounded border border-slate-850 bg-slate-950 p-0.5 text-[10px]">
                  {[44100, 48000].map((rate) => (
                    <button
                      key={rate}
                      type="button"
                      disabled={isRecording}
                      onClick={() => handleSampleRateChange(rate)}
                      className={`w-full rounded px-2 py-0.5 text-center font-bold transition cursor-pointer ${recordingSampleRate === rate ? 'bg-emerald-500 text-slate-950 shadow' : 'text-slate-400 hover:text-slate-200'} disabled:opacity-50`}
                    >
                      {rate / 1000}
                    </button>
                  ))}
                </div>
              </div>
              <div className="w-16 space-y-1">
                <span className="block text-center text-[10px] font-bold uppercase tracking-wider text-slate-400">Mode</span>
                <div className="flex flex-col rounded border border-slate-850 bg-slate-950 p-0.5 text-[10px]">
                  {(['stereo', 'mono'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      disabled={isRecording}
                      onClick={() => handleModeChange(mode)}
                      className={`w-full rounded px-2 py-0.5 text-center font-bold uppercase transition cursor-pointer ${channelMode === mode ? 'bg-emerald-500 text-slate-950 shadow' : 'text-slate-400 hover:text-slate-200'} disabled:opacity-50`}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
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
