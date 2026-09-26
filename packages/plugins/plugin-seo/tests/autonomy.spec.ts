import { createVerify, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { toToolData } from "@partnersinbiz/pib-plugin-kit";
import { NAMESPACE } from "../src/namespace.js";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { createEnv, type Actor } from "../src/service/common.js";
import {
  clearServiceAccountTokenCache,
  JWT_BEARER_GRANT,
  parseServiceAccountKey,
  serviceAccountToken,
  signServiceAccountJwt,
  verificationChange,
  verificationSite,
} from "../src/integrations/google-sa.js";
import { indexNowRequest, submitIndexNow } from "../src/integrations/indexnow.js";
import { bingAddSite, bingSubmitSitemap, bingSubmitUrlBatch, bingVerificationFiles, bingVerifySite } from "../src/integrations/bing.js";
import { evaluateChange, githubRepo, isCodeTask } from "../src/engine/site-change.js";
import { carryOver, mergeItem, needsYouDescription, resolveItem, weekStart, type NewNeedsYouItem } from "../src/engine/needs-you.js";
import { buildSetupChecklist, type SetupFacts } from "../src/engine/setup.js";
import { clientAccessEmail } from "../src/engine/items.js";
import { gscAccess, gscCheckAccess, gscSubmitSitemap, gscVerificationToken, gscVerifySite } from "../src/service/gsc.js";
import { companyInfo } from "../src/service/common.js";
import { upgradeSprintPlan, v3Target } from "../src/service/upgrade.js";
import { blockTask, createTaskIssue, type MaterialiseContext } from "../src/service/tasks.js";
import { addNeedsYou, recheckNeedsYou, resolveNeedsYou } from "../src/service/needs-you.js";
import { linkSiteTool } from "../src/service/site.js";
import type { SprintTask } from "../src/db.js";
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

type Row = Record<string, unknown>;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const SA_JSON = JSON.stringify({
  type: "service_account",
  project_id: "partners-in-biz-85059",
  private_key_id: "kid-1",
  private_key: PEM,
  client_email: "paperclip-seo@partners-in-biz-85059.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token",
});
const SA_EMAIL = "paperclip-seo@partners-in-biz-85059.iam.gserviceaccount.com";

const SPRINT: Row = {
  id: "sp-1", company_id: "co-1", name: "PiB", site_url: "https://partnersinbiz.online", site_name: "Partners in Biz", client_kind: null, client_ref: null, client_name: null,
  status: "pre_launch", start_date: "2026-09-26", template_id: "outrank-90", template_version: 2, autopilot_mode: "safe", owner_user_id: "user-1",
  project_id: "seo-proj", root_issue_id: "root-1", root_issue_identifier: "PIB-1", agent_id: "agent-1", notes: null, paused_reason: null,
  health: {}, scoreboard: {}, today: {}, current_day: 0, current_week: 0, current_phase: 0, last_daily_on: null, last_weekly_on: null,
  audit_days_done: [], seeded_at: "2026-09-26T00:00:00Z", site_project_id: null, site_access: "unlinked", repo_url: null, default_branch: "main",
  framework: null, hosting: null, change_policy: "merge_seo_scope", verification: {}, created_at: "2026-09-26T00:00:00Z", updated_at: "2026-09-26T00:00:00Z",
};

function taskRow(extra: Row = {}): Row {
  return {
    id: "t-1", company_id: "co-1", sprint_id: "sp-1", template_key: "w0-meta-tags", week: 0, phase: 0, due_day: null, focus: "Pre-launch",
    title: "Set up meta tags on every page (title, description, OG image)", description: null, task_type: "meta-tag-audit", owner: "agent", autopilot_eligible: true,
    playbook_key: "w0-meta-tags", status: "not_started", source: "template", parent_optimization_id: null, context: null, issue_id: null, issue_identifier: null,
    issue_status: null, issue_project_id: null, assignee_kind: null, blocker_reason: null, human_ask: null, evidence: null, started_at: null, completed_at: null,
    completed_by: null, created_at: null, updated_at: null, ...extra,
  };
}

const INTEGRATION = { id: "int-1", company_id: "co-1", sprint_id: "sp-1", provider: "gsc", status: "disconnected", property_url: null, token_sealed: null, scopes: [], settings: {}, stats: {}, alert_issue_id: null };

/**
 * Fake host: SQL is checked against the host guard; sprints, tasks,
 * integrations and needs_you rows are kept in memory so writes are visible to
 * later reads.
 */
function fakeHost(opts: { sprint?: Row; tasks?: Row[]; integration?: Row; config?: Row; fetch?: (url: string, init?: RequestInit) => Promise<Response> } = {}) {
  const sprint: Row = { ...SPRINT, ...(opts.sprint ?? {}) };
  const tasks = new Map<string, Row>((opts.tasks ?? []).map((t) => [String(t.id), { ...t }]));
  const integration: Row = { ...INTEGRATION, ...(opts.integration ?? {}) };
  const digests: Row[] = [];
  const issuesCreated: Row[] = [];
  const issueUpdates: Array<{ id: string; patch: Row }> = [];
  const comments: Array<{ id: string; body: string }> = [];
  const executes: Array<{ sql: string; params: unknown[] }> = [];
  const wakeups: string[] = [];
  const issues = new Map<string, Row>();

  const applySet = (row: Row, sql: string, params: unknown[]) => {
    const set = sql.slice(sql.indexOf(" SET ") + 5, sql.indexOf(" WHERE "));
    for (const part of set.split(/, (?=[a-z_]+ = )/)) {
      const m = /^([a-z_]+) = (NULL|now\(\)|\$(\d+))/.exec(part.trim());
      if (!m) continue;
      if (m[2] === "NULL") row[m[1]!] = null;
      else if (m[3]) {
        const value = params[Number(m[3]) - 1];
        row[m[1]!] = typeof value === "string" && /::jsonb/.test(part) ? JSON.parse(value) : value;
      }
    }
  };

  const ctx = {
    db: {
      namespace: NAMESPACE,
      async query(sql: string, params: unknown[] = []) {
        validateRuntimeQuery(sql, NAMESPACE, ["heartbeat_runs"]);
        validateParams(sql, params);
        if (/FROM plugin_seo_8099f8879a\.sprints WHERE id = \$1/.test(sql)) return [sprint];
        if (/FROM plugin_seo_8099f8879a\.sprints WHERE company_id/.test(sql)) return [sprint];
        if (/FROM plugin_seo_8099f8879a\.sprint_tasks WHERE id = \$1/.test(sql)) return tasks.has(String(params[0])) ? [tasks.get(String(params[0]))] : [];
        if (/FROM plugin_seo_8099f8879a\.sprint_tasks WHERE issue_id/.test(sql)) return [...tasks.values()].filter((t) => t.issue_id === params[0]);
        if (/FROM plugin_seo_8099f8879a\.sprint_tasks WHERE company_id/.test(sql)) {
          const statuses = sql.includes("status IN") ? (JSON.parse(String(params[2])) as string[]) : null;
          return [...tasks.values()].filter((t) => !statuses || statuses.includes(String(t.status)));
        }
        if (/FROM plugin_seo_8099f8879a\.integrations/.test(sql)) return params.includes("bing") ? [] : [integration];
        if (/FROM plugin_seo_8099f8879a\.needs_you WHERE company_id = \$1 AND sprint_id = \$2 AND week_start = \$3/.test(sql)) return digests.filter((d) => d.week_start === params[2]);
        if (/FROM plugin_seo_8099f8879a\.needs_you WHERE company_id = \$1 AND sprint_id = \$2 AND week_start < \$3/.test(sql)) {
          return digests.filter((d) => String(d.week_start) < String(params[2])).sort((a, b) => String(b.week_start).localeCompare(String(a.week_start))).slice(0, 1);
        }
        if (/FROM plugin_seo_8099f8879a\.needs_you WHERE company_id = \$1 AND issue_id/.test(sql)) return digests.filter((d) => d.issue_id === params[1]);
        return [];
      },
      async execute(sql: string, params: unknown[] = []) {
        validateRuntimeExecute(sql, NAMESPACE);
        validateParams(sql, params);
        executes.push({ sql, params });
        if (sql.startsWith("INSERT INTO plugin_seo_8099f8879a.needs_you")) {
          const existing = digests.find((d) => d.sprint_id === params[2] && d.week_start === params[3]);
          if (existing) {
            existing.items = JSON.parse(String(params[4]));
            existing.status = params[5];
          } else {
            digests.push({ id: params[0], company_id: params[1], sprint_id: params[2], week_start: params[3], items: JSON.parse(String(params[4])), status: params[5], issue_id: null, issue_identifier: null, updated_at: null });
          }
        } else if (sql.startsWith("UPDATE plugin_seo_8099f8879a.needs_you")) {
          const d = digests.find((x) => x.id === params[2]);
          if (d) {
            d.issue_id = params[0];
            d.issue_identifier = params[1];
          }
        } else if (sql.startsWith("UPDATE plugin_seo_8099f8879a.sprint_tasks SET") && !sql.includes("'creating'") && !sql.includes("issue_status = NULL, updated_at")) {
          const id = params[params.length - 2];
          const t = tasks.get(String(id));
          if (t) applySet(t, sql, params);
        } else if (sql.includes("issue_status = 'creating'")) {
          const t = tasks.get(String(params[0]));
          if (!t || t.issue_id) return { rowCount: 0 };
          t.issue_status = "creating";
        } else if (sql.startsWith("UPDATE plugin_seo_8099f8879a.sprints SET")) {
          applySet(sprint, sql, params);
        } else if (sql.startsWith("UPDATE plugin_seo_8099f8879a.integrations SET")) {
          applySet(integration, sql, params);
        }
        return { rowCount: 1 };
      },
    },
    config: { get: vi.fn(async () => ({ timezone: "Africa/Johannesburg", ...(opts.config ?? {}) })) },
    secrets: { resolve: vi.fn(async (_ref: unknown, o?: { configPath?: string }) => (o?.configPath === "google.serviceAccountJson" ? SA_JSON : o?.configPath === "bingApiKey" ? "bing-key" : `resolved:${o?.configPath}`)) },
    companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PIB" })) },
    agents: {
      get: vi.fn(async (id: string) => ({ id, name: "SEO Specialist", status: "active" })),
      managed: { get: vi.fn(async () => ({ agentId: null, agent: null })) },
    },
    projects: {
      get: vi.fn(async (id: string) => (id === "site-proj" ? { id, name: "PiB website", codebase: { repoUrl: "https://github.com/Partners-in-Biz/partnersinbiz-web", defaultRef: "main" } } : null)),
      getPrimaryWorkspace: vi.fn(async () => ({ repoUrl: "https://github.com/Partners-in-Biz/partnersinbiz-web", defaultRef: "main", repoRef: null })),
      list: vi.fn(async () => []),
      managed: { reconcile: vi.fn(async () => ({ projectId: "seo-proj", status: "resolved" })) },
    },
    issues: {
      get: vi.fn(async (id: string) => issues.get(id) ?? { id, status: "todo", identifier: `PIB-${id}` }),
      update: vi.fn(async (id: string, patch: Row) => {
        issueUpdates.push({ id, patch });
        issues.set(id, { ...(issues.get(id) ?? { id, identifier: `PIB-${id}` }), ...patch });
        return { id, ...patch };
      }),
      createComment: vi.fn(async (id: string, body: string) => {
        comments.push({ id, body });
        return { id: "c" };
      }),
      create: vi.fn(async (input: Row) => {
        const id = `new-${issuesCreated.length + 1}`;
        issuesCreated.push({ id, ...input });
        issues.set(id, { id, status: "todo", identifier: `PIB-${10 + issuesCreated.length}` });
        return { id };
      }),
      requestWakeup: vi.fn(async (id: string) => {
        wakeups.push(id);
        return { queued: true, runId: null };
      }),
    },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    skills: { managed: { reconcile: vi.fn(), reset: vi.fn() } },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => (key.stateKey === "plugin-ui-base" ? "/_plugins/051bbf0b-aeb5-42d7-b0b6-c4cabd271cdc/ui/" : key.stateKey.startsWith("role:") ? { agentId: "agent-1" } : null)),
      set: vi.fn(),
    },
  } as unknown as PluginContext;
  const fetchImpl = vi.fn(opts.fetch ?? (async () => new Response("{}")));
  const env = createEnv(ctx, { now: () => new Date("2026-09-26T08:00:00Z"), fetch: fetchImpl as never, site: vi.fn(async () => ({ status: 404, text: "", url: "", redirects: [], headers: {}, ms: 1 })) as never });
  return { env, ctx, sprint, tasks, integration, digests, issuesCreated, issueUpdates, comments, executes, wakeups, fetch: fetchImpl };
}

