import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { hireTaskDraft, startHire, type HireRole } from "../src/agent-hire.js";
import { adapterPreferenceFor, hireRefusal, hostingFromConfig, modelKeyHireText, unboundKeyAgents, unboundModelKeyCheck } from "../src/model-key.js";

const role: HireRole = {
  pluginKey: "partnersinbiz.seo",
  pluginName: "SEO",
  roleKey: "seo-specialist",
  displayName: "SEO Specialist",
  title: "SEO Specialist",
  role: "general",
  capabilities: "Runs SEO sprints.",
  adapterPreference: ["hermes_local", "claude_local"],
  skills: [],
  budgetMonthlyCents: 0,
  instructions: "You are the SEO Specialist.",
  pluginSetup: [],
  toolPlugins: [],
};
const client = { profile: "client" as const, secretName: "ANTHROPIC_API_KEY", secretId: "sec-1" };

function ctxWith(config: Record<string, unknown> | null) {
  const created: Array<Record<string, unknown>> = [];
  const state = new Map<string, unknown>();
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    config: { get: async () => config },
    state: { get: async (k: { stateKey: string }) => state.get(k.stateKey) ?? null, set: async (k: { stateKey: string }, v: unknown) => void state.set(k.stateKey, v) },
    issues: { create: async (input: Record<string, unknown>) => (created.push(input), { id: "i1", identifier: "PAR-1", ...input }), requestWakeup: async () => {} },
  } as unknown as PluginContext;
  return { ctx, created };
}

describe("hosting settings", () => {
  it("is pib unless the settings say client", () => {
    expect(hostingFromConfig(null).profile).toBe("pib");
    expect(hostingFromConfig({ hostingProfile: "weird" }).profile).toBe("pib");
    expect(hostingFromConfig({ hostingProfile: "client", modelKeySecretName: " K ", modelKeySecretId: "s" })).toEqual({ profile: "client", secretName: "K", secretId: "s" });
  });
  it("keeps the role's order for pib and uses claude_local for a client", () => {
    expect(adapterPreferenceFor(["hermes_local", "claude_local"], undefined)).toEqual(["hermes_local", "claude_local"]);
    expect(adapterPreferenceFor(["hermes_local", "claude_local"], hostingFromConfig({}))).toEqual(["hermes_local", "claude_local"]);
    expect(adapterPreferenceFor(["hermes_local", "claude_local"], client)).toEqual(["claude_local"]);
  });
  it("refuses a client without the key secret only", () => {
    expect(hireRefusal({ ...client, secretId: "" })).toContain("ANTHROPIC_API_KEY");
    expect(hireRefusal(client)).toBeNull();
    expect(hireRefusal(hostingFromConfig({}))).toBeNull();
  });
});

describe("hire task text", () => {
  it("is unchanged for pib and carries the secret reference for a client", () => {
    expect(hireTaskDraft(role).description).toBe(hireTaskDraft(role, hostingFromConfig({})).description);
    const draft = hireTaskDraft(role, client).description;
    expect(draft).toContain('"secretId": "sec-1"');
    expect(draft).toContain('"type": "secret_ref"');
    expect(draft).toContain("| **Adapter** | `claude_local` (the company's own key) |");
    expect(draft).not.toContain("`hermes_local`, then");
  });
});

describe("startHire", () => {
  it("refuses a client hire without the key and opens no task", async () => {
    const { ctx, created } = ctxWith({ hostingProfile: "client", modelKeySecretName: "", modelKeySecretId: "" });
    await expect(startHire(ctx, "co", role, { actorUserId: null })).rejects.toThrow(/own Anthropic key/);
    expect(created).toEqual([]);
  });
  it("opens the task with the key section, also on a prefilled description, once", async () => {
    const { ctx, created } = ctxWith({ hostingProfile: "client", modelKeySecretName: "ANTHROPIC_API_KEY", modelKeySecretId: "sec-1" });
    await startHire(ctx, "co", role, { actorUserId: null, description: "Prefilled by Setup." });
    expect(String(created[0]!.description)).toMatch(/^Prefilled by Setup\.\n\n## Model key \(client company\)/);
    await startHire(ctx, "co", role, { actorUserId: null, description: modelKeyHireText(client) });
    expect((String(created[1]!.description).match(/## Model key \(client company\)/g) ?? []).length).toBe(1);
  });
  it("no saved settings (null) means pib: the hire is not refused", async () => {
    const { ctx, created } = ctxWith(null);
    await startHire(ctx, "co", role, { actorUserId: null });
    expect(created).toHaveLength(1);
    expect(String(created[0]!.description)).not.toContain("## Model key");
  });
  it("a config read that throws fails the hire (closed, on purpose: never guess a client is pib)", async () => {
    const { ctx, created } = ctxWith({});
    (ctx as unknown as { config: { get: () => Promise<never> } }).config.get = async () => {
      throw new Error("config unavailable");
    };
    await expect(startHire(ctx, "co", role, { actorUserId: null })).rejects.toThrow("config unavailable");
    expect(created).toEqual([]);
  });
  it("a client hire whose role prefers hermes_local is not refused with the key, and asks for claude_local", async () => {
    const { ctx, created } = ctxWith({ hostingProfile: "client", modelKeySecretName: "ANTHROPIC_API_KEY", modelKeySecretId: "sec-1" });
    await startHire(ctx, "co", { ...role, adapterPreference: ["hermes_local"] }, { actorUserId: null });
    const text = String(created[0]!.description);
    expect(text).toContain("| **Adapter** | `claude_local` (the company's own key) |");
    expect(text).not.toContain("hermes_local");
  });
  it("does not change a pib hire or a plugin with no config reader", async () => {
    const { ctx, created } = ctxWith({ hostingProfile: "pib" });
    await startHire(ctx, "co", role, { actorUserId: null, description: "Plain." });
    expect(created[0]!.description).toBe("Plain.");
    const bare = ctxWith(null);
    delete (bare.ctx as unknown as { config?: unknown }).config;
    await startHire(bare.ctx, "co", role, { actorUserId: null });
    expect(String(bare.created[0]!.description)).toContain("`hermes_local`, then `claude_local`");
  });
});

describe("unbound agents", () => {
  const agent = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, status: "idle", adapterType: "claude_local", adapterConfig: { env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "sec-1" } } }, ...extra });
  it("flags claude agents without the binding, in client companies only", () => {
    const agents = [agent("ok"), agent("none", { adapterConfig: {} }), agent("plain", { adapterConfig: { env: { ANTHROPIC_API_KEY: "x" } } }), agent("stale", { adapterConfig: { env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "old" } } } }), agent("hermes", { adapterType: "hermes_local" }), agent("gone", { status: "terminated", adapterConfig: {} })];
    expect(unboundKeyAgents(agents, client).map((a) => a.id)).toEqual(["none", "plain", "stale"]);
    expect(unboundKeyAgents(agents, hostingFromConfig({}))).toEqual([]);
    expect(unboundModelKeyCheck(agents, client)).toMatchObject({ key: "agents:model-key", status: "bad" });
    expect(unboundModelKeyCheck([agent("ok")], client)).toBeNull();
  });
});
