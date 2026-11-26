/** The `speak` action and the two provider calls (plan PAR-14808, T1). Real SDK harness, stubbed global fetch. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarnessPerformActionOptions } from "@paperclipai/plugin-sdk/testing";
import { PERMISSION_DENIED, accessCompanyScope, accessGrantScope } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { GEMINI_VOICES, XAI_VOICES, settingsFrom, validGeminiVoice, validVoice } from "../src/config.js";
import { cleanStyle, geminiAudioFrom, geminiRequestBody, geminiSpeak, xaiRequestBody, xaiSpeak } from "../src/tts.js";
import { SPEAK_DAILY_CHAR_CAP } from "../src/limits.js";

const COMPANY = "a4f00000-0000-4000-8000-000000000001";
const OTHER_COMPANY = "a4f00000-0000-4000-8000-000000000002";
const [OWNER, OPERATOR, GRANTED] = ["a4f00000-0000-4000-8000-000000000010", "a4f00000-0000-4000-8000-000000000011", "a4f00000-0000-4000-8000-000000000012"];
const AGENT = "a4f00000-0000-4000-8000-0000000000a1";
const FOREIGN_AGENT = "a4f00000-0000-4000-8000-0000000000a2";
const GEMINI_KEY = "gem-key-VALUE-1234";
const XAI_KEY = "xai-key-VALUE-5678";
const REF = (id: string) => ({ type: "secret_ref", secretId: id });
const user = (userId = OWNER) => ({ companyId: COMPANY, actor: { type: "user" as const, userId } });
const pcm = (n: number) => Buffer.alloc(n, 7);

type Calls = Array<{ url: string; init: RequestInit }>;
function stubFetch(answer: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const calls: Calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer(url, init);
  }));
  return calls;
}
const geminiOk = (b64 = pcm(4800).toString("base64")) =>
  new Response(JSON.stringify({ steps: [{ type: "model_output", content: [{ type: "text", text: "x" }, { type: "audio", mime_type: "audio/l16", data: b64 }] }] }), { status: 200 });

async function setup(config: Record<string, unknown> = { geminiApiKey: REF("g"), xaiApiKey: REF("x") }, mode?: "enforce") {
  const harness = createTestHarness({ manifest, config });
  const at = new Date().toISOString();
  const member = (userId: string, role: string) => ({ id: `m-${userId}`, companyId: COMPANY, principalType: "user" as const, principalId: userId, status: "active" as const, membershipRole: role, grants: [], createdAt: at, updatedAt: at });
  harness.seed({
    accessMembers: [member(OWNER, "owner"), member(OPERATOR, "member"), member(GRANTED, "member")],
    agents: [{ id: AGENT, companyId: COMPANY, name: "Ren" }, { id: FOREIGN_AGENT, companyId: OTHER_COMPANY, name: "Zed" }] as never,
  });
  // The harness resolves a ref to a string of its own; give the secrets real-looking values to grep for.
  harness.ctx.secrets.resolve = vi.fn(async (ref: unknown) => ((ref as { secretId?: string }).secretId === "g" ? GEMINI_KEY : XAI_KEY)) as never;
  await plugin.definition.setup(harness.ctx);
  if (mode) {
    await harness.ctx.state.set(accessCompanyScope(COMPANY), { mode, rev: 1, userIds: [], receivedAt: at });
    await harness.ctx.state.set(accessGrantScope(COMPANY, OPERATOR), { preset: "manager", allow: [] });
    await harness.ctx.state.set(accessGrantScope(COMPANY, GRANTED), { allow: ["voice.use:create", "voice.use:view"] });
  }
  return harness;
}
const speak = (h: Awaited<ReturnType<typeof setup>>, params: Record<string, unknown> = {}, who: TestHarnessPerformActionOptions = user()) =>
  h.performAction<Record<string, unknown>>("speak", { agentId: AGENT, text: "Hello there.", provider: "gemini", ...params }, who);

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("provider requests", () => {
  it("Gemini: exact URL, header name and body string", async () => {
    const calls = stubFetch(() => geminiOk());
    const h = await setup();
    await speak(h, { text: "Hello there." });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe(GEMINI_KEY);
    expect(calls[0]!.init.body).toBe(
      '{"model":"gemini-3.8-flash-tts","input":[{"type":"user_input","content":[{"type":"text","text":"Hello there."}]}],"response_format":{"type":"audio","mime_type":"audio/l16","sample_rate":24000},"generation_config":{"speech_config":[{"voice":"Kore"}]}}',
    );
  });

  it("Gemini: style goes only into speech_metadata.style, cleaned", () => {
    const body = JSON.parse(geminiRequestBody({ text: "Hi", voice: "Puck", style: "warm\n<sigh> [x] {a}  and calm" }));
    expect(body.input[0].content[0]).toEqual({ type: "text", text: "Hi", annotations: [{ type: "speech_metadata", style: "warm sigh x a and calm" }] });
    expect(JSON.stringify(body)).not.toMatch(/<|\[x\]|\{a\}/);
    expect(cleanStyle("x".repeat(200))).toHaveLength(120);
    expect(cleanStyle(42)).toBe("");
  });

  it("xAI: exact URL, bearer header and body string", async () => {
    const calls = stubFetch(() => new Response(pcm(100), { status: 200 }));
    const h = await setup();
    await speak(h, { provider: "grok", text: "Hi." });
    expect(calls[0]!.url).toBe("https://api.x.ai/v1/tts");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${XAI_KEY}`);
    expect(calls[0]!.init.body).toBe('{"text":"Hi.","voice_id":"eve","language":"en","output_format":{"codec":"pcm","sample_rate":24000}}');
    expect(xaiRequestBody({ text: "a", voice: "luna" })).toBe('{"text":"a","voice_id":"luna","language":"auto","output_format":{"codec":"pcm","sample_rate":24000}}');
  });

  it("parses the last audio item over steps[].content[]; xAI raw bytes become base64", async () => {
    expect(geminiAudioFrom({ steps: [{ content: [{ type: "audio", data: "AAA=" }] }, { content: [{ type: "text" }, { type: "audio", data: "QkJC" }] }] })).toBe("QkJC");
    expect(geminiAudioFrom({ steps: [{ content: [{ type: "text", text: "no audio" }] }] })).toBeNull();
    expect(geminiAudioFrom({})).toBeNull();
    const bytes = Buffer.from([1, 2, 3, 250, 251]);
    expect(await xaiSpeak({ apiKey: "k", text: "t", voice: "eve" }, (async () => new Response(bytes)) as never)).toEqual({ outcome: "ok", audio: bytes.toString("base64") });
  });
});

describe("speak outcomes", () => {
  it("200: audio, 24 kHz, provider and voice", async () => {
    const b64 = pcm(4800).toString("base64");
    stubFetch(() => geminiOk(b64));
    expect(await speak(await setup())).toEqual({ audio: b64, sampleRate: 24000, provider: "gemini", voice: "Kore" });
  });
  it("401 → auth_failed, 403 too", async () => {
    stubFetch(() => new Response("nope", { status: 401 }));
    expect(await speak(await setup())).toEqual({ error: "auth_failed" });
    stubFetch(() => new Response("nope", { status: 403 }));
    expect(await speak(await setup())).toEqual({ error: "auth_failed" });
  });
  it("429 → rate_limited", async () => {
    stubFetch(() => new Response("slow", { status: 429 }));
    expect(await speak(await setup())).toEqual({ error: "rate_limited" });
  });
  it("500 → provider_error", async () => {
    stubFetch(() => new Response("boom", { status: 500 }));
    expect(await speak(await setup())).toEqual({ error: "provider_error" });
  });
  it("200 with a bad body → provider_error (Gemini not JSON, no audio; xAI empty)", async () => {
    stubFetch(() => new Response("<html>", { status: 200 }));
    expect(await speak(await setup())).toEqual({ error: "provider_error" });
    stubFetch(() => new Response(JSON.stringify({ steps: [] }), { status: 200 }));
    expect(await speak(await setup())).toEqual({ error: "provider_error" });
    stubFetch(() => new Response(new Uint8Array(0), { status: 200 }));
    expect(await speak(await setup(), { provider: "grok" })).toEqual({ error: "provider_error" });
  });
  it("a fetch that never answers is aborted at 12 s → timeout", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    stubFetch((_u, init) => {
      signal = init.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    });
    const h = await setup();
    const pending = speak(h);
    await vi.advanceTimersByTimeAsync(11_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(signal?.aborted).toBe(true);
    expect(await pending).toEqual({ error: "timeout" });
  });
  it("the whole action answers timeout at 20 s even when a state call hangs", async () => {
    vi.useFakeTimers();
    const calls = stubFetch(() => geminiOk());
    const h = await setup();
    const realGet = h.ctx.state.get.bind(h.ctx.state);
    h.ctx.state.get = (async (scope: { namespace?: string }) =>
      scope.namespace === "speak-usage" ? new Promise(() => undefined) : realGet(scope as never)) as never;
    const pending = speak(h);
    await vi.advanceTimersByTimeAsync(19_999);
    let done = false;
    void pending.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await pending).toEqual({ error: "timeout" });
    expect(calls).toHaveLength(0);
  });
  it("daily cap: exactly 50,000 characters pass, one more is daily_limit", async () => {
    const calls = stubFetch(() => geminiOk());
    const h = await setup();
    const day = new Date().toISOString().slice(0, 10);
    const scope = { scopeKind: "company" as const, scopeId: COMPANY, namespace: "speak-usage", stateKey: `${OWNER}:${day}` };
    await h.ctx.state.set(scope, SPEAK_DAILY_CHAR_CAP - 12);
    expect(await speak(h, { text: "x".repeat(12) })).toMatchObject({ provider: "gemini" });
    expect(h.getState(scope)).toBe(SPEAK_DAILY_CHAR_CAP);
    expect(await speak(h, { text: "x" })).toEqual({ error: "daily_limit" });
    expect(calls).toHaveLength(1);
    // Another person has their own count.
    expect(await speak(h, { text: "x" }, user(GRANTED))).toMatchObject({ provider: "gemini" });
  });
  it("a failed call does not count against the cap", async () => {
    stubFetch(() => new Response("boom", { status: 500 }));
    const h = await setup();
    await speak(h);
    const day = new Date().toISOString().slice(0, 10);
    expect(h.getState({ scopeKind: "company", scopeId: COMPANY, namespace: "speak-usage", stateKey: `${OWNER}:${day}` })).toBeUndefined();
  });
  it("no Gemini secret → not_configured, and no provider call", async () => {
    const calls = stubFetch(() => geminiOk());
    const h = await setup({ xaiApiKey: REF("x") });
    expect(await speak(h)).toEqual({ error: "not_configured" });
    expect(calls).toHaveLength(0);
    expect(await h.getData("status", { companyId: COMPANY })).toMatchObject({ configured: true, geminiConfigured: false });
  });
  it("status reports geminiConfigured when the ref is saved", async () => {
    expect(await (await setup()).getData("status", { companyId: COMPANY })).toMatchObject({ geminiConfigured: true });
  });
  it("provider defaults to defaultProvider when the caller names none", async () => {
    const calls = stubFetch(() => geminiOk());
    const h = await setup({ geminiApiKey: REF("g"), xaiApiKey: REF("x"), defaultProvider: "gemini" });
    await h.performAction("speak", { agentId: AGENT, text: "Hi" }, user());
    expect(calls[0]!.url).toContain("generativelanguage");
  });
});

describe("speak refusals", () => {
  it("601 characters, empty text and a bad agent are refused before any provider call", async () => {
    const calls = stubFetch(() => geminiOk());
    const h = await setup();
    await expect(speak(h, { text: "x".repeat(601) })).rejects.toThrow(/under 600/);
    await expect(speak(h, { text: "" })).rejects.toThrow(/nothing to say/);
    await expect(speak(h, { text: "   " })).rejects.toThrow(/nothing to say/);
    await expect(speak(h, { agentId: FOREIGN_AGENT })).rejects.toThrow(/not in this company/);
    await expect(speak(h, { agentId: "nope" })).rejects.toThrow(/not in this company/);
    expect(await speak(h, { text: "x".repeat(600) })).toMatchObject({ provider: "gemini" });
    expect(calls).toHaveLength(1);
  });
});

describe("a large answer through the SDK harness", () => {
  it("returns a 1.5 MB base64 result intact after serialising like the worker RPC", async () => {
    const b64 = Buffer.alloc(1_125_000, 3).toString("base64");
    expect(b64.length).toBeGreaterThanOrEqual(1_500_000);
    stubFetch(() => geminiOk(b64));
    const result = await speak(await setup());
    const wire = JSON.parse(JSON.stringify(result)) as { audio: string };
    expect(wire.audio).toBe(b64);
    expect(wire.audio.length).toBeGreaterThanOrEqual(1_500_000);
  });
});

describe("who may speak (actor shapes of server/src/routes/plugins.ts)", () => {
  it("session user passes; agent key, run token and system are refused", async () => {
    const calls = stubFetch(() => geminiOk());
    const h = await setup();
    expect(await speak(h, {}, user())).toMatchObject({ provider: "gemini" });
    const agentKey = { companyId: COMPANY, actor: { type: "agent" as const, agentId: AGENT, runId: null } };
    const runJwt = { companyId: COMPANY, actor: { type: "agent" as const, agentId: AGENT, runId: "run-1" } };
    const system = { companyId: COMPANY, actor: { type: "system" as const } };
    for (const who of [agentKey, runJwt, system]) await expect(speak(h, {}, who)).rejects.toThrow(/signed-in people/);
    expect(calls).toHaveLength(1);
  });
  it("restricted member: refused without voice.use, passes with it, owner passes", async () => {
    stubFetch(() => geminiOk());
    const h = await setup(undefined, "enforce");
    expect(await speak(h, {}, user(OPERATOR))).toMatchObject({ ok: false, refused: true, code: PERMISSION_DENIED });
    expect(await speak(h, {}, user(GRANTED))).toMatchObject({ provider: "gemini" });
    expect(await speak(h, {}, user(OWNER))).toMatchObject({ provider: "gemini" });
  });
});

describe("logs and lists", () => {
  it("no log line carries a secret value, the spoken text or a provider body", async () => {
    stubFetch(() => new Response(`provider says ${GEMINI_KEY} and SPOKEN-TEXT`, { status: 500 }));
    const h = await setup();
    await speak(h, { text: "SPOKEN-TEXT here" });
    stubFetch(() => geminiOk());
    await speak(h, { text: "SPOKEN-TEXT here" });
    stubFetch(() => new Response(pcm(10)));
    await speak(h, { provider: "grok", text: "SPOKEN-TEXT here" });
    expect(h.logs.length).toBeGreaterThan(0);
    const all = JSON.stringify(h.logs);
    for (const secret of [GEMINI_KEY, XAI_KEY, "SPOKEN-TEXT", "provider says"]) expect(all).not.toContain(secret);
  });
  it("voice lists: 30 Gemini, 28 xAI, validators and config defaults", () => {
    expect(GEMINI_VOICES).toHaveLength(30);
    expect(XAI_VOICES).toHaveLength(28);
    expect(new Set(GEMINI_VOICES).size).toBe(30);
    expect(validVoice("Orion")).toBe("orion");
    expect(validVoice("kore")).toBeNull();
    expect(validGeminiVoice("kore")).toBe("Kore");
    expect(validGeminiVoice("voice_abc")).toBeNull();
    expect(settingsFrom({})).toMatchObject({ geminiVoice: "Kore", defaultProvider: "grok" });
    expect(settingsFrom({ geminiVoice: "puck", defaultProvider: "gemini" })).toMatchObject({ geminiVoice: "Puck", defaultProvider: "gemini" });
    expect(settingsFrom({ geminiVoice: "nope", defaultProvider: "x" })).toMatchObject({ geminiVoice: "Kore", defaultProvider: "grok" });
  });
  it("geminiSpeak reports a thrown fetch as provider_error", async () => {
    expect(await geminiSpeak({ apiKey: "k", text: "t", voice: "Kore" }, (async () => { throw new Error("dns"); }) as never)).toEqual({ outcome: "provider_error" });
  });
});
