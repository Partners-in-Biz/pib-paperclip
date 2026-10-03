/**
 * 0.7.2: the first plan of a scope. An account connecting (or the hourly
 * sweep) opens one "Plan social for <client or own work>" issue for a scope
 * that has a live account, no posts and no earlier plan; never twice.
 */
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { runDoneCheck, type DoneCheckIssue } from "@partnersinbiz/pib-plugin-kit";
import { OWN, rowScope } from "../src/clients.js";
import { checkPlan, SOCIAL_DONE_CHECKS } from "../src/done-checks.js";
import { NAMESPACE } from "../src/namespace.js";
import { ensurePlanForScope, planClaimKey, planDescription, planScopeKey, planScopeOfKey, planSweep, startPlan } from "../src/plan-trigger.js";
import { fakeCtx } from "./helpers.js";

const T = (name: string) => `${NAMESPACE}.${name}`;
const NOW = new Date("2026-10-03T08:00:00Z").getTime();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

interface AccountSeed {
  platform: string;
  display_name: string;
  client_kind?: string | null;
  client_ref?: string | null;
  client_name?: string | null;
  status?: string;
  /** `org` (default) or `personal`. */
  scope?: string;
}
interface PostSeed {
  client_ref?: string | null;
  source?: string;
  created_at?: string;
}
interface Claim {
  issue_id: string | null;
  /** Minutes since the claim was made (a claim without an issue older than ten minutes is taken over). */
  age?: number;
}

/** Accounts, posts and the claim table in memory; host issues, the linked agent and the module switch in fakes. */
function world(
  opts: { agent?: boolean | "paused"; moduleOff?: boolean; accounts?: AccountSeed[]; posts?: PostSeed[]; claims?: Record<string, Claim>; failQueries?: boolean } = {},
) {
  const accounts = opts.accounts ?? [{ platform: "facebook", display_name: "PiB" }];
  const posts = opts.posts ?? [];
  const claims = new Map<string, Claim>(Object.entries(opts.claims ?? {}));
  const created: Array<Record<string, unknown>> = [];
  const wakeups: string[] = [];
  const claimInserts: unknown[][] = [];
  const logs: string[] = [];

  const scopeMatch = (sql: string, params: unknown[], row: { client_kind?: string | null; client_ref?: string | null }) => {
    if (sql.includes("client_ref IS NULL")) return !row.client_ref;
    return row.client_ref === params[2] && (row.client_kind ?? "company") === params[1];
  };

  const ctx = fakeCtx(
    {
      state: {
        get: vi.fn(async (key: { namespace?: string }) => {
          if (key.namespace === "pib-hire") return opts.agent === false ? null : { agentId: "agent-1" };
          if (key.namespace === "pib-setup" && opts.moduleOff) return { modules: { social: false } };
          return null;
        }),
        set: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      },
      agents: {
        get: vi.fn(async (id: string) => ({ id, status: opts.agent === "paused" ? "paused" : "idle" })),
        managed: { get: vi.fn(async () => ({ agentId: null })) },
      },
      projects: { managed: { get: vi.fn(async () => ({ projectId: "proj-social" })) } },
      companies: { get: vi.fn(async () => ({ id: "co", issuePrefix: "PIB", defaultResponsibleUserId: "boss-1" })) },
      issues: {
        create: vi.fn(async (input: Record<string, unknown>) => {
          created.push(input);
          return { id: `iss-${created.length}` };
        }),
        requestWakeup: vi.fn(async (id: string) => {
          wakeups.push(id);
          return { queued: true };
        }),
      },
      logger: { info: (message: string) => void logs.push(message), warn: () => undefined, error: () => undefined, debug: () => undefined },
    },
    {
      queryResult: (sql, params) => {
        if (opts.failQueries) throw new Error("db down");
        if (sql.includes(`FROM ${T("handoffs")} WHERE key = $1`)) {
          const claim = claims.get(String(params[0]));
          return claim ? [{ issue_id: claim.issue_id }] : [];
        }
        if (sql.includes(`FROM ${T("accounts")}`) && sql.includes("GROUP BY client_kind, client_ref")) {
          const seen = new Map<string, unknown>();
          for (const a of accounts.filter((x) => ((x.status ?? "connected") === "connected" || x.status === "expiring") && (x.scope ?? "org") === "org")) {
            const key = `${a.client_kind ?? ""}:${a.client_ref ?? ""}`;
            if (!seen.has(key)) seen.set(key, { client_kind: a.client_kind ?? null, client_ref: a.client_ref ?? null, client_name: a.client_name ?? null });
          }
          return [...seen.values()];
        }
        if (sql.includes(`FROM ${T("accounts")}`) && sql.includes("status IN ('connected', 'expiring')")) {
          return accounts
            .filter((a) => ["connected", "expiring"].includes(a.status ?? "connected") && (a.scope ?? "org") === "org" && scopeMatch(sql, params, a))
            .map((a) => ({ platform: a.platform, display_name: a.display_name }));
        }
        if (sql.includes(`FROM ${T("posts")}`) && sql.includes("source NOT IN ('rss', 'inbox_reply')")) {
          const since = sql.includes("created_at >= $") ? Date.parse(String(params[params.length - 1])) : null;
          const n = posts.filter((p) => !["rss", "inbox_reply"].includes(p.source ?? "agent") && scopeMatch(sql, params, p) && (since === null || Date.parse(p.created_at ?? ago(0)) >= since)).length;
          return [{ n: String(n) }];
        }
        return [];
      },
      executeResult: (sql, params) => {
        if (sql.startsWith(`INSERT INTO ${T("handoffs")}`)) {
          const key = String(params[0]);
          const claim = claims.get(key);
          // ON CONFLICT ... WHERE issue_id IS NULL AND claimed_at < now() - 10 minutes
          if (claim && (claim.issue_id || (claim.age ?? 0) < 10)) return 0;
          claims.set(key, { issue_id: null, age: 0 });
          claimInserts.push(params);
          return 1;
        }
        if (sql.startsWith(`UPDATE ${T("handoffs")} SET issue_id = $3`)) {
          const claim = claims.get(String(params[0]));
          if (claim) claim.issue_id = String(params[2]);
          return claim ? 1 : 0;
        }
        return 1;
      },
    },
  );
  return { ctx, created, wakeups, claims, claimInserts, logs };
}

