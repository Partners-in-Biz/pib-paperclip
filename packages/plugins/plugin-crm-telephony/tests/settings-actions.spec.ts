import { describe, expect, it, beforeEach, vi } from "vitest";
import { settingsStateKey, templateSyncStateKey } from "../src/settings.js";
import { registerSettingsActions } from "../src/settings-actions.js";
import { TELEPHONY_SECRET_NAMES } from "../src/secret-names.js";
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";

class FakeCtx {
  state: Map<string, Record<string, unknown>> = new Map();
  companies: Map<string, { id: string; name: string | null }> = new Map();
  secrets: Map<string, Map<string, string | null>> = new Map();
  actions: Map<string, (params: unknown, context: PluginPerformActionContext) => Promise<unknown>> = new Map();
  config = { get: vi.fn().mockResolvedValue({}) };
  db = { namespace: {} };
  jobs = { register: vi.fn() };
  tools = { register: vi.fn() };
  logger = { debug: vi.fn() };

  async getState(key: unknown): Promise<Record<string, unknown> | null> {
    return this.state.get(JSON.stringify(key)) || null;
  }

  async setState(key: unknown, value: unknown): Promise<void> {
    this.state.set(JSON.stringify(key), value as Record<string, unknown>);
  }

  async resolveSecret(ref: string, opts: { companyId: string }): Promise<string | null> {
    const byCompany = this.secrets.get(ref);
    if (!byCompany) throw new Error(`Secret not found: ${ref}`);
    const val = byCompany.get(opts.companyId);
    if (!val) throw new Error(`Secret not set for company`);
    return val;
  }
}

function makeFakeCtx(fake: FakeCtx): PluginContext {
  return {
    state: {
      get: (k: unknown) => Promise.resolve(fake.getState(k)),
      set: (k: unknown, v: unknown) => fake.setState(k, v),
    },
    secrets: {
      resolve: (ref: string, opts: { companyId: string }) => fake.resolveSecret(ref, opts),
    },
    companies: {
      get: (id: string) => Promise.resolve(fake.companies.get(id) || null),
    },
    actions: {
      register: (key: string, fn: (params: unknown, context: PluginPerformActionContext) => Promise<unknown>) =>
        fake.actions.set(key, fn),
    },
    config: fake.config,
    db: fake.db,
    jobs: fake.jobs,
    tools: fake.tools,
    logger: fake.logger,
  } as any;
}

