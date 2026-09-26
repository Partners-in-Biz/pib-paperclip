import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { buildKeyring, sealJson } from "@partnersinbiz/pib-plugin-kit";
import { NAMESPACE } from "../src/namespace.js";
import { createEnv, type Actor } from "../src/service/common.js";
import { gscAccess, gscOauthComplete } from "../src/service/gsc.js";
import { blockTask, completeTask, syncTaskFromIssue } from "../src/service/tasks.js";
import type { SprintTask } from "../src/db.js";
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

type Row = Record<string, unknown>;
type Route = [RegExp, (params: unknown[]) => Row[]];

const SPRINT: Row = {
  id: "sp-1", company_id: "co-1", name: "Acme", site_url: "https://acme.co.za", site_name: "Acme", client_ref: null, client_name: "Acme Ltd",
  status: "active", start_date: "2026-09-01", template_id: "outrank-90", template_version: 2, autopilot_mode: "safe", owner_user_id: "user-1",
  project_id: "proj-1", root_issue_id: "root-1", root_issue_identifier: "PIB-1", agent_id: "agent-1", notes: null, paused_reason: null,
  health: {}, scoreboard: {}, today: {}, current_day: 25, current_week: 4, current_phase: 1, last_daily_on: null, last_weekly_on: null,
  audit_days_done: [0], seeded_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};

function taskRow(extra: Row = {}): Row {
  return {
    id: "t-1", company_id: "co-1", sprint_id: "sp-1", template_key: "w5-post-1", week: 5, phase: 2, due_day: 29, focus: "Content",
    title: "Publish post 1", description: null, task_type: "post-publish", owner: "agent", autopilot_eligible: false, playbook_key: "w5-post-1",
    status: "in_progress", source: "template", parent_optimization_id: null, context: null, issue_id: "iss-1", issue_identifier: "PIB-9",
    issue_status: "in_progress", assignee_kind: "agent", blocker_reason: null, human_ask: null, evidence: null, started_at: null,
    completed_at: null, completed_by: null, created_at: null, updated_at: null, ...extra,
  };
}

function fakeHost(routes: Route[], config: Row = {}) {
  const executes: Array<{ sql: string; params: unknown[] }> = [];
  const issueUpdates: Array<{ id: string; patch: Row }> = [];
  const comments: Array<{ id: string; body: string }> = [];
  const ctx = {
    db: {
      namespace: NAMESPACE,
      async query(sql: string, params: unknown[] = []) {
        validateRuntimeQuery(sql, NAMESPACE, ["heartbeat_runs"]);
        validateParams(sql, params);
        for (const [pattern, handler] of routes) if (pattern.test(sql)) return handler(params);
        return [];
      },
      async execute(sql: string, params: unknown[] = []) {
        validateRuntimeExecute(sql, NAMESPACE);
        validateParams(sql, params);
        executes.push({ sql, params });
        return { rowCount: 1 };
      },
    },
    config: { get: vi.fn(async () => config) },
    secrets: { resolve: vi.fn(async (_ref: unknown, opts?: { configPath?: string }) => `resolved:${opts?.configPath}`) },
    companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PIB" })) },
    issues: {
      get: vi.fn(async (id: string) => ({ id, status: "todo", identifier: "PIB-3" })),
      update: vi.fn(async (id: string, patch: Row) => {
        issueUpdates.push({ id, patch });
        return { id, ...patch };
      }),
      createComment: vi.fn(async (id: string, body: string) => {
        comments.push({ id, body });
        return { id: "c" };
      }),
      create: vi.fn(async () => ({ id: "new-issue" })),
      requestWakeup: vi.fn(async () => ({ queued: true, runId: null })),
    },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    skills: { managed: { reconcile: vi.fn(), reset: vi.fn() } },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => (key.stateKey === "plugin-ui-base" ? "/_plugins/051bbf0b-aeb5-42d7-b0b6-c4cabd271cdc/ui/" : null)),
      set: vi.fn(),
    },
  } as unknown as PluginContext;
  const env = createEnv(ctx, { now: () => new Date("2026-09-26T08:00:00Z"), fetch: vi.fn() as never, site: vi.fn() as never });
  return { env, ctx, executes, issueUpdates, comments };
}

const agent: Actor = { kind: "agent", agentId: "agent-1", runId: "run-1", responsibleUserId: null };

