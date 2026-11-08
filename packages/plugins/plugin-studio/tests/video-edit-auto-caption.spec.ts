import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { audioExtractArgs, captionOps, groupCues, timelineWords } from "../src/video-edit/auto-caption.js";
import { runContained } from "../src/video-edit/ffmpeg.js";
import { applyOps } from "../src/video-edit/ops.js";
import { parseSttWords, XAI_STT_MODEL, XAI_STT_URL, xaiSpeechToText } from "../src/video-edit/stt.js";
import { normalizeEdit, type CaptionClip } from "../src/video-edit/timeline.js";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const fixture = JSON.parse(readFileSync(new URL("./fixtures/xai-stt-words.json", import.meta.url), "utf8"));

function doc(extra: unknown[] = []) {
  return normalizeEdit({
    tracks: [
      { id: "video", kind: "video", clips: [{ id: "clip-1", assetId: "a1", version: 1, in: 2, out: 8, start: 1 }] },
      ...extra,
    ],
  });
}

describe("speech to text words (fixture)", () => {
  it("parses xAI words, drops empty ones and sorts by time", () => {
    const words = parseSttWords(fixture.words);
    expect(words).toHaveLength(10);
    expect(words[0]).toEqual({ text: "Hi", start: 0.32, end: 0.5 });
    expect(parseSttWords([{ word: "alt", start: 1, end: 2 }, { text: "bad", start: 2, end: 1 }, null])).toEqual([{ text: "alt", start: 1, end: 2 }]);
    expect(parseSttWords(undefined)).toEqual([]);
  });

  it("calls xAI with the model and the WAV, and returns its words", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const stt = xaiSpeechToText("test-key", async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(fixture), { status: 200, headers: { "content-type": "application/json" } });
    });
    const out = await stt.transcribe({ audio: new Uint8Array([1, 2, 3]), mimeType: "audio/wav", language: "en" });
    expect(calls[0].url).toBe(XAI_STT_URL);
    const form = calls[0].init.body as FormData;
    expect(form.get("model")).toBe(XAI_STT_MODEL);
    expect(form.get("language")).toBe("en");
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect(out.words).toHaveLength(10);
    expect(out.duration).toBe(6.2);
  });

  it("names a bad key without echoing it", async () => {
    const stt = xaiSpeechToText("secret-123", async () => new Response("no", { status: 401 }));
    await expect(stt.transcribe({ audio: new Uint8Array([1]), mimeType: "audio/wav" })).rejects.toThrow(/401.*xAI key/);
    await expect(stt.transcribe({ audio: new Uint8Array([1]), mimeType: "audio/wav" })).rejects.not.toThrow(/secret-123/);
  });
});

describe("word timing to the timeline", () => {
  it("offsets by the clip start, clips to the clip's span and divides by speed", () => {
    const words = parseSttWords(fixture.words);
    const at1 = timelineWords(words, { start: 1, in: 2, out: 8, speed: 1 });
    expect(at1[0]).toEqual({ text: "Hi", start: 1.32, end: 1.5 });
    // "late" runs past the 6 s span and is cut at the clip's end (1 + 6 = 7).
    expect(at1[at1.length - 1]).toEqual({ text: "late", start: 6.9, end: 7 });
    const fast = timelineWords(words, { start: 0, in: 0, out: 6, speed: 2 });
    expect(fast[0]).toEqual({ text: "Hi", start: 0.16, end: 0.25 });
    expect(fast[fast.length - 1].end).toBeLessThanOrEqual(3);
  });

  it("never lets words overlap", () => {
    const out = timelineWords([{ text: "a", start: 0, end: 1 }, { text: "b", start: 0.5, end: 1.5 }], { start: 0, in: 0, out: 5, speed: 1 });
    expect(out[1].start).toBeGreaterThanOrEqual(out[0].end);
  });

  it("groups words into cues at pauses, relative to the cue start", () => {
    const cues = groupCues(timelineWords(parseSttWords(fixture.words), { start: 1, in: 2, out: 8, speed: 1 }));
    expect(cues.map((c) => c.words.map((w) => w.text).join(" "))).toEqual(["Hi there, this is Studio.", "Captions now write themselves.", "late"]);
    expect(cues[0].start).toBe(1.32);
    expect(cues[0].words[0]).toEqual({ text: "Hi", start: 0, end: 0.18 });
    expect(cues[1].start).toBe(4.1);
  });

  it("splits long runs at 10 words", () => {
    const run = Array.from({ length: 23 }, (_, i) => ({ text: `w${i}`, start: i * 0.1, end: i * 0.1 + 0.09 }));
    expect(groupCues(run).map((c) => c.words.length)).toEqual([10, 10, 3]);
  });
});

