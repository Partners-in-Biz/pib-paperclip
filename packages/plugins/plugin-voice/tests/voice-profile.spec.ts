/** Voice profile and per-person mode (plan PAR-14808, T2). Real SDK harness. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarnessPerformActionOptions } from "@paperclipai/plugin-sdk/testing";
import { PERMISSION_DENIED, accessCompanyScope, accessGrantScope } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { GEMINI_VOICES, XAI_VOICES } from "../src/config.js";

const COMPANY = "a4f00000-0000-4000-8000-000000000001";
const OTHER_COMPANY = "a4f00000-0000-4000-8000-000000000002";
const [OWNER, OPERATOR, GRANTED] = ["a4f00000-0000-4000-8000-000000000010", "a4f00000-0000-4000-8000-000000000011", "a4f00000-0000-4000-8000-000000000012"];
const AGENT = "a4f00000-0000-4000-8000-0000000000a1";
const FOREIGN_AGENT = "a4f00000-0000-4000-8000-0000000000a2";
const REF = (id: string) => ({ type: "secret_ref", secretId: id });
const user = (userId = OWNER) => ({ companyId: COMPANY, actor: { type: "user" as const, userId } });
const profileScope = (agentId = AGENT) => ({ scopeKind: "agent" as const, scopeId: agentId, stateKey: "voice-profile" });
const legacyScope = (agentId = AGENT) => ({ scopeKind: "agent" as const, scopeId: agentId, stateKey: "voice" });
const modeScope = (userId: string) => ({ scopeKind: "company" as const, scopeId: COMPANY, namespace: "voice-mode", stateKey: userId });

async function setup(config: Record<string, unknown> = { xaiApiKey: REF("x"), geminiApiKey: REF("g") }, mode?: "enforce") {
  const harness = createTestHarness({ manifest, config });
  const at = new Date().toISOString();
  const member = (userId: string, role: string) => ({ id: `m-${userId}`, companyId: COMPANY, principalType: "user" as const, principalId: userId, status: "active" as const, membershipRole: role, grants: [], createdAt: at, updatedAt: at });
  harness.seed({
    accessMembers: [member(OWNER, "owner"), member(OPERATOR, "member"), member(GRANTED, "member")],
    agents: [{ id: AGENT, companyId: COMPANY, name: "Ren" }, { id: FOREIGN_AGENT, companyId: OTHER_COMPANY, name: "Zed" }] as never,
  });
  harness.ctx.secrets.resolve = vi.fn(async () => "key-VALUE-1234") as never;
  await plugin.definition.setup(harness.ctx);
  if (mode) {
    await harness.ctx.state.set(accessCompanyScope(COMPANY), { mode, rev: 1, userIds: [], receivedAt: at });
    await harness.ctx.state.set(accessGrantScope(COMPANY, OPERATOR), { preset: "manager", allow: [] });
    await harness.ctx.state.set(accessGrantScope(COMPANY, GRANTED), { allow: ["voice.use:create", "voice.use:view", "voice.settings:edit", "voice.settings:view"] });
  }
  return harness;
}
type H = Awaited<ReturnType<typeof setup>>;
const act = <T = Record<string, unknown>>(h: H, key: string, params: Record<string, unknown> = {}, who: TestHarnessPerformActionOptions = user()) =>
  h.performAction<T>(key, params, who);
const pcm = Buffer.alloc(4800, 7).toString("base64");
const geminiOk = () => new Response(JSON.stringify({ steps: [{ content: [{ type: "audio", data: pcm }] }] }), { status: 200 });
const bodies = () => (vi.mocked(fetch).mock.calls as unknown as Array<[string, RequestInit]>).map(([url, init]) => ({ url, body: String(init.body) }));

afterEach(() => vi.unstubAllGlobals());

describe("voice profile", () => {
  it("a legacy-only agent keeps its voice; a profile beats legacy; a profile write updates the legacy key", async () => {
    const h = await setup();
    await h.ctx.state.set(legacyScope(), "rex");
    expect((await act<{ profile: unknown }>(h, "agent-voice", {}, user()).catch(() => null))).toBeNull(); // data handler, not an action
    expect(await h.getData<{ profile: unknown }>("agent-voice", { companyId: COMPANY, agentId: AGENT })).toMatchObject({ profile: { grokVoice: "rex" } });
    await act(h, "set-agent-voice-profile", { agentId: AGENT, grokVoice: "Leo", geminiVoice: "puck" });
    expect(h.getState(profileScope())).toEqual({ grokVoice: "leo", geminiVoice: "Puck" });
    expect(h.getState(legacyScope())).toBe("leo");
    expect(await h.getData("agent-voice", { companyId: COMPANY, agentId: AGENT })).toMatchObject({ profile: { grokVoice: "leo" } });
    await act(h, "set-agent-voice-profile", { agentId: AGENT, grokVoice: "" });
    expect(h.getState(legacyScope())).toBeUndefined();
    expect(h.getState(profileScope())).toEqual({ geminiVoice: "Puck" });
  });

  it("the old set-agent-voice keeps the other profile fields", async () => {
    const h = await setup();
    await act(h, "set-agent-voice-profile", { agentId: AGENT, geminiVoice: "Puck" });
    await act(h, "set-agent-voice", { agentId: AGENT, voice: "sal" });
    expect(h.getState(profileScope())).toEqual({ grokVoice: "sal", geminiVoice: "Puck" });
    expect(h.getState(legacyScope())).toBe("sal");
  });

  it("refuses unknown voices and an agent of another company, writing nothing", async () => {
    const h = await setup();
    await expect(act(h, "set-agent-voice-profile", { agentId: AGENT, grokVoice: "zed" })).rejects.toThrow(/Unknown Grok voice/);
    await expect(act(h, "set-agent-voice-profile", { agentId: AGENT, geminiVoice: "eve" })).rejects.toThrow(/Unknown Gemini voice/);
    await expect(act(h, "set-agent-voice-profile", { agentId: FOREIGN_AGENT, grokVoice: "eve" })).rejects.toThrow(/not in this company/);
    expect(h.getState(profileScope())).toBeUndefined();
    expect(h.getState(profileScope(FOREIGN_AGENT))).toBeUndefined();
    expect(h.getState(legacyScope(FOREIGN_AGENT))).toBeUndefined();
  });

  it("cleans the style on save: no newlines, tags, brackets or braces, at most 120 characters", async () => {
    const h = await setup();
    const raw = `warm\n<sigh>  and [x]\t{}calm ${"a".repeat(200)}`;
    const { profile } = await act<{ profile: { geminiStyle: string } }>(h, "set-agent-voice-profile", { agentId: AGENT, geminiStyle: raw });
    expect(profile.geminiStyle).toMatch(/^warm sigh and x calm a+$/);
    expect(profile.geminiStyle.length).toBeLessThanOrEqual(120);
    expect((h.getState(profileScope()) as { geminiStyle: string }).geminiStyle).toBe(profile.geminiStyle);
  });

  it("agent-voice data returns profile, company voices, geminiConfigured and both lists", async () => {
    const h = await setup({ xaiApiKey: REF("x"), voice: "ara", geminiVoice: "Leda" });
    expect(await h.getData("agent-voice", { companyId: COMPANY, agentId: AGENT })).toEqual({
      profile: {}, company: { grokVoice: "ara", geminiVoice: "Leda" }, geminiConfigured: false,
      voices: { grok: [...XAI_VOICES], gemini: [...GEMINI_VOICES] },
    });
  });

  it("speak resolves the voice and style from the profile, and falls back to the company voice", async () => {
    const h = await setup();
    const fetchMock = vi.fn(async () => geminiOk());
    vi.stubGlobal("fetch", fetchMock);
    await act(h, "set-agent-voice-profile", { agentId: AGENT, geminiVoice: "Puck", geminiStyle: "bright <b>" });
    await act(h, "speak", { agentId: AGENT, text: "Hello there.", provider: "gemini" });
    expect(bodies()[0]!.body).toContain('"voice":"Puck"');
    expect(bodies()[0]!.body).toContain('"style":"bright b"');
    await act(h, "set-agent-voice-profile", { agentId: AGENT, geminiVoice: null, geminiStyle: "" });
    await act(h, "speak", { agentId: AGENT, text: "Hello there.", provider: "gemini" });
    expect(bodies()[1]!.body).toContain('"voice":"Kore"');
    expect(bodies()[1]!.body).not.toContain("speech_metadata");
  });
});

describe("my voice mode", () => {
  it("is private to the caller: B can neither read nor write A's choice", async () => {
    const h = await setup();
    await act(h, "set-my-voice-mode", { mode: "classic" }, user(OWNER));
    expect(await act(h, "get-my-voice-mode", {}, user(OWNER))).toMatchObject({ mode: "classic" });
    expect(await act(h, "get-my-voice-mode", {}, user(GRANTED))).toMatchObject({ mode: "direct", provider: "grok" });
    // A userId param is ignored: only the actor counts.
    await act(h, "set-my-voice-mode", { mode: "direct", provider: "gemini", userId: OWNER }, user(GRANTED));
    expect(h.getState(modeScope(OWNER))).toEqual({ mode: "classic" });
    expect(h.getState(modeScope(GRANTED))).toEqual({ mode: "direct", provider: "gemini" });
  });

  it("refuses gemini when not configured, and unknown modes and providers", async () => {
    const h = await setup({ xaiApiKey: REF("x") });
    await expect(act(h, "set-my-voice-mode", { mode: "direct", provider: "gemini" })).rejects.toThrow(/not set up/);
    await expect(act(h, "set-my-voice-mode", { mode: "direct", provider: "azure" })).rejects.toThrow(/voice engine/);
    await expect(act(h, "set-my-voice-mode", { mode: "direct" })).rejects.toThrow(/voice engine/);
    await expect(act(h, "set-my-voice-mode", { mode: "shout" })).rejects.toThrow(/Unknown mode/);
    expect(h.getState(modeScope(OWNER))).toBeUndefined();
    expect(await act(h, "set-my-voice-mode", { mode: "direct", provider: "grok" })).toEqual({ mode: "direct", provider: "grok" });
  });

  it("a state read that throws answers the default and writes nothing", async () => {
    const h = await setup();
    const realGet = h.ctx.state.get.bind(h.ctx.state);
    h.ctx.state.get = (async (scope: { namespace?: string }) => {
      if (scope.namespace === "voice-mode") throw new Error("boom");
      return realGet(scope as never);
    }) as never;
    const set = vi.spyOn(h.ctx.state, "set");
    expect(await act(h, "get-my-voice-mode")).toMatchObject({ mode: "direct", provider: "grok" });
    expect(set).not.toHaveBeenCalled();
  });

  it("default: grok with no key, still grok with a key and no defaultProvider, gemini only when set and configured", async () => {
    const get = async (config: Record<string, unknown>) => act(await setup(config), "get-my-voice-mode");
    expect(await get({ defaultProvider: "gemini" })).toMatchObject({ mode: "direct", provider: "grok", geminiConfigured: false });
    expect(await get({ geminiApiKey: REF("g") })).toMatchObject({ mode: "direct", provider: "grok", geminiConfigured: true });
    expect(await get({ geminiApiKey: REF("g"), defaultProvider: "gemini" })).toMatchObject({ mode: "direct", provider: "gemini" });
  });

  it("a saved gemini choice falls back to grok if the key is later removed", async () => {
    const h = await setup({ xaiApiKey: REF("x") });
    await h.ctx.state.set(modeScope(OWNER), { mode: "direct", provider: "gemini" });
    expect(await act(h, "get-my-voice-mode")).toMatchObject({ mode: "direct", provider: "grok" });
  });
});

describe("who may use the new actions (actor shapes of server/src/routes/plugins.ts)", () => {
  const CASES: Array<[string, Record<string, unknown>]> = [
    ["set-agent-voice-profile", { agentId: AGENT, grokVoice: "eve" }],
    ["get-my-voice-mode", {}],
    ["set-my-voice-mode", { mode: "classic" }],
  ];
  for (const [key, params] of CASES) {
    it(`${key}: session user passes; agent key, run token and system are refused`, async () => {
      const h = await setup();
      await act(h, key, params, user());
      const agentKey = { companyId: COMPANY, actor: { type: "agent" as const, agentId: AGENT, runId: null } };
      const runJwt = { companyId: COMPANY, actor: { type: "agent" as const, agentId: AGENT, runId: "run-1" } };
      const system = { companyId: COMPANY, actor: { type: "system" as const } };
      for (const who of [agentKey, runJwt, system]) await expect(act(h, key, params, who)).rejects.toThrow(/signed-in people/);
    });
  }

  it("restricted member: refused without the permission, passes with it; owner passes", async () => {
    const h = await setup(undefined, "enforce");
    for (const [key, params] of CASES) {
      expect(await act(h, key, params, user(OPERATOR)), key).toMatchObject({ ok: false, refused: true, code: PERMISSION_DENIED });
      await act(h, key, params, user(GRANTED));
      await act(h, key, params, user(OWNER));
    }
    // voice.use alone does not edit an agent's voices.
    const h2 = await setup(undefined, "enforce");
    await h2.ctx.state.set(accessGrantScope(COMPANY, GRANTED), { allow: ["voice.use:create", "voice.use:view"] });
    expect(await act(h2, "set-agent-voice-profile", { agentId: AGENT, grokVoice: "eve" }, user(GRANTED))).toMatchObject({ refused: true, code: PERMISSION_DENIED });
  });
});