const SA_CONFIG = { google: { serviceAccountJson: { type: "secret_ref", secretId: "sa" } }, bingApiKey: { type: "secret_ref", secretId: "b" } };
const agentActor: Actor = { kind: "agent", agentId: "agent-1", runId: "run-1", responsibleUserId: null };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => clearServiceAccountTokenCache());

// ---------------------------------------------------------------------------

describe("service account JWT", () => {
  it("signs an RS256 assertion Google accepts (verified with the public key)", () => {
    const key = parseServiceAccountKey(SA_JSON);
    const jwt = signServiceAccountJwt(key, ["https://www.googleapis.com/auth/webmasters", "https://www.googleapis.com/auth/siteverification"], Date.UTC(2026, 8, 26, 8));
    const [h, c, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT", kid: "kid-1" });
    const claims = JSON.parse(Buffer.from(c!, "base64url").toString());
    expect(claims).toMatchObject({ iss: SA_EMAIL, aud: "https://oauth2.googleapis.com/token", scope: "https://www.googleapis.com/auth/webmasters https://www.googleapis.com/auth/siteverification" });
    expect(claims.exp - claims.iat).toBe(3600);
    const ok = createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(sig!, "base64url"));
    expect(ok).toBe(true);
  });

  it("exchanges the JWT for a token and caches it for ~50 minutes", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("grant_type")).toBe(JWT_BEARER_GRANT);
      expect(form.get("assertion")!.split(".")).toHaveLength(3);
      return json({ access_token: "sa-token", expires_in: 3600 });
    });
    const key = parseServiceAccountKey(SA_JSON);
    const t0 = Date.UTC(2026, 8, 26, 8);
    expect(await serviceAccountToken(fetchImpl, key, undefined, t0)).toBe("sa-token");
    expect(await serviceAccountToken(fetchImpl, key, undefined, t0 + 49 * 60_000)).toBe("sa-token");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await serviceAccountToken(fetchImpl, key, undefined, t0 + 51 * 60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects keys that are not service account JSON", () => {
    expect(() => parseServiceAccountKey("nope")).toThrow(/not valid JSON/);
    expect(() => parseServiceAccountKey(JSON.stringify({ type: "authorized_user" }))).toThrow(/not a service account/);
  });
});

