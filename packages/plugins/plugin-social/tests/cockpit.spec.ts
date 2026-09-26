import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { accountChecks, cockpitSnapshot, formatLift, publishCockpitSnapshots, rateTone, SOCIAL_JOBS } from "../src/cockpit.js";
import manifest from "../src/manifest.js";
import { NAMESPACE } from "../src/namespace.js";
import plugin from "../src/worker.js";
import { fakeCtx } from "./helpers.js";

const T = (name: string) => `${NAMESPACE}.${name}`;
const HOUR = 3600_000;

type State = Record<string, unknown>;

function ctxWith(rows: (sql: string, params: unknown[]) => unknown[], state: State = {}, extra: Record<string, unknown> = {}) {
  return fakeCtx(
    {
      state: {
        get: vi.fn(async (key: { namespace?: string; stateKey: string }) => state[`${key.namespace}:${key.stateKey}`] ?? null),
        set: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      },
      agents: { get: vi.fn(async () => null), managed: { get: vi.fn(async () => ({ agentId: null })) } },
      events: { emit: vi.fn(async () => undefined), on: vi.fn() },
      ...extra,
    },
    { queryResult: rows },
  );
}

describe("cockpit snapshot (unconfigured)", () => {
  it("returns zeros, jobs that have not run and nothing waiting", async () => {
    const ctx = ctxWith(() => []);
    const snap = await cockpitSnapshot(ctx, "co");
    expect(snap).toMatchObject({ plugin: "partnersinbiz.social", title: "Social", waiting: [], activity: [] });
    expect(snap.kpis.map((k) => k.key)).toEqual(["posts_published_7d", "posts_scheduled_7d", "engagement_lift_7d", "inbox_needs_reply", "experiments_running"]);
    expect(snap.kpis.find((k) => k.key === "engagement_lift_7d")).toMatchObject({ value: "—", raw: null, tone: "neutral", group: "marketing" });
    expect(snap.kpis.every((k) => k.href?.startsWith("/social"))).toBe(true);
    const jobs = snap.health.filter((h) => h.key.startsWith("job:"));
    expect(jobs.map((j) => j.key)).toEqual(SOCIAL_JOBS.map((j) => `job:${j.key}`));
    expect(jobs.every((j) => j.status === "ok" && j.detail === "Has not run yet.")).toBe(true);
    expect(snap.health.find((h) => h.key === "accounts")).toMatchObject({ status: "ok" });
    expect(snap.health.find((h) => h.key === "publish-failures")).toMatchObject({ status: "ok" });
    // Every statement passed the host SQL guard copy (fakeCtx validates each one) and nothing was written.
    expect(ctx.fakeDb.executes).toEqual([]);
  });

  it("one failing query never breaks the snapshot", async () => {
    const ctx = ctxWith((sql) => {
      if (sql.includes("percentile_cont")) throw new Error("boom");
      return [];
    });
    const snap = await cockpitSnapshot(ctx, "co");
    expect(snap.kpis).toEqual([]);
    expect(snap.health.length).toBeGreaterThan(SOCIAL_JOBS.length);
    expect(snap.quality.length).toBe(4);
  });
});

