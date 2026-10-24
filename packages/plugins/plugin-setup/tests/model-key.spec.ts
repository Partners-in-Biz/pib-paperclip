import { describe, expect, it, vi } from "vitest";
import { patchAgentEnv } from "../src/ui/api.js";
import { claudeAgents, findKeySecret, isBound, parseAgents, parseSecretCatalog, withKeyEnv } from "../src/model-key.js";
import { runClientSteps, stepModelKey, type RunnerEnv } from "../src/bootstrap-runner.js";
import type { StepItem } from "../src/bootstrap.js";
import { allModulesOn } from "../src/modules.js";

const CO = "co-client";
const REF = { type: "secret_ref", secretId: "sec-1", version: "latest" };
const agent = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `Agent ${id}`, adapterType: "claude_local", status: "idle", adapterConfig: { model: "m", env: { KEEP: "1" } }, ...extra });

function env(patch: { profile?: "client" | "pib"; catalog?: unknown; agents?: unknown[] | null; failBind?: string; config?: Record<string, unknown> } = {}) {
  const saves: Array<{ target: string; config: Record<string, unknown> }> = [];
  const binds: Array<{ agentId: string; env: Record<string, unknown> }> = [];
  const catalog = patch.catalog === undefined ? [{ id: "sec-1", name: "ANTHROPIC_API_KEY", key: "anthropic_api_key", status: "active" }] : patch.catalog;
  const e = {
    companyId: CO,
    company: { id: CO, name: "Client", prefix: "CL" },
    modules: allModulesOn(),
    installed: { "partnersinbiz.crm": { pluginKey: "partnersinbiz.crm", id: "crm-id", status: "ready", schema: {}, module: "crm" } },
    options: { hostingProfile: patch.profile ?? "client" },
    getConfig: async () => ({ saved: true, config: patch.config ?? { enabled: true } }),
    saveConfig: async (target: string, _c: string, config: Record<string, unknown>) => void saves.push({ target, config }),
    fetchSecretCatalog: async () => catalog as never,
    fetchAgents: async () => (patch.agents === undefined ? [agent("a1")] : patch.agents),
    bindAgentKey: async (agentId: string, bindEnv: Record<string, unknown>) => {
      if (patch.failBind === agentId) throw new Error("host said no");
      binds.push({ agentId, env: bindEnv });
    },
    record: async () => {},
  } as unknown as RunnerEnv;
  return { e, saves, binds };
}
const itemOf = (items: StepItem[], key: string) => items.find((item) => item.key === key)!;

describe("model key helpers", () => {
  it("finds the secret by either spelling, by name or key, and ignores unusable ones", () => {
    expect(findKeySecret([{ id: "1", name: "x", key: "anthropic_api_key", status: "active" }])?.id).toBe("1");
    expect(findKeySecret([{ id: "2", name: "anthropic-api-key", key: "k", status: null }])?.id).toBe("2");
    expect(findKeySecret([{ id: "3", name: "ANTHROPIC_API_KEY", key: "k", status: "disabled" }])).toBeNull();
    expect(findKeySecret([{ id: "4", name: "other", key: "other", status: "active" }])).toBeNull();
  });
  it("sends only the env: the other entries stay and the key entry is replaced", () => {
    expect(withKeyEnv({ model: "m", env: { A: "1", ANTHROPIC_API_KEY: "plain" } }, "sec-1")).toEqual({ A: "1", ANTHROPIC_API_KEY: REF });
    expect(isBound({ env: { ANTHROPIC_API_KEY: REF } }, "sec-1")).toBe(true);
    expect(isBound({ env: { ANTHROPIC_API_KEY: REF } }, "sec-2")).toBe(false);
    expect(isBound(null, "sec-1")).toBe(false);
  });
  it("parses the catalog and agents defensively and picks live claude agents", () => {
    expect(parseSecretCatalog({ data: [{ id: "s", name: "n", key: "k", status: "active" }, { name: "no id" }] })).toHaveLength(1);
    expect(parseSecretCatalog("nope")).toBeNull();
    const agents = parseAgents([agent("a"), agent("b", { adapterType: "hermes_local" }), agent("c", { status: "terminated" }), { name: "no id" }]);
    expect(claudeAgents(agents).map((a) => a.id)).toEqual(["a"]);
  });
});