describe("GSC access: service account first, OAuth fallback", () => {
  it("uses the service account and auto-selects the property it owns", async () => {
    const host = fakeHost({
      config: SA_CONFIG,
      fetch: async (url) => {
        if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "sa-token", expires_in: 3600 });
        if (url.endsWith("/webmasters/v3/sites")) return json({ siteEntry: [{ siteUrl: "https://partnersinbiz.online/", permissionLevel: "siteOwner" }] });
        return json({});
      },
    });
    const info = await companyInfo(host.env, "co-1");
    const sprint = (await import("../src/db.js")).getSprint(host.env.ctx.db, "co-1", "sp-1");
    const access = await gscAccess(host.env, info, (await sprint)!, { needProperty: true });
    expect(access).toMatchObject({ via: "service_account", accessToken: "sa-token", propertyUrl: "https://partnersinbiz.online/" });
    expect(host.integration).toMatchObject({ property_url: "https://partnersinbiz.online/", status: "connected" });
    expect((host.integration.settings as Row).auth).toBe("service_account");
  });

  it("falls back to the OAuth connection when the service account gets 403 on the property", async () => {
    const { buildKeyring, sealJson } = await import("@partnersinbiz/pib-plugin-kit");
    const sealed = sealJson({ accessToken: "oauth-token", refreshToken: "rt", expiresAt: Date.now() + 3_600_000, scope: "s" }, buildKeyring({ purpose: "seo", companyId: "co-1", secret: "resolved:encryptionKey" }));
    const puts: string[] = [];
    const host = fakeHost({
      config: { ...SA_CONFIG, encryptionKey: { type: "secret_ref", secretId: "k" } },
      integration: { status: "connected", property_url: "sc-domain:partnersinbiz.online", token_sealed: sealed, settings: { auth: "service_account" } },
      fetch: async (url, init) => {
        if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "sa-token", expires_in: 3600 });
        if (init?.method === "PUT") {
          const auth = String((init.headers as Record<string, string>).Authorization);
          puts.push(auth);
          return auth === "Bearer sa-token" ? json({ error: { message: "User does not have sufficient permission" } }, 403) : json({});
        }
        return json({});
      },
    });
    const result = await gscSubmitSitemap(host.env, "co-1", { sprintId: "sp-1" });
    expect(result).toMatchObject({ submitted: true });
    expect(puts).toEqual(["Bearer sa-token", "Bearer oauth-token"]);
  });
});

