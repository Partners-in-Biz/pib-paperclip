import { describe, expect, it } from "vitest";
import { pickHiringAgent, toHiringCandidates } from "../src/hiring.js";
import type { PluginRecordLite } from "../src/ui/api.js";
import { agentContext, buildRunnerEnv, type EnvInput } from "../src/ui/bootstrap-client.js";
import { allModulesOn } from "../src/modules.js";

const plugin = (pluginKey: string): PluginRecordLite => ({ id: `${pluginKey}-id`, pluginKey, status: "ready", version: "1.0.0", displayName: pluginKey, schema: null });
const actions = { record: async () => undefined, startTemplateHire: async () => ({}), templateDraft: async () => ({}), starterPackImport: async () => ({}) };
const input = (installed: EnvInput["installed"]): EnvInput => ({
  companyId: "co-1",
  company: { id: "co-1", name: "Acme", prefix: "ACM" },
  me: "user-1",
  ownerName: null,
  modules: allModulesOn(),
  installed,
  options: {},
  requireApproval: false,
  statuses: {},
  starter: { approved: false, importedAt: null },
  hires: [],
  actions,
});

describe("the runner's environment", () => {
  it("keeps an unreadable plugin list unreadable (null), so the steps fail instead of finding nothing to do", () => {
    expect(buildRunnerEnv(input(null)).installed).toBeNull();
  });

  it("keeps an empty answer empty and the runner's plugins keyed, for the PiB module plugins only", () => {
    expect(buildRunnerEnv(input({})).installed).toEqual({});
    const env = buildRunnerEnv(input({ "partnersinbiz.crm": plugin("partnersinbiz.crm"), "some.other.plugin": plugin("some.other.plugin") }));
    expect(Object.keys(env.installed!)).toEqual(["partnersinbiz.crm"]);
    expect(env.installed!["partnersinbiz.crm"]).toMatchObject({ id: "partnersinbiz.crm-id", module: "crm", status: "ready" });
  });
});

describe("what the page tells the worker about the agents", () => {
  const raw = [
    { id: "ceo", name: "PiB", title: "CEO", role: "general", status: "idle", reportsTo: null, urlKey: "pib", permissions: { canCreateAgents: true }, adapterConfig: { model: "m", env: { GITHUB_TOKEN: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111" } } }, runtimeConfig: { heartbeat: {} } },
    { id: "dev", name: "Developer", title: "Software Engineer", role: "engineer", status: "paused", reportsTo: "ceo", urlKey: "developer", adapterConfig: { apiKey: "sk-should-never-travel" } },
  ];
  const hiring = pickHiringAgent(toHiringCandidates(raw));

  it("carries only the fields matching needs: no adapter settings, env bindings or permissions", () => {
    const context = agentContext(raw, hiring);
    expect(context.agents).toEqual([
      { id: "ceo", name: "PiB", title: "CEO", role: "general", status: "idle", reportsTo: null, urlKey: "pib" },
      { id: "dev", name: "Developer", title: "Software Engineer", role: "engineer", status: "paused", reportsTo: "ceo", urlKey: "developer" },
    ]);
    expect(JSON.stringify(context)).not.toMatch(/adapterConfig|runtimeConfig|GITHUB_TOKEN|secretId|sk-should|permissions/);
    expect(context.ceo).toEqual({ name: "PiB", urlKey: "pib" });
  });

  it("names no CEO when there is no hiring agent (or the page does not know yet), and copes with an unreadable list", () => {
    expect(agentContext(raw, null).ceo).toBeNull();
    expect(agentContext(raw, pickHiringAgent([])).ceo).toBeNull();
    expect(agentContext(null, null)).toEqual({ agents: [], ceo: null });
  });
});