describe("stepModelKey", () => {
  it("skips a pib company and touches nothing", async () => {
    const { e, saves, binds } = env({ profile: "pib" });
    const out = await stepModelKey(e);
    expect(out.status).toBe("skipped");
    expect(saves).toEqual([]);
    expect(binds).toEqual([]);
  });

  it("saves the profile and binds every claude agent with the whole config", async () => {
    const { e, saves, binds } = env({ agents: [agent("a1"), agent("a2", { adapterType: "hermes_local" })] });
    const out = await stepModelKey(e);
    expect(out.status).toBe("done");
    expect(saves).toEqual([{ target: "crm-id", config: { enabled: true, hostingProfile: "client", modelKeySecretName: "ANTHROPIC_API_KEY", modelKeySecretId: "sec-1" } }]);
    expect(binds).toEqual([{ agentId: "a1", env: { KEEP: "1", ANTHROPIC_API_KEY: REF } }]);
  });

  it("is repeatable: bound agents and saved profiles change nothing", async () => {
    const bound = agent("a1", { adapterConfig: { model: "m", env: { ANTHROPIC_API_KEY: REF } } });
    const { e, saves, binds } = env({ agents: [bound], config: { hostingProfile: "client", modelKeySecretName: "ANTHROPIC_API_KEY", modelKeySecretId: "sec-1" } });
    const out = await stepModelKey(e);
    expect(out.status).toBe("done");
    expect(saves).toEqual([]);
    expect(binds).toEqual([]);
  });

  it("rebinds an agent that points at an older secret", async () => {
    const stale = agent("a1", { adapterConfig: { env: { ANTHROPIC_API_KEY: { ...REF, secretId: "old" } } } });
    const { e, binds } = env({ agents: [stale] });
    await stepModelKey(e);
    expect(binds[0]!.env).toEqual({ ANTHROPIC_API_KEY: REF });
  });

  it("without the secret saves an empty key name, binds nothing and tells the owner the exact name", async () => {
    const { e, saves, binds } = env({ catalog: [] });
    const out = await stepModelKey(e);
    expect(out.status).toBe("needs_owner");
    expect(saves[0]!.config).toMatchObject({ hostingProfile: "client", modelKeySecretName: "", modelKeySecretId: "" });
    expect(binds).toEqual([]);
    expect(itemOf(out.items, "secret").detail).toContain("ANTHROPIC_API_KEY");
  });

  it("never touches an agent whose config was not returned (missing or the empty view), and keeps going after one failure", async () => {
    const { e, binds } = env({ agents: [agent("a1", { adapterConfig: undefined }), agent("a2"), agent("a3"), agent("a4", { adapterConfig: {} })], failBind: "a2" });
    const out = await stepModelKey(e);
    expect(out.status).toBe("failed");
    expect(itemOf(out.items, "a1").status).toBe("failed");
    expect(itemOf(out.items, "a2").detail).toBe("host said no");
    expect(itemOf(out.items, "a4").status).toBe("failed");
    expect(binds.map((b) => b.agentId)).toEqual(["a3"]);
  });

  it("reports two matching secrets and uses the first", async () => {
    const { e, binds } = env({ catalog: [{ id: "sec-1", name: "ANTHROPIC_API_KEY", key: "a", status: "active" }, { id: "sec-2", name: "anthropic-api-key", key: "b", status: "active" }] });
    const out = await stepModelKey(e);
    expect(itemOf(out.items, "secret-duplicate").detail).toContain("2 secrets");
    expect(binds[0]!.env).toEqual({ KEEP: "1", ANTHROPIC_API_KEY: REF });
  });

  it("tells a pib company how to reset a client setting", async () => {
    expect((await stepModelKey(env({ profile: "pib" }).e)).detail).toContain("stays client");
  });

  it("the page sends only env in the PATCH body", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => (calls.push({ url, body: init.body }), { ok: true, json: async () => ({}) }));
    await patchAgentEnv("a1", { ANTHROPIC_API_KEY: REF });
    vi.unstubAllGlobals();
    expect(calls[0]!.url).toBe("/api/agents/a1");
    expect(JSON.parse(calls[0]!.body)).toEqual({ adapterConfig: { env: { ANTHROPIC_API_KEY: REF } } });
  });

  it("fails without changing anything when the secrets or the agents cannot be read", async () => {
    const noSecrets = env({ catalog: null });
    expect((await stepModelKey(noSecrets.e)).status).toBe("failed");
    expect(noSecrets.saves).toEqual([]);
    const noAgents = env({ agents: null });
    expect((await stepModelKey(noAgents.e)).status).toBe("failed");
    expect(noAgents.binds).toEqual([]);
  });

  it("runs between the plugin settings and the skills", async () => {
    const { e } = env({ profile: "pib" });
    const ids = (await runClientSteps(e, ["plugin-settings", "model-key", "skills"])).map((r) => r.id);
    expect(ids).toEqual(["plugin-settings", "model-key", "skills"]);
  });
});
