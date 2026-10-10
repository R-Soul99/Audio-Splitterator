import { outputClock } from './playbackClock';
export interface PeakLevels { live: [number, number]; held: [number, number]; error?: string }
/** Silent side branch: the approved source-to-destination audio path stays intact. */
export class PlaybackPeakMeter {
  private context: AudioContext | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private attached = new Set<AudioBufferSourceNode>();
  private retired = new Map<AudioBufferSourceNode, number>();
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private active = false;
  private generation = 0;
  private epoch = 0;
  private raf = 0;
  private queue: { end: number; peaks: [number, number]; peakTimes: [number, number] }[] = [];
  private listeners = new Set<(levels: PeakLevels) => void>();
  private levels: PeakLevels = { live: [0, 0], held: [0, 0] };
  private modules = new WeakMap<AudioContext, Promise<void>>();
  subscribe(listener: (levels: PeakLevels) => void) { this.listeners.add(listener); listener(this.levels); return () => { this.listeners.delete(listener); }; }
  private emit() { for (const listener of this.listeners) listener(this.levels); }
  reset() { this.levels = { ...this.levels, held: [0, 0] }; this.emit(); }
  recordingChanged() { this.stop(); this.reset(); }
  track(source: AudioBufferSourceNode, context: AudioContext) {
    if (this.context !== context) { this.disconnect(); this.sources.clear(); this.retired.clear(); this.context = context; }
    this.sources.add(source);
    if (this.active) void this.connect();
  }
  untrack(source: AudioBufferSourceNode) {
    this.attached.delete(source);
    // Render completion precedes heard completion; preserve queued final-sample peaks.
    if (this.active && this.node && this.context) this.retired.set(source, this.context.currentTime);
    else this.sources.delete(source);
  }
  private hear(clock: number): [number, number] {
    const live: [number, number] = [0, 0], held: [number, number] = [...this.levels.held];
    while (this.queue.length) {
      const block = this.queue[0];
      for (let c = 0; c < 2; c++) if (block.peakTimes[c] <= clock) {
        live[c] = Math.max(live[c], block.peaks[c]);
        held[c] = Math.max(held[c], block.peaks[c]);
        block.peaks[c] = 0;
      }
      if (block.end > clock) break;
      this.queue.shift();
    }
    this.levels = { ...this.levels, held };
    return live;
  }
  stop() {
    if (this.context) this.hear(outputClock(this.context, performance.now()));
    this.epoch++;
    this.node?.port.postMessage({ epoch: this.epoch });
    for (const source of this.attached) { try { if (this.node) source.disconnect(this.node); } catch {} }
    this.sources.clear(); this.attached.clear(); this.retired.clear(); this.queue = [];
    this.levels = { ...this.levels, live: [0, 0] }; this.emit();
  }
  setActive(active: boolean) {
    if (this.active === active) return;
    this.active = active;
    if (active) void this.connect(); else this.disconnect();
  }
  private disconnect() {
    this.generation++;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const source of this.attached) { try { if (this.node) source.disconnect(this.node); } catch {} }
    this.attached.clear();
    for (const source of this.retired.keys()) this.sources.delete(source);
    this.retired.clear();
    if (this.node) { this.node.port.onmessage = null; this.node.port.close(); this.node.disconnect(); }
    this.sink?.disconnect(); this.node = null; this.sink = null; this.queue = [];
    this.levels = { ...this.levels, live: [0, 0] }; this.emit();
  }
  private connecting: Promise<void> | null = null;
  private async connect() {
    const ctx = this.context;
    if (!this.active || !ctx || ctx.state === 'closed') return;
    if (!this.node) {
      if (this.connecting) return this.connecting;
      const generation = this.generation;
      this.connecting = (async () => {
        try {
          let module = this.modules.get(ctx);
          if (!module) { module = ctx.audioWorklet.addModule(new URL('playback-peak-meter.js', document.baseURI).href); this.modules.set(ctx, module); }
          await module;
          if (!this.active || generation !== this.generation || ctx !== this.context) return;
          this.node = new AudioWorkletNode(ctx, 'playback-sample-peaks', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
          this.node.port.postMessage({ epoch: this.epoch });
          this.sink = ctx.createGain(); this.sink.gain.value = 0;
          this.node.connect(this.sink); this.sink.connect(ctx.destination);
          this.node.port.onmessage = event => {
            if (event.data.epoch !== this.epoch || !this.sources.size) return;
            this.queue.push(event.data);
            // Bound backlog without losing a held peak when the UI is briefly busy.
            if (this.queue.length > 256) {
              const first = this.queue.shift()!;
              for (let c = 0; c < 2; c++) if (first.peaks[c] > this.queue[0].peaks[c]) {
                this.queue[0].peaks[c] = first.peaks[c]; this.queue[0].peakTimes[c] = first.peakTimes[c];
              }
            }
          };
          const tick = () => {
            if (!this.active || !this.context || !this.node) return;
            const clock = outputClock(this.context, performance.now());
            let live = this.hear(clock);
            for (const [source, end] of this.retired) if (end <= clock) { this.sources.delete(source); this.retired.delete(source); }
            if (!this.sources.size || this.context.state !== 'running') live = [0, 0];
            this.levels = { ...this.levels, live }; this.emit();
            this.raf = requestAnimationFrame(tick);
          };
          this.raf = requestAnimationFrame(tick);
        } catch { this.levels = { ...this.levels, error: 'Playback meters unavailable' }; this.emit(); }
        finally { this.connecting = null; if (this.active && (generation !== this.generation || ctx !== this.context)) void this.connect(); }
      })();
      await this.connecting;
    }
    if (!this.node || !this.active) return;
    for (const source of this.sources) if (!this.attached.has(source)) { source.connect(this.node); this.attached.add(source); }
  }
  dispose() { this.active = false; this.disconnect(); this.sources.clear(); this.retired.clear(); this.listeners.clear(); }
}