describe("cockpit snapshot (configured)", () => {
  const now = Date.now();
  const state: State = {
    "pib-cockpit-jobs:job:publish-due": { lastStartedAt: null, lastOkAt: new Date(now - 60_000).toISOString(), lastErrorAt: null, lastError: null, consecutiveFailures: 0 },
    "pib-cockpit-jobs:job:poll-inbox": { lastStartedAt: null, lastOkAt: new Date(now - 60 * 60_000).toISOString(), lastErrorAt: new Date(now).toISOString(), lastError: "429 rate limited", consecutiveFailures: 2 },
    "pib-cockpit-jobs:job:refresh-tokens": { lastStartedAt: null, lastOkAt: new Date(now - 10 * HOUR).toISOString(), lastErrorAt: null, lastError: null, consecutiveFailures: 0 },
  };
  const rows = (sql: string) => {
    if (sql.includes("percentile_cont")) return [{ published: "4", scheduled: "3", inbox: "7", experiments: "1", lift: "0.18", scored: "9" }];
    if (sql.includes(`FROM ${T("accounts")}`)) {
      return [
        { id: "a1", platform: "linkedin", display_name: "PiB", status: "needs_reconnect", client_kind: null, client_ref: null, client_name: null, token_expires_at: null, last_error: "invalid_grant", updated_at: "2026-09-25T10:00:00Z" },
        { id: "a2", platform: "facebook", display_name: "Acme page", status: "expiring", client_kind: "company", client_ref: "c1", client_name: "Acme", token_expires_at: "2026-09-30T00:00:00Z", last_error: null, updated_at: null },
      ];
    }
    if (sql.includes("min(updated_at)")) return [{ failed: "2", since: "2026-09-26T01:00:00Z" }];
    if (sql.includes(`FROM ${T("posts")} WHERE company_id = $1 AND status = 'review'`)) {
      return [
        { id: "p1", body: "Launch day for the new site", client_kind: null, client_ref: null, client_name: null, review_issue_id: "iss-r1", updated_at: "2026-09-26T08:00:00Z" },
        { id: "p2", body: "Acme spring sale", client_kind: "company", client_ref: "c1", client_name: "Acme", review_issue_id: null, updated_at: "2026-09-26T09:00:00Z" },
      ];
    }
    if (sql.includes("triage->>'action' = 'escalated'")) return [{ id: "i1", platform: "x", kind: "comment", body: "I will sue you", client_kind: null, client_ref: null, client_name: null, triage_issue_id: "iss-e1", created_at: "2026-09-26T07:00:00Z" }];
    if (sql.includes(`FROM ${T("growth_playbook_changes")} c`)) return [{ id: "ch1", reason: "Carousels beat single images", approval_issue_id: "iss-g1", created_at: "2026-09-25T00:00:00Z", client_kind: null, client_ref: null, client_name: null }];
    if (sql.includes(`FROM ${T("growth_experiments")} e`)) return [{ id: "e1", hypothesis: "Questions in the hook lift comments", approval_issue_id: "iss-g1", created_at: "2026-09-24T00:00:00Z", client_kind: null, client_ref: null, client_name: null }];
    if (sql.includes("p.published_at IS NOT NULL")) return [{ id: "p9", body: "Case study: Acme", client_kind: null, client_ref: null, client_name: null, published_at: "2026-09-26T06:00:00Z", status: "published", created_by_agent_id: "ag-1", n: "3" }];
    if (sql.includes("measured_at IS NOT NULL")) return [{ hypothesis: "Morning posts", verdict: "no_change", measured_at: "2026-09-25T03:50:00Z" }];
    if (sql.includes("review_returns > 0)::text AS returned")) return [{ returned: "3", reviewed: "10", exp_rejected: "1", exp_approved: "1", ch_discarded: "0", ch_kept: "2", dest_failed: "2", dest_total: "8" }];
    if (sql.includes(`FROM ${T("decisions")}`)) return [{ purpose: "social-inbox-triage", question_key: "intent", total: "20", corrected: "6", avg_confidence: "0.8" }];
    return [];
  };

  it("fills KPIs, health, waiting, activity and quality", async () => {
    const snap = await cockpitSnapshot(ctxWith(rows, state), "co");
    const kpi = Object.fromEntries(snap.kpis.map((k) => [k.key, k]));
    expect(kpi.posts_published_7d).toMatchObject({ value: "4", raw: 4 });
    expect(kpi.posts_scheduled_7d).toMatchObject({ value: "3", tone: "ok" });
    expect(kpi.engagement_lift_7d).toMatchObject({ value: "+18%", raw: 0.18, tone: "ok", delta: "9 scored posts in 30 days" });
    expect(kpi.inbox_needs_reply).toMatchObject({ value: "7", href: "/social?tab=inbox" });

    const health = Object.fromEntries(snap.health.map((h) => [h.key, h]));
    expect(health["job:publish-due"]!.status).toBe("ok");
    expect(health["job:poll-inbox"]).toMatchObject({ status: "warn", detail: "Last error: 429 rate limited" });
    expect(health["job:refresh-tokens"]!.status).toBe("bad");
    expect(health["token:linkedin:a1"]).toMatchObject({ status: "bad", href: "/social?tab=accounts" });
    expect(health["token:facebook:a2"]).toMatchObject({ status: "warn", title: "[Acme] Facebook · Acme page token expires soon", href: "/social?tab=accounts&client=company%3Ac1" });
    expect(health.accounts).toBeUndefined();
    expect(health["publish-failures"]).toMatchObject({ status: "bad", detail: "2 destinations failed after every retry." });

    expect(snap.waiting.map((w) => [w.key, w.kind, w.issueId])).toEqual([
      ["social:review:p1", "review", "iss-r1"],
      ["social:review:p2", "review", null],
      ["social:escalated:i1", "judgement", "iss-e1"],
      ["social:playbook-change:ch1", "judgement", "iss-g1"],
      ["social:experiment:e1", "judgement", "iss-g1"],
    ]);
    expect(snap.waiting[0]!.why).toContain("Reviewer");
    expect(snap.waiting[1]).toMatchObject({ title: "[Acme] Approve post: Acme spring sale", href: "/social?tab=posts&client=company%3Ac1" });

    expect(snap.activity.map((a) => a.text)).toEqual([
      'Published "Case study: Acme" to 3 accounts',
      'Measured experiment "Morning posts": no change',
    ]);
    expect(snap.activity[0]!.agentId).toBe("ag-1");

    const quality = Object.fromEntries(snap.quality.map((q) => [q.key, q]));
    expect(quality.posts_changes_requested_30d).toMatchObject({ value: "3 of 10", raw: 0.3, tone: "warn" });
    expect(quality.growth_rejected_30d).toMatchObject({ value: "1 of 4", tone: "ok" });
    expect(quality.publish_failure_rate_7d).toMatchObject({ value: "25% (2 of 8)", tone: "bad" });
    expect(quality.triage_corrected_30d).toMatchObject({ value: "6 of 20", raw: 0.3, tone: "bad" });
  });

  it("formats and grades", () => {
    expect(formatLift(0.123)).toBe("+12%");
    expect(formatLift(-0.05)).toBe("−5%");
    expect(formatLift(0)).toBe("0%");
    expect(rateTone(0.3, 0.1, 0.25)).toBe("bad");
    expect(rateTone(0.05, 0.1, 0.25)).toBe("ok");
    expect(accountChecks([])).toEqual([{ key: "accounts", title: "Connected accounts", status: "ok" }]);
  });
});