describe("site verification with the service account", () => {
  it("gets a META token, then verifies, adds the property and submits the sitemap", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const host = fakeHost({
      config: SA_CONFIG,
      fetch: async (url, init) => {
        calls.push({ url, method: String(init?.method ?? "GET"), body: init?.body && !String(init.body).startsWith("grant_type") ? JSON.parse(String(init.body)) : null });
        if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "sa-token", expires_in: 3600 });
        if (url.endsWith("/siteVerification/v1/token")) return json({ method: "META", token: '<meta name="google-site-verification" content="abc123" />' });
        if (url.includes("/siteVerification/v1/webResource")) return json({ id: "https%3A%2F%2Fpartnersinbiz.online%2F", owners: [SA_EMAIL, "peet@partnersinbiz.online"] });
        return json({});
      },
    });
    const token = await gscVerificationToken(host.env, "co-1", { sprintId: "sp-1" });
    expect(token).toMatchObject({ method: "META", property: "https://partnersinbiz.online/", serviceAccountEmail: SA_EMAIL, change: { kind: "meta", detail: { content: "abc123" } } });
    expect(calls.find((c) => c.url.endsWith("/token") && c.url.includes("siteVerification"))!.body).toEqual({ site: { type: "SITE", identifier: "https://partnersinbiz.online/" }, verificationMethod: "META" });
    expect((host.sprint.verification as Row).google).toMatchObject({ method: "META", property: "https://partnersinbiz.online/" });

    const verified = await gscVerifySite(host.env, "co-1", agentActor, { sprintId: "sp-1" });
    expect(verified).toMatchObject({ verified: true, property: "https://partnersinbiz.online/", addedToSearchConsole: true, sitemap: { submitted: true } });
    const order = calls.filter((c) => !c.url.startsWith("https://oauth2")).map((c) => `${c.method} ${c.url.replace("https://www.googleapis.com", "")}`);
    expect(order.slice(-3)).toEqual([
      "POST /siteVerification/v1/webResource?verificationMethod=META",
      "PUT /webmasters/v3/sites/https%3A%2F%2Fpartnersinbiz.online%2F",
      "PUT /webmasters/v3/sites/https%3A%2F%2Fpartnersinbiz.online%2F/sitemaps/https%3A%2F%2Fpartnersinbiz.online%2Fsitemap.xml",
    ]);
    expect(host.integration).toMatchObject({ status: "connected", property_url: "https://partnersinbiz.online/" });
  });

  it("puts the client email on Needs you when the service account has no access", async () => {
    const host = fakeHost({
      config: SA_CONFIG,
      sprint: { client_kind: "company", client_ref: "crm-1", client_name: "Acme", site_url: "https://acme.co.za", site_name: "Acme" },
      fetch: async (url) => (url.startsWith("https://oauth2") ? json({ access_token: "sa-token", expires_in: 3600 }) : json({ siteEntry: [] })),
    });
    const result = await gscCheckAccess(host.env, "co-1", { sprintId: "sp-1" });
    expect(result).toMatchObject({ hasAccess: false, property: "sc-domain:acme.co.za", usersLink: "https://search.google.com/search-console/users?resource_id=sc-domain%3Aacme.co.za" });
    const items = host.digests[0]!.items as Array<Row>;
    expect(items[0]).toMatchObject({ key: "gsc_access", kind: "message", check: "gsc_access" });
    expect(String(items[0]!.copy)).toContain(SA_EMAIL);
    expect(host.issuesCreated).toHaveLength(1);
    expect(host.issuesCreated[0]).toMatchObject({ assigneeUserId: "user-1", parentId: "root-1", originKind: "plugin:partnersinbiz.seo:needs-you" });
  });

  it("maps verification methods to the change to make", () => {
    expect(verificationSite({ siteUrl: "https://x.co.za" })).toEqual({ type: "SITE", identifier: "https://x.co.za/" });
    expect(verificationSite({ siteUrl: "sc-domain:x.co.za" })).toEqual({ type: "INET_DOMAIN", identifier: "x.co.za" });
    expect(verificationChange("FILE", "google1a2b.html")).toEqual({ kind: "file", detail: { path: "/google1a2b.html", content: "google-site-verification: google1a2b.html", nextjs: "public/google1a2b.html" } });
    expect(verificationChange("DNS_TXT", "google-site-verification=zz").kind).toBe("dns");
  });
});