describe("Settings Actions", () => {
  let ctx: PluginContext;
  let fake: FakeCtx;

  beforeEach(() => {
    fake = new FakeCtx();
    ctx = makeFakeCtx(fake);
    registerSettingsActions(ctx);
    fake.companies.set("companyA", { id: "companyA", name: "Company A" });
    fake.companies.set("companyB", { id: "companyB", name: "Company B" });
  });

  async function callAction(key: string, params: unknown, context: Partial<PluginPerformActionContext>): Promise<any> {
    const handler = fake.actions.get(key);
    if (!handler) throw new Error(`Action not registered: ${key}`);
    return handler(params, context as PluginPerformActionContext) as Promise<any>;
  }

  const agentCtx = (cid = "companyA") => ({ actor: { type: "agent", agentId: "agent-1", runId: "run-1" } as any, companyId: cid });
  const userCtx = (cid: string) => ({ actor: { type: "user", userId: "user1" } as any, companyId: cid });

  it("registers three actions", () => {
    expect(fake.actions.size).toBe(3);
    expect(fake.actions.has("telephony.settings.get")).toBe(true);
    expect(fake.actions.has("telephony.settings.save")).toBe(true);
    expect(fake.actions.has("telephony.settings.sync-templates")).toBe(true);
  });

  it("get returns company A with all 12 secrets as set/missing", async () => {
    const result = await callAction("telephony.settings.get", {}, agentCtx("companyA"));
    expect(result.company.id).toBe("companyA");
    expect(result.company.name).toBe("Company A");
    expect(Object.keys(result.secrets)).toHaveLength(TELEPHONY_SECRET_NAMES.length);
    expect(result.secrets.ANTHROPIC_API_KEY).toBe("missing");
  });

  it("get for company B returns B's values, separate from A", async () => {
    ctx.config.get = vi.fn().mockResolvedValue({});
    await callAction("telephony.settings.save", { maxCallsPerDay: 75 }, userCtx("companyA"));

    const a = await callAction("telephony.settings.get", {}, agentCtx("companyA"));
    const b = await callAction("telephony.settings.get", {}, agentCtx("companyB"));
    expect(a.settings.maxCallsPerDay).toBe(75);
    expect(b.settings.maxCallsPerDay).toBe(50); // default
    expect(a.company.name).toBe("Company A");
    expect(b.company.name).toBe("Company B");
  });

  it("get ignores params.companyId, uses context.companyId", async () => {
    const result = await callAction("telephony.settings.get", { companyId: "companyB" }, agentCtx("companyA"));
    expect(result.company.id).toBe("companyA");
  });

  it("save then readSettings round trip", async () => {
    ctx.config.get = vi.fn().mockResolvedValue({});
    const saved = await callAction("telephony.settings.save", {
      maxCallsPerDay: 80,
      whatsappFrom: "+27123456789",
      callerIds: ["+27111111111"],
    }, userCtx("companyA"));
    expect(saved.ok).toBe(true);

    const retrieved = await callAction("telephony.settings.get", {}, agentCtx("companyA"));
    expect(retrieved.settings.maxCallsPerDay).toBe(80);
    expect(retrieved.settings.whatsappFrom).toBe("+27123456789");
  });

  it("usMessagingServiceSid round-trips through save and get, per company", async () => {
    ctx.config.get = vi.fn().mockResolvedValue({});
    const sid = "MGd3200a283d8d4dd9827e5b6d5f5e5e5a";
    const saved = await callAction("telephony.settings.save", { usMessagingServiceSid: sid }, userCtx("companyA"));
    expect(saved.ok).toBe(true);

    const a = await callAction("telephony.settings.get", {}, agentCtx("companyA"));
    const b = await callAction("telephony.settings.get", {}, agentCtx("companyB"));
    expect(a.settings.usMessagingServiceSid).toBe(sid);
    expect(b.settings.usMessagingServiceSid).not.toBe(sid);

    const bad = await callAction("telephony.settings.save", { usMessagingServiceSid: "MG123" }, userCtx("companyA"));
    expect(bad.ok).toBe(false);
    expect(bad.errors.usMessagingServiceSid).toBeDefined();
  });

  it("save ignores params.companyId, changes only context.companyId", async () => {
    ctx.config.get = vi.fn().mockResolvedValue({});
    await callAction("telephony.settings.save", { maxCallsPerDay: 85, companyId: "companyB" }, userCtx("companyA"));
    const a = await callAction("telephony.settings.get", {}, agentCtx("companyA"));
    const b = await callAction("telephony.settings.get", {}, agentCtx("companyB"));
    expect(a.settings.maxCallsPerDay).toBe(85);
    expect(b.settings.maxCallsPerDay).toBe(50);
  });

  it.each([
    ["save", "telephony.settings.save", { maxCallsPerDay: 100 }],
    ["sync-templates", "telephony.settings.sync-templates", {}],
  ])("%s rejects agent actors with no state written", async (_name, action, params) => {
    await expect(() => callAction(action, params, agentCtx("companyA"))).rejects.toThrow("This action is for board users");
    const saved = await fake.getState(settingsStateKey("companyA"));
    expect(saved).toBeNull();
  });

  it.each([
    ["maxCallsPerDay 0", { maxCallsPerDay: 0 }, "maxCallsPerDay"],
    ["callerIds invalid", { callerIds: ["invalid"] }, "callerIds"],
    ["allowedHours bad order", { allowedHours: { start: "18:00", end: "08:00" } }, "allowedHours"],
  ])("save rejects invalid payload %s", async (_label, params, errorKey) => {
    const result = await callAction("telephony.settings.save", params, userCtx("companyA"));
    expect(result.ok).toBe(false);
    expect(result.errors[errorKey]).toBeDefined();
    const saved = await fake.getState(settingsStateKey("companyA"));
    expect(saved).toBeNull();
  });

  it("missing companyId throws 'Company is required'", async () => {
    await expect(() => callAction("telephony.settings.get", {}, { actor: { type: "agent" } } as any)).rejects.toThrow(
      "Company is required",
    );
  });

  it("get allowed for agent actors", async () => {
    const result = await callAction("telephony.settings.get", {}, agentCtx("companyA"));
    expect(result).toBeDefined();
  });

  it("sync-templates stores requestedAt and get shows it", async () => {
    const before = new Date().toISOString();
    const result = await callAction("telephony.settings.sync-templates", {}, userCtx("companyA"));
    expect(result.requestedAt).toBeDefined();
    expect(result.requestedAt >= before).toBe(true);

    const view = await callAction("telephony.settings.get", {}, agentCtx("companyA"));
    expect(view.templateSyncRequestedAt).toBe(result.requestedAt);
  });

  it("sync-templates does not affect settings, isolated per company", async () => {
    ctx.config.get = vi.fn().mockResolvedValue({});
    await callAction("telephony.settings.save", { maxCallsPerDay: 90 }, userCtx("companyA"));
    await callAction("telephony.settings.sync-templates", {}, userCtx("companyA"));
    const view = await callAction("telephony.settings.get", {}, agentCtx("companyA"));
    expect(view.settings.maxCallsPerDay).toBe(90);

    const b = await callAction("telephony.settings.get", {}, agentCtx("companyB"));
    expect(b.templateSyncRequestedAt).toBeNull();
  });

  it("secret values never appear in returned JSON", async () => {
    const fakeSecret = "sk-SECRET-VALUE-XYZ";
    const secretRef = TELEPHONY_SECRET_NAMES[0];
    const byCompany = new Map();
    byCompany.set("companyA", fakeSecret);
    fake.secrets.set(secretRef, byCompany);

    const originalResolve = ctx.secrets.resolve;
    ctx.secrets.resolve = vi.fn(async (ref: string, opts: { companyId: string }) => {
      if (ref === secretRef && opts.companyId === "companyA") return fakeSecret;
      return originalResolve(ref, opts);
    });

    const result = await callAction("telephony.settings.get", {}, agentCtx("companyA"));
    expect(JSON.stringify(result)).not.toContain(fakeSecret);
  });
});
