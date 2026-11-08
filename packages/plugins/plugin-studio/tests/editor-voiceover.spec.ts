import { describe, expect, it, vi } from "vitest";
import { XAI_VOICES } from "../src/video-edit/tts.js";
import { MAX_SCRIPT_CHARS, ttsCredits } from "../src/video-edit/tts-price.js";
import { VOICEOVER_MAX_CHARS, VOICEOVER_VOICES, voiceoverCredits, voiceoverParams } from "../src/ui/editor/audio-track.js";
import { createEditorStore, type EditorApi } from "../src/ui/editor/editor-store.js";

const doc = (clips: string[]) => ({ schemaVersion: 1, project: { size: "9:16", width: 1080, height: 1920, fps: 30 }, tracks: [{ id: "v1", kind: "video", clips: clips.map((id) => ({ id })) }] });

describe("voiceover form", () => {
  it("mirrors the server's limit, voices and price", () => {
    expect(VOICEOVER_MAX_CHARS).toBe(MAX_SCRIPT_CHARS);
    expect([...VOICEOVER_VOICES]).toEqual([...XAI_VOICES]);
    for (const n of [0, 1, 500, 4000]) expect(voiceoverCredits(n)).toBe(ttsCredits(n));
    expect(voiceoverCredits(4000)).toBe(0.96);
  });
  it("trims the script, defaults an unknown voice to eve and refuses empty or over-long text", () => {
    expect(voiceoverParams("  hello ", "rex", 2.5)).toEqual({ script: "hello", voice: "rex", at: 2.5 });
    expect(voiceoverParams("hi", "nope", -1)).toEqual({ script: "hi", voice: "eve", at: 0 });
    expect(voiceoverParams("   ", "eve", 0)).toHaveProperty("error");
    expect(voiceoverParams("x".repeat(4001), "eve", 0)).toHaveProperty("error");
    expect(voiceoverParams("x".repeat(4000), "eve", 0)).not.toHaveProperty("error");
  });
});

describe("store.voiceover", () => {
  const make = (voiceover: EditorApi["voiceover"]) => {
    const api = { get: vi.fn(async () => ({ id: "e1", revision: 1, doc: doc(["c1"]) })), applyOps: vi.fn(), voiceover } as unknown as EditorApi;
    return createEditorStore(api);
  };
  it("calls video-edit-voiceover with editId, baseRevision, script, voice and at, and returns the new clip id", async () => {
    const call = vi.fn(async () => ({ revision: 2, doc: doc(["c1", "vo1"]), duration: 9, clipId: "vo1" }));
    const store = make(call);
    await store.load("e1");
    expect(await store.voiceover({ script: "hello", voice: "eve", at: 3 })).toBe("vo1");
    expect(call).toHaveBeenCalledWith({ editId: "e1", baseRevision: 1, script: "hello", voice: "eve", at: 3 });
    expect(store.getState().revision).toBe(2);
  });
  it("returns null and toasts the xAI voice setting on not_configured", async () => {
    const store = make(vi.fn(async () => { throw Object.assign(new Error("not set"), { code: "not_configured" }); }));
    await store.load("e1");
    expect(await store.voiceover({ script: "hi", voice: "eve", at: 0 })).toBeNull();
    expect(store.getState().toast).toContain("xAI voice");
  });
});