describe("IndexNow and Bing", () => {
  it("builds the IndexNow request for the site's host only", async () => {
    const body = indexNowRequest("https://partnersinbiz.online", "0123456789abcdef0123456789abcdef", ["https://partnersinbiz.online/", "https://partnersinbiz.online/pricing", "https://evil.example/x"]);
    expect(body).toEqual({
      host: "partnersinbiz.online",
      key: "0123456789abcdef0123456789abcdef",
      keyLocation: "https://partnersinbiz.online/0123456789abcdef0123456789abcdef.txt",
      urlList: ["https://partnersinbiz.online/", "https://partnersinbiz.online/pricing"],
    });
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.indexnow.org/indexnow");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>)["Content-Type"]).toContain("application/json");
      expect(JSON.parse(String(init?.body))).toEqual(body);
      return new Response("", { status: 202 });
    });
    expect(await submitIndexNow(fetchImpl, body)).toMatchObject({ ok: true, status: 202, submitted: 2 });
    expect((await submitIndexNow(vi.fn(async () => new Response("", { status: 403 })), body)).ok).toBe(false);
  });

  it("adds, verifies and submits through the Bing Webmaster API", async () => {
    const calls: Array<{ method: string; body: unknown }> = [];
    let added = false;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const method = /json\/([A-Za-z]+)\?apikey=bing-key$/.exec(url)?.[1] ?? "?";
      calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method === "GetUserSites") return json({ d: added ? [{ Url: "https://partnersinbiz.online/", IsVerified: false, AuthenticationCode: "ABC123" }] : [] });
      if (method === "AddSite") {
        added = true;
        return json({ d: null });
      }
      if (method === "VerifySite") return json({ d: true });
      return json({ d: null });
    });
    const site = await bingAddSite(fetchImpl, "bing-key", "https://partnersinbiz.online/");
    expect(site).toMatchObject({ authenticationCode: "ABC123", isVerified: false });
    expect(await bingVerifySite(fetchImpl, "bing-key", "https://partnersinbiz.online/")).toBe(true);
    await bingSubmitSitemap(fetchImpl, "bing-key", "https://partnersinbiz.online/", "https://partnersinbiz.online/sitemap.xml");
    expect(await bingSubmitUrlBatch(fetchImpl, "bing-key", "https://partnersinbiz.online/", ["https://partnersinbiz.online/a", "https://partnersinbiz.online/a"])).toBe(1);
    expect(calls.map((c) => c.method)).toEqual(["GetUserSites", "AddSite", "GetUserSites", "VerifySite", "SubmitSitemap", "SubmitUrlBatch"]);
    expect(calls[1]!.body).toEqual({ siteUrl: "https://partnersinbiz.online/" });
    expect(calls[4]!.body).toEqual({ siteUrl: "https://partnersinbiz.online/", feedUrl: "https://partnersinbiz.online/sitemap.xml" });
    expect(calls[5]!.body).toEqual({ siteUrl: "https://partnersinbiz.online/", urlList: ["https://partnersinbiz.online/a"] });
    expect(bingVerificationFiles("ABC123").file.content).toContain("<user>ABC123</user>");
  });
});

describe("change scope", () => {
  it("merges SEO-scope changes only when checks pass", () => {
    const seo = [{ path: "src/app/layout.tsx", category: "head_metadata" }, { path: "public/BingSiteAuth.xml", category: "verification_file" }];
    expect(evaluateChange("merge_seo_scope", seo, "passed").decision).toBe("merge");
    expect(evaluateChange("merge_seo_scope", seo, "pending").decision).toBe("wait");
    expect(evaluateChange("merge_seo_scope", seo, "failed").decision).toBe("wait");
    expect(evaluateChange("pr_only", seo, "passed").decision).toBe("pr_only");
  });

  it("keeps out-of-scope files for a person", () => {
    const verdict = evaluateChange("merge_seo_scope", [{ path: "src/app/layout.tsx", category: "head_metadata" }, { path: "package.json", category: "head_metadata" }, { path: "src/lib/x.ts", category: "other" }], "passed");
    expect(verdict.decision).toBe("pr_only");
    expect(verdict.outOfScope.map((o) => o.path)).toEqual(["package.json", "src/lib/x.ts"]);
    expect(evaluateChange("merge_seo_scope", [{ path: "next.config.mjs", category: "seo_redirect" }], "passed").decision).toBe("merge");
    expect(evaluateChange("merge_seo_scope", [{ path: "next.config.mjs", category: "head_metadata" }], "passed").decision).toBe("pr_only");
    expect(evaluateChange("full", [{ path: "src/lib/x.ts", category: "other" }], "passed").decision).toBe("merge");
    expect(evaluateChange("full", [{ path: ".env.production", category: "other" }], "passed").decision).toBe("pr_only");
  });

  it("recognises code tasks and GitHub repos", () => {
    expect(isCodeTask({ taskType: "schema-add" })).toBe(true);
    expect(isCodeTask({ taskType: "keyword-discover" })).toBe(false);
    expect(isCodeTask({ taskType: "custom", title: "Fix broken WebSite SearchAction", source: "manual" })).toBe(true);
    expect(githubRepo("https://github.com/Partners-in-Biz/partnersinbiz-web.git")).toEqual({ owner: "Partners-in-Biz", repo: "partnersinbiz-web" });
  });
});

