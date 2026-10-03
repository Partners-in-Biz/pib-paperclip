/**
 * 0.8.0 (Q9-10): connecting an account closes the loop it was asked for. An agent that needs an account asks the owner once;
 * when the owner connects it (or reconnects it) the asking issue gets a comment, is handed back to the agent and woken, and
 * the account's own "Reconnect" issue closes. An ask can also carry an effect that checks the connection is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildKeyring } from "@partnersinbiz/pib-plugin-kit";
import { CONNECT_EFFECT_KEY, connectedComment, connectEffect, issueOfRun, recordConnectRequest, resolveConnectRequests } from "../src/connect-requests.js";
import { NAMESPACE } from "../src/namespace.js";
import { completeOAuth, confirmPicker } from "../src/oauth/flow.js";
import { connectAccountRecord } from "../src/service.js";
import { account } from "./world.js";
import { fakeCtx, fastNetwork, json, mockFetch, TEST_UI_BASE } from "./helpers.js";

const T = (name: string) => `${NAMESPACE}.${name}`;
const AGENT = { companyId: "co", userId: null, agentId: "ag-1", runId: "run-1", isAgent: true };
const PERSON = { companyId: "co", userId: "owner-1", agentId: null, runId: null, isAgent: false };
const CLIENT = { kind: "company" as const, id: "c1" };

interface RequestRow { id: string; company_id: string; platform: string; client_kind: string | null; client_ref: string | null; client_name: string | null; agent_id: string | null; run_id: string | null; issue_id: string | null; status: string; account_id: string | null }

function world(opts: { runs?: Record<string, string>; issues?: Record<string, { status: string; assigneeAgentId?: string | null; assigneeUserId?: string | null }>; accounts?: Array<Record<string, unknown>> } = {}) {
  const requests: RequestRow[] = [];
  const issues = { ...(opts.issues ?? {}) };
  const comments: Array<{ id: string; body: string }> = [];
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const wakeups: string[] = [];
  const scopeMatches = (sql: string, params: unknown[], row: RequestRow, first: number) =>
    sql.includes("client_ref IS NULL") ? !row.client_ref : row.client_ref === params[first + 1] && (row.client_kind ?? "company") === params[first];
  const ctx = fakeCtx(
    {
      issues: {
        get: vi.fn(async (id: string) => (issues[id] ? { id, ...issues[id] } : null)),
        update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
          updates.push({ id, patch });
          if (issues[id]) Object.assign(issues[id]!, patch);
          return { id };
        }),
        createComment: vi.fn(async (id: string, body: string) => {
          comments.push({ id, body });
          return { id: "c" };
        }),
        requestWakeup: vi.fn(async (id: string) => {
          wakeups.push(id);
          return { queued: true };
        }),
      },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    },
    {
      queryResult: (sql, params) => {
        if (sql.includes("FROM public.heartbeat_runs")) return opts.runs?.[String(params[0])] ? [{ issue_id: opts.runs[String(params[0])] }] : [];
        if (sql.includes(`FROM ${T("connect_requests")}`) && sql.includes("AND issue_id = $3")) {
          return requests.filter((r) => r.status === "open" && r.platform === params[1] && r.issue_id === params[2] && scopeMatches(sql, params, r, 3)).map((r) => ({ id: r.id }));
        }
        if (sql.includes(`FROM ${T("connect_requests")}`) && sql.includes("SELECT id, issue_id, agent_id")) {
          return requests.filter((r) => r.status === "open" && r.platform === params[1] && scopeMatches(sql, params, r, 2)).map((r) => ({ id: r.id, issue_id: r.issue_id, agent_id: r.agent_id }));
        }
        if (sql.includes(`FROM ${T("accounts")}`) && !sql.includes("GROUP BY")) {
          return (opts.accounts ?? []).filter((a) => (sql.includes("client_ref IS NULL") ? !a.client_ref : a.client_ref === params[2]));
        }
        return [];
      },
      executeResult: (sql, params) => {
        if (sql.startsWith(`INSERT INTO ${T("connect_requests")}`)) {
          requests.push({ id: String(params[0]), company_id: String(params[1]), platform: String(params[2]), client_kind: params[3] as string | null, client_ref: params[4] as string | null, client_name: params[5] as string | null, agent_id: params[6] as string | null, run_id: params[7] as string | null, issue_id: params[8] as string | null, status: "open", account_id: null });
          return 1;
        }
        if (sql.includes(`UPDATE ${T("connect_requests")} SET agent_id = $3`)) {
          const r = requests.find((x) => x.id === params[0])!;
          r.agent_id = params[2] as string | null;
          r.run_id = params[3] as string | null;
          return 1;
        }
        if (sql.includes(`UPDATE ${T("connect_requests")} SET status = 'resolved'`)) {
          const r = requests.find((x) => x.id === params[0] && x.status === "open");
          if (!r) return 0;
          r.status = "resolved";
          r.account_id = params[2] as string | null;
          return 1;
        }
        return 1;
      },
    },
  );
  return { ctx, requests, issues, comments, updates, wakeups };
}

describe("the issue an agent is working on", () => {
  it("comes from its run, and is null when there is no run, no agent or the host cannot be read", async () => {
    const w = world({ runs: { "run-1": "iss-5" } });
    expect(await issueOfRun(w.ctx, "co", "ag-1", "run-1")).toBe("iss-5");
    expect(await issueOfRun(w.ctx, "co", "ag-1", "run-9")).toBeNull();
    expect(await issueOfRun(w.ctx, "co", null, "run-1")).toBeNull();
    expect(await issueOfRun(w.ctx, "co", "ag-1", null)).toBeNull();
    const q = w.ctx.fakeDb.queries[0]!;
    expect(q.params).toEqual(["run-1", "co", "ag-1"]);
    const broken = fakeCtx({}, { queryResult: () => { throw new Error("no table"); } });
    expect(await issueOfRun(broken, "co", "ag-1", "run-1")).toBeNull();
  });
});

describe("recording the wish", () => {
  const wish = { platform: "facebook", scope: CLIENT, clientName: "Acme", agentId: "ag-1", runId: "run-1", issueId: "iss-5" };

  it("one open request per platform, scope and issue: asking again only refreshes the run", async () => {
    const w = world();
    const first = await recordConnectRequest(w.ctx, "co", wish);
    expect(first.id).toBeTruthy();
    expect(w.requests).toMatchObject([{ platform: "facebook", client_kind: "company", client_ref: "c1", client_name: "Acme", agent_id: "ag-1", issue_id: "iss-5", status: "open" }]);
    const again = await recordConnectRequest(w.ctx, "co", { ...wish, runId: "run-2" });
    expect(again.id).toBe(first.id);
    expect(w.requests).toHaveLength(1);
    expect(w.requests[0]!.run_id).toBe("run-2");
    // Another platform, another client or another issue is a different wish.
    await recordConnectRequest(w.ctx, "co", { ...wish, platform: "linkedin" });
    await recordConnectRequest(w.ctx, "co", { ...wish, scope: null, clientName: null });
    await recordConnectRequest(w.ctx, "co", { ...wish, issueId: "iss-6" });
    expect(w.requests).toHaveLength(4);
  });

  it("without an issue there is nothing to wake, so nothing is recorded; a database failure never breaks the tool", async () => {
    const w = world();
    expect(await recordConnectRequest(w.ctx, "co", { ...wish, issueId: null })).toEqual({ id: null, issueId: null });
    expect(w.requests).toEqual([]);
    const broken = fakeCtx({ logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } }, { queryResult: () => { throw new Error("db down"); } });
    expect(await recordConnectRequest(broken, "co", wish)).toEqual({ id: null, issueId: "iss-5" });
  });
});

describe("connect-account", () => {
  it("an agent's call is recorded against its issue and returns the effect to pass on the ask", async () => {
    const w = world({ runs: { "run-1": "iss-5" } });
    w.ctx.fakeDb.queryResult = ((orig) => (sql: string, params: unknown[]) => (sql.includes(`FROM ${T("crm_companies")}`) ? [{ id: "c1", name: "Acme", domain: null, lifecycle: null }] : orig(sql, params)))(w.ctx.fakeDb.queryResult);
    const out = await connectAccountRecord(w.ctx, AGENT, { platform: "facebook", client: "company:c1" }, null) as Record<string, unknown>;
    expect(out).toMatchObject({ platform: "facebook", link: "/social?tab=accounts&client=company%3Ac1", effect: { key: CONNECT_EFFECT_KEY, params: { platform: "facebook", client: "company:c1" } } });
    expect(String(out.noted)).toContain("Recorded against issue iss-5");
    expect(String(out.noted)).toContain("Do not poll");
    expect(w.requests).toMatchObject([{ platform: "facebook", client_ref: "c1", issue_id: "iss-5", agent_id: "ag-1" }]);
  });

  it("an explicit issueId wins; with no issue at all it tells the agent how to get woken; a person gets the plain steps", async () => {
    const own = world({ runs: { "run-1": "iss-from-run" } });
    const explicit = await connectAccountRecord(own.ctx, AGENT, { platform: "linkedin", issueId: "iss-7" }, null) as Record<string, unknown>;
    expect(own.requests[0]).toMatchObject({ issue_id: "iss-7", client_ref: null });
    expect(explicit.effect).toEqual({ key: CONNECT_EFFECT_KEY, params: { platform: "linkedin", client: "own" } });
    const none = world();
    const out = await connectAccountRecord(none.ctx, AGENT, { platform: "linkedin" }, null) as Record<string, unknown>;
    expect(out.effect).toBeUndefined();
    expect(String(out.noted)).toContain("Pass the issue you are working on as issueId");
    const person = world();
    const plain = await connectAccountRecord(person.ctx, PERSON, { platform: "linkedin" }, null) as Record<string, unknown>;
    expect(plain.effect).toBeUndefined();
    expect(plain.noted).toBeUndefined();
    expect(person.requests).toEqual([]);
  });
});

describe("a connection answers the requests it matches", () => {
  const connected = { platform: "facebook", accountId: "a1", displayName: "Acme Page", scope: CLIENT, reconnected: false };

  async function asked(extra: Parameters<typeof world>[0] = {}) {
    const w = world(extra);
    await recordConnectRequest(w.ctx, "co", { platform: "facebook", scope: CLIENT, clientName: "Acme", agentId: "ag-1", runId: "run-1", issueId: "iss-5" });
    return w;
  }

  it("comments on the asking issue, hands it back from the owner to the agent that asked, and wakes it", async () => {
    // ask-owner left the issue with the owner (in review).
    const w = await asked({ issues: { "iss-5": { status: "in_review", assigneeUserId: "owner-1", assigneeAgentId: null } } });
    const result = await resolveConnectRequests(w.ctx, "co", connected, "Acme");
    expect(result).toEqual({ resolved: 1, reconnectClosed: false });
    expect(w.requests[0]).toMatchObject({ status: "resolved", account_id: "a1" });
    expect(w.comments).toEqual([{ id: "iss-5", body: connectedComment(connected, "Acme") }]);
    expect(w.comments[0]!.body).toBe("**Connected:** Facebook · Acme Page (client Acme) is connected. You can carry on: `list-connected-accounts` shows it as connected, and nothing more is needed from the owner for this.");
    expect(w.updates).toEqual([{ id: "iss-5", patch: { status: "todo", assigneeAgentId: "ag-1", assigneeUserId: null } }]);
    expect(w.wakeups).toEqual(["iss-5"]);
  });

  it("an issue already with an agent is only commented on and woken; a closed one is left alone", async () => {
    const withAgent = await asked({ issues: { "iss-5": { status: "in_progress", assigneeAgentId: "ag-1", assigneeUserId: null } } });
    await resolveConnectRequests(withAgent.ctx, "co", connected);
    expect(withAgent.updates).toEqual([]);
    expect(withAgent.comments).toHaveLength(1);
    expect(withAgent.wakeups).toEqual(["iss-5"]);
    const closed = await asked({ issues: { "iss-5": { status: "done" } } });
    await resolveConnectRequests(closed.ctx, "co", connected);
    expect(closed.comments).toEqual([]);
    expect(closed.wakeups).toEqual([]);
    expect(closed.requests[0]!.status).toBe("resolved");
  });

  it("answers only the platform and scope that were connected", async () => {
    const w = await asked({ issues: { "iss-5": { status: "in_review", assigneeUserId: "owner-1" } } });
    expect((await resolveConnectRequests(w.ctx, "co", { ...connected, platform: "linkedin" })).resolved).toBe(0);
    expect((await resolveConnectRequests(w.ctx, "co", { ...connected, scope: null })).resolved).toBe(0);
    expect((await resolveConnectRequests(w.ctx, "co", { ...connected, scope: { kind: "company", id: "other" } })).resolved).toBe(0);
    expect(w.requests[0]!.status).toBe("open");
    expect(w.wakeups).toEqual([]);
    expect((await resolveConnectRequests(w.ctx, "co", connected)).resolved).toBe(1);
    // Resolved once: a second connection finds nothing waiting.
    expect((await resolveConnectRequests(w.ctx, "co", connected)).resolved).toBe(0);
    expect(w.wakeups).toEqual(["iss-5"]);
  });

  it("a reconnect closes the account's own Reconnect issue with a note", async () => {
    const w = world({ issues: { "iss-rc": { status: "todo", assigneeUserId: "owner-1" } } });
    const result = await resolveConnectRequests(w.ctx, "co", { ...connected, reconnected: true, reconnectIssueId: "iss-rc" }, "Acme");
    expect(result).toEqual({ resolved: 0, reconnectClosed: true });
    expect(w.comments[0]).toEqual({ id: "iss-rc", body: "Facebook · Acme Page is signed in again. Closing this issue." });
    expect(w.updates).toEqual([{ id: "iss-rc", patch: { status: "done" } }]);
    const gone = world();
    expect((await resolveConnectRequests(gone.ctx, "co", { ...connected, reconnectIssueId: "iss-none" })).reconnectClosed).toBe(false);
  });

  it("never throws: a host that refuses the comment does not fail the connection", async () => {
    const w = await asked({ issues: { "iss-5": { status: "in_review", assigneeUserId: "owner-1" } } });
    (w.ctx.issues.createComment as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("host down"));
    await expect(resolveConnectRequests(w.ctx, "co", connected)).resolves.toMatchObject({ resolved: 1 });
    const unreadable = fakeCtx({}, { queryResult: () => { throw new Error("db down"); } });
    await expect(resolveConnectRequests(unreadable, "co", connected)).resolves.toEqual({ resolved: 0, reconnectClosed: false });
  });
});

describe("the connect flow resolves the ask (OAuth completion)", () => {
  beforeEach(() => fastNetwork());
  afterEach(() => vi.unstubAllGlobals());

  const REF = (id: string) => ({ type: "secret_ref", secretId: id });
  const CONFIG = { publicBaseUrl: "https://paperclip.example.com", encryptionKey: REF("enc"), platforms: { facebook: { clientId: "fb-id", clientSecret: REF("fb") } } };
  const SECRETS: Record<string, string> = { enc: "a-very-long-encryption-key-123", fb: "fb-secret" };
  void buildKeyring;

  it("an agent asks, the owner signs in, and the issue is handed back and woken", async () => {
    const session = { state: "st-1", company_id: "co", platform: "facebook", account_label: "Facebook", extra: { clientKind: "company", clientRef: "c1", clientName: "Acme" }, pending_options: null as string | null, created_by_user_id: "owner-1", picker_id: null as string | null, status: "started", expires_at: new Date(Date.now() + 600_000) };
    const w = world({ issues: { "iss-5": { status: "in_review", assigneeUserId: "owner-1", assigneeAgentId: null } } });
    const ctx = fakeCtx(
      {
        issues: w.ctx.issues,
        config: { get: vi.fn(async () => CONFIG) },
        secrets: { resolve: vi.fn(async (ref: { secretId: string }) => SECRETS[ref.secretId] ?? "") },
        companies: { get: vi.fn(async () => ({ id: "co", issuePrefix: "PIB" })) },
        projects: { managed: { get: vi.fn(async () => ({ projectId: "proj-social" })) } },
        agents: { managed: { get: vi.fn(async () => ({ agentId: null })) }, get: vi.fn(async () => null) },
        state: { get: vi.fn(async (key: { stateKey?: string }) => (key.stateKey === "plugin-ui-base" ? TEST_UI_BASE : null)), set: vi.fn(), delete: vi.fn() },
      },
      {
        queryResult: (sql, params) => {
          if (sql.includes(`FROM ${T("oauth_sessions")}`) && sql.includes("WHERE state = $1")) return params[0] === session.state ? [session] : [];
          if (sql.includes("WHERE picker_id = $1")) return params[0] === session.picker_id && session.status === "pending_selection" ? [session] : [];
          if (sql.includes(`FROM ${T("connect_requests")}`) && sql.includes("SELECT id, issue_id, agent_id")) return w.requests.filter((r) => r.status === "open" && r.platform === params[1] && r.client_ref === params[3]).map((r) => ({ id: r.id, issue_id: r.issue_id, agent_id: r.agent_id }));
          if (sql.includes(`FROM ${T("crm_companies")}`)) return [{ id: "c1", name: "Acme", domain: null, lifecycle: null }];
          if (sql.includes(`FROM ${T("accounts")}`) && sql.includes("external_id = $3")) return [{ ...account("a-existing", { platform: "facebook", external_id: "p2", client_kind: "company", client_ref: "c1", client_name: "Acme", reconnect_issue_id: "iss-rc" }) }];
          return [];
        },
        executeResult: (sql, params) => {
          if (sql.includes("SET status = 'exchanging'")) return session.status === "started" ? ((session.status = "exchanging"), 1) : 0;
          if (sql.includes("SET status = 'pending_selection'")) {
            session.status = "pending_selection";
            session.picker_id = String(params[1]);
            session.pending_options = String(params[2]);
            return 1;
          }
          if (sql.includes(`UPDATE ${T("connect_requests")} SET status = 'resolved'`)) {
            const r = w.requests.find((x) => x.id === params[0] && x.status === "open");
            if (!r) return 0;
            r.status = "resolved";
            return 1;
          }
          return 1;
        },
      },
    );
    // The agent's wish was recorded while it worked on iss-5.
    w.requests.push({ id: "r1", company_id: "co", platform: "facebook", client_kind: "company", client_ref: "c1", client_name: "Acme", agent_id: "ag-1", run_id: "run-1", issue_id: "iss-5", status: "open", account_id: null });
    w.issues["iss-rc"] = { status: "todo", assigneeUserId: "owner-1" };
    mockFetch([
      ["GET https://graph.facebook.com/v21.0/oauth/access_token", (url) => json(url.searchParams.get("grant_type") ? { access_token: "long", expires_in: 5_184_000 } : { access_token: "short" })],
      ["GET https://graph.facebook.com/v21.0/me/accounts", () => json({ data: [{ id: "p2", name: "Client", access_token: "pt2" }] })],
    ]);
    const done = await completeOAuth(ctx, { companyId: "co", userId: "owner-1", state: "st-1", params: { code: "c", state: "st-1" } });
    // One account: saved at once (no picker). The page it returns to is the client's workspace.
    expect(done).toMatchObject({ connected: 1 });
    expect(w.requests[0]!.status).toBe("resolved");
    expect(w.comments.map((c) => c.id).sort()).toEqual(["iss-5", "iss-rc"]);
    expect(w.updates).toContainEqual({ id: "iss-5", patch: { status: "todo", assigneeAgentId: "ag-1", assigneeUserId: null } });
    expect(w.updates).toContainEqual({ id: "iss-rc", patch: { status: "done" } });
    expect(w.wakeups).toEqual(["iss-5"]);
    void confirmPicker;
  });
});

describe("the ask effect", () => {
  const ask = (params: Record<string, string | number | boolean | null>, answer = "Yes") => ({
    key: "ask:a1:t", askId: "a1", issueId: "iss-5", kind: "grant", effect: { key: CONNECT_EFFECT_KEY, params }, question: "q", options: [], answer, answeredByUserId: "owner-1", answeredAt: "2026-10-03T08:00:00Z", returnAgentId: "ag-1",
  });
  const input = (w: ReturnType<typeof world>, params: Record<string, string | number | boolean | null>) => ({ ctx: w.ctx, companyId: "co", ask: ask(params), decision: "approve" as const, optionIndex: null });
  const live = { id: "a1", platform: "facebook", display_name: "Acme Page", token_enc: "v1.x", status: "connected", client_ref: "c1", client_kind: "company" };

  it("whitelists its params: a known platform, an own/company/contact scope, nothing else", () => {
    const w = world();
    expect(connectEffect.validate!(input(w, { platform: "facebook", client: "company:c1" }))).toBeNull();
    expect(connectEffect.validate!(input(w, { platform: "facebook", client: "own" }))).toBeNull();
    expect(connectEffect.validate!(input(w, { platform: "facebook" }))).toBeNull();
    expect(connectEffect.validate!(input(w, { platform: "myspace" }))).toContain("must be one of");
    expect(connectEffect.validate!(input(w, { platform: "facebook", client: "company:../x" }))).toContain("not in the expected form");
    expect(connectEffect.validate!(input(w, { platform: "facebook", scope: "all" }))).toContain('"scope" is not a parameter this effect accepts');
    expect(connectEffect.validate!(input(w, {}))).toContain('"platform" is required');
  });

  it("applies only by reading: a connected account is reported, a missing one is a failure the agent is told about", async () => {
    const w = world({ accounts: [live] });
    await expect(connectEffect.apply(input(w, { platform: "facebook", client: "company:c1" }))).resolves.toEqual({ detail: "Facebook · Acme Page is connected (company:c1)." });
    expect(await connectEffect.verify!(input(w, { platform: "facebook", client: "company:c1" }))).toBe(true);
    await expect(connectEffect.apply(input(w, { platform: "linkedin", client: "company:c1" }))).rejects.toThrow("no LinkedIn account is connected in company:c1 yet: the sign-in was not completed");
    const stale = world({ accounts: [{ ...live, status: "needs_reconnect" }] });
    await expect(connectEffect.apply(input(stale, { platform: "facebook", client: "company:c1" }))).rejects.toThrow("need reconnecting");
    expect(await connectEffect.verify!(input(stale, { platform: "facebook", client: "company:c1" }))).toBe(false);
    // Nothing was written by any of this.
    expect(w.ctx.fakeDb.executes).toEqual([]);
  });
});
