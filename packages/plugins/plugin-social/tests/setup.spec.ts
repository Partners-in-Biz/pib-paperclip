import { describe, expect, it, vi } from "vitest";
import { setupProgress } from "@partnersinbiz/pib-plugin-kit";
import { pollInboxJob } from "../src/inbox.js";
import { publishDueJob } from "../src/publish.js";
import { pollRssJob } from "../src/rss.js";
import { socialSetupStatus } from "../src/setup-status.js";
import plugin, { publishSetupStatuses } from "../src/worker.js";
import { fakeCtx, TEST_UI_BASE } from "./helpers.js";

const FULL_CONFIG = {
  publicBaseUrl: "https://paperclip.example.com",
  encryptionKey: { secretId: "s-key" },
  platforms: { linkedin: { clientId: "li-123", clientSecret: { secretId: "s-li" } }, x: { clientId: "x-1" } },
  r2: { accountId: "acc", bucket: "media", accessKeyId: "AK", secretAccessKey: { secretId: "s-r2" }, publicMediaBaseUrl: "https://media.example.com" },
  jev: { apiKey: { secretId: "s-jev" } },
};

const ACCOUNT = { id: "acct-1", company_id: "co", platform: "linkedin", scope: "org", status: "connected", display_name: "PiB", token_enc: "v1:sealed", client_ref: null };
const PROGRAM = { id: "prog-1", company_id: "co", channel: "social", objective: "More leads", autopilot: "safe", client_ref: null };

function world(input: { config?: Record<string, unknown>; configured?: boolean; modules?: Record<string, boolean> | null } = {}) {
  const configured = input.configured ?? false;
  const state = new Map<string, unknown>();
  if (input.modules) state.set("modules", { companyId: "co", modules: input.modules, updatedAt: "2026-09-01T00:00:00Z" });
  const emit = vi.fn(async () => undefined);
  const ctx = fakeCtx({
    config: { get: vi.fn(async () => input.config ?? (configured ? FULL_CONFIG : {})) },
    state: {
      get: async (k: { stateKey: string }) => (k.stateKey === "plugin-ui-base" ? TEST_UI_BASE : state.get(k.stateKey) ?? null),
      set: async (k: { stateKey: string }, v: unknown) => void state.set(k.stateKey, v),
      delete: async () => undefined,
    },
    agents: {
      get: vi.fn(async (id: string) => (configured && id === "a1" ? { id: "a1", name: "Social Media Manager", status: "idle" } : null)),
      list: vi.fn(async () => []),
      managed: { get: vi.fn(async () => ({ agentId: configured ? "a1" : null, status: "resolved" })) },
    },
    routines: {
      managed: {
        get: vi.fn(async () => (configured ? { status: "resolved", routineId: "r1", routine: { id: "r1", status: "active", assigneeAgentId: "a1" } } : { status: "missing", routineId: null, routine: null })),
      },
    },
    events: { emit, on: () => undefined },
  }, {
    queryResult: (sql) => {
      if (!configured) return [];
      if (sql.includes(".accounts")) return sql.includes("DISTINCT company_id") ? [{ company_id: "co" }] : [ACCOUNT];
      if (sql.includes(".growth_programs")) return [PROGRAM];
      if (sql.includes("DISTINCT company_id")) return [{ company_id: "co" }];
      return [];
    },
  });
  return { ctx, emit, state };
}

const byKey = (items: Array<{ key: string }>) => Object.fromEntries(items.map((i) => [i.key, i])) as Record<string, any>;

describe("social setup status", () => {
  it("lists exact next steps for a new company", async () => {
    const { ctx } = world();
    const status = await socialSetupStatus(ctx, "co", new Date("2026-09-26T10:00:00Z"));
    expect(status).toMatchObject({ plugin: "partnersinbiz.social", module: "social", title: "Social", version: "0.5.2", checkedAt: "2026-09-26T10:00:00.000Z" });
    expect(status.items[0]!.key).toBe("settings");
    const items = byKey(status.items);
    expect(items.settings).toMatchObject({ status: "missing", required: true, href: "/company/settings/instance/plugins/e588ce00-a14b-49fc-b62d-54b0208daafa" });
    expect(items.base_url_key).toMatchObject({ status: "missing", required: true });
    expect(items.r2).toMatchObject({ status: "missing", required: true });
    expect(items.r2.steps.length).toBeGreaterThan(3);
    expect(items.platform_apps).toMatchObject({ status: "missing", required: true });
    expect(items.redirect_uri).toMatchObject({ status: "blocked", required: false, blockedBy: ["base_url_key"] });
    expect(items.own_accounts).toMatchObject({ status: "blocked", required: true, href: "/social?tab=accounts", blockedBy: ["base_url_key", "platform_apps"] });
    expect(items.agent).toMatchObject({ status: "missing", required: true, href: "/social", action: { plugin: "partnersinbiz.social", key: "social.start-hire" } });
    expect(items.routine).toMatchObject({ status: "blocked", required: true, blockedBy: ["agent"] });
    expect(items.jev).toMatchObject({ status: "optional", required: false });
    expect(items.growth_program).toMatchObject({ status: "optional", required: false, action: { key: "social.growth-load" } });
    expect(items.app_linkedin).toMatchObject({ status: "optional", required: false, href: "https://www.linkedin.com/developers/apps" });
    expect(items.app_bluesky).toBeUndefined();
    expect(setupProgress(status.items).done).toBe(0);
  });

  it("marks everything done for a configured company", async () => {
    const { ctx } = world({ configured: true });
    const status = await socialSetupStatus(ctx, "co");
    const items = byKey(status.items);
    const progress = setupProgress(status.items);
    expect(progress.missing.map((i) => i.key)).toEqual([]);
    expect(progress.done).toBe(progress.total);
    expect(items.platform_apps.detail).toContain("Ready: LinkedIn.");
    expect(items.platform_apps.detail).toContain("X (no secret)");
    expect(items.app_linkedin.status).toBe("done");
    expect(items.app_x.status).toBe("optional");
    expect(items.redirect_uri).toMatchObject({ status: "unknown" });
    expect(items.redirect_uri.detail).toContain(`https://paperclip.example.com${TEST_UI_BASE}oauth-callback.html`);
    expect(items.own_accounts.detail).toContain("LinkedIn · PiB");
    expect(items.agent.action).toBeNull();
    expect(items.routine).toMatchObject({ status: "done", href: "/routines/r1" });
    expect(items.jev.status).toBe("done");
    expect(items.growth_program).toMatchObject({ status: "done", action: null });
  });

  it("publishes the status hourly for saved companies with the module on", async () => {
    const on = world({ configured: true });
    expect(await publishSetupStatuses(on.ctx)).toEqual({ published: 1, skipped: 0 });
    expect(on.emit).toHaveBeenCalledWith("setup.status", "co", expect.objectContaining({ plugin: "partnersinbiz.social" }));

    const off = world({ configured: true, modules: { social: false } });
    expect(await publishSetupStatuses(off.ctx)).toEqual({ published: 0, skipped: 1 });
    expect(off.emit).not.toHaveBeenCalled();
  });
});