describe("code tasks in the site project", () => {
  const mc = (host: ReturnType<typeof fakeHost>, info: Awaited<ReturnType<typeof companyInfo>>, sprint: Awaited<ReturnType<typeof import("../src/db.js").getSprint>>): MaterialiseContext => ({ info, sprint: sprint!, day: 0, agent: { id: "agent-1", status: "active" }, projectId: "seo-proj" });

  it("opens a code task in the linked site project, still under the sprint root", async () => {
    const host = fakeHost({ sprint: { site_access: "repo", site_project_id: "site-proj", repo_url: "https://github.com/Partners-in-Biz/partnersinbiz-web", hosting: "vercel" }, tasks: [taskRow()] });
    const db = await import("../src/db.js");
    const info = await companyInfo(host.env, "co-1");
    const sprint = await db.getSprint(host.env.ctx.db, "co-1", "sp-1");
    const task = (await db.getTask(host.env.ctx.db, "co-1", "t-1"))!;
    const issueId = await createTaskIssue(host.env, mc(host, info, sprint), task);
    expect(issueId).toBe("new-1");
    expect(host.issuesCreated[0]).toMatchObject({ projectId: "site-proj", parentId: "root-1", assigneeAgentId: "agent-1" });
    expect(String(host.issuesCreated[0]!.description)).toContain("seo/w0-meta-tags");
    expect(String(host.issuesCreated[0]!.description)).toContain("check-change-scope");
    expect(host.tasks.get("t-1")).toMatchObject({ issue_id: "new-1", issue_project_id: "site-proj" });
  });

  it("puts code tasks on Needs you (one item) while no site repo is linked", async () => {
    const host = fakeHost({ tasks: [taskRow(), taskRow({ id: "t-2", template_key: "w0-schema", task_type: "schema-add", title: "Add schema" })] });
    const db = await import("../src/db.js");
    const info = await companyInfo(host.env, "co-1");
    const sprint = await db.getSprint(host.env.ctx.db, "co-1", "sp-1");
    for (const id of ["t-1", "t-2"]) expect(await createTaskIssue(host.env, mc(host, info, sprint), (await db.getTask(host.env.ctx.db, "co-1", id))!)).toBeNull();
    expect(host.digests).toHaveLength(1);
    const items = host.digests[0]!.items as Array<Row>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "site_project", check: "site_project", taskIds: ["t-1", "t-2"] });
    // One digest issue, for the owner; the second task updates it.
    expect(host.issuesCreated).toHaveLength(1);
    expect(host.issuesCreated[0]).toMatchObject({ assigneeUserId: "user-1", title: expect.stringContaining("Needs you") });
  });

  it("linking the site project resolves the item and opens the waiting tasks there", async () => {
    const host = fakeHost({ tasks: [taskRow()] });
    const db = await import("../src/db.js");
    const info = await companyInfo(host.env, "co-1");
    await createTaskIssue(host.env, mc(host, info, await db.getSprint(host.env.ctx.db, "co-1", "sp-1")), (await db.getTask(host.env.ctx.db, "co-1", "t-1"))!);
    const result = await linkSiteTool(host.env, "co-1", { kind: "user", userId: "user-1" }, { sprintId: "sp-1", projectId: "site-proj", hosting: "vercel" });
    expect(result).toMatchObject({ siteAccess: "repo", siteProjectId: "site-proj", repoUrl: "https://github.com/Partners-in-Biz/partnersinbiz-web", needsYouResolved: true, issuesOpened: 1 });
    expect(host.issuesCreated.find((i) => i.projectId === "site-proj")).toBeDefined();
    expect((host.digests[0]!.items as Array<Row>)[0]!.status).toBe("done");
  });

  it("an agent cannot raise the change policy", async () => {
    const host = fakeHost({ sprint: { change_policy: "pr_only" } });
    await expect(linkSiteTool(host.env, "co-1", agentActor, { sprintId: "sp-1", changePolicy: "full" })).rejects.toThrow(/lower/);
  });
});

describe("plan upgrade to v3", () => {
  it("moves open person tasks to the agent, retries blocked agent tasks, keeps done ones", async () => {
    const host = fakeHost({
      tasks: [
        taskRow({ id: "h-1", template_key: "w0-gsc-verify", task_type: "gsc-verify", owner: "human", autopilot_eligible: false, title: "Verify site in Google Search Console", playbook_key: "w0-gsc-verify", issue_id: "iss-h1", issue_status: "todo", assignee_kind: "user" }),
        taskRow({ id: "h-2", template_key: "w0-bing-verify", task_type: "bing-verify", owner: "human", status: "done", issue_id: "iss-h2", issue_status: "done" }),
        taskRow({ id: "a-1", status: "blocked", issue_id: "iss-a1", issue_status: "blocked", assignee_kind: "user" }),
        taskRow({ id: "m-1", template_key: null, source: "manual", task_type: "custom", owner: "human", title: "Fix broken WebSite SearchAction", issue_id: null }),
      ],
    });
    const db = await import("../src/db.js");
    const info = await companyInfo(host.env, "co-1");
    const sprint = (await db.getSprint(host.env.ctx.db, "co-1", "sp-1"))!;
    const result = await upgradeSprintPlan(host.env, info, sprint, { id: "agent-1", status: "active" });
    expect(result).toMatchObject({ upgraded: true, rewritten: 2, reassigned: 2, retried: 1 });
    const h1 = host.issueUpdates.find((u) => u.id === "iss-h1")!.patch;
    expect(h1).toMatchObject({ status: "todo", assigneeAgentId: "agent-1", assigneeUserId: null });
    expect(String(h1.title)).toContain("service account");
    expect(String(h1.description)).toContain("gsc-verification-token");
    expect(host.tasks.get("h-1")).toMatchObject({ owner: "agent", autopilot_eligible: true });
    expect(host.tasks.get("m-1")).toMatchObject({ owner: "agent" });
    expect(host.issueUpdates.some((u) => u.id === "iss-h2")).toBe(false);
    expect(host.issueUpdates.find((u) => u.id === "iss-a1")!.patch).toMatchObject({ status: "todo", assigneeAgentId: "agent-1" });
    expect(host.wakeups.sort()).toEqual(["iss-a1", "iss-h1"]);
    expect(host.sprint.template_version).toBe(3);
    expect(host.comments.find((c) => c.id === "root-1")!.body).toContain("Needs you");
    // Idempotent: a v3 sprint is left alone.
    expect((await upgradeSprintPlan(host.env, info, { ...sprint, templateVersion: 3 }, { id: "agent-1", status: "active" })).upgraded).toBe(false);
  });

  it("leaves done and sign-off tasks alone", () => {
    const base = { templateKey: "w0-gsc-verify", taskType: "gsc-verify", owner: "human" } as unknown as SprintTask;
    expect(v3Target({ ...base, status: "done" })).toBeNull();
    expect(v3Target({ ...base, status: "not_started" })).toMatchObject({ owner: "agent", autopilotEligible: true });
  });
});