describe("hourly cockpit push", () => {
  it("skips companies with unsaved settings or the module off, publishes the rest and re-emits leads", async () => {
    const emit = vi.fn(async (_name: string, _companyId: string, _payload: unknown) => undefined);
    const config = vi.fn(async (companyId: string) => (companyId === "co-new" ? {} : { publicBaseUrl: "https://paperclip.partnersinbiz.online" }));
    const state: State = { "social-setup:companies": ["co-1", "co-new", "co-off"], "pib-setup:modules:co-off": null };
    const ctx = ctxWith(
      (sql) => {
        if (sql.includes("triaged_at >= now() - interval '24 hours'")) {
          return [{ id: "i9", platform: "instagram", author: "sam", body: "How much for a logo?", permalink: "https://instagram.com/p/1", client_kind: null, client_ref: null, received_at: "2026-09-26T08:00:00Z", created_at: "2026-09-26T08:00:00Z", confidence: "0.91" }];
        }
        return [];
      },
      state,
      { config: { get: config }, events: { emit, on: vi.fn() } },
    );
    // co-off: the module switch lives in company-scoped state.
    (ctx.state.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: { namespace?: string; stateKey: string; scopeId?: string }) => {
      if (key.stateKey === "companies") return state["social-setup:companies"];
      if (key.scopeId === "co-off" && key.stateKey === "modules") return { companyId: "co-off", modules: { social: false }, updatedAt: "2026-09-26T00:00:00Z" };
      return null;
    });
    const result = await publishCockpitSnapshots(ctx);
    expect(result).toEqual({ published: 1, skipped: 2, leads: 1 });
    const events = emit.mock.calls.map((c) => [c[0], c[1]]);
    expect(events).toEqual([["cockpit.snapshot", "co-1"], ["lead.captured", "co-1"]]);
    const lead = (emit.mock.calls[1] as unknown[])[2] as Record<string, unknown>;
    expect(lead).toMatchObject({ key: "social:inbox:i9", source: "social", handle: "sam", platform: "instagram", url: "https://instagram.com/p/1", confidence: 0.91 });
  });
});

describe("cockpit route and job tracking (SDK harness)", () => {
  it("serves GET /cockpit and records job runs", async () => {
    const harness = createTestHarness({ manifest, config: { publicBaseUrl: "https://paperclip.partnersinbiz.online" } });
    harness.seed({ companies: [{ id: "co-1", issuePrefix: "PIB", name: "PiB" } as never] });
    await plugin.definition.setup(harness.ctx);
    const res = await plugin.definition.onApiRequest!({
      routeKey: "cockpit", method: "GET", path: "/cockpit", params: {}, query: { companyId: "co-1" }, body: null, headers: {},
      companyId: "co-1", actor: { actorType: "user", actorId: "user-1", userId: "user-1", agentId: null, runId: null },
    } as never);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ plugin: "partnersinbiz.social", title: "Social" });
    const missing = await plugin.definition.onApiRequest!({ routeKey: "cockpit", query: {}, companyId: "", actor: { actorType: "user" } } as never);
    expect(missing.status).toBe(400);
    // The harness namespace is not a host namespace, so the job fails: the failure is recorded for jobHealth.
    await expect(harness.runJob("poll-rss")).rejects.toThrow("Unsafe identifier");
    const record = await harness.ctx.state.get({ scopeKind: "instance", namespace: "pib-cockpit-jobs", stateKey: "job:poll-rss" });
    expect(record).toMatchObject({ consecutiveFailures: 1, lastError: "Unsafe identifier", lastOkAt: null });
  });
});
