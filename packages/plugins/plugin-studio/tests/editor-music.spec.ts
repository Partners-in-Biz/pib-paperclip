import { describe, expect, it, vi } from "vitest";
import { MAX_PROMPT_CHARS, MUSIC_DEFAULT_SECONDS, MUSIC_MAX_SECONDS, musicCredits, STABLE_AUDIO_USD_PER_GENERATION } from "../src/music/stable-audio-price.js";
import { MUSIC_MAX_PROMPT_CHARS, MUSIC_MAX_SECONDS as UI_MAX, MUSIC_DEFAULT_SECONDS as UI_DEFAULT, MUSIC_PRICE_LABEL, musicParams, musicUsageLine } from "../src/ui/editor/audio-track.js";
import { createEditorStore, MUSIC_UNKNOWN_MESSAGE, type EditorApi } from "../src/ui/editor/editor-store.js";

const doc = (clips: string[]) => ({ schemaVersion: 1, project: { size: "9:16", width: 1080, height: 1920, fps: 30 }, tracks: [{ id: "v1", kind: "video", clips: clips.map((id) => ({ id })) }] });
const refusal = (code: string, message: string) => Object.assign(new Error(message), { code });

describe("music form", () => {
  it("mirrors the server's limits and price", () => {
    expect(MUSIC_MAX_PROMPT_CHARS).toBe(MAX_PROMPT_CHARS);
    expect(UI_MAX).toBe(MUSIC_MAX_SECONDS);
    expect(UI_DEFAULT).toBe(MUSIC_DEFAULT_SECONDS);
    expect(MUSIC_PRICE_LABEL).toBe(`USD ${STABLE_AUDIO_USD_PER_GENERATION.toFixed(2)} · ${musicCredits()} credits`);
    expect(MUSIC_PRICE_LABEL).toBe("USD 0.08 · 1.28 credits");
  });
  it("trims the prompt and refuses empty, over-long and out-of-range input", () => {
    expect(musicParams("  calm piano ", "30", 2)).toEqual({ prompt: "calm piano", duration: 30, at: 2 });
    expect(musicParams("x", 1, -3)).toEqual({ prompt: "x", duration: 1, at: 0 });
    expect(musicParams("x", 180, 0)).not.toHaveProperty("error");
    for (const bad of ["", "0", "181", "abc", "0.5"]) expect(musicParams("x", bad, 0)).toHaveProperty("error");
    expect(musicParams("  ", 30, 0)).toHaveProperty("error");
    expect(musicParams("x".repeat(2001), 30, 0)).toHaveProperty("error");
    expect(musicParams("x".repeat(2000), 30, 0)).not.toHaveProperty("error");
  });
});

describe("page line", () => {
  it("shows used of the cap, or unknown", () => {
    expect(musicUsageLine({ status: "ok", usedUsd: 24.92, capUsd: 25 })).toBe("Stable Audio this month: USD 24.92 of 25");
    expect(musicUsageLine({ status: "unknown" })).toBe("Stable Audio this month: unknown");
    expect(musicUsageLine(undefined)).toBe("Stable Audio this month: unknown");
  });
});

describe("store.music", () => {
  const make = (music: EditorApi["music"]) => createEditorStore({ get: vi.fn(async () => ({ id: "e1", revision: 1, doc: doc(["c1"]) })), applyOps: vi.fn(), music } as unknown as EditorApi);
  it("sends editId, baseRevision, prompt, duration, at and adopts the placed clip", async () => {
    const call = vi.fn(async () => ({ status: "succeeded", revision: 2, doc: doc(["c1", "m1"]), duration: 9, clipId: "m1" }));
    const store = make(call);
    await store.load("e1");
    expect(await store.music({ prompt: "calm", duration: 30, at: 1 })).toEqual({ kind: "placed", clipId: "m1" });
    expect(call).toHaveBeenCalledWith({ editId: "e1", baseRevision: 1, prompt: "calm", duration: 30, at: 1 });
    expect(store.getState().revision).toBe(2);
  });
  it("provider_cap_reached: server message as toast, retry stays possible, revision unchanged", async () => {
    const message = "Stable Audio's monthly limit of USD 25 is used up.";
    const store = make(vi.fn(async () => { throw refusal("provider_cap_reached", message); }));
    await store.load("e1");
    expect(await store.music({ prompt: "calm", duration: 30, at: 0 })).toEqual({ kind: "failed", message, retry: true });
    expect(store.getState().toast).toBe(message);
    expect(store.getState().busy).toBe(false);
    expect(store.getState().revision).toBe(1);
  });
  it("synthesizing: no retry, the Library message, nothing adopted", async () => {
    const store = make(vi.fn(async () => ({ status: "synthesizing", generationId: "g1" })));
    await store.load("e1");
    const out = await store.music({ prompt: "calm", duration: 30, at: 0 });
    expect(out).toMatchObject({ kind: "synthesizing" });
    expect((out as { message: string }).message).toBe("Still making it; it will be in the Library; add it with Add audio.");
    expect(store.getState().revision).toBe(1);
    expect(store.getState().busy).toBe(false);
  });
  it("a raw RPC timeout (no code) says it may have been charged and offers no retry", async () => {
    const store = make(vi.fn(async () => { throw new Error("Request timed out"); }));
    await store.load("e1");
    expect(await store.music({ prompt: "calm", duration: 30, at: 0 })).toEqual({ kind: "failed", message: MUSIC_UNKNOWN_MESSAGE, retry: false });
    expect(MUSIC_UNKNOWN_MESSAGE).toBe("This may have been charged. Check the Library before trying again.");
  });
  it("a charged server outcome (music_not_placed) offers no retry; a nothing-charged one does", async () => {
    const a = make(vi.fn(async () => { throw refusal("music_not_placed", "The music was made and saved as asset x, USD 0.08 charged, but it was not added."); }));
    await a.load("e1");
    expect(await a.music({ prompt: "p", duration: 30, at: 0 })).toMatchObject({ kind: "failed", retry: false });
    const b = make(vi.fn(async () => { throw refusal("provider_error", "Provider down. Nothing was charged."); }));
    await b.load("e1");
    expect(await b.music({ prompt: "p", duration: 30, at: 0 })).toMatchObject({ kind: "failed", retry: true });
  });
  it("an edit conflict reloads and toasts", async () => {
    const store = make(vi.fn(async () => { throw refusal("edit_conflict", "Someone saved"); }));
    await store.load("e1");
    expect(await store.music({ prompt: "p", duration: 30, at: 0 })).toMatchObject({ kind: "failed", retry: true });
    expect(store.getState().toast).toContain("Someone else changed");
  });
});