const ACME = rowScope({ client_kind: "company", client_ref: "c1", client_name: "Acme" });

describe("plan keys", () => {
  it("names a scope the same way in the origin id, the claim and the done-check", () => {
    expect(planScopeKey(null)).toBe("own");
    expect(planScopeKey({ kind: "company", id: "c1" })).toBe("company:c1");
    expect(planScopeKey({ kind: "contact", id: "ct1" })).toBe("contact:ct1");
    expect(planClaimKey("co", { kind: "company", id: "c1" })).toBe("plan:co:company:c1");
    expect(planScopeOfKey("own")).toBeNull();
    expect(planScopeOfKey("contact:ct1")).toEqual({ kind: "contact", id: "ct1" });
    expect(planScopeOfKey("nonsense")).toBeUndefined();
    expect(planScopeOfKey("")).toBeUndefined();
  });

  it("the issue text scopes the agent's tool calls and says how it is closed", () => {
    const own = planDescription(OWN, [{ platform: "facebook", display_name: "PiB" }, { platform: "linkedin", display_name: "PiB" }]);
    expect(own).toContain("Connected accounts: Facebook (PiB), LinkedIn (PiB).");
    expect(own).toContain("Scope: own work");
    expect(own).toContain("Plan key: `plan:own`");
    expect(own).toContain("Never approve a post");
    const client = planDescription(ACME, [{ platform: "x", display_name: "Acme" }]);
    expect(client).toContain("Acme has connected social accounts and no plan yet");
    expect(client).toContain('clientKind: "company"');
    expect(client).toContain('clientRef: "c1"');
    expect(client).toContain("Plan key: `plan:company:c1`");
  });
});