describe("task tools", () => {
  const routes = (task: Row, facts: Row = {}): Route[] => [
    [/FROM plugin_seo_8099f8879a\.sprint_tasks WHERE id = \$1/, () => [task]],
    [/FROM plugin_seo_8099f8879a\.sprints WHERE id = \$1/, () => [SPRINT]],
    [/AS active_keywords/, () => [{ active_keywords: 12, no_intent: 0, priority: 5, dirs: 0, latest_day: 0, ...facts }]],
  ];

  it("refuses to complete a sign-off task for an agent in safe mode", async () => {
    const { env } = fakeHost(routes(taskRow()));
    await expect(completeTask(env, "co-1", agent, { taskId: "t-1", summary: "Published" })).rejects.toThrow(/sign-off/);
  });

  it("refuses status-only directory completion and accepts real work", async () => {
    const dirTask = taskRow({ task_type: "directory-submission", autopilot_eligible: true, template_key: "w9-directories" });
    const blocked = fakeHost(routes(dirTask, { dirs: 6 }));
    await expect(completeTask(blocked.env, "co-1", agent, { taskId: "t-1", summary: "done" })).rejects.toThrow(/6 directory/);
    const ok = fakeHost(routes(dirTask, { dirs: 0 }));
    const result = await completeTask(ok.env, "co-1", agent, { taskId: "t-1", summary: "All 15 handled", links: ["https://g2.com/x"] });
    expect(result).toMatchObject({ status: "done", issueClosed: true });
    expect(ok.issueUpdates).toEqual([{ id: "iss-1", patch: { status: "done" } }]);
    expect(ok.comments[0]!.body).toContain("All 15 handled");
    const taskUpdate = ok.executes.find((e) => e.sql.includes("sprint_tasks") && e.params.includes("done"));
    expect(taskUpdate).toBeDefined();
    expect(JSON.parse(String(taskUpdate!.params.find((p) => typeof p === "string" && p.startsWith("{"))))).toMatchObject({ summary: "All 15 handled", links: ["https://g2.com/x"], byKind: "agent" });
  });

  it("hands a review to the owner as in_review", async () => {
    const { env, issueUpdates, comments } = fakeHost(routes(taskRow()));
    const result = await blockTask(env, "co-1", agent, { taskId: "t-1", reason: "Draft ready", humanAsk: "Approve and publish the draft at https://docs/x", review: true });
    expect(result).toMatchObject({ status: "in_progress", humanAsk: "Approve and publish the draft at https://docs/x", handedTo: "sprint owner" });
    expect(issueUpdates[0]).toEqual({ id: "iss-1", patch: { status: "in_review", assigneeAgentId: null, assigneeUserId: "user-1" } });
    expect(comments[0]!.body).toContain("Ready for your sign-off");
  });
});

describe("issue sync", () => {
  const task = (extra: Partial<SprintTask> = {}): SprintTask => ({
    id: "t-1", companyId: "co-1", sprintId: "sp-1", templateKey: null, week: 1, phase: 1, dueDay: 1, focus: "", title: "t", description: null,
    taskType: "custom", owner: "agent", autopilotEligible: true, playbookKey: null, status: "not_started", source: "template",
    parentOptimizationId: null, context: null, issueId: "iss-1", issueIdentifier: null, issueStatus: "todo", assigneeKind: "agent",
    blockerReason: null, humanAsk: null, evidence: null, startedAt: null, completedAt: null, completedBy: null, createdAt: null, updatedAt: null, ...extra,
  });

  it("marks the task done when a person closes the issue (idempotently)", async () => {
    const { env, executes } = fakeHost([]);
    const first = await syncTaskFromIssue(env, task(), { id: "iss-1", status: "done", identifier: "PIB-5" });
    expect(first).toEqual({ changed: true, status: "done" });
    expect(executes[0]!.params).toContain("done");
    expect(executes[0]!.params).toContain("PIB-5");
    const again = await syncTaskFromIssue(env, task({ status: "done", issueStatus: "done", issueIdentifier: "PIB-5" }), { id: "iss-1", status: "done", identifier: "PIB-5" });
    expect(again.changed).toBe(false);
  });

  it("retries closing the issue when the task was completed but the issue stayed open", async () => {
    const { env, issueUpdates } = fakeHost([]);
    await syncTaskFromIssue(env, task({ status: "done", issueStatus: "in_progress" }), { id: "iss-1", status: "in_progress" });
    expect(issueUpdates).toEqual([{ id: "iss-1", patch: { status: "done" } }]);
  });
});