describe("Needs you digest", () => {
  const item = (key: string, extra: Partial<NewNeedsYouItem> = {}): NewNeedsYouItem => ({ key, kind: "grant", title: key, why: "w", steps: [], links: [], after: "a", check: "manual", ...extra });

  it("dedupes by key and merges task ids", () => {
    const a = mergeItem([], item("k", { taskIds: ["t1"] }), "2026-09-26T08:00:00Z");
    const b = mergeItem(a.items, item("k", { taskIds: ["t2"] }), "2026-09-26T09:00:00Z");
    expect(b.items).toHaveLength(1);
    expect(b.items[0]!.taskIds).toEqual(["t1", "t2"]);
    const done = resolveItem(b.items, "k", "Peet", "2026-09-27T08:00:00Z").items;
    expect(mergeItem(done, item("k"), "x").changed).toBe(false);
    expect(mergeItem(done, item("k"), "x", { reopen: true }).items[0]!.status).toBe("open");
    expect(carryOver(done, []).length).toBe(0);
    expect(weekStart("2026-09-26")).toBe("2026-09-21");
    expect(weekStart("2026-09-21")).toBe("2026-09-21");
    expect(weekStart("2026-09-27")).toBe("2026-09-21");
  });

  it("renders steps, copy and what the agent does next", () => {
    const text = needsYouDescription({ id: "sp-1", siteName: "PiB", siteUrl: "https://x", clientName: null, autopilotMode: "safe" }, mergeItem([], item("gsc_access", { copy: "Hi there", steps: ["Send it"], links: [{ label: "Users", url: "https://u" }] }), "t").items, { week: "2026-09-21", cockpitPath: "/PIB/seo?sprint=sp-1" });
    expect(text).toContain("### 1. gsc_access");
    expect(text).toContain("```text\nHi there\n```");
    expect(text).toContain("[Users](https://u)");
    expect(text).toContain("**Then the agent:** a");
  });

  it("one issue per sprint per week: the second item updates it, a new week carries open items over", async () => {
    const host = fakeHost({});
    const db = await import("../src/db.js");
    const info = await companyInfo(host.env, "co-1");
    const sprint = (await db.getSprint(host.env.ctx.db, "co-1", "sp-1"))!;
    await addNeedsYou(host.env, info, sprint, item("a"));
    await addNeedsYou(host.env, info, sprint, item("b"));
    await addNeedsYou(host.env, info, sprint, item("a"));
    expect(host.issuesCreated).toHaveLength(1);
    expect(host.digests).toHaveLength(1);
    expect((host.digests[0]!.items as Row[]).map((i) => i.key)).toEqual(["a", "b"]);
    expect(host.issueUpdates.some((u) => u.id === "new-1" && String(u.patch.description).includes("### 2. b"))).toBe(true);
    // Next week: a new issue with the open items; last week's issue closes.
    const nextWeek = { ...info, today: "2026-09-29" };
    await addNeedsYou(host.env, nextWeek, sprint, item("c"));
    expect(host.digests).toHaveLength(2);
    expect((host.digests[1]!.items as Row[]).map((i) => i.key)).toEqual(["a", "b", "c"]);
    expect(host.issueUpdates.find((u) => u.id === "new-1" && u.patch.status === "done")).toBeDefined();
    expect(host.issuesCreated).toHaveLength(2);
  });

  it("the daily re-check rolls open items into a new weekly issue and closes items it can see done", async () => {
    const host = fakeHost({ config: SA_CONFIG });
    const db = await import("../src/db.js");
    const info = await companyInfo(host.env, "co-1");
    const sprint = (await db.getSprint(host.env.ctx.db, "co-1", "sp-1"))!;
    await addNeedsYou(host.env, info, sprint, item("service_account", { check: "service_account" }));
    await addNeedsYou(host.env, info, sprint, item("dm", { kind: "message" }));
    const resolved = await recheckNeedsYou(host.env, { ...info, today: "2026-09-29" }, sprint);
    expect(resolved).toBe(1); // the key is configured now
    expect(host.digests).toHaveLength(2);
    const next = host.digests[1]!.items as Row[];
    expect(next.map((i) => [i.key, i.status])).toEqual([["service_account", "done"], ["dm", "open"]]);
    expect(host.issuesCreated).toHaveLength(2);
    expect(String(host.issuesCreated[1]!.title)).toContain("week of 2026-09-28");
  });

  it("resolving an item hands blocked tasks back to the agent and closes the issue when empty", async () => {
    const host = fakeHost({ tasks: [taskRow({ id: "b-1", status: "blocked", issue_id: "iss-b1", issue_status: "blocked", assignee_kind: "agent" })] });
    const db = await import("../src/db.js");
    const info = await companyInfo(host.env, "co-1");
    const sprint = (await db.getSprint(host.env.ctx.db, "co-1", "sp-1"))!;
    await blockTask(host.env, "co-1", agentActor, { taskId: "b-1", reason: "DNS needed", humanAsk: "Add the TXT record" });
    // A blocked task stays with the agent; the ask is on Needs you.
    expect(host.issueUpdates.find((u) => u.id === "iss-b1")!.patch).toEqual({ status: "blocked" });
    const r = await resolveNeedsYou(host.env, info, sprint, "task:b-1", "Peet");
    expect(r).toMatchObject({ resolved: true, tasksContinued: 1 });
    expect(host.issueUpdates.filter((u) => u.id === "iss-b1").pop()!.patch).toMatchObject({ status: "todo", assigneeAgentId: "agent-1" });
    expect(host.wakeups).toContain("iss-b1");
    expect(host.issueUpdates.find((u) => u.id === "new-1" && u.patch.status === "done")).toBeDefined();
  });

  it("does not resolve a checkable item the plugin still sees open", async () => {
    const host = fakeHost({});
    const db = await import("../src/db.js");
    const info = await companyInfo(host.env, "co-1");
    const sprint = (await db.getSprint(host.env.ctx.db, "co-1", "sp-1"))!;
    await addNeedsYou(host.env, info, sprint, item("site_project", { check: "site_project" }));
    const r = await resolveNeedsYou(host.env, info, sprint, "site_project", "Peet");
    expect(r.resolved).toBe(false);
    expect(r.stillOpen).toMatch(/does not see/);
  });

  it("writes the client access email with the service account and the Users link", () => {
    const text = clientAccessEmail({ clientName: "Acme", siteUrl: "https://acme.co.za", serviceAccountEmail: SA_EMAIL, property: "sc-domain:acme.co.za" });
    expect(text).toContain(SA_EMAIL);
    expect(text).toContain("https://search.google.com/search-console/users?resource_id=sc-domain%3Aacme.co.za");
  });
});