describe("the first plan of a scope", () => {
  it("opens one plan for own work: claimed first, assigned to the Social agent, woken, and recorded", async () => {
    const w = world();
    const outcome = await ensurePlanForScope(w.ctx, "co", OWN);
    expect(outcome).toEqual({ status: "opened", issueId: "iss-1" });
    expect(w.claimInserts).toHaveLength(1);
    expect(w.claimInserts[0]).toEqual(["plan:co:own", "co", "plan", JSON.stringify({ scope: "own", clientName: null })]);
    expect(w.created).toHaveLength(1);
    expect(w.created[0]).toMatchObject({
      companyId: "co",
      projectId: "proj-social",
      title: "Plan social for own work",
      status: "todo",
      priority: "medium",
      originKind: "plugin:partnersinbiz.social",
      originId: "plan:own",
      assigneeAgentId: "agent-1",
    });
    expect(w.wakeups).toEqual(["iss-1"]);
    expect(w.claims.get("plan:co:own")).toEqual({ issue_id: "iss-1", age: 0 });
  });

  it("opens a client's plan in the client's scope", async () => {
    const w = world({ accounts: [{ platform: "linkedin", display_name: "Acme", client_kind: "company", client_ref: "c1", client_name: "Acme" }] });
    expect(await ensurePlanForScope(w.ctx, "co", ACME)).toEqual({ status: "opened", issueId: "iss-1" });
    expect(w.created[0]).toMatchObject({ title: "Plan social for Acme", originId: "plan:company:c1", assigneeAgentId: "agent-1" });
    expect(String(w.created[0]!.description)).toContain("Connected accounts: LinkedIn (Acme).");
    expect(w.claimInserts[0]![0]).toBe("plan:co:company:c1");
  });

  it("never opens a second plan for the same scope", async () => {
    const w = world();
    expect(await ensurePlanForScope(w.ctx, "co", OWN)).toMatchObject({ status: "opened" });
    expect(await ensurePlanForScope(w.ctx, "co", OWN)).toEqual({ status: "exists", issueId: "iss-1" });
    expect(w.created).toHaveLength(1);
  });

  it("two connects at once (a picker saves two accounts) open one issue", async () => {
    const w = world({ accounts: [{ platform: "facebook", display_name: "PiB" }, { platform: "instagram", display_name: "pib" }] });
    const [a, b] = await Promise.all([ensurePlanForScope(w.ctx, "co", OWN), ensurePlanForScope(w.ctx, "co", OWN)]);
    expect(w.created).toHaveLength(1);
    expect([a.status, b.status].sort()).toEqual(["busy", "opened"]);
  });

  it("an earlier plan for the scope (a claim with an issue) is never reopened, even if it is closed", async () => {
    const w = world({ claims: { "plan:co:own": { issue_id: "iss-old" } } });
    expect(await ensurePlanForScope(w.ctx, "co", OWN)).toEqual({ status: "exists", issueId: "iss-old" });
    expect(w.created).toEqual([]);
  });

  it("a claim another run holds is left alone; one that crashed before opening its issue is taken over after ten minutes", async () => {
    const busy = world({ claims: { "plan:co:own": { issue_id: null, age: 2 } } });
    expect(await ensurePlanForScope(busy.ctx, "co", OWN)).toEqual({ status: "busy" });
    expect(busy.created).toEqual([]);
    const stale = world({ claims: { "plan:co:own": { issue_id: null, age: 30 } } });
    expect(await ensurePlanForScope(stale.ctx, "co", OWN)).toEqual({ status: "opened", issueId: "iss-1" });
  });

  it("needs a live account in the scope: none, or only ones that need reconnecting, plan nothing", async () => {
    const none = world({ accounts: [] });
    expect(await ensurePlanForScope(none.ctx, "co", OWN)).toEqual({ status: "no-accounts" });
    const broken = world({ accounts: [{ platform: "facebook", display_name: "PiB", status: "needs_reconnect" }] });
    expect(await ensurePlanForScope(broken.ctx, "co", OWN)).toEqual({ status: "no-accounts" });
    // A person's own profile cannot take company posts, so it is not a plan.
    const personal = world({ accounts: [{ platform: "linkedin", display_name: "Sam", scope: "personal" }] });
    expect(await ensurePlanForScope(personal.ctx, "co", OWN)).toEqual({ status: "no-accounts" });
    // Another scope's account does not count.
    const other = world({ accounts: [{ platform: "linkedin", display_name: "Acme", client_kind: "company", client_ref: "c1" }] });
    expect(await ensurePlanForScope(other.ctx, "co", OWN)).toEqual({ status: "no-accounts" });
    expect(none.created.length + broken.created.length + other.created.length + personal.created.length).toBe(0);
  });

  it("a scope that already has posts has a plan; RSS and reply drafts are not a plan", async () => {
    const planned = world({ posts: [{ client_ref: null, source: "agent" }] });
    expect(await ensurePlanForScope(planned.ctx, "co", OWN)).toEqual({ status: "planned" });
    expect(planned.created).toEqual([]);
    expect(planned.claimInserts).toEqual([]);
    const feeds = world({ posts: [{ client_ref: null, source: "rss" }, { client_ref: null, source: "inbox_reply" }] });
    expect(await ensurePlanForScope(feeds.ctx, "co", OWN)).toMatchObject({ status: "opened" });
    // A client's post does not plan own work.
    const client = world({ posts: [{ client_ref: "c1", source: "agent" }] });
    expect(await ensurePlanForScope(client.ctx, "co", OWN)).toMatchObject({ status: "opened" });
  });

  it("with no agent to take it, nothing is opened and nothing is claimed (the next try can)", async () => {
    for (const agent of [false, "paused"] as const) {
      const w = world({ agent });
      expect(await ensurePlanForScope(w.ctx, "co", OWN)).toEqual({ status: "no-agent" });
      expect(w.created).toEqual([]);
      expect(w.claimInserts).toEqual([]);
    }
  });

  it("does nothing when the company switched Social off in Setup", async () => {
    const w = world({ moduleOff: true });
    expect(await ensurePlanForScope(w.ctx, "co", OWN)).toEqual({ status: "off" });
    expect(w.created).toEqual([]);
  });

  it("startPlan never throws, so a failed plan never fails the connection", async () => {
    const w = world({ failQueries: true });
    await expect(startPlan(w.ctx, "co", OWN)).resolves.toBeNull();
    expect(w.logs).toContain("First social plan not opened; the hourly check tries again");
    const ok = world();
    await expect(startPlan(ok.ctx, "co", OWN)).resolves.toEqual({ status: "opened", issueId: "iss-1" });
  });

  it("every statement passed the host SQL guard copy", async () => {
    const w = world({ accounts: [{ platform: "linkedin", display_name: "Acme", client_kind: "company", client_ref: "c1", client_name: "Acme" }] });
    expect(await ensurePlanForScope(w.ctx, "co", ACME)).toMatchObject({ status: "opened" });
    const db = (w.ctx as PluginContext & { fakeDb: { queries: unknown[]; executes: Array<{ sql: string }> } }).fakeDb;
    expect(db.queries.length).toBeGreaterThan(0);
    expect(db.executes.map((e) => e.sql.split(/\s+/)[0])).toEqual(["INSERT", "UPDATE"]);
  });
});

