/**
 * A fake plugin host for service-level tests: a route-based database (queries answer by SQL pattern, every execute is
 * recorded and run through the host's SQL guard), a fake Paperclip issues API that records what the plugin does, Google
 * and site fetchers the test controls, and a company with a Google service account. Nothing here is a real key.
 */
import { generateKeyPairSync } from "node:crypto";
import { vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "../../src/namespace.js";
import { createEnv, type Env } from "../../src/service/common.js";
import type { SiteFetcher } from "../../src/checks/site.js";
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./sql-guard.js";

export type Row = Record<string, unknown>;
export type Route = [RegExp, (params: unknown[], sql: string) => Row[]];

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const SA_EMAIL = "paperclip-seo@example.iam.gserviceaccount.com";
export const SA_JSON = JSON.stringify({ type: "service_account", client_email: SA_EMAIL, private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), private_key_id: "k1" });

export const SPRINT: Row = {
  id: "sp-1", company_id: "co-1", name: "Acme", site_url: "https://acme.co.za", site_name: "Acme Accounting", client_kind: "company", client_ref: "crm-1", client_name: "Acme Accounting (Pty) Ltd",
  status: "active", start_date: "2026-09-01", template_id: "outrank-90-professional", template_version: 5, autopilot_mode: "safe", owner_user_id: "user-1",
  project_id: "proj-1", root_issue_id: "root-1", root_issue_identifier: "PIB-1", agent_id: "agent-1", notes: null, paused_reason: null,
  health: {}, scoreboard: {}, today: {}, current_day: 32, current_week: 5, current_phase: 2, last_daily_on: null, last_weekly_on: null,
  audit_days_done: [0], seeded_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
  site_project_id: "proj-site", site_access: "repo", repo_url: "https://github.com/pib/acme", default_branch: "main", change_policy: "merge_seo_scope", verification: {}, client_project_id: "proj-client",
};

export function taskRow(extra: Row = {}): Row {
  return {
    id: "t-1", company_id: "co-1", sprint_id: "sp-1", template_key: "w0-meta-tags", week: 0, phase: 0, due_day: null, focus: "Pre-launch",
    title: "Set up the title, description and share image on every page", description: null, task_type: "meta-tag-audit", owner: "agent", autopilot_eligible: true,
    playbook_key: "w0-meta-tags", status: "not_started", source: "template", parent_optimization_id: null, context: null, issue_id: null, issue_identifier: null,
    issue_status: null, assignee_kind: null, blocker_reason: null, human_ask: null, evidence: null, started_at: null, completed_at: null, completed_by: null,
    created_at: "2026-09-01T00:00:00Z", updated_at: null, issue_project_id: null, ...extra,
  };
}

export interface HostOptions {
  routes?: Route[];
  /** Google (oauth, Analytics) calls: return a Response; the default token endpoint answers by itself. */
  google?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
  site?: SiteFetcher;
  now?: string;
  noServiceAccount?: boolean;
  /** Skip the heartbeat_runs core table in the SQL guard's whitelist. */
  agent?: { id: string; status: string } | null;
}