describe("setup checklist", () => {
  const facts = (extra: Partial<SetupFacts> = {}): SetupFacts => ({
    prefix: "PIB",
    settingsPath: "/PIB/company/settings/instance/plugins/abc",
    settingsSaved: true,
    serviceAccount: { configured: false, email: null, error: null },
    agent: null,
    pagespeedKey: false,
    bingKey: false,
    ...extra,
  });

  it("shows what is missing with links and the agent's next step", () => {
    const items = buildSetupChecklist(facts());
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(byKey.settings!.status).toBe("done");
    expect(byKey.service_account!.status).toBe("todo");
    expect(byKey.service_account!.links.map((l) => l.url)).toContain("https://console.cloud.google.com/iam-admin/serviceaccounts?project=partners-in-biz-85059");
    expect(byKey.service_account!.links.map((l) => l.url)).toContain("https://console.cloud.google.com/apis/library/siteverification.googleapis.com?project=partners-in-biz-85059");
    expect(byKey.service_account!.steps).toHaveLength(5);
    expect(byKey.github_token!.status).toBe("unknown");
    expect(byKey.github_token!.steps.join(" ")).toContain("GITHUB_TOKEN");
    expect(byKey.agent!.status).toBe("todo");
    expect(byKey.bing_key!.status).toBe("todo");
    expect(byKey.site_project).toBeUndefined();
  });

  it("covers the sprint: repo link, property, Bing, autopilot", () => {
    const sprint = { siteName: "PiB", siteUrl: "https://partnersinbiz.online", isClient: false, siteAccess: "repo", siteProjectId: "p1", repoUrl: "https://github.com/a/b", changePolicy: "merge_seo_scope", autopilotMode: "safe", property: "https://partnersinbiz.online/", gscVia: "service_account" as const, bingVerified: false };
    const items = buildSetupChecklist(facts({ serviceAccount: { configured: true, email: SA_EMAIL, error: null }, agent: { id: "a1", status: "active" }, bingKey: true, sprint }));
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(byKey.service_account!.status).toBe("done");
    expect(byKey.agent!.status).toBe("done");
    expect(byKey.site_project!.status).toBe("done");
    expect(byKey.gsc_property!.status).toBe("done");
    expect(byKey.bing_site!.status).toBe("todo");
    expect(byKey.autopilot!.status).toBe("done");
    const unlinked = buildSetupChecklist(facts({ sprint: { ...sprint, siteAccess: "unlinked", siteProjectId: null, property: null, autopilotMode: "off" } }));
    expect(unlinked.find((i) => i.key === "site_project")!.status).toBe("todo");
    expect(unlinked.find((i) => i.key === "site_project")!.links[0]!.url).toBe("/PIB/projects");
    expect(unlinked.find((i) => i.key === "autopilot")!.status).toBe("todo");
  });
});

describe("tool results are always objects", () => {
  it("wraps arrays and scalars", () => {
    expect(toToolData([1, 2])).toEqual({ items: [1, 2], count: 2 });
    expect(toToolData(null)).toEqual({ ok: true });
    expect(toToolData("x")).toEqual({ value: "x" });
  });

  it("returns an object for successes and for errors", async () => {
    const harness = createTestHarness({ manifest, config: { timezone: "Africa/Johannesburg" } });
    harness.seed({ companies: [{ id: "co-1", issuePrefix: "PIB", name: "PiB" } as never] });
    await plugin.definition.setup(harness.ctx);
    const ok = await harness.executeTool<{ data?: unknown; error?: string }>("list-sprints", {}, { companyId: "co-1" });
    expect(ok.data).toBeTypeOf("object");
    expect(ok.data).not.toBeNull();
    const failed = await harness.executeTool<{ data?: Record<string, unknown>; error?: string; content?: string }>("get-sprint", { sprintId: "missing" }, { companyId: "co-1" });
    expect(failed.error).toMatch(/not found/);
    expect(failed.data).toEqual({ ok: false, error: failed.error });
    for (const name of ["setup-checklist", "check-change-scope", "needs-you", "gsc-verify-site", "request-indexing", "link-site"]) {
      const result = await harness.executeTool<{ data?: unknown }>(name, {}, { companyId: "co-1" });
      expect(result.data, name).toBeTypeOf("object");
      expect(result.data, name).not.toBeNull();
    }
  });
});
