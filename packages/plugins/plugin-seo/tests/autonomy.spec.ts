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
import { checkChangeScopeTool, getSiteLinkTool, linkSiteTool } from "../src/service/site.js";
import { needsYouAddTool } from "../src/service/needs-you.js";
import { autoLinkWordPressSite, setVerifyFailure } from "../src/service/wordpress.js";
import { verificationKindOf, verifyRouteOf, versionAtLeast } from "../src/engine/verify-route.js";
import { indexNowKeyTool, bingAddSiteTool, requestIndexingTool } from "../src/service/indexing.js";
import { evaluateWordPressChange, SEO_SCOPE_CATEGORIES, WORDPRESS_SCOPE_CATEGORIES } from "../src/engine/site-change.js";
import { wpConnectorItem } from "../src/engine/items.js";
import { siteSection } from "../src/engine/copy.js";
import { registerCrmSiteProjection } from "@partnersinbiz/pib-plugin-kit";
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
function fakeHost(opts: { sprint?: Row; tasks?: Row[]; integration?: Row; config?: Row; sites?: Row[]; fetch?: (url: string, init?: RequestInit) => Promise<Response> } = {}) {
  const sprint: Row = { ...SPRINT, ...(opts.sprint ?? {}) };
  // CRM website projection rows (crm_sites).
  const sites: Row[] = (opts.sites ?? []).map((site) => ({ ...site }));
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
        if (/FROM plugin_seo_8099f8879a\.crm_sites WHERE company_id = \$1 AND id = \$2/.test(sql)) return sites.filter((x) => x.company_id === params[0] && x.id === params[1] && !x.deleted);
        if (/FROM plugin_seo_8099f8879a\.crm_sites/.test(sql)) return sites.filter((x) => x.company_id === params[0] && x.client_kind === params[1] && x.client_ref === params[2] && !x.deleted);
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
  return { env, ctx, sprint, sites, tasks, integration, digests, issuesCreated, issueUpdates, comments, executes, wakeups, fetch: fetchImpl };
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
    expect(host.issuesCreated[0]).toMatchObject({ projectId: "site-proj", parentId: "root-1", assigneeAgentId: "agent-1", originKind: "plugin:partnersinbiz.seo:task", originId: "seo:task:t-1" });
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
    expect(host.sprint.template_version).toBe(4);
    expect(host.comments.find((c) => c.id === "root-1")!.body).toContain("Needs you");
    // Idempotent: a sprint on the current plan is left alone.
    expect((await upgradeSprintPlan(host.env, info, { ...sprint, templateVersion: 4 }, { id: "agent-1", status: "active" })).upgraded).toBe(false);
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

describe("Cockpit Reviewer routing (sign-offs and out-of-scope PRs)", () => {
  const ROLES = { companyId: "co-1", operatorAgentId: null, reviewerAgentId: "rev-1", ownerUserId: "user-1", reviewOutward: true, updatedAt: "2026-09-26T00:00:00Z" };
  function withReviewer(host: ReturnType<typeof fakeHost>, roles: Row | null = ROLES) {
    (host.ctx.state.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: { namespace?: string; stateKey: string }) => {
      if (key.namespace === "pib-cockpit" && key.stateKey === "roles") return roles;
      if (key.stateKey === "plugin-ui-base") return "/_plugins/051bbf0b-aeb5-42d7-b0b6-c4cabd271cdc/ui/";
      return key.stateKey.startsWith("role:") ? { agentId: "agent-1" } : null;
    });
  }
  const signoffTask = () => taskRow({ id: "s-1", title: "Publish post 1 — comparison format", task_type: "post-publish", autopilot_eligible: false, status: "in_progress", issue_id: "iss-s1", issue_status: "in_progress", assignee_kind: "agent" });

  it("without a Reviewer a sign-off goes straight to the owner (unchanged)", async () => {
    const host = fakeHost({ tasks: [signoffTask()] });
    const result = await blockTask(host.env, "co-1", agentActor, { taskId: "s-1", reason: "Ready to publish", humanAsk: "Approve the post", review: true, links: ["https://github.com/pib/site/pull/7"] });
    expect(host.issueUpdates.find((u) => u.id === "iss-s1")!.patch).toEqual({ status: "in_review", assigneeAgentId: null, assigneeUserId: "user-1" });
    expect(result.handedTo).toBe("sprint owner");
    expect(host.comments.some((c) => c.body.includes("## Reviewer"))).toBe(false);
  });

  it("with a Reviewer the sign-off goes to the Reviewer with the checks, handing it to the owner", async () => {
    const host = fakeHost({ tasks: [signoffTask()] });
    withReviewer(host);
    const result = await blockTask(host.env, "co-1", agentActor, { taskId: "s-1", reason: "Ready to publish", humanAsk: "Approve the post", review: true, links: ["https://github.com/pib/site/pull/7"] });
    expect(host.issueUpdates.find((u) => u.id === "iss-s1")!.patch).toEqual({ status: "in_review", assigneeAgentId: "rev-1", assigneeUserId: null });
    expect(result.handedTo).toBe("the Reviewer, then the sprint owner");
    const brief = host.comments.find((c) => c.id === "iss-s1" && c.body.includes("## Reviewer"))!.body;
    for (const check of ["allowed SEO scope", "Preview and CI checks passed", "Copy is accurate", "No pricing, legal"]) expect(brief).toContain(check);
    expect(brief).toContain("reassign this issue to user `user-1` (the sprint owner)");
    expect(brief).toContain("The owner approves it by marking the issue done");
    expect(host.wakeups).toContain("iss-s1");
    expect(host.tasks.get("s-1")!.assignee_kind).toBe("reviewer");
  });

  it("a blocked (not sign-off) task never goes to the Reviewer", async () => {
    const host = fakeHost({ tasks: [signoffTask()] });
    withReviewer(host);
    await blockTask(host.env, "co-1", agentActor, { taskId: "s-1", reason: "DNS", humanAsk: "Add the TXT record" });
    expect(host.issueUpdates.find((u) => u.id === "iss-s1")!.patch).toEqual({ status: "blocked" });
  });

  it("an out-of-scope PR on Needs you opens one review issue for the Reviewer", async () => {
    const { needsYouAddTool } = await import("../src/service/needs-you.js");
    const host = fakeHost({});
    withReviewer(host);
    const params = { sprintId: "sp-1", kind: "pr", title: "Merge PR #12 (touches pricing page)", why: "The PR changes app/pricing, which is outside SEO scope.", after: "Re-checks production.", links: ["PR #12 | https://github.com/pib/site/pull/12"], steps: ["Review and merge PR #12"] };
    const first = await needsYouAddTool(host.env, "co-1", agentActor, params);
    expect((first as { reviewIssueId?: string }).reviewIssueId).toBeDefined();
    const review = host.issuesCreated.find((i) => String(i.originId).startsWith("review:sp-1:"))!;
    expect(review).toMatchObject({ assigneeAgentId: "rev-1", status: "todo", parentId: "root-1" });
    expect(String(review.title)).toBe("Review PR before the owner merges: Merge PR #12 (touches pricing page)");
    expect(String(review.description)).toContain("Closing this issue approves nothing");
    expect(String(review.description)).toContain("https://github.com/pib/site/pull/12");
    // Added again (same key): no second review issue.
    await needsYouAddTool(host.env, "co-1", agentActor, params);
    expect(host.issuesCreated.filter((i) => String(i.originId).startsWith("review:"))).toHaveLength(1);
  });

  it("no Reviewer: an out-of-scope PR only lands on Needs you", async () => {
    const { needsYouAddTool } = await import("../src/service/needs-you.js");
    const host = fakeHost({});
    const result = await needsYouAddTool(host.env, "co-1", agentActor, { sprintId: "sp-1", kind: "pr", title: "Merge PR #13", why: "Out of scope", after: "Carries on." });
    expect((result as { reviewIssueId?: string }).reviewIssueId).toBeUndefined();
    expect(host.issuesCreated.every((i) => !String(i.originId).startsWith("review:"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 0.10.0: WordPress sites through the PiB Connector
// ---------------------------------------------------------------------------

const CLIENT_SPRINT: Row = { client_kind: "company", client_ref: "crm-1", client_name: "Hunt and Gun", site_url: "https://huntandgun.co.za", site_name: "Hunt and Gun", seeded_at: null, root_issue_id: null };

function siteRow(extra: Row = {}): Row {
  return {
    id: "site-1", company_id: "co-1", client_kind: "company", client_ref: "crm-1", label: "Main site", url: "https://www.huntandgun.co.za",
    platform: "wordpress", seo_plugin: "yoast", hosting: "xneelo", access: ["connector"], project_id: null,
    connector_status: "connected", connector_version: "1.0.0", connector_seen_at: "2026-09-26T07:00:00Z", deleted: false, ...extra,
  };
}

const person: Actor = { kind: "user", userId: "user-1" };

describe("link-site: wordpress mode", () => {
  it("refuses PiB's own sprints, other clients' sites, non-WordPress sites and unknown sites", async () => {
    const own = fakeHost({ sites: [siteRow()] });
    await expect(linkSiteTool(own.env, "co-1", person, { sprintId: "sp-1", wordpressSiteId: "site-1" })).rejects.toThrow(/own sprints/);
    const other = fakeHost({ sprint: CLIENT_SPRINT, sites: [siteRow({ client_ref: "crm-2" })] });
    await expect(linkSiteTool(other.env, "co-1", person, { sprintId: "sp-1", wordpressSiteId: "site-1" })).rejects.toThrow(/different CRM client/);
    const contact = fakeHost({ sprint: CLIENT_SPRINT, sites: [siteRow({ client_kind: "contact" })] });
    await expect(linkSiteTool(contact.env, "co-1", person, { sprintId: "sp-1", wordpressSiteId: "site-1" })).rejects.toThrow(/different CRM client/);
    const next = fakeHost({ sprint: CLIENT_SPRINT, sites: [siteRow({ platform: "nextjs" })] });
    await expect(linkSiteTool(next.env, "co-1", person, { sprintId: "sp-1", wordpressSiteId: "site-1" })).rejects.toThrow(/not a WordPress site/);
    const missing = fakeHost({ sprint: CLIENT_SPRINT, sites: [siteRow({ deleted: true })] });
    await expect(linkSiteTool(missing.env, "co-1", person, { sprintId: "sp-1", wordpressSiteId: "site-1" })).rejects.toThrow(/not found in the CRM/);
    expect(other.sprint.site_access).toBe("unlinked");
  });

  it("links a connected site: wordpress mode, site id, no repo, hosting other", async () => {
    const host = fakeHost({ sprint: { ...CLIENT_SPRINT, site_access: "repo", site_project_id: "site-proj", repo_url: "https://github.com/a/b" }, sites: [siteRow()] });
    const result = await linkSiteTool(host.env, "co-1", person, { sprintId: "sp-1", wordpressSiteId: "site-1" });
    expect(host.sprint).toMatchObject({ site_access: "wordpress", site_id: "site-1", site_project_id: null, repo_url: null, hosting: "other" });
    expect(result).toMatchObject({ siteAccess: "wordpress", siteId: "site-1", siteProjectId: null, repoUrl: null, warnings: [] });
    expect(result.site).toMatchObject({ siteId: "site-1", url: "https://www.huntandgun.co.za", seoPlugin: "yoast", connected: true, summary: "WordPress · Yoast SEO · Connector connected" });
    expect(host.digests).toHaveLength(0);
    // Another mode clears the site id.
    await linkSiteTool(host.env, "co-1", person, { sprintId: "sp-1", noRepo: true });
    expect(host.sprint).toMatchObject({ site_access: "none", site_id: null });
  });

  it("puts wp_connector on Needs you when the Connector is not connected, and the daily check closes it", async () => {
    const host = fakeHost({ sprint: CLIENT_SPRINT, sites: [siteRow({ connector_status: "pending", access: ["connector"] })] });
    const result = await linkSiteTool(host.env, "co-1", person, { sprintId: "sp-1", wordpressSiteId: "site-1" });
    expect(result.warnings.join(" ")).toMatch(/CRM client page → Websites/);
    expect(result.site?.summary).toBe("WordPress · Yoast SEO · Connector: waiting for the key");
    const items = host.digests[0]!.items as Row[];
    expect(items.map((i) => [i.key, i.check, i.status])).toEqual([["wp_connector", "wp_connector", "open"]]);
    expect((items[0]!.steps as string[]).join(" ")).toContain("CRM → Hunt and Gun → **Websites**");
    expect(items[0]!.links).toEqual([{ label: "CRM client → Websites", url: "/PIB/crm?client=company:crm-1" }]);

    const db = await import("../src/db.js");
    const info = await companyInfo(host.env, "co-1");
    const sprint = (await db.getSprint(host.env.ctx.db, "co-1", "sp-1"))!;
    expect(await recheckNeedsYou(host.env, info, sprint)).toBe(0);
    host.sites[0]!.connector_status = "connected";
    expect(await recheckNeedsYou(host.env, info, sprint)).toBe(1);
    expect((host.digests[0]!.items as Row[])[0]!.status).toBe("done");
  });

  it("closes a task hand-off line when its task is later finished by the agent, and keeps it while the task is open", async () => {
    // AHS Law: the agent handed PAR-91 to a person, then completed it itself; the line stayed open for days.
    const host = fakeHost({ sprint: CLIENT_SPRINT, tasks: [taskRow({ id: "t-open", status: "blocked" }), taskRow({ id: "t-fin", status: "done" })] });
    const info = await companyInfo(host.env, "co-1");
    const db = await import("../src/db.js");
    const sprint = (await db.getSprint(host.env.ctx.db, "co-1", "sp-1"))!;
    for (const id of ["t-open", "t-fin"]) {
      await addNeedsYou(host.env, info, sprint, { key: `task:${id}`, kind: "task", title: `Task ${id}`, why: "w", steps: [], links: [], after: "a", check: "manual", taskIds: [id] });
    }
    // A custom-keyed ask that names a finished task is still a real ask for a person.
    await addNeedsYou(host.env, info, sprint, { key: "par131-duplicate-og-plugin", kind: "task", title: "Deactivate a plugin", why: "w", steps: [], links: [], after: "a", check: "manual", taskIds: ["t-fin"] });
    // A plain manual item without tasks is never auto-closed.
    await addNeedsYou(host.env, info, sprint, { key: "gbp_claim", kind: "grant", title: "Claim the profile", why: "w", steps: [], links: [], after: "a", check: "manual" });
    expect(await recheckNeedsYou(host.env, info, sprint)).toBe(1);
    const items = host.digests[host.digests.length - 1]!.items as Row[];
    expect(items.map((i) => [i.key, i.status])).toEqual([["task:t-open", "open"], ["task:t-fin", "done"], ["par131-duplicate-og-plugin", "open"], ["gbp_claim", "open"]]);
    expect(String(items[1]!.note)).toMatch(/task is done or skipped/);
  });

  it("get-site-link explains the Connector flow by change policy", async () => {
    const host = fakeHost({ sprint: { ...CLIENT_SPRINT, site_access: "wordpress", site_id: "site-1" }, sites: [siteRow()] });
    const link = await getSiteLinkTool(host.env, "co-1", { sprintId: "sp-1" });
    for (const tool of ["wp-seo", "wp-schema", "wp-redirects", "wp-robots", "wp-sitemap", "wp-health", "wp-log", "wp-undo", "wp-plugins", "wp-media", "wp-content", "wp-connector"]) expect(link.next).toContain(`partnersinbiz.crm:${tool}`);
    expect(link.next).toMatch(/run `wp-connector` update before you park the task on Needs you|run wp-connector update|`wp-connector` update before you park/);
    expect(link.next).toContain('siteId "site-1"');
    expect(link.next).toMatch(/apply SEO fields, schema, redirects/);
    expect(link.site?.connected).toBe(true);
    const prOnly = fakeHost({ sprint: { ...CLIENT_SPRINT, site_access: "wordpress", site_id: "site-1", change_policy: "pr_only" }, sites: [siteRow({ connector_status: "none" })] });
    const next = (await getSiteLinkTool(prOnly.env, "co-1", { sprintId: "sp-1" })).next;
    expect(next).toMatch(/key wp_connector, then block-task/);
    expect(next).toMatch(/Needs you \(needs-you-add kind task/);
  });

  it("needs-you-add wp_connector writes the standard item; refused on a sprint without WordPress", async () => {
    const host = fakeHost({ sprint: { ...CLIENT_SPRINT, site_access: "wordpress", site_id: "site-1" }, sites: [siteRow({ connector_status: "error" })], tasks: [taskRow()] });
    const added = await needsYouAddTool(host.env, "co-1", agentActor, { sprintId: "sp-1", key: "wp_connector", taskIds: ["t-1"] });
    expect(added).toMatchObject({ added: true, standard: true, key: "wp_connector" });
    expect((host.digests[0]!.items as Row[])[0]).toMatchObject({ key: "wp_connector", kind: "grant", check: "wp_connector", taskIds: ["t-1"] });
    const repo = fakeHost({ sprint: CLIENT_SPRINT });
    await expect(needsYouAddTool(repo.env, "co-1", agentActor, { sprintId: "sp-1", key: "wp_connector" })).rejects.toThrow(/WordPress site/);
  });

  it("auto-links only the one connected WordPress site at the sprint URL", async () => {
    const db = await import("../src/db.js");
    const pick = async (sites: Row[]) => {
      const host = fakeHost({ sprint: CLIENT_SPRINT, sites });
      return autoLinkWordPressSite(host.env, (await db.getSprint(host.env.ctx.db, "co-1", "sp-1"))!);
    };
    expect((await pick([siteRow()]))?.id).toBe("site-1");
    expect(await pick([siteRow({ connector_status: "pending" })])).toBeNull();
    expect(await pick([siteRow({ url: "https://shop.example.com" })])).toBeNull();
    expect(await pick([siteRow(), siteRow({ id: "site-2", url: "https://huntandgun.co.za/shop" })])).toBeNull();
    expect((await pick([siteRow(), siteRow({ id: "site-2", platform: "nextjs", url: "https://huntandgun.co.za" })]))?.id).toBe("site-1");
    const own = fakeHost({ sites: [siteRow({ url: "https://partnersinbiz.online" })] });
    expect(await autoLinkWordPressSite(own.env, (await db.getSprint(own.env.ctx.db, "co-1", "sp-1"))!)).toBeNull();
  });
});

describe("check-change-scope: wordpress", () => {
  const seo = [{ path: "wp:seo:/about", category: "head_metadata" }, { path: "wp:schema:site/localbusiness", category: "json_ld" }, { path: "wp:redirects:/old", category: "seo_redirect" }, { path: "wp:robots", category: "sitemap_robots" }];

  it("applies SEO scope under merge_seo_scope and full, hands everything else to a person", () => {
    expect(evaluateWordPressChange("merge_seo_scope", seo)).toMatchObject({ decision: "apply", verdict: "apply", siteAccess: "wordpress", inScope: true });
    expect(evaluateWordPressChange("full", seo).decision).toBe("apply");
    expect(evaluateWordPressChange("pr_only", seo)).toMatchObject({ decision: "pr_only", inScope: true });
    // 0.11.0: alt text, images, page copy and new draft pages are the agent's now.
    const wider = [
      ...seo,
      { path: "wp:images:/about", category: "image_alt" },
      { path: "wp:media:/about", category: "media" },
      { path: "wp:content:/about", category: "page_copy" },
      { path: "wp:content:/about", category: "internal_links" },
      { path: "wp:page:/new-service", category: "new_content" },
    ];
    expect(evaluateWordPressChange("merge_seo_scope", wider)).toMatchObject({ decision: "apply", inScope: true, outOfScope: [] });
    expect(evaluateWordPressChange("pr_only", wider).decision).toBe("pr_only");
    for (const category of ["image_alt", "internal_links", "new_content", "page_copy", "media"]) expect(WORDPRESS_SCOPE_CATEGORIES).toContain(category);
    // Repo sprints keep their own scope.
    expect(SEO_SCOPE_CATEGORIES).not.toContain("page_copy");
    expect(SEO_SCOPE_CATEGORIES).not.toContain("media");
    // Still a person, whatever the policy.
    for (const [path, reason] of [
      ["wp:plugins:hunt-auctions", /plugin installs and rollbacks/],
      ["wp:delete:/old-page", /deleting anything/],
      ["wp:publish-existing:/about", /Connector did not create/],
      ["wp:theme:functions", /theme changes go to a person/],
      ["wp:settings:blogname", /settings and users/],
    ] as const) {
      const verdict = evaluateWordPressChange("full", [{ path, category: "page_copy" }]);
      expect(verdict.decision, path).toBe("pr_only");
      expect(verdict.outOfScope[0]!.reason, path).toMatch(reason);
    }
    const unknown = evaluateWordPressChange("merge_seo_scope", [{ path: "wp:menus", category: "other" }]);
    expect(unknown.decision).toBe("pr_only");
    expect(unknown.outOfScope[0]!.reason).toMatch(/ask for the asset, not for a wp-admin edit/);
    const plugin = evaluateWordPressChange("full", [{ path: "wp:plugins:hunt-auctions", category: "other" }]);
    expect(plugin).toMatchObject({ decision: "pr_only" });
    expect(plugin.outOfScope[0]!.reason).toMatch(/plugin installs/);
    expect(evaluateWordPressChange("full", []).decision).toBe("pr_only");
  });

  it("the tool uses the WordPress rules on a wordpress sprint and the repo rules otherwise", async () => {
    const wp = fakeHost({ sprint: { ...CLIENT_SPRINT, site_access: "wordpress", site_id: "site-1" }, sites: [siteRow()] });
    const verdict = await checkChangeScopeTool(wp.env, "co-1", { sprintId: "sp-1", changes: seo });
    expect(verdict).toMatchObject({ decision: "apply", siteAccess: "wordpress", changePolicy: "merge_seo_scope" });
    const repo = fakeHost({ sprint: { site_access: "repo", site_project_id: "site-proj" } });
    const merge = await checkChangeScopeTool(repo.env, "co-1", { sprintId: "sp-1", changes: [{ path: "src/app/layout.tsx", category: "head_metadata" }], checks: "passed" });
    expect(merge).toMatchObject({ decision: "merge" });
    expect(merge).not.toHaveProperty("siteAccess");
  });
});

describe("WordPress copy, checklist and Needs you item", () => {
  it("task issues in wordpress mode name the Connector tools and the site id", () => {
    const text = siteSection({ access: "wordpress", siteId: "site-1", repoUrl: null, defaultBranch: "main", branch: "seo/w0", changePolicy: "merge_seo_scope", hosting: "other" }).join("\n");
    expect(text).toContain("## Site changes (WordPress)");
    expect(text).toContain("siteId `site-1`");
    expect(text).toContain("partnersinbiz.crm:wp-seo");
    expect(text).toContain("references/wordpress.md");
    for (const tool of ["wp-media", "wp-content", "wp-connector"]) expect(text).toContain(`partnersinbiz.crm:${tool}`);
    // 0.11.0 change policy: what the agent does now, what stays with a person, and update before parking.
    expect(text).toMatch(/image alt text, featured images, page copy edits and new draft pages yourself, and publish your own drafts when the task says so/);
    expect(text).toMatch(/Still Needs you: plugin installs and rollbacks, deleting anything, publishing anything the Connector did not create, a site's theme or settings/);
    expect(text).toMatch(/ask for the asset, not for a wp-admin edit/);
    expect(text).toMatch(/Never hotlink an image you have no rights to/);
    expect(text).toMatch(/Before you park a task because the Connector cannot do something.*wp-connector.* update/);
    expect(text).not.toMatch(/New pages, copy and alt text are wp-admin edits/);
    expect(siteSection({ access: "wordpress", siteId: "site-1", repoUrl: null, defaultBranch: "main", branch: "b", changePolicy: "pr_only", hosting: null }).join(" ")).toMatch(/do not apply anything/);
  });

  it("opens wordpress code tasks in the SEO project with the WordPress section", async () => {
    const host = fakeHost({ sprint: { site_access: "wordpress", site_id: "site-1", client_kind: "company", client_ref: "crm-1" }, sites: [siteRow()], tasks: [taskRow()] });
    const db = await import("../src/db.js");
    const info = await companyInfo(host.env, "co-1");
    const sprint = (await db.getSprint(host.env.ctx.db, "co-1", "sp-1"))!;
    await createTaskIssue(host.env, { info, sprint, day: 0, agent: { id: "agent-1", status: "active" }, projectId: "seo-proj" }, (await db.getTask(host.env.ctx.db, "co-1", "t-1"))!);
    expect(host.issuesCreated[0]).toMatchObject({ projectId: "seo-proj" });
    expect(String(host.issuesCreated[0]!.description)).toContain("partnersinbiz.crm:wp-seo");
  });

  it("the setup checklist counts WordPress as linked and shows the Connector steps until it is connected", () => {
    const base = { siteName: "Hunt and Gun", siteUrl: "https://huntandgun.co.za", isClient: true, siteAccess: "wordpress", siteProjectId: null, repoUrl: null, changePolicy: "merge_seo_scope", autopilotMode: "safe", property: null, gscVia: null, bingVerified: false };
    const wordpress = { url: "https://huntandgun.co.za", summary: "WordPress · Yoast SEO · Connector connected", connected: true, clientName: "Hunt and Gun", clientPath: "/PIB/crm?client=company:crm-1" };
    const facts = { prefix: "PIB", settingsPath: null, settingsSaved: true, serviceAccount: { configured: false, email: null, error: null }, agent: null, pagespeedKey: false, bingKey: false };
    const done = buildSetupChecklist({ ...facts, sprint: { ...base, wordpress } }).find((i) => i.key === "site_project")!;
    expect(done).toMatchObject({ status: "done", steps: [] });
    const waiting = buildSetupChecklist({ ...facts, sprint: { ...base, wordpress: { ...wordpress, connected: false } } }).find((i) => i.key === "site_project")!;
    expect(waiting.status).toBe("warn");
    expect(waiting.steps.join(" ")).toContain("Connect WordPress");
    expect(waiting.steps.join(" ")).toContain("Upload Plugin");
    expect(waiting.links[0]!.url).toBe("/PIB/crm?client=company:crm-1");
  });

  it("the wp_connector item has the exact pairing steps", () => {
    const item = wpConnectorItem({ clientName: "Hunt and Gun", clientPath: "/PIB/crm?client=company:crm-1", siteUrl: "https://huntandgun.co.za/" }, ["t-1"]);
    expect(item).toMatchObject({ key: "wp_connector", kind: "grant", check: "wp_connector", taskIds: ["t-1"], title: "Connect the PiB Connector on huntandgun.co.za" });
    expect(item.steps).toEqual([
      "Open Paperclip → CRM → Hunt and Gun → **Websites** → https://huntandgun.co.za/ → **Connect WordPress**, and copy the key.",
      "In wp-admin → Plugins → Add New → **Upload Plugin**, upload pib-connector.zip (download link on the same CRM panel) and activate it.",
      "In wp-admin → Settings → **PiB Connector**, paste the key and save.",
      "Back in the CRM, press **Check**.",
    ]);
  });
});

describe("CRM site projection", () => {
  it("upserts and soft-deletes sites with SQL the host accepts", async () => {
    const handlers = new Map<string, (event: Row) => Promise<void>>();
    const executes: Array<{ sql: string; params: unknown[] }> = [];
    const ctx = {
      events: { on: (name: string, fn: (event: Row) => Promise<void>) => handlers.set(name, fn) },
      db: {
        namespace: NAMESPACE,
        async execute(sql: string, params: unknown[] = []) {
          validateRuntimeExecute(sql, NAMESPACE);
          validateParams(sql, params);
          executes.push({ sql, params });
          return { rowCount: 1 };
        },
      },
      logger: { info: vi.fn() },
    } as unknown as PluginContext;
    registerCrmSiteProjection(ctx, NAMESPACE);
    const payload = {
      id: "site-1", clientKind: "company", clientRef: "crm-1", label: "Main site", url: "https://huntandgun.co.za", platform: "wordpress", seoPlugin: "yoast",
      hosting: "xneelo", access: ["connector", "sftp"], projectId: null, connectorStatus: "connected", connectorVersion: "1.0.0", connectorSeenAt: "2026-09-26T07:00:00Z", updatedAt: "2026-09-26T07:00:00Z",
    };
    await handlers.get("plugin.partnersinbiz.crm.site.upserted")!({ companyId: "co-1", payload });
    expect(executes).toHaveLength(1);
    expect(executes[0]!.sql).toContain(`INSERT INTO ${NAMESPACE}.crm_sites`);
    expect(executes[0]!.params.slice(0, 8)).toEqual(["site-1", "co-1", "company", "crm-1", "Main site", "https://huntandgun.co.za", "wordpress", "yoast"]);
    expect(executes[0]!.params[9]).toBe(JSON.stringify(["connector", "sftp"]));
    expect(executes[0]!.params[11]).toBe("connected");
    // No company or no id: ignored.
    await handlers.get("plugin.partnersinbiz.crm.site.upserted")!({ companyId: null, payload });
    expect(executes).toHaveLength(1);
    await handlers.get("plugin.partnersinbiz.crm.site.deleted")!({ companyId: "co-1", payload: { id: "site-1" } });
    expect(executes[1]!.sql).toContain("SET deleted = true");
    expect(executes[1]!.params).toEqual(["site-1"]);
  });
});

// ---------------------------------------------------------------------------
// 0.12.0: verification through the Connector (wp-verify)
// ---------------------------------------------------------------------------

const WP_SPRINT: Row = { ...CLIENT_SPRINT, site_access: "wordpress", site_id: "site-1", site_url: "https://www.huntandgun.co.za" };
const NO_ACCESS = async (url: string): Promise<Response> => (url.startsWith("https://oauth2") ? json({ access_token: "sa-token", expires_in: 3600 }) : json({ siteEntry: [] }));

describe("verification through the Connector: the rules", () => {
  it("wp-verify needs a connected Connector 1.2 or newer", () => {
    expect(versionAtLeast("1.2.0", "1.2.0")).toBe(true);
    expect(versionAtLeast("1.10.0", "1.2.0")).toBe(true);
    expect(versionAtLeast("1.1.9", "1.2.0")).toBe(false);
    expect(versionAtLeast(null, "1.2.0")).toBe(false);
    expect(verifyRouteOf({ siteAccess: "wordpress", connectorStatus: "connected", connectorVersion: "1.2.0" })).toBe("available");
    expect(verifyRouteOf({ siteAccess: "wordpress", connectorStatus: "connected", connectorVersion: "1.1.0" })).toBe("update");
    expect(verifyRouteOf({ siteAccess: "wordpress", connectorStatus: "connected", connectorVersion: null })).toBe("update");
    expect(verifyRouteOf({ siteAccess: "wordpress", connectorStatus: "pending", connectorVersion: "1.2.0" })).toBe("none");
    expect(verifyRouteOf({ siteAccess: "repo", connectorStatus: "connected", connectorVersion: "1.2.0" })).toBe("none");
  });

  it("recognises verification items by key and title, and leaves the real grants alone", () => {
    expect(verificationKindOf({ key: "gsc_access", title: "Ask Acme to add our service account in Search Console" })).toBe("google");
    expect(verificationKindOf({ key: "indexnow_key_file", title: "Upload the IndexNow key file" })).toBe("indexnow");
    expect(verificationKindOf({ key: "task:bing-verification-meta", title: "Add the Bing msvalidate.01 meta tag" })).toBe("bing");
    expect(verificationKindOf({ key: "bing_verification_file", title: "Add BingSiteAuth.xml" })).toBe("bing");
    for (const key of ["bing_key", "service_account", "github_token", "site_project", "wp_connector", "gsc_dns", "gsc_reconnect"]) expect(verificationKindOf({ key, title: "Add the Bing key for Search Console" }), key).toBeNull();
    expect(verificationKindOf({ key: "task:purge-cache", title: "Purge the site cache" })).toBeNull();
  });

  it("check-change-scope: verification_file is in scope only with a Connector that has wp-verify", () => {
    const change = [{ path: "wp:verify:/BingSiteAuth.xml", category: "verification_file" }];
    expect(WORDPRESS_SCOPE_CATEGORIES).toContain("verification_file");
    expect(evaluateWordPressChange("merge_seo_scope", change, { verify: "available" })).toMatchObject({ decision: "apply", inScope: true });
    const old = evaluateWordPressChange("merge_seo_scope", change, { verify: "update" });
    expect(old).toMatchObject({ decision: "pr_only", inScope: false });
    expect(old.outOfScope[0]!.reason).toMatch(/wp-connector.* update first/);
    expect(evaluateWordPressChange("full", change, { verify: "none" }).outOfScope[0]!.reason).toMatch(/connected Connector 1\.2/);
    expect(evaluateWordPressChange("pr_only", change, { verify: "available" }).decision).toBe("pr_only");
  });
});

describe("check-change-scope tool: verification_file on WordPress", () => {
  const change = [{ path: "wp:verify:/abcd1234.txt", category: "verification_file" }];

  it("applies on Connector 1.2, points to wp-connector update on 1.0", async () => {
    const fresh = fakeHost({ sprint: WP_SPRINT, sites: [siteRow({ connector_version: "1.2.0" })] });
    expect(await checkChangeScopeTool(fresh.env, "co-1", { sprintId: "sp-1", changes: change })).toMatchObject({ decision: "apply", verifyRoute: "available" });
    const old = fakeHost({ sprint: WP_SPRINT, sites: [siteRow({ connector_version: "1.0.0" })] });
    const verdict = await checkChangeScopeTool(old.env, "co-1", { sprintId: "sp-1", changes: change });
    expect(verdict).toMatchObject({ decision: "pr_only", verifyRoute: "update" });
    expect(verdict.outOfScope[0]!.reason).toMatch(/older Connector/);
  });

  it("repo sprints keep verification_file as before", async () => {
    const repo = fakeHost({ sprint: { site_access: "repo", site_project_id: "site-proj" } });
    expect(await checkChangeScopeTool(repo.env, "co-1", { sprintId: "sp-1", changes: [{ path: "public/BingSiteAuth.xml", category: "verification_file" }], checks: "passed" })).toMatchObject({ decision: "merge" });
  });
});

describe("gsc-check-access: three cases", () => {
  it("WordPress + Connector 1.2: no client email, the exact route instead", async () => {
    const host = fakeHost({ config: SA_CONFIG, sprint: WP_SPRINT, sites: [siteRow({ connector_version: "1.2.0" })], fetch: NO_ACCESS });
    const result = (await gscCheckAccess(host.env, "co-1", { sprintId: "sp-1", askClient: true })) as Row;
    expect(result).toMatchObject({ hasAccess: false, queued: false });
    expect(host.digests).toHaveLength(0);
    expect(host.issuesCreated).toHaveLength(0);
    const route = result.verificationRoute as { steps: string[]; siteId: string; urlProperty: string };
    expect(route).toMatchObject({ route: "wp-verify", siteId: "site-1", urlProperty: "https://www.huntandgun.co.za/" });
    expect(route.steps.join(" ")).toMatch(/gsc-verification-token.*META.*url[\s\S]*wp-verify[\s\S]*gsc-verify-site/);
    expect(result.askClientIgnored).toBeDefined();
    expect(String(result.next)).toMatch(/Do not ask the client/);
  });

  it("WordPress + older Connector: run wp-connector update first, still no client email", async () => {
    const host = fakeHost({ config: SA_CONFIG, sprint: WP_SPRINT, sites: [siteRow({ connector_version: "1.1.0" })], fetch: NO_ACCESS });
    const result = (await gscCheckAccess(host.env, "co-1", { sprintId: "sp-1" })) as Row;
    expect(result).toMatchObject({ hasAccess: false, queued: false });
    expect(host.digests).toHaveLength(0);
    const route = result.verificationRoute as { steps: string[]; route: string };
    expect(route.route).toMatch(/wp-connector update, then wp-verify/);
    expect(route.steps[0]).toMatch(/wp-connector.*update/);
    expect(route.steps[0]).toMatch(/1\.1\.0/);
  });

  it("WordPress: the client email is queued once the wp-verify route has failed, and says why", async () => {
    const host = fakeHost({ config: SA_CONFIG, sprint: WP_SPRINT, sites: [siteRow({ connector_version: "1.2.0" })], fetch: NO_ACCESS });
    const db = await import("../src/db.js");
    await setVerifyFailure(host.env, (await db.getSprint(host.env.ctx.db, "co-1", "sp-1"))!, "google", "Google could not find the meta tag");
    const result = (await gscCheckAccess(host.env, "co-1", { sprintId: "sp-1" })) as Row;
    expect(result).toMatchObject({ queued: true, verificationAttempt: { route: "wp-verify", failed: true, error: "Google could not find the meta tag" } });
    expect(String(result.next)).toMatch(/wp-verify route failed \(Google could not find the meta tag\)/);
    expect(host.digests[0]!.items as Row[]).toEqual([expect.objectContaining({ key: "gsc_access", kind: "message" })]);
  });

  it("repo and no-repo client sprints: unchanged, the email is queued straight away", async () => {
    for (const sprint of [{ ...CLIENT_SPRINT, site_access: "repo", site_project_id: "site-proj" }, { ...CLIENT_SPRINT, site_access: "none" }]) {
      const host = fakeHost({ config: SA_CONFIG, sprint, fetch: NO_ACCESS });
      const result = (await gscCheckAccess(host.env, "co-1", { sprintId: "sp-1" })) as Row;
      expect(result).toMatchObject({ hasAccess: false, queued: true });
      expect(result).not.toHaveProperty("verificationRoute");
      expect((host.digests[0]!.items as Row[])[0]).toMatchObject({ key: "gsc_access" });
    }
    // A WordPress sprint whose Connector is not connected has no wp-verify route either.
    const pending = fakeHost({ config: SA_CONFIG, sprint: WP_SPRINT, sites: [siteRow({ connector_status: "pending", connector_version: "1.2.0" })], fetch: NO_ACCESS });
    expect(await gscCheckAccess(pending.env, "co-1", { sprintId: "sp-1" })).toMatchObject({ queued: true });
  });

  it("gsc-verify-site records a failed attempt on a WordPress sprint, and a success clears it", async () => {
    let webResource = 400;
    const host = fakeHost({
      config: SA_CONFIG,
      sprint: WP_SPRINT,
      sites: [siteRow({ connector_version: "1.2.0" })],
      fetch: async (url) => {
        if (url.startsWith("https://oauth2")) return json({ access_token: "sa-token", expires_in: 3600 });
        if (url.endsWith("/siteVerification/v1/token")) return json({ method: "META", token: '<meta name="google-site-verification" content="abc123" />' });
        if (url.includes("/siteVerification/v1/webResource")) return webResource === 200 ? json({ id: "x", owners: [SA_EMAIL] }) : json({ error: { message: "The necessary verification token could not be found" } }, 400);
        return json({});
      },
    });
    const token = (await gscVerificationToken(host.env, "co-1", { sprintId: "sp-1" })) as Row;
    expect(token.wordpress).toMatchObject({ route: "available", tool: "partnersinbiz.crm:wp-verify", siteId: "site-1", set: { metaTags: [{ name: "google-site-verification", content: "abc123" }] } });
    expect(String(token.next)).toMatch(/wp-verify.*siteId site-1.*op get, then op set/);
    await expect(gscVerifySite(host.env, "co-1", agentActor, { sprintId: "sp-1" })).rejects.toThrow(/could not verify/);
    expect(((host.sprint.verification as Row).wpVerifyFailures as Row).google).toMatchObject({ error: expect.stringContaining("token could not be found") });
    webResource = 200;
    await gscVerifySite(host.env, "co-1", agentActor, { sprintId: "sp-1" });
    expect((host.sprint.verification as Row).wpVerifyFailures).toEqual({});
  });
});

describe("indexnow-key and bing-add-site on WordPress", () => {
  it("point at wp-verify with the exact file or tag, never at the repo or Needs you", async () => {
    const host = fakeHost({ config: SA_CONFIG, sprint: WP_SPRINT, sites: [siteRow({ connector_version: "1.2.0" })], fetch: async (url) => (url.includes("GetUserSites") ? json({ d: [{ Url: "https://www.huntandgun.co.za/", IsVerified: false, AuthenticationCode: "ABC123DEF456" }] }) : json({ d: {} })) });
    const key = (await indexNowKeyTool(host.env, "co-1", { sprintId: "sp-1" })) as Row;
    expect(key.live).toBe(false);
    expect((key.wordpress as Row).tool).toBe("partnersinbiz.crm:wp-verify");
    expect((key.wordpress as { set: { files: Array<{ path: string; content: string }> } }).set.files[0]).toEqual({ path: `/${key.key}.txt`, content: key.key });
    expect(String(key.next)).toMatch(/wp-verify.*op get.*existing files/);
    const bing = (await bingAddSiteTool(host.env, "co-1", { sprintId: "sp-1" })) as Row;
    expect((bing.wordpress as { set: unknown }).set).toEqual({ metaTags: [{ name: "msvalidate.01", content: "ABC123DEF456" }] });
    expect(String(bing.next)).toMatch(/wp-verify/);
    expect(String(bing.next)).toMatch(/Do not put this on Needs you/);
    expect(host.digests).toHaveLength(0);
    const old = fakeHost({ config: SA_CONFIG, sprint: WP_SPRINT, sites: [siteRow({ connector_version: "1.0.0" })] });
    expect(String(((await indexNowKeyTool(old.env, "co-1", { sprintId: "sp-1" })) as Row).next)).toMatch(/wp-connector update first/);
    const repo = fakeHost({ config: SA_CONFIG, sprint: { site_access: "repo", site_project_id: "site-proj" } });
    const repoKey = (await indexNowKeyTool(repo.env, "co-1", { sprintId: "sp-1" })) as Row;
    expect(repoKey).not.toHaveProperty("wordpress");
    expect(String(repoKey.next)).toMatch(/through the site repo/);
  });
});

describe("Needs you: verification on WordPress sites that can self-serve", () => {
  const item = { sprintId: "sp-1", kind: "task", title: "Add the IndexNow key file to the site root", why: "The key file returns 404.", after: "Runs request-indexing.", key: "indexnow_key_file" };

  it("refuses to raise indexnow, bing and Search Console items while wp-verify is available (or one update away)", async () => {
    for (const version of ["1.2.0", "1.1.0"]) {
      const host = fakeHost({ sprint: WP_SPRINT, sites: [siteRow({ connector_version: version })] });
      await expect(needsYouAddTool(host.env, "co-1", agentActor, item)).rejects.toThrow(/Not a Needs you item[\s\S]*wp-verify[\s\S]*IndexNow/);
      await expect(needsYouAddTool(host.env, "co-1", agentActor, { ...item, key: "bing_verification_meta", title: "Add the Bing msvalidate.01 meta tag" })).rejects.toThrow(/Bing verification/);
      await expect(needsYouAddTool(host.env, "co-1", agentActor, { ...item, key: "gsc_access", title: "Give the service account access in Search Console" })).rejects.toThrow(/Search Console access/);
      expect(host.digests).toHaveLength(0);
    }
    const old = fakeHost({ sprint: WP_SPRINT, sites: [siteRow({ connector_version: "1.1.0" })] });
    await expect(needsYouAddTool(old.env, "co-1", agentActor, item)).rejects.toThrow(/Run the CRM's wp-connector update first/);
  });

  it("accepts the item once wpVerifyFailed says what failed, and records it on the sprint", async () => {
    const host = fakeHost({ sprint: WP_SPRINT, sites: [siteRow({ connector_version: "1.2.0" })] });
    const result = await needsYouAddTool(host.env, "co-1", agentActor, { ...item, wpVerifyFailed: "wp-verify set answered pib_unsafe: path not allowed" });
    expect(result).toMatchObject({ added: true });
    expect(((host.sprint.verification as Row).wpVerifyFailures as Row).indexnow).toMatchObject({ error: expect.stringContaining("pib_unsafe") });
    // A failure for one kind does not open the others.
    await expect(needsYouAddTool(host.env, "co-1", agentActor, { ...item, key: "bing_verification_meta", title: "Add the Bing msvalidate.01 meta tag" })).rejects.toThrow(/Not a Needs you item/);
  });

  it("does not touch repo sprints, sites without a connected Connector, the Bing API key or other items", async () => {
    const repo = fakeHost({ sprint: { ...CLIENT_SPRINT, site_access: "repo", site_project_id: "site-proj" } });
    expect(await needsYouAddTool(repo.env, "co-1", agentActor, item)).toMatchObject({ added: true });
    const pending = fakeHost({ sprint: WP_SPRINT, sites: [siteRow({ connector_status: "pending", connector_version: "1.2.0" })] });
    expect(await needsYouAddTool(pending.env, "co-1", agentActor, item)).toMatchObject({ added: true });
    const wp = fakeHost({ config: SA_CONFIG, sprint: WP_SPRINT, sites: [siteRow({ connector_version: "1.2.0" })] });
    expect(await needsYouAddTool(wp.env, "co-1", agentActor, { sprintId: "sp-1", key: "bing_key" })).toMatchObject({ added: true, standard: true });
    expect(await needsYouAddTool(wp.env, "co-1", agentActor, { ...item, key: "task:merchant-center", title: "Create the Merchant Center account" })).toMatchObject({ added: true });
  });

  it("the daily check closes existing items as superseded, keeps them as history and hands the task back", async () => {
    const host = fakeHost({
      sprint: WP_SPRINT,
      sites: [siteRow({ connector_version: "1.1.0" })],
      tasks: [taskRow({ id: "t-9", owner: "agent", status: "blocked", issue_id: "issue-9", task_type: "indexing-setup" })],
    });
    const db = await import("../src/db.js");
    const info = { ...(await companyInfo(host.env, "co-1")), today: "2026-09-26" };
    const sprint = (await db.getSprint(host.env.ctx.db, "co-1", "sp-1"))!;
    const manual = (key: string, title: string, extra: Partial<NewNeedsYouItem> = {}): NewNeedsYouItem => ({ key, kind: "task", title, why: "parked", steps: ["Add it"], links: [], after: "Carries on.", check: "manual", taskIds: ["t-9"], ...extra });
    await addNeedsYou(host.env, info, sprint, manual("indexnow_key_file", "Upload the IndexNow key file"));
    await addNeedsYou(host.env, info, sprint, manual("bing_verification_meta", "Add the Bing msvalidate.01 meta tag"));
    await addNeedsYou(host.env, info, sprint, manual("gsc_access", "Ask Hunt and Gun to add our service account in Search Console", { kind: "message", check: "gsc_access" }));
    await addNeedsYou(host.env, info, sprint, manual("task:merchant-center", "Create the Merchant Center account"));
    expect((host.digests[0]!.items as Row[]).map((i) => i.status)).toEqual(["open", "open", "open", "open"]);

    const resolved = await recheckNeedsYou(host.env, info, sprint);
    expect(resolved).toBe(3);
    const items = host.digests[0]!.items as Row[];
    expect(items.map((i) => [i.key, i.status])).toEqual([["indexnow_key_file", "done"], ["bing_verification_meta", "done"], ["gsc_access", "done"], ["task:merchant-center", "open"]]);
    expect(items[0]).toMatchObject({ doneBy: "checked by the SEO plugin", note: expect.stringMatching(/Superseded[\s\S]*wp-verify/) });
    expect(host.issueUpdates.some((u) => u.id === "issue-9" && u.patch.status === "todo")).toBe(true);
    expect(host.comments.some((c) => c.id === "issue-9" && /Superseded/.test(c.body))).toBe(true);
  });

  it("the daily check leaves items on Needs you once the wp-verify route failed, or on a repo sprint", async () => {
    const wp = fakeHost({ sprint: WP_SPRINT, sites: [siteRow({ connector_version: "1.2.0" })] });
    const db = await import("../src/db.js");
    const info = { ...(await companyInfo(wp.env, "co-1")), today: "2026-09-26" };
    const sprint = (await db.getSprint(wp.env.ctx.db, "co-1", "sp-1"))!;
    const failed = await setVerifyFailure(wp.env, sprint, "indexnow", "file rejected");
    await addNeedsYou(wp.env, info, failed, { key: "indexnow_key_file", kind: "task", title: "Upload the IndexNow key file", why: "w", steps: [], links: [], after: "a", check: "manual", taskIds: [] });
    expect(await recheckNeedsYou(wp.env, info, failed)).toBe(0);
    expect((wp.digests[0]!.items as Row[])[0]!.status).toBe("open");
    const repo = fakeHost({ sprint: { ...CLIENT_SPRINT, site_access: "repo", site_project_id: "site-proj" } });
    const repoSprint = (await db.getSprint(repo.env.ctx.db, "co-1", "sp-1"))!;
    await addNeedsYou(repo.env, info, repoSprint, { key: "indexnow_key_file", kind: "task", title: "Upload the IndexNow key file", why: "w", steps: [], links: [], after: "a", check: "manual", taskIds: [] });
    expect(await recheckNeedsYou(repo.env, info, repoSprint)).toBe(0);
  });
});

describe("setup checklist: verification on WordPress", () => {
  it("says the agent verifies Search Console and Bing itself through the Connector", () => {
    const base = { siteName: "Hunt and Gun", siteUrl: "https://huntandgun.co.za", isClient: true, siteAccess: "wordpress", siteProjectId: null, repoUrl: null, changePolicy: "merge_seo_scope", autopilotMode: "safe", property: null, gscVia: null, bingVerified: false };
    const wordpress = { url: "https://huntandgun.co.za", summary: "WordPress · Yoast SEO · Connector connected", connected: true, clientName: "Hunt and Gun", clientPath: "/PIB/crm?client=company:crm-1" };
    const facts = { prefix: "PIB", settingsPath: null, settingsSaved: true, serviceAccount: { configured: true, email: SA_EMAIL, error: null }, agent: null, pagespeedKey: false, bingKey: true };
    const find = (verifyRoute: "available" | "update" | "none", key: string) => buildSetupChecklist({ ...facts, sprint: { ...base, wordpress: { ...wordpress, verifyRoute } } }).find((i) => i.key === key)!;
    expect(find("available", "gsc_property").detail).toMatch(/verifies the site itself through the PiB Connector.*wp-verify.*gsc-verify-site/);
    expect(find("available", "gsc_property").steps).toEqual([]);
    expect(find("update", "gsc_property").detail).toMatch(/after wp-connector update/);
    expect(find("available", "bing_site").detail).toMatch(/bing-add-site → wp-verify → bing-verify-site/);
    expect(find("none", "gsc_property").detail).toMatch(/client adds the service account/);
    expect(find("none", "gsc_property").steps.join(" ")).toMatch(/Send the client the email/);
  });
});

describe("request-indexing finishes inside the gateway timeout", () => {
  const property = "https://partnersinbiz.online/";
  function indexingHost(opts: { inspect?: (url: string) => Promise<Response>; indexNow?: () => Promise<Response> }) {
    const host = fakeHost({
      config: SA_CONFIG,
      integration: { property_url: property, status: "connected", settings: { auth: "service_account" } },
      fetch: async (url, init) => {
        if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "sa-token", expires_in: 3600 });
        if (url.includes("urlInspection")) return opts.inspect!(String(JSON.parse(String(init?.body)).inspectionUrl));
        if (url.startsWith("https://api.indexnow.org/")) return opts.indexNow ? opts.indexNow() : new Response("", { status: 200 });
        return json({});
      },
    });
    host.env.site = vi.fn(async (url: string) => ({ status: 200, text: new URL(url).pathname.slice(1).replace(/\.txt$/, ""), url, redirects: [], headers: {}, ms: 1 })) as never;
    return host;
  }
  const verdict = (v: string) => json({ inspectionResult: { indexStatusResult: { verdict: v, coverageState: "Submitted and indexed" } } });
  const never = () => new Promise<Response>(() => undefined);

  it("runs the steps in parallel and returns the IndexNow status with every inspection", async () => {
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const host = indexingHost({ inspect: async (url) => { await delay(150); return verdict(url.endsWith("/b") ? "NEUTRAL" : "PASS"); } });
    const started = Date.now();
    const out = (await requestIndexingTool(host.env, "co-1", { sprintId: "sp-1", urls: ["https://partnersinbiz.online/a", "https://partnersinbiz.online/b", "https://partnersinbiz.online/c", "https://partnersinbiz.online/d", "https://partnersinbiz.online/e"] })) as Row;
    expect(Date.now() - started).toBeLessThan(450);
    expect(out.sitemap).toMatchObject({ submitted: true, property });
    expect(out.indexNow).toMatchObject({ ok: true, status: 200, submitted: 5 });
    expect((out.inspections as Row[]).map((i) => i.verdict)).toEqual(["PASS", "NEUTRAL", "PASS", "PASS", "PASS"]);
    expect(out.notIndexed).toEqual(["https://partnersinbiz.online/b"]);
    expect(out).not.toHaveProperty("uninspected");
    expect((host.sprint.verification as Row).indexing).toMatchObject({ requestedOn: "2026-09-26", notIndexed: ["https://partnersinbiz.online/b"] });
  });

  it("returns the IndexNow status and partial inspections when URL Inspection is slower than the wait", async () => {
    const host = indexingHost({ inspect: (url) => (url.endsWith("/slow") ? never() : Promise.resolve(verdict("PASS"))) });
    const started = Date.now();
    const out = (await requestIndexingTool(host.env, "co-1", { sprintId: "sp-1", urls: ["https://partnersinbiz.online/fast", "https://partnersinbiz.online/slow"], waitSeconds: 1 })) as Row;
    expect(Date.now() - started).toBeLessThan(2500);
    expect(out.indexNow).toMatchObject({ ok: true, status: 200 });
    expect(out.sitemap).toMatchObject({ submitted: true });
    expect(out.inspections).toMatchObject([{ url: "https://partnersinbiz.online/fast", verdict: "PASS" }, { url: "https://partnersinbiz.online/slow", pending: true }]);
    expect(out.uninspected).toEqual(["https://partnersinbiz.online/slow"]);
    expect(out.notIndexed).toEqual([]);
    expect(String(out.note)).toMatch(/did not finish in time/);
    expect((host.sprint.verification as Row).indexing).toMatchObject({ urls: ["https://partnersinbiz.online/fast", "https://partnersinbiz.online/slow"] });
  });

  it("marks a hung IndexNow ping as timed out and still returns the inspections", async () => {
    const host = indexingHost({ inspect: () => Promise.resolve(verdict("PASS")), indexNow: never });
    const out = (await requestIndexingTool(host.env, "co-1", { sprintId: "sp-1", urls: ["https://partnersinbiz.online/a"], waitSeconds: 1 })) as Row;
    expect(out.indexNow).toMatchObject({ ok: false, timedOut: true });
    expect(out.inspections).toMatchObject([{ verdict: "PASS" }]);
  });

  it("skips URL Inspection when inspect is false", async () => {
    const inspect = vi.fn(async () => verdict("PASS"));
    const host = indexingHost({ inspect });
    const out = (await requestIndexingTool(host.env, "co-1", { sprintId: "sp-1", urls: ["https://partnersinbiz.online/a"], inspect: false })) as Row;
    expect(inspect).not.toHaveBeenCalled();
    expect(out.inspections).toEqual([]);
    expect(out.indexNow).toMatchObject({ ok: true });
  });

  it("reports a Search Console failure per step without losing IndexNow", async () => {
    const host = indexingHost({ inspect: async () => json({ error: { message: "denied" } }, 403) });
    host.integration.property_url = null;
    host.env.fetch = vi.fn(async (url: string) => (url.startsWith("https://oauth2.googleapis.com/token") ? json({ access_token: "t", expires_in: 3600 }) : url.includes("/webmasters/v3/sites") ? json({ siteEntry: [] }) : new Response("", { status: 200 }))) as never;
    const out = (await requestIndexingTool(host.env, "co-1", { sprintId: "sp-1", urls: ["https://partnersinbiz.online/a"] })) as Row;
    expect(out.sitemap).toMatchObject({ submitted: false });
    expect(out.indexNow).toMatchObject({ ok: true, status: 200 });
    expect(out.inspections).toMatchObject([{ url: "https://partnersinbiz.online/a", error: expect.any(String) }]);
  });
});
