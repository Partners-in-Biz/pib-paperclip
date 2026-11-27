// Clip normalisation (pure). The plugin's level is RMS x 4 per frame (src/ui/audio.ts `level`); the endpointer
// counts speech above ENDPOINT_SPEECH_LEVEL = 0.02 (src/limits.ts:38). Clips are scaled so the median speech
// frame sits at TARGET_LEVEL, 20x that threshold, and the quietest speech frames stay above MIN_LEVEL.
export const TARGET_LEVEL = 0.4;
export const MIN_LEVEL = 0.2;
const FRAME = 2048; // ~85 ms at 24 kHz, the size of one plugin mic frame
const PEAK = 0.98;

export function decodePcm16(b64) {
  const buf = Buffer.from(b64, "base64");
  const out = new Float32Array(Math.floor(buf.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

export function encodePcm16(samples) {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  return buf.toString("base64");
}

/** Plugin level of each frame. */
export function frameLevels(samples, frame = FRAME) {
  const out = [];
  for (let at = 0; at < samples.length; at += frame) {
    const end = Math.min(samples.length, at + frame);
    let sum = 0;
    for (let i = at; i < end; i += 1) sum += samples[i] * samples[i];
    out.push(Math.min(1, Math.sqrt(sum / (end - at)) * 4));
  }
  return out;
}

/** Speech frames: at least a tenth of the loudest frame (TTS has near-silent lead-in and tail). */
export function speechLevels(samples) {
  const levels = frameLevels(samples);
  const loudest = Math.max(0, ...levels);
  return levels.filter((l) => l >= loudest / 10 && l > 0).sort((a, b) => a - b);
}

/** Scales and soft-limits a clip; answers the new samples and the median and 10th-percentile speech levels. */
export function normalise(samples) {
  const speech = speechLevels(samples);
  if (speech.length === 0) throw new Error("clip has no speech");
  const median = speech[Math.floor(speech.length / 2)];
  const p10 = speech[Math.floor(speech.length / 10)];
  // Enough gain for the median and for the quiet 10th percentile; tanh compresses the loud frames that overshoot.
  const gain = Math.max(TARGET_LEVEL / median, (MIN_LEVEL * 1.25) / p10);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = PEAK * Math.tanh((samples[i] * gain) / PEAK);
  const after = speechLevels(out);
  return { samples: out, median: after[Math.floor(after.length / 2)], p10: after[Math.floor(after.length / 10)] };
}