describe("GSC OAuth completion", () => {
  const input = (companyId: string, params: Row, actorType: "user" | "agent" = "user") => ({
    routeKey: "oauth-complete",
    method: "POST",
    path: "/oauth/complete",
    params: {},
    query: {},
    body: { companyId, state: "st-1", params },
    actor: { actorType, actorId: "user-1", userId: "user-1" },
    companyId,
    headers: {},
  });

  it("rejects a session from another company", async () => {
    const { env } = fakeHost([[/oauth_sessions/, () => [{ state: "st-1", company_id: "co-1", sprint_id: "sp-1", provider: "gsc", created_by_user_id: "user-1", return_to: null, expired: false }]]]);
    const res = await gscOauthComplete(env, input("co-2", { code: "x" }) as never);
    expect(res.status).toBe(403);
  });

  it("reports provider errors and expired sessions", async () => {
    const live = fakeHost([[/oauth_sessions/, () => [{ state: "st-1", company_id: "co-1", sprint_id: "sp-1", provider: "gsc", created_by_user_id: "u", return_to: null, expired: false }]]]);
    const denied = await gscOauthComplete(live.env, input("co-1", { error: "access_denied" }) as never);
    expect(denied).toMatchObject({ status: 400 });
    expect(String((denied.body as { error: string }).error)).toMatch(/did not grant/);
    expect(live.executes.some((e) => e.sql.startsWith("DELETE FROM plugin_seo_8099f8879a.oauth_sessions"))).toBe(true);
    const expired = fakeHost([[/oauth_sessions/, () => [{ state: "st-1", company_id: "co-1", sprint_id: "sp-1", provider: "gsc", created_by_user_id: "u", return_to: null, expired: true }]]]);
    expect((await gscOauthComplete(expired.env, input("co-1", { code: "x" }) as never)).status).toBe(400);
  });

  it("exchanges the code, seals tokens, picks the property and redirects to the cockpit", async () => {
    const config = {
      publicBaseUrl: "https://paperclip.partnersinbiz.online",
      encryptionKey: { type: "secret_ref", secretId: "k" },
      google: { clientId: "cid", clientSecret: { type: "secret_ref", secretId: "s" } },
    };
    const host = fakeHost([
      [/oauth_sessions/, () => [{ state: "st-1", company_id: "co-1", sprint_id: "sp-1", provider: "gsc", created_by_user_id: "user-1", return_to: null, expired: false }]],
      [/FROM plugin_seo_8099f8879a\.sprints WHERE id = \$1/, () => [SPRINT]],
      [/FROM plugin_seo_8099f8879a\.integrations/, () => [{ id: "int-1", company_id: "co-1", sprint_id: "sp-1", provider: "gsc", status: "disconnected", property_url: null, token_sealed: null, scopes: [], settings: {}, stats: {}, alert_issue_id: null }]],
    ], config);
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://oauth2.googleapis.com/token") {
        expect(new URLSearchParams(String(init?.body)).get("redirect_uri")).toBe("https://paperclip.partnersinbiz.online/_plugins/051bbf0b-aeb5-42d7-b0b6-c4cabd271cdc/ui/oauth-callback.html");
        return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "https://www.googleapis.com/auth/webmasters" }));
      }
      return new Response(JSON.stringify({ siteEntry: [{ siteUrl: "sc-domain:acme.co.za", permissionLevel: "siteOwner" }] }));
    });
    host.env.fetch = fetchImpl;
    const res = await gscOauthComplete(host.env, input("co-1", { code: "the-code", state: "st-1" }) as never);
    expect(res).toEqual({ status: 200, body: { redirectTo: "/PIB/seo?sprint=sp-1&tab=integrations&connected=gsc", propertyUrl: "sc-domain:acme.co.za" } });
    const update = host.executes.find((e) => e.sql.includes("integrations") && e.sql.includes("token_sealed"));
    expect(update).toBeDefined();
    const sealed = update!.params.find((p) => typeof p === "string" && p.startsWith("v1."));
    expect(sealed).toBeDefined();
    expect(String(sealed)).not.toContain("rt");
    expect(update!.params).toContain("sc-domain:acme.co.za");
  });
});

describe("GSC token refresh", () => {
  it("refreshes an expired access token and persists it", async () => {
    const keyring = buildKeyring({ purpose: "seo", companyId: "co-1", secret: "resolved:encryptionKey" });
    const sealed = sealJson({ accessToken: "old", refreshToken: "rt", expiresAt: 0, scope: "s" }, keyring);
    const integration = { id: "int-1", company_id: "co-1", sprint_id: "sp-1", provider: "gsc", status: "connected", property_url: "sc-domain:acme.co.za", token_sealed: sealed, scopes: [], settings: {}, stats: {}, alert_issue_id: null };
    const host = fakeHost([[/FROM plugin_seo_8099f8879a\.integrations/, () => [integration]]], {
      encryptionKey: { type: "secret_ref", secretId: "k" },
      google: { clientId: "cid", clientSecret: { type: "secret_ref", secretId: "s" } },
    });
    host.env.fetch = vi.fn(async () => new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 })));
    const { companyInfo } = await import("../src/service/common.js");
    const info = await companyInfo(host.env, "co-1");
    const access = await gscAccess(host.env, info, { id: "sp-1", companyId: "co-1" } as never, { needProperty: true });
    expect(access.accessToken).toBe("fresh");
    const persisted = host.executes.find((e) => e.sql.includes("token_sealed"));
    expect(persisted).toBeDefined();
    expect(persisted!.params.some((p) => typeof p === "string" && p.startsWith("v1."))).toBe(true);
  });
});