describe("module switched off", () => {
  it("publish-due leaves the company's posts alone", async () => {
    const { ctx } = world({ modules: { social: false } });
    const due = fakeCtx({}, {
      queryResult: (sql) => (sql.includes("scheduled_at") ? [{ id: "p1", company_id: "co" }] : []),
    });
    (due as any).state = ctx.state;
    (due as any).config = ctx.config;
    const ensure = vi.fn(async () => undefined);
    const summary = await publishDueJob(due, ensure);
    expect(summary.skipped).toContain("co: Social is switched off");
    expect(ensure).not.toHaveBeenCalled();
    expect(summary.posts).toBe(0);
    // Only the company-agnostic stale-claim release runs; no post or destination of the company is touched.
    expect(due.fakeDb.executes.map((e) => e.sql).filter((sql) => !sql.includes("claimed_at <"))).toEqual([]);
  });

  it("poll-inbox and poll-rss skip the company", async () => {
    const { ctx } = world({ modules: { social: false } });
    const rows = fakeCtx({}, {
      queryResult: (sql) => (sql.includes("DISTINCT company_id") ? [{ company_id: "co" }] : sql.includes(".rss_feeds") ? [{ id: "f1", company_id: "co", url: "https://example.com/feed" }] : []),
    });
    (rows as any).state = ctx.state;
    (rows as any).config = { get: vi.fn(async () => FULL_CONFIG) };
    const ensure = vi.fn(async () => undefined);
    expect(await pollInboxJob(rows, ensure)).toMatchObject({ accounts: 0 });
    expect(ensure).not.toHaveBeenCalled();
    expect((rows as any).config.get).not.toHaveBeenCalled();
    expect(await pollRssJob(rows)).toMatchObject({ feeds: 0, switchedOff: 1 });
  });

  it("keeps working when no choice was saved", async () => {
    const { ctx } = world({ modules: { seo: false } });
    const due = fakeCtx({}, { queryResult: (sql) => (sql.includes("next_attempt_at") ? [{ id: "p1", company_id: "co" }] : []) });
    (due as any).state = ctx.state;
    (due as any).config = { get: vi.fn(async () => ({})) };
    const summary = await publishDueJob(due, async () => undefined);
    expect(summary.skipped).toContain("co: Social settings not saved");
  });

  it("agent tools refuse once Setup switches Social off", async () => {
    const tools = new Map<string, (params: unknown, run: unknown) => Promise<any>>();
    const events = new Map<string, Array<(event: unknown) => Promise<void>>>();
    const state = new Map<string, unknown>();
    const ctx = fakeCtx({
      state: {
        get: async (k: { stateKey: string }) => (k.stateKey === "plugin-ui-base" ? TEST_UI_BASE : state.get(k.stateKey) ?? null),
        set: async (k: { stateKey: string }, v: unknown) => void state.set(k.stateKey, v),
        delete: async () => undefined,
      },
      config: { get: vi.fn(async () => ({})) },
      tools: { register: (name: string, _decl: unknown, fn: (params: unknown, run: unknown) => Promise<any>) => void tools.set(name, fn) },
      actions: { register: () => undefined },
      jobs: { register: () => undefined },
      events: { on: (name: string, fn: (event: unknown) => Promise<void>) => void events.set(name, [...(events.get(name) ?? []), fn]), emit: async () => undefined },
      skills: { managed: { get: vi.fn(async () => { throw new Error("no skills"); }), reconcile: vi.fn(async () => { throw new Error("no skills"); }) } },
    });
    await plugin.definition.setup(ctx);
    const run = { companyId: "co", agentId: "a1", runId: null };
    expect((await tools.get("list-templates")!({}, run)).error).toBeUndefined();
    for (const fn of events.get("plugin.partnersinbiz.setup.modules.updated") ?? []) {
      await fn({ companyId: "co", payload: { companyId: "co", modules: { social: false }, updatedAt: "2026-09-26T08:00:00Z" } });
    }
    expect((await tools.get("list-templates")!({}, run)).error).toContain("switched off");
  });
});
