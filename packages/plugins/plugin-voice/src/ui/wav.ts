/** 16-bit mono PCM → WAV file bytes (44-byte header), for the `transcribe` action (`audio/wav`). */
import { TTS_SAMPLE_RATE } from "../limits.js";

export function encodeWav(samples: Int16Array, sampleRate = TTS_SAMPLE_RATE): ArrayBuffer {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i += 1) view.setInt16(44 + i * 2, samples[i]!, true);
  return buffer;
}

/** Join PCM16 frames (as the mic capture delivers them) into one sample array. */
export function concatPcm16(frames: ArrayBuffer[]): Int16Array {
  const total = frames.reduce((sum, frame) => sum + frame.byteLength / 2, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const frame of frames) {
    out.set(new Int16Array(frame), offset);
    offset += frame.byteLength / 2;
  }
  return out;
}
