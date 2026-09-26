import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { setupProgress, type SetupItem } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import { NAMESPACE } from "../src/namespace.js";
import { createEnv } from "../src/service/common.js";
import { runDailyJob } from "../src/service/jobs.js";
import { clearProbeCache, publishSetupStatuses, seoSetupStatus } from "../src/service/setup-status.js";
import plugin from "../src/worker.js";
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

type Row = Record<string, unknown>;
const UI_BASE = "/_plugins/051bbf0b-aeb5-42d7-b0b6-c4cabd271cdc/ui/";

const SPRINT: Row = {
  id: "sp-1", company_id: "co-1", name: "Acme", site_url: "https://acme.co.za", site_name: "Acme", client_ref: null, client_name: null,
  status: "active", start_date: "2026-09-01", template_id: "outrank-90", template_version: 2, autopilot_mode: "safe", owner_user_id: "user-1",
  project_id: "proj-1", root_issue_id: "root-1", root_issue_identifier: "PIB-1", agent_id: "agent-1", notes: null, paused_reason: null,
  health: {}, scoreboard: {}, today: {}, current_day: 25, current_week: 4, current_phase: 1, last_daily_on: null, last_weekly_on: null,
  audit_days_done: [0], seeded_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
  site_project_id: "proj-site", site_access: "repo", repo_url: "https://github.com/pib/acme", change_policy: "merge_seo_scope",
};

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA_JSON = JSON.stringify({
  type: "service_account",
  client_email: "paperclip-seo@example.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  private_key_id: "k1",
});

function host(input: { configured?: boolean; modules?: Record<string, boolean>; apis?: "on" | "off" } = {}) {
  const configured = input.configured ?? false;
  const emitted: Array<{ name: string; companyId: string; payload: unknown }> = [];
  const issuesCreate = vi.fn(async () => ({ id: "new-issue" }));
  const state = new Map<string, unknown>([["plugin-ui-base", UI_BASE]]);
  if (input.modules) state.set("modules", { companyId: "co-1", modules: input.modules, updatedAt: "2026-09-01T00:00:00Z" });
  const ctx = {
    db: {
      namespace: NAMESPACE,
      async query(sql: string, params: unknown[] = []) {
        validateRuntimeQuery(sql, NAMESPACE, ["heartbeat_runs"]);
        validateParams(sql, params);
        if (!configured && !input.modules) return [];
        if (/DISTINCT company_id FROM plugin_seo_\w+\.sprints/.test(sql)) return [{ company_id: "co-1" }];
        if (/FROM plugin_seo_\w+\.sprints/.test(sql)) return [SPRINT];
        if (/FROM plugin_seo_\w+\.integrations/.test(sql)) {
          return params[2] === "gsc"
            ? [{ id: "i1", company_id: "co-1", sprint_id: "sp-1", provider: "gsc", status: "connected", property_url: "sc-domain:acme.co.za", settings: { auth: "service_account" } }]
            : [{ id: "i2", company_id: "co-1", sprint_id: "sp-1", provider: "bing", status: "enabled" }];
        }
        return [];
      },
      async execute(sql: string, params: unknown[] = []) {
        validateRuntimeExecute(sql, NAMESPACE);
        validateParams(sql, params);
        return { rowCount: 1 };
      },
    },
    config: {
      get: vi.fn(async () => (configured ? { publicBaseUrl: "https://paperclip.example.com", google: { serviceAccountJson: SA_JSON }, bingApiKey: "bing", pagespeedApiKey: "psi" } : {})),
    },
    secrets: { resolve: vi.fn(async () => "") },
    companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PIB" })), list: vi.fn(async () => [{ id: "co-1" }]) },
    agents: {
      get: vi.fn(async (id: string) => (configured && id === "agent-1" ? { id, name: "SEO Specialist", status: "idle" } : null)),
      list: vi.fn(async () => []),
      managed: { get: vi.fn(async () => (configured ? { agentId: "agent-1", agent: { id: "agent-1" } } : { agentId: null, agent: null })) },
    },
    issues: { create: issuesCreate, get: vi.fn(async () => null), update: vi.fn(), createComment: vi.fn(), requestWakeup: vi.fn() },
    projects: { managed: { reconcile: vi.fn(async () => ({ projectId: "proj-1" })) } },
    skills: { managed: { get: vi.fn(async () => { throw new Error("no skills"); }), reconcile: vi.fn(async () => { throw new Error("no skills"); }) } },
    events: { emit: vi.fn(async (name: string, companyId: string, payload: unknown) => void emitted.push({ name, companyId, payload })), on: () => undefined },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => state.get(key.stateKey) ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => void state.set(key.stateKey, value)),
    },
  } as unknown as PluginContext;
  const disabled = (api: string) => new Response(JSON.stringify({ error: { code: 403, message: `${api} has not been used in project 1 before or it is disabled.`, status: "PERMISSION_DENIED" } }), { status: 403 });
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.includes("oauth2")) return new Response(JSON.stringify({ access_token: "sa-token", expires_in: 3600 }), { status: 200 });
    if (url.includes("siteVerification")) return input.apis === "off" ? disabled("Google Site Verification API") : new Response(JSON.stringify({ items: [] }), { status: 200 });
    if (url.includes("webmasters")) return new Response(JSON.stringify({ siteEntry: [] }), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  });
  const env = createEnv(ctx, { now: () => new Date("2026-09-26T08:00:00Z"), fetch: fetchImpl as never, site: vi.fn() as never });
  return { env, ctx, emitted, fetchImpl, issuesCreate };
}

