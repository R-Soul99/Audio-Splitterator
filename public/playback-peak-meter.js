class PlaybackPeakProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.peaks = [0, 0]; this.frames = 0; this.peakTimes = [0, 0]; this.epoch = 0; this.port.onmessage = event => { this.epoch = event.data.epoch; this.peaks = [0, 0]; this.peakTimes = [0, 0]; this.frames = 0; }; }
  process(inputs) {
    const channels = inputs[0];
    if (channels?.length) {
      for (let c = 0; c < 2; c++) {
        const data = channels[c] || channels[0];
        for (let i = 0; i < data.length; i++) { const peak = Math.abs(data[i]); if (Number.isFinite(peak) && peak > this.peaks[c]) { this.peaks[c] = peak; this.peakTimes[c] = currentTime + i / sampleRate; } }
      }
      this.frames += channels[0].length;
      if (this.frames >= 512) {
        this.port.postMessage({ epoch: this.epoch, end: currentTime + channels[0].length / sampleRate, peaks: this.peaks, peakTimes: this.peakTimes });
        this.peaks = [0, 0]; this.peakTimes = [0, 0]; this.frames = 0;
      }
    }
    if (!channels?.length && this.frames) {
      this.port.postMessage({ epoch: this.epoch, end: currentTime, peaks: this.peaks, peakTimes: this.peakTimes });
      this.peaks = [0, 0]; this.peakTimes = [0, 0]; this.frames = 0;
    }
    return true;
  }
}
registerProcessor('playback-sample-peaks', PlaybackPeakProcessor);