describe("caption ops", () => {
  const words = timelineWords(parseSttWords(fixture.words), { start: 1, in: 2, out: 8, speed: 1 });

  it("adds a caption track and clips that normalize and stay editable", () => {
    const plan = captionOps(doc(), "clip-1", words, { style: "bold" });
    expect(plan).toMatchObject({ trackId: "captions", cues: 3, words: 10 });
    const out = applyOps(doc(), plan.ops);
    const track = out.tracks.find((t) => t.kind === "caption")!;
    const clips = track.clips as CaptionClip[];
    expect(clips.map((c) => c.id)).toEqual(["cap-clip-1-1", "cap-clip-1-2", "cap-clip-1-3"]);
    expect(clips[0]).toMatchObject({ start: 1.32, style: "bold" });
    expect(normalizeEdit(out)).toEqual(out);
    // Editable afterwards with the normal ops.
    const edited = applyOps(out, [{ op: "setProps", clipId: "cap-clip-1-1", props: { words: [{ text: "Hey", start: 0, end: 0.4 }] } }]);
    expect((edited.tracks.find((t) => t.kind === "caption")!.clips[0] as CaptionClip).words).toEqual([{ text: "Hey", start: 0, end: 0.4 }]);
  });

  it("uses an existing caption track and refuses to stack captions over the clip", () => {
    const withTrack = doc([{ id: "subs", kind: "caption", clips: [] }]);
    const plan = captionOps(withTrack, "clip-1", words);
    expect(plan.trackId).toBe("subs");
    expect(plan.ops.some((o) => (o as { op: string }).op === "addTrack")).toBe(false);
    const once = applyOps(withTrack, plan.ops);
    expect(() => captionOps(once, "clip-1", words)).toThrow(/already covers/);
  });

  it("refuses a caption clip, an unknown clip, a non-caption track and silence", () => {
    const withCap = doc([{ id: "subs", kind: "caption", clips: [{ id: "c1", start: 20, words: [{ text: "x", start: 0, end: 1 }] }] }]);
    expect(() => captionOps(withCap, "c1", words)).toThrow(/video or sound clip/);
    expect(() => captionOps(withCap, "nope", words)).toThrow(/not in this video edit/);
    expect(() => captionOps(withCap, "clip-1", words, { trackId: "video" })).toThrow(/not a caption track/);
    expect(() => captionOps(withCap, "clip-1", [])).toThrow(/No speech/);
  });

  it.skipIf(!hasFfmpeg)("really cuts a clip's sound with the contained runner (ffmpeg on this machine)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-"));
    try {
      const src = join(dir, "src.mp4");
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=5", "-shortest", "-c:a", "aac", "-c:v", "libx264", "-y", src]);
      const out = join(dir, "audio.wav");
      const res = await runContained(audioExtractArgs(src, 1, 2, out), { cwd: dir, timeoutSec: 60 }).done;
      expect(res.outcome).toBe("ok");
      const wav = readFileSync(out);
      expect(wav.subarray(0, 4).toString()).toBe("RIFF");
      // 2 s of 16 kHz mono 16-bit is 64000 bytes of samples plus a small header.
      expect(wav.length).toBeGreaterThan(63_000);
      expect(wav.length).toBeLessThan(66_000);
      const silent = join(dir, "silent.mp4");
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=2", "-c:v", "libx264", "-y", silent]);
      expect((await runContained(audioExtractArgs(silent, 0, 1, join(dir, "x.wav")), { cwd: dir, timeoutSec: 60 }).done).outcome).toBe("nonzero");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("extracts only the clip's source range as 16 kHz mono WAV", () => {
    expect(audioExtractArgs("/w/source.bin", 2, 6, "/w/audio.wav")).toEqual([
      "-y", "-ss", "2", "-t", "6", "-i", "file:/w/source.bin", "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", "file:/w/audio.wav",
    ]);
  });
});
