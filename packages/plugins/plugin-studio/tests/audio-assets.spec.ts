/** Sound files (PAR-8415): MP3 and WAV are sniffed from their bytes, stored as kind `audio`, and probed by the existing probe. */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extFor, kindFor, sniffMime } from "../src/storage.js";
import { probeMedia } from "../src/video-edit/probe.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const pad = (head: number[]) => new Uint8Array([...head, ...new Array(16).fill(0)]);
const hasProbe = ["/usr/bin/timeout", "/usr/bin/prlimit", "/usr/bin/nice"].every(existsSync) && spawnSync("ffprobe", ["-version"]).status === 0;

describe("audio assets", () => {
  it("an MP3 (ID3 tag) stores as kind audio with extension mp3", () => {
    const mime = sniffMime(fixture("tone.mp3"));
    expect(mime).toBe("audio/mpeg");
    expect(kindFor(mime!)).toBe("audio");
    expect(extFor(mime!)).toBe("mp3");
  });

  it("an MP3 without a tag is found by its frame sync", () => {
    expect(sniffMime(pad([0xff, 0xfb, 0x90, 0x64]))).toBe("audio/mpeg"); // MPEG-1 layer III
    expect(sniffMime(pad([0xff, 0xf3, 0x48, 0xc4]))).toBe("audio/mpeg"); // MPEG-2 layer III
  });

  it("ADTS AAC, JPEG and a reserved MPEG version are not MP3", () => {
    expect(sniffMime(pad([0xff, 0xf1, 0x50, 0x80]))).toBeNull();
    expect(sniffMime(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMime(pad([0xff, 0xeb, 0x90, 0x64]))).toBeNull();
  });

  it("a WAV stores as kind audio with extension wav; WEBP (also RIFF) stays an image", () => {
    const mime = sniffMime(fixture("tone.wav"));
    expect(mime).toBe("audio/wav");
    expect(kindFor(mime!)).toBe("audio");
    expect(extFor(mime!)).toBe("wav");
    expect(sniffMime(pad([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")]))).toBe("image/webp");
  });

  it("other sound types are still refused", () => {
    expect(() => extFor("audio/ogg")).toThrow(/MP3, WAV/);
  });

  it.skipIf(!hasProbe)("the existing probe reads the length of both fixtures", async () => {
    const mp3 = await probeMedia(join(FIXTURES, "tone.mp3"));
    expect(mp3).toMatchObject({ hasAudio: true, hasVideo: false });
    expect(Math.abs(mp3.durationSec - 0.5)).toBeLessThan(0.2); // encoder padding at 8 kHz
    const wav = await probeMedia(join(FIXTURES, "tone.wav"));
    expect(wav).toMatchObject({ hasAudio: true, hasVideo: false });
    expect(Math.abs(wav.durationSec - 0.25)).toBeLessThan(0.01);
  });
});