describe("the hourly sweep", () => {
  it("gives every scope with a live account its first plan, once", async () => {
    const w = world({
      accounts: [
        { platform: "facebook", display_name: "PiB" },
        { platform: "linkedin", display_name: "PiB" },
        { platform: "x", display_name: "Acme", client_kind: "company", client_ref: "c1", client_name: "Acme" },
        { platform: "x", display_name: "Beta", client_kind: "company", client_ref: "c2", client_name: "Beta", status: "needs_reconnect" },
      ],
    });
    expect(await planSweep(w.ctx, "co")).toEqual({ scopes: 2, opened: 2 });
    expect(w.created.map((c) => [c.title, c.originId])).toEqual([
      ["Plan social for own work", "plan:own"],
      ["Plan social for Acme", "plan:company:c1"],
    ]);
    expect(await planSweep(w.ctx, "co")).toEqual({ scopes: 2, opened: 0 });
    expect(w.created).toHaveLength(2);
  });

  it("skips scopes that already have posts, and never throws", async () => {
    const w = world({ posts: [{ client_ref: null, source: "agent" }] });
    expect(await planSweep(w.ctx, "co")).toEqual({ scopes: 1, opened: 0 });
    const down = world({ failQueries: true });
    expect(await planSweep(down.ctx, "co")).toEqual({ scopes: 0, opened: 0 });
  });
});