/** A host whose state (issues, comments, executes) the test reads afterwards. */
export function seoHost(options: HostOptions = {}) {
  const executes: Array<{ sql: string; params: unknown[] }> = [];
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const created: Array<{ id: string; input: Row }> = [];
  const updates: Array<{ id: string; patch: Row }> = [];
  const comments: Array<{ id: string; body: string }> = [];
  const wakeups: string[] = [];
  const state = new Map<string, unknown>([["plugin-ui-base", "/_plugins/051bbf0b-aeb5-42d7-b0b6-c4cabd271cdc/ui/"]]);
  const routes: Route[] = options.routes ?? [];
  const googleCalls: Array<{ url: string; method: string; body: unknown; scope?: string }> = [];
  let issueSeq = 0;
  const agent = options.agent === undefined ? { id: "agent-1", status: "idle" } : options.agent;
  const ctx = {
    db: {
      namespace: NAMESPACE,
      async query(sql: string, params: unknown[] = []) {
        validateRuntimeQuery(sql, NAMESPACE, ["heartbeat_runs", "issue_comments"]);
        validateParams(sql, params);
        queries.push({ sql, params });
        for (const [pattern, handler] of routes) if (pattern.test(sql)) return handler(params, sql);
        return [];
      },
      async execute(sql: string, params: unknown[] = []) {
        validateRuntimeExecute(sql, NAMESPACE);
        validateParams(sql, params);
        executes.push({ sql, params });
        return { rowCount: 1 };
      },
    },
    config: { get: vi.fn(async () => ({ publicBaseUrl: "https://paperclip.example.com", ...(options.noServiceAccount ? {} : { google: { serviceAccountJson: SA_JSON } }) })) },
    secrets: { resolve: vi.fn(async (_ref: unknown, o?: { configPath?: string }) => (o?.configPath === "google.serviceAccountJson" ? SA_JSON : `resolved:${o?.configPath}`)) },
    companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PIB" })), list: vi.fn(async () => [{ id: "co-1" }]) },
    agents: {
      get: vi.fn(async (id: string) => (agent && id === agent.id ? { id, name: "SEO Specialist", status: agent.status } : null)),
      list: vi.fn(async () => (agent ? [{ id: agent.id, name: "SEO Specialist", status: agent.status }] : [])),
      managed: { get: vi.fn(async () => (agent ? { agentId: agent.id, agent: { id: agent.id, status: agent.status } } : { agentId: null, agent: null })) },
    },
    issues: {
      get: vi.fn(async (id: string) => ({ id, status: "todo", identifier: `PIB-${id.replace(/\D/g, "") || "0"}` })),
      create: vi.fn(async (input: Row) => {
        // Ids start at 101 so a created issue never collides with a fixture's issue-1, issue-2 …
        issueSeq += 1;
        const id = `issue-${100 + issueSeq}`;
        created.push({ id, input });
        return { id, identifier: `PIB-${100 + issueSeq}` };
      }),
      update: vi.fn(async (id: string, patch: Row) => {
        updates.push({ id, patch });
        return { id, ...patch };
      }),
      createComment: vi.fn(async (id: string, body: string) => {
        comments.push({ id, body });
        return { id: "c" };
      }),
      requestWakeup: vi.fn(async (id: string) => {
        wakeups.push(id);
        return { queued: true, runId: null };
      }),
    },
    events: { emit: vi.fn(), on: () => undefined },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    skills: { managed: { reconcile: vi.fn(), reset: vi.fn() } },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => state.get(key.stateKey) ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => void state.set(key.stateKey, value)),
    },
  } as unknown as PluginContext;
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? (() => { try { return JSON.parse(String(init.body)); } catch { return String(init.body); } })() : null;
    const scope = url.includes("/token") && typeof init?.body === "string" ? (() => {
      const assertion = new URLSearchParams(init.body as string).get("assertion") ?? "";
      try { return (JSON.parse(Buffer.from(assertion.split(".")[1]!, "base64url").toString()) as { scope?: string }).scope; } catch { return undefined; }
    })() : undefined;
    googleCalls.push({ url, method: init?.method ?? "GET", body, scope });
    const answer = options.google?.(url, init);
    if (answer) return answer;
    if (url.includes("oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "sa-token", expires_in: 3600 }), { status: 200 });
    throw new Error(`unexpected Google call ${url}`);
  });
  const site = options.site ?? ((async () => { throw new Error("unexpected site fetch"); }) as SiteFetcher);
  const env: Env = createEnv(ctx, { now: () => new Date(options.now ?? "2026-10-03T08:00:00Z"), fetch: fetchImpl as never, site: site as never });
  return { env, ctx, executes, queries, created, updates, comments, wakeups, state, googleCalls, fetchImpl, routes };
}

/** An integration row as the database returns it. */
export function integrationRow(provider: string, extra: Row = {}): Row {
  return { id: `int-${provider}`, company_id: "co-1", sprint_id: "sp-1", provider, status: "disconnected", property_url: null, settings: {}, stats: {}, scopes: [], ...extra };
}

/** The standard routes: the sprint, and nothing else. Tests add their own in front. */
export const sprintRoutes: Route[] = [[/FROM plugin_seo_8099f8879a\.sprints WHERE id = \$1/, () => [SPRINT]]];

export function executed(host: { executes: Array<{ sql: string; params: unknown[] }> }, pattern: RegExp) {
  return host.executes.filter((e) => pattern.test(e.sql));
}

/**
 * Routes that give the sprint this week's Needs you digest (2026-10-03 is in the week of Monday 2026-09-28). `issueId` null:
 * the digest has no issue yet. `recent`: the sprint's earlier digests, as `recentNeedsYouDigests` reads them.
 */
export function needsYouRoutes(items: unknown[] = [], opts: { issueId?: string | null; recent?: Row[]; open?: boolean } = {}): Route[] {
  const issueId = opts.issueId === undefined ? "ny-issue" : opts.issueId;
  return [
    [/FROM plugin_seo_8099f8879a\.needs_you WHERE company_id = \$1 AND sprint_id = \$2 ORDER BY week_start DESC LIMIT \$3/, () => opts.recent ?? []],
    ...(opts.open ? ([[/FROM plugin_seo_8099f8879a\.needs_you n JOIN/, () => [{ sprint_id: "sp-1", items }]]] as Route[]) : []),
    [/FROM plugin_seo_8099f8879a\.needs_you WHERE company_id = \$1 AND sprint_id = \$2 AND week_start < /, () => []],
    [/FROM plugin_seo_8099f8879a\.needs_you WHERE company_id = \$1 AND sprint_id = \$2 AND week_start = /, () => [{ id: "ny-1", company_id: "co-1", sprint_id: "sp-1", week_start: "2026-09-28", issue_id: issueId, issue_identifier: issueId ? "PIB-9" : null, items, status: "open" }]],
  ];
}

/** The items of the last Needs you digest the plugin saved. */
export function savedNeedsYouItems(host: { executes: Array<{ sql: string; params: unknown[] }> }): Array<Record<string, unknown>> {
  const writes = host.executes.filter((e) => /INSERT INTO plugin_seo_8099f8879a\.needs_you /.test(e.sql));
  const last = writes[writes.length - 1];
  return last ? (JSON.parse(String(last.params[4])) as Array<Record<string, unknown>>) : [];
}