const byKey = (items: SetupItem[]) => Object.fromEntries(items.map((i) => [i.key, i])) as Record<string, SetupItem>;

describe("SEO setup status", () => {
  beforeEach(() => clearProbeCache());

  it("maps the checklist for a new company, with exact next steps", async () => {
    const { env } = host();
    const status = await seoSetupStatus(env, "co-1");
    expect(status).toMatchObject({ plugin: "partnersinbiz.seo", module: "seo", title: "SEO", version: "0.6.1", checkedAt: "2026-09-26T08:00:00.000Z" });
    expect(status.items[0]!.key).toBe("settings");
    const items = byKey(status.items);
    expect(items.settings).toMatchObject({ status: "missing", required: true, href: "/company/settings/instance/plugins/051bbf0b-aeb5-42d7-b0b6-c4cabd271cdc" });
    expect(items.service_account).toMatchObject({ status: "missing", required: true });
    expect(items.service_account!.steps!.length).toBe(5);
    expect(items.site_verification_api).toMatchObject({ status: "blocked", blockedBy: ["service_account"] });
    expect(items.first_sprint).toMatchObject({ status: "missing", required: true, href: "/seo" });
    expect(items.site_project).toMatchObject({ status: "blocked", blockedBy: ["first_sprint"] });
    expect(items.github_token).toMatchObject({ status: "unknown", required: false });
    expect(items.github_token!.steps!.join(" ")).toContain("/company/settings/secrets");
    expect(items.bing_key).toMatchObject({ status: "missing", required: true });
    expect(items.pagespeed_key).toMatchObject({ status: "optional", required: false });
    expect(items.agent).toMatchObject({ status: "missing", required: true, action: { plugin: "partnersinbiz.seo", key: "seo.start-hire" } });
    expect(items.autopilot).toMatchObject({ status: "blocked", required: true });
    // No company prefix in any Paperclip path.
    for (const item of status.items) if (item.href?.startsWith("/")) expect(item.href.startsWith("/PIB")).toBe(false);
    expect(setupProgress(status.items).done).toBe(0);
  });

  it("marks a configured company done, probing both Google APIs once", async () => {
    const { env, fetchImpl } = host({ configured: true });
    const status = await seoSetupStatus(env, "co-1");
    const items = byKey(status.items);
    const progress = setupProgress(status.items);
    expect(progress.missing.map((i) => i.key)).toEqual([]);
    expect(progress.done).toBe(progress.total);
    expect(items.service_account!.detail).toContain("paperclip-seo@example.iam.gserviceaccount.com");
    expect(items.site_verification_api).toMatchObject({ status: "done" });
    expect(items.site_project).toMatchObject({ status: "done", href: "/seo?sprint=sp-1&tab=integrations" });
    expect(items.autopilot!.status).toBe("done");
    expect(items.gsc_property).toMatchObject({ status: "done", required: false });
    expect(items.agent).toMatchObject({ status: "done", href: "/agents/agent-1", action: null });
    expect(items.github_token!.steps!.join(" ")).toContain("https://github.com/pib/acme");
    await seoSetupStatus(env, "co-1");
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes("siteVerification"))).toHaveLength(1);
  });

  it("reports a disabled Site Verification API", async () => {
    const { env } = host({ configured: true, apis: "off" });
    const items = byKey((await seoSetupStatus(env, "co-1")).items);
    expect(items.site_verification_api).toMatchObject({ status: "missing", required: true });
    expect(items.site_verification_api!.detail).toContain("Site Verification API is not enabled");
  });

  it("publishes the status for saved companies with SEO on", async () => {
    const on = host({ configured: true });
    expect(await publishSetupStatuses(on.env)).toEqual({ published: 1, skipped: 0 });
    expect(on.emitted[0]).toMatchObject({ name: "setup.status", companyId: "co-1", payload: { plugin: "partnersinbiz.seo" } });
    const off = host({ configured: true, modules: { seo: false } });
    expect(await publishSetupStatuses(off.env)).toEqual({ published: 0, skipped: 1 });
    expect(off.emitted).toEqual([]);
  });
});

describe("SEO module switched off", () => {
  it("the daily job skips the company's sprints", async () => {
    const { env, issuesCreate, emitted } = host({ configured: true, modules: { seo: false } });
    const result = await runDailyJob(env, { force: true });
    expect(result).toMatchObject({ processed: 0, skipped: 1, errors: [] });
    expect(issuesCreate).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it("agent tools refuse once Setup switches SEO off", async () => {
    const harness = createTestHarness({ manifest, config: { timezone: "Africa/Johannesburg", publicBaseUrl: "https://paperclip.partnersinbiz.online" } });
    harness.seed({ companies: [{ id: "co-1", issuePrefix: "PIB", name: "PiB" } as never] });
    await plugin.definition.setup(harness.ctx);
    const before = await harness.executeTool<{ error?: string }>("list-sprints", {}, { companyId: "co-1" });
    expect(before.error).toBeUndefined();
    await harness.emit("plugin.partnersinbiz.setup.modules.updated", { companyId: "co-1", modules: { seo: false }, updatedAt: "2026-09-26T08:00:00Z" }, { companyId: "co-1" });
    const after = await harness.executeTool<{ error?: string }>("list-sprints", {}, { companyId: "co-1" });
    expect(after.error).toContain("switched off");
  });
});