describe("done-check for a first plan", () => {
  const issue = (originId: string, createdAt: string | null = ago(120)): DoneCheckIssue => ({
    id: "iss-p", companyId: "co", identifier: "PIB-9", title: "Plan social for own work", originId, assigneeAgentId: "agent-1", createdAt,
  });

  it("is done once a post was drafted in the scope after the issue opened", async () => {
    const w = world({ posts: [{ client_ref: null, source: "agent", created_at: ago(30) }] });
    expect(await checkPlan(issue("plan:own"), w.ctx)).toEqual({ done: true });
  });

  it("is not done while the scope has only older posts, other scopes' posts or feed drafts", async () => {
    const w = world({ posts: [{ client_ref: null, source: "agent", created_at: ago(500) }, { client_ref: "c1", source: "agent", created_at: ago(10) }, { client_ref: null, source: "rss", created_at: ago(10) }] });
    const result = await checkPlan(issue("plan:own"), w.ctx);
    expect(result.done).toBe(false);
    expect(result.missing?.[0]).toContain("No post has been drafted for own work since this plan opened");
    expect(result.missing?.[0]).toContain("`get-playbook`");
  });

  it("names the client in the tool calls for client work", async () => {
    const w = world({ accounts: [{ platform: "x", display_name: "Acme", client_kind: "company", client_ref: "c1" }] });
    const result = await checkPlan(issue("plan:company:c1"), w.ctx);
    expect(result.done).toBe(false);
    expect(result.missing?.[0]).toContain("this client");
    expect(result.missing?.[0]).toContain('client: "company:c1"');
  });

  it("is done when there is nothing left to plan for, or the key is not ours", async () => {
    const none = world({ accounts: [] });
    expect(await checkPlan(issue("plan:own"), none.ctx)).toEqual({ done: true });
    const w = world();
    expect(await checkPlan(issue("plan:???"), w.ctx)).toEqual({ done: true });
  });

  it("counts any post in the scope when the issue has no creation time", async () => {
    const w = world({ posts: [{ client_ref: null, source: "agent", created_at: ago(9000) }] });
    expect(await checkPlan(issue("plan:own", null), w.ctx)).toEqual({ done: true });
  });
});

describe("through the kit's done-check runner", () => {
  function closed(originId: string, posts: PostSeed[]) {
    const w = world({ posts });
    const issue: Record<string, unknown> = { id: "iss-p", title: "Plan social for own work", status: "done", originKind: "plugin:partnersinbiz.social", originId, assigneeAgentId: "agent-1", createdAt: ago(60) };
    const updates: Array<Record<string, unknown>> = [];
    const comments: string[] = [];
    const issues = (w.ctx as unknown as { issues: Record<string, unknown> }).issues;
    issues.get = vi.fn(async () => issue);
    issues.update = vi.fn(async (_id: string, patch: Record<string, unknown>) => void updates.push(patch));
    issues.createComment = vi.fn(async (_id: string, body: string) => void comments.push(body));
    return { ctx: w.ctx, updates, comments };
  }
  const agentClose = { entityId: "iss-p", companyId: "co", actorType: "agent" as const };

  it("an agent closing a first plan with nothing drafted gets it reopened with what is missing; a drafted one passes", async () => {
    const early = closed("plan:own", []);
    expect(await runDoneCheck(early.ctx, SOCIAL_DONE_CHECKS, agentClose)).toBe("reopened");
    expect(early.updates).toEqual([{ status: "todo" }]);
    expect(early.comments[0]).toContain("First social plan");
    expect(early.comments[0]).toContain("No post has been drafted for own work");
    expect(await runDoneCheck(closed("plan:own", [{ client_ref: null, source: "agent", created_at: ago(5) }]).ctx, SOCIAL_DONE_CHECKS, agentClose)).toBe("passed");
  });

  it("the weekly routine's own issues (routine_execution, the routine's uuid) match no rule and are never checked", async () => {
    const routineIssue = closed("1f4b4a64-033f-43cf-ba05-8e5171fe4f57", []);
    expect(await runDoneCheck(routineIssue.ctx, SOCIAL_DONE_CHECKS, agentClose)).toBe("skipped");
    expect(routineIssue.updates).toEqual([]);
  });
});
