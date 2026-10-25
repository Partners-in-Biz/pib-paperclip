import { describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { decodeAudio, keytermsFor, liveSessionAction, requireBoardUser, statusAction, transcribeAction } from "../src/actions.js";
import { settingsFrom, splitKeyterms } from "../src/config.js";
import { MAX_AUDIO_BYTES } from "../src/xai.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";

function fakeCtx(config: Record<string, unknown>, agents: Array<{ name: string }> = []) {
  const resolve = vi.fn(async () => "resolved-secret");
  const ctx = {
    config: { get: vi.fn(async () => config) },
    secrets: { resolve },
    agents: { list: vi.fn(async () => agents) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as PluginContext;
  return { ctx, resolve };
}

function userAction(companyId: string | null = COMPANY): PluginPerformActionContext {
  return { companyId, actor: { type: "user", userId: "user-1", agentId: null, runId: null, companyId } };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("settings", () => {
  it("splits, trims, de-duplicates and caps keyterms", () => {
    expect(splitKeyterms(" SEO, PiB ,seo,\nHunt and Gun,, ")).toEqual(["SEO", "PiB", "Hunt and Gun"]);
    expect(splitKeyterms(`${"x".repeat(80)}`)).toEqual(["x".repeat(50)]);
    expect(splitKeyterms(undefined)).toEqual([]);
  });

  it("defaults to the eve voice, English and live on", () => {
    expect(settingsFrom({})).toMatchObject({ voice: "eve", language: "en", liveEnabled: true, voiceNoteAutoSend: false });
    expect(settingsFrom({ liveEnabled: false, voiceNoteAutoSend: true, language: "" })).toMatchObject({
      liveEnabled: false,
      voiceNoteAutoSend: true,
      language: "",
    });
  });
});

describe("who may use voice", () => {
  it("refuses agent runs and calls without a company", () => {
    expect(() => requireBoardUser({ companyId: COMPANY, actor: { type: "agent", userId: null, agentId: "a", runId: "r", companyId: COMPANY } })).toThrow(/signed-in people/);
    expect(() => requireBoardUser(userAction(null))).toThrow(/company/);
    expect(requireBoardUser(userAction())).toEqual({ companyId: COMPANY, userId: "user-1" });
  });
});

describe("status", () => {
  it("is off until a key is saved", async () => {
    expect(await statusAction(fakeCtx({}).ctx, COMPANY)).toEqual({ configured: false, liveEnabled: false, voiceNoteAutoSend: false });
    expect(await statusAction(fakeCtx({ xaiApiKey: { type: "secret_ref", secretId: "s" } }).ctx, COMPANY)).toMatchObject({ configured: true, liveEnabled: true });
    expect(await statusAction(fakeCtx({ xaiApiKey: { type: "secret_ref", secretId: "s" }, liveEnabled: false }).ctx, COMPANY)).toMatchObject({ liveEnabled: false });
    expect(await statusAction(fakeCtx({ xaiApiKey: "k" }).ctx, null)).toMatchObject({ configured: false });
  });

  it("never resolves the secret just to answer status", async () => {
    const { ctx, resolve } = fakeCtx({ xaiApiKey: { type: "secret_ref", secretId: "s" } });
    await statusAction(ctx, COMPANY);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("decodeAudio", () => {
  it("accepts plain base64 and data URLs", () => {
    expect([...decodeAudio("AQID")]).toEqual([1, 2, 3]);
    expect([...decodeAudio("data:audio/mp4;base64,AQID")]).toEqual([1, 2, 3]);
  });

  it("rejects missing and oversized audio before decoding", () => {
    expect(() => decodeAudio(undefined)).toThrow(/No audio/);
    expect(() => decodeAudio("A".repeat(Math.ceil((MAX_AUDIO_BYTES * 4) / 3) + 8))).toThrow(/too long/);
  });
});

describe("keytermsFor", () => {
  it("adds agent names after the configured terms, without duplicates", async () => {
    const { ctx } = fakeCtx({}, [{ name: "SEO Specialist" }, { name: "seo" }, { name: "Kai" }]);
    expect(await keytermsFor(ctx, COMPANY, settingsFrom({ keyterms: "SEO, PiB" }))).toEqual(["SEO", "PiB", "SEO Specialist", "Kai"]);
  });

  it("still returns the configured terms when agents cannot be read", async () => {
    const { ctx } = fakeCtx({});
    (ctx.agents.list as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("nope"));
    expect(await keytermsFor(ctx, COMPANY, settingsFrom({ keyterms: "PiB" }))).toEqual(["PiB"]);
  });
});

describe("transcribeAction", () => {
  it("transcribes with the resolved key and agent names as keyterms", async () => {
    const { ctx, resolve } = fakeCtx({ xaiApiKey: { type: "secret_ref", secretId: "s" }, keyterms: "PiB" }, [{ name: "Kai" }]);
    const fetchImpl = vi.fn(async () => jsonResponse({ text: "Hello Kai", duration: 1.2 }));
    const out = await transcribeAction(ctx, { audio: "AQID", mimeType: "audio/webm;codecs=opus" }, userAction(), fetchImpl as unknown as typeof fetch);
    expect(out).toEqual({ text: "Hello Kai", duration: 1.2, autoSend: false });
    expect(resolve).toHaveBeenCalledWith({ type: "secret_ref", secretId: "s" }, { companyId: COMPANY, configPath: "xaiApiKey" });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer resolved-secret");
    expect((init.body as FormData).getAll("keyterm")).toEqual(["PiB", "Kai"]);
  });

  it("says how to set it up when the key is missing", async () => {
    const fetchImpl = vi.fn();
    await expect(transcribeAction(fakeCtx({}).ctx, { audio: "AQID", mimeType: "audio/mp4" }, userAction(), fetchImpl as unknown as typeof fetch)).rejects.toThrow(/Save the xAI key/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("liveSessionAction", () => {
  it("returns a short-lived pass, the socket URL and the voice settings, never the key", async () => {
    const { ctx } = fakeCtx({ xaiApiKey: { type: "secret_ref", secretId: "s" }, voice: "ara", language: "af" }, [{ name: "PiB" }]);
    const fetchImpl = vi.fn(async () => jsonResponse({ value: "eph-token", expires_at: 99 }));
    const out = await liveSessionAction(ctx, userAction(), fetchImpl as unknown as typeof fetch);
    expect(out).toMatchObject({
      token: "eph-token",
      expiresAt: 99,
      url: "wss://api.x.ai/v1/realtime?model=grok-voice-latest",
      voice: "ara",
      language: "af",
    });
    expect(JSON.stringify(out)).not.toContain("resolved-secret");
  });

  it("refuses when live voice is switched off", async () => {
    const { ctx } = fakeCtx({ xaiApiKey: { type: "secret_ref", secretId: "s" }, liveEnabled: false });
    await expect(liveSessionAction(ctx, userAction(), vi.fn() as unknown as typeof fetch)).rejects.toThrow(/switched off/);
  });
});
