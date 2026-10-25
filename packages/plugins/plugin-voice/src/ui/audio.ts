/** Grok voice speaks and listens in 24 kHz mono PCM16 (little-endian). */
export const LIVE_SAMPLE_RATE = 24_000;

/** Linear resample; speech at 44.1/48 kHz down to 24 kHz loses nothing that matters. */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, input.length - 1);
    const frac = pos - left;
    out[i] = input[left]! * (1 - frac) + input[right]! * frac;
  }
  return out;
}

export function floatToPcm16(input: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i]!));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

export function pcm16ToFloat(buffer: ArrayBuffer): Float32Array<ArrayBuffer> {
  const view = new DataView(buffer);
  const samples = Math.floor(buffer.byteLength / 2);
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Root-mean-square level of a frame, 0..1, for the orb. */
export function level(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) sum += frame[i]! * frame[i]!;
  return Math.min(1, Math.sqrt(sum / frame.length) * 4);
}

/**
 * Microphone capture. ScriptProcessorNode is deprecated but works on every
 * phone browser and needs no separate worklet file (the host's CSP and the
 * plugin bundle make a worklet module awkward).
 */
export class MicCapture {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  muted = false;
  private stopped = false;

  constructor(
    private readonly context: AudioContext,
    private readonly onFrame: (pcm16: ArrayBuffer, level: number) => void,
  ) {}

  async start(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    // Hung up while the permission prompt was open: release the mic at once.
    if (this.stopped) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.stream = stream;
    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(4096, 1, 1);
    // A silent sink keeps the processor running without echoing the mic.
    this.sink = this.context.createGain();
    this.sink.gain.value = 0;
    this.processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const frame = resample(input, this.context.sampleRate, LIVE_SAMPLE_RATE);
      this.onFrame(this.muted ? floatToPcm16(new Float32Array(frame.length)) : floatToPcm16(frame), this.muted ? 0 : level(frame));
    };
    this.source.connect(this.processor);
    this.processor.connect(this.sink);
    this.sink.connect(this.context.destination);
  }

  stop(): void {
    this.stopped = true;
    this.processor?.disconnect();
    this.source?.disconnect();
    this.sink?.disconnect();
    if (this.processor) this.processor.onaudioprocess = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.source = null;
    this.processor = null;
    this.sink = null;
  }
}

/** Queues assistant audio back to back; `flush` stops it at once on barge-in. */
export class Player {
  private playhead = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private idleWaiters: Array<() => void> = [];
  onLevel: ((level: number) => void) | null = null;

  constructor(private readonly context: AudioContext) {}

  get playing(): boolean {
    return this.sources.size > 0;
  }

  enqueue(pcm16: ArrayBuffer): void {
    const samples = pcm16ToFloat(pcm16);
    if (samples.length === 0) return;
    const buffer = this.context.createBuffer(1, samples.length, LIVE_SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const startAt = Math.max(this.context.currentTime + 0.02, this.playhead);
    source.start(startAt);
    this.playhead = startAt + buffer.duration;
    this.sources.add(source);
    const chunkLevel = level(samples);
    source.onended = () => {
      this.sources.delete(source);
      if (this.sources.size === 0) {
        this.onLevel?.(0);
        const waiters = this.idleWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
    };
    this.onLevel?.(chunkLevel);
  }

  flush(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Not started yet.
      }
    }
    this.sources.clear();
    this.playhead = 0;
    this.onLevel?.(0);
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  /** Resolves when everything queued has played (or was flushed). */
  idle(): Promise<void> {
    if (this.sources.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}
