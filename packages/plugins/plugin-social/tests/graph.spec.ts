/**
 * 0.7.0 graph round: the company-graph stages Social reports (social.drafts,
 * social.approval, social.scheduled), the done-checks on the work issues it
 * hands to agents, stable origin ids, and drafts linked to a repurposed page.
 */
import { describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { DONE_CHECK_MAX_REOPENS, flowStagesFor, PIB_PLUGINS, runDoneCheck, type DoneCheckIssue } from "@partnersinbiz/pib-plugin-kit";
import { cockpitSnapshot, draftsFlow, socialFlows } from "../src/cockpit.js";
import {
  checkPublishFailure,
  checkReconnect,
  checkRepurpose,
  checkReplyQueue,
  checkSchedule,
  pageNeedle,
  SOCIAL_DONE_CHECKS,
  SOCIAL_ORIGINS,
} from "../src/done-checks.js";
import { repurposeDescription } from "../src/handoff.js";
import { NAMESPACE } from "../src/namespace.js";
import { createPostRecord, type Viewer } from "../src/service.js";
import { SOCIAL_PUBLISH_BODY } from "../src/skills.js";
import { SOCIAL_TOOLS } from "../src/tools.js";
import plugin from "../src/worker.js";
import { fakeCtx } from "./helpers.js";

type Row = Record<string, unknown>;
const T = (name: string) => `${NAMESPACE}.${name}`;
const DAY = 24 * 3600_000;
const NOW = new Date("2026-09-28T08:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

const HANDOFF = {
  key: "seo:content:ct-1",
  issue_id: "iss-r",
  payload: { key: "seo:content:ct-1", url: "https://www.acme.co.za/blog/website-cost/", title: "What a website costs", clientKind: "company", clientRef: "c1" },
  created_at: ago(3),
};

const issue = (originId: string, extra: Partial<DoneCheckIssue> = {}): DoneCheckIssue => ({ id: "iss-1", companyId: "co", identifier: "PIB-7", title: "Work", originId, assigneeAgentId: "social-1", createdAt: ago(1), ...extra });

/** A context whose SQL goes through the host guard copy; `rows` answers by SQL text. */
function ctxWith(rows: (sql: string, params: unknown[]) => unknown[], extra: Record<string, unknown> = {}) {
  return fakeCtx({ ...extra }, { queryResult: rows });
}

// ---------------------------------------------------------------------------

describe("origin ids", () => {
  it("every kind of work issue has a stable prefix, and the rules cover the agent's work", () => {
    expect(SOCIAL_ORIGINS).toMatchObject({ repurpose: "repurpose:", schedule: "schedule:", reconnect: "account:", replyQueue: "inbox:", publishFailed: "post-failed:", plan: "plan:" });
    expect(SOCIAL_DONE_CHECKS.map((r) => r.originPrefix)).toEqual(["repurpose:", "schedule:", "account:", "inbox:", "post-failed:", "plan:"]);
    // "inbox:" never catches the escalation issues a person decides.
    expect(`${SOCIAL_ORIGINS.escalation}x`.startsWith(SOCIAL_ORIGINS.replyQueue)).toBe(false);
  });
});

describe("repurpose drafts: linked or listing the page", () => {
  it("matches the page by host and path, ignoring www., the query and a trailing slash", () => {
    expect(pageNeedle("https://www.Acme.co.za/blog/Website-Cost/?utm_source=x")).toBe("acme.co.za/blog/website-cost");
    expect(pageNeedle("not a url")).toBe("");
    expect(pageNeedle(null)).toBe("");
  });

  it("passes when a draft for the page exists in its scope", async () => {
    const seen: unknown[][] = [];
    const ctx = ctxWith((sql, params) => {
      if (sql.includes(`FROM ${T("handoffs")}`)) return [HANDOFF];
      if (sql.includes("jsonb_to_recordset")) {
        seen.push(params);
        return [{ key: HANDOFF.key, drafts: 2 }];
      }
      return [];
    });
    expect(await checkRepurpose(issue("repurpose:seo:content:ct-1", { id: "iss-r" }), ctx)).toEqual({ done: true });
    const refs = JSON.parse(String(seen[0]![1])) as Array<Record<string, string>>;
    expect(refs).toEqual([{ key: "seo:content:ct-1", ref: "c1", needle: "acme.co.za/blog/website-cost" }]);
  });

  it("reopens with how to draft them (hand-off key and client) when there are none", async () => {
    const ctx = ctxWith((sql) => (sql.includes(`FROM ${T("handoffs")}`) ? [HANDOFF] : sql.includes("jsonb_to_recordset") ? [{ key: HANDOFF.key, drafts: 0 }] : []));
    const result = await checkRepurpose(issue("repurpose:seo:content:ct-1"), ctx);
    expect(result.done).toBe(false);
    expect(result.missing![0]).toContain('`handoffKey: "seo:content:ct-1"`');
    expect(result.missing![0]).toContain('`client: "company:c1"`');
    expect(result.missing![0]).toContain('"What a website costs"');
  });

  it("is not Social's when no hand-off stands behind it", async () => {
    expect(await checkRepurpose(issue("repurpose:other"), ctxWith(() => []))).toEqual({ done: true });
  });
});

describe("schedule approved posts: none left without a time", () => {
  const rows = (approved: Row[]) => (sql: string) => {
    if (sql.includes("AND (id = $2 OR schedule_issue_id = $3)")) return [{ id: "p1" }];
    if (sql.includes("status = 'approved' AND COALESCE(client_ref, '') = $2")) return approved;
    return [];
  };

  it("reopens with each approved post that still has no time", async () => {
    const result = await checkSchedule(issue("schedule:company:c1:p1"), ctxWith(rows([{ id: "p1", body: "Launch day!" }, { id: "p2", body: "Second" }])));
    expect(result.done).toBe(false);
    expect(result.missing).toHaveLength(2);
    expect(result.missing![0]).toContain("post `p1`");
    expect(result.missing![0]).toContain("`schedule-post`");
  });

  it("passes when they were scheduled or moved back to draft (none approved in the scope)", async () => {
    expect(await checkSchedule(issue("schedule:own:p1"), ctxWith(rows([])))).toEqual({ done: true });
  });

  it("reads the scope from the origin id (own work is client_ref '')", async () => {
    const params: unknown[][] = [];
    const ctx = ctxWith((sql, p) => {
      params.push(p);
      return rows([])(sql);
    });
    await checkSchedule(issue("schedule:contact:ct9:p1"), ctx);
    expect(params.at(-1)).toEqual(["co", "ct9"]);
    await checkSchedule(issue("schedule:own:p1"), ctx);
    expect(params.at(-1)).toEqual(["co", ""]);
  });

  it("is not Social's when neither the post nor any post links the issue", async () => {
    expect(await checkSchedule(issue("schedule:own:p404"), ctxWith(() => []))).toEqual({ done: true });
  });
});

describe("reconnect: the account is connected again", () => {
  const acc = (extra: Row) => ({ id: "a1", company_id: "co", platform: "linkedin", display_name: "PiB page", status: "needs_reconnect", token_enc: "v1.x", ...extra });
  const ctx = (row: Row | null) => ctxWith((sql) => (sql.includes(`FROM ${T("accounts")} WHERE id = $1`) && row ? [row] : []));

  it("passes once connected, or when a person disconnected or removed it", async () => {
    expect(await checkReconnect(issue("account:a1"), ctx(acc({ status: "connected" })))).toEqual({ done: true });
    expect(await checkReconnect(issue("account:a1"), ctx(acc({ status: "disabled", token_enc: null })))).toEqual({ done: true });
    expect(await checkReconnect(issue("account:a1"), ctx(null))).toEqual({ done: true });
  });

  it("reopens while a person still has to sign in, and says the agent cannot", async () => {
    const result = await checkReconnect(issue("account:a1"), ctx(acc({})));
    expect(result.done).toBe(false);
    expect(result.missing![0]).toContain("LinkedIn · PiB page is still disconnected");
    expect(result.missing![0]).toContain("partnersinbiz.cockpit:ask-owner");
    expect((await checkReconnect(issue("account:a1"), ctx(acc({ status: "expiring" })))).missing![0]).toContain("about to stop working");
  });
});

describe("reply queue: every comment replied to or needing none", () => {
  it("reopens with the comments that still need a reply (the Cockpit's needs-reply rule)", async () => {
    let sqlSeen = "";
    const ctx = ctxWith((sql) => {
      sqlSeen = sql;
      return [{ id: "i1", author: "Thandi", platform: "facebook", body: "Do you work in Durban?" }];
    });
    const result = await checkReplyQueue(issue("inbox:a1:2026-09-28"), ctx);
    expect(result.missing![0]).toContain('Thandi on Facebook: "Do you work in Durban?" (itemId `i1`)');
    expect(sqlSeen).toContain("triage_issue_id = $2");
    expect(sqlSeen).toContain("'corrected'->>'needs_reply'");
  });

  it("passes when all are replied to, marked read or marked as needing no reply", async () => {
    expect(await checkReplyQueue(issue("inbox:a1:2026-09-28"), ctxWith(() => []))).toEqual({ done: true });
  });
});

describe("failed post: no destination still failed", () => {
  const post = (status: string) => ({ id: "p1", company_id: "co", body: "Launch day!", status });
  const ctx = (p: Row | null, dests: Row[]) =>
    ctxWith((sql) => {
      if (sql.includes(`FROM ${T("posts")} WHERE id = $1`)) return p ? [p] : [];
      if (sql.includes(`FROM ${T("destinations")} WHERE post_id = $1`)) return dests;
      if (sql.includes(`FROM ${T("accounts")} WHERE company_id = $1 AND id = ANY`)) return [{ id: "a1", platform: "x", display_name: "@pib" }];
      return [];
    });

  it("reopens while a destination is still failed", async () => {
    const result = await checkPublishFailure(issue("post-failed:p1"), ctx(post("failed"), [{ id: "d1", account_id: "a1", status: "failed", last_error: "duplicate content" }]));
    expect(result.done).toBe(false);
    expect(result.missing![0]).toContain("still failed on X · @pib (duplicate content)");
    expect(result.missing![0]).toContain("`retry-post`");
    expect(result.missing![0]).toContain("`detach-destination`");
  });

  it("passes once retried, detached, moved back to draft or gone", async () => {
    expect(await checkPublishFailure(issue("post-failed:p1"), ctx(post("publishing"), []))).toEqual({ done: true });
    expect(await checkPublishFailure(issue("post-failed:p1"), ctx(post("partially_published"), [{ id: "d1", account_id: "a1", status: "published" }]))).toEqual({ done: true });
    expect(await checkPublishFailure(issue("post-failed:p1"), ctx(post("draft"), [{ id: "d1", account_id: "a1", status: "failed" }]))).toEqual({ done: true });
    expect(await checkPublishFailure(issue("post-failed:p1"), ctx(null, []))).toEqual({ done: true });
  });
});

describe("the kit loop on Social's rules", () => {
  function host(done: boolean) {
    const updates: Row[] = [];
    const comments: string[] = [];
    const wakes: string[] = [];
    const state = new Map<string, unknown>();
    const issueRow: Row = { id: "iss-1", title: "Reply to social comments", status: "done", originId: "inbox:a1:2026-09-28", assigneeAgentId: "social-1", createdAt: ago(1) };
    const ctx = fakeCtx(
      {
        issues: {
          get: vi.fn(async () => issueRow),
          update: vi.fn(async (_id: string, patch: Row) => {
            updates.push(patch);
            Object.assign(issueRow, patch);
            return issueRow;
          }),
          createComment: vi.fn(async (_id: string, body: string) => void comments.push(body)),
          requestWakeup: vi.fn(async (id: string) => void wakes.push(id)),
        },
        state: {
          get: vi.fn(async (k: { namespace?: string; stateKey: string }) => state.get(`${k.namespace}:${k.stateKey}`) ?? null),
          set: vi.fn(async (k: { namespace?: string; stateKey: string }, v: unknown) => void state.set(`${k.namespace}:${k.stateKey}`, v)),
        },
        events: { on: vi.fn(), emit: vi.fn() },
      },
      { queryResult: (sql) => (sql.includes(`FROM ${T("inbox_items")}`) && !done ? [{ id: "i1", author: "Thandi", platform: "facebook", body: "Hi" }] : []) },
    );
    return { ctx, issueRow, updates, comments, wakes };
  }
  const agentClose = { entityId: "iss-1", companyId: "co", actorType: "agent" as const };

  it("reopens an early close with what is missing and wakes the agent; a finished queue passes", async () => {
    const early = host(false);
    expect(await runDoneCheck(early.ctx, SOCIAL_DONE_CHECKS, agentClose)).toBe("reopened");
    expect(early.updates).toEqual([{ status: "todo" }]);
    expect(early.comments[0]).toContain("Reply to social comments");
    expect(early.comments[0]).toContain("itemId `i1`");
    expect(early.wakes).toEqual(["iss-1"]);
    expect(await runDoneCheck(host(true).ctx, SOCIAL_DONE_CHECKS, agentClose)).toBe("passed");
  });

  it("never checks a person's close, and hands the third early close on", async () => {
    expect(await runDoneCheck(host(false).ctx, SOCIAL_DONE_CHECKS, { ...agentClose, actorType: "user" })).toBe("skipped");
    const loop = host(false);
    for (let i = 1; i < DONE_CHECK_MAX_REOPENS; i += 1) {
      loop.issueRow.status = "done";
      expect(await runDoneCheck(loop.ctx, SOCIAL_DONE_CHECKS, agentClose)).toBe("reopened");
    }
    loop.issueRow.status = "done";
    expect(await runDoneCheck(loop.ctx, SOCIAL_DONE_CHECKS, agentClose)).toBe("escalated");
  });

  it("the worker registers the checks on its one issue.updated subscription", async () => {
    const handlers: Array<{ name: string; fn: (event: PluginEvent) => Promise<void> }> = [];
    const early = host(false);
    const ctx = {
      ...early.ctx,
      events: { on: vi.fn((name: string, fn: (event: PluginEvent) => Promise<void>) => void handlers.push({ name, fn })), emit: vi.fn() },
      tools: { register: vi.fn() },
      actions: { register: vi.fn() },
      jobs: { register: vi.fn() },
    } as unknown as PluginContext;
    await plugin.definition.setup(ctx);
    const issueHandlers = handlers.filter((h) => h.name === "issue.updated");
    expect(issueHandlers).toHaveLength(1);
    await issueHandlers[0]!.fn({ eventType: "issue.updated", ...agentClose } as unknown as PluginEvent);
    expect(early.updates).toEqual([{ status: "todo" }]);
  });
});

describe("company graph: the stages Social reports", () => {
  it("owns social.drafts, social.approval and social.scheduled", () => {
    expect(flowStagesFor(PIB_PLUGINS.social).map((s) => s.key)).toEqual(["social.drafts", "social.approval", "social.scheduled"]);
  });

  it("social.drafts: drafts plus work with no draft yet; stuck after two days", () => {
    expect(draftsFlow({ drafts: 4, work: [{ kind: "repurpose", createdAt: ago(3) }, { kind: "repurpose", createdAt: ago(1) }, { kind: "plan", createdAt: ago(5) }] }, NOW)).toEqual({
      stage: "social.drafts",
      count: 7,
      stuck: 2,
      stuckReason: "1 repurpose task and the weekly plan over 2 days old with no draft",
      oldestDays: 5,
    });
    expect(draftsFlow({ drafts: 2, work: [] }, NOW)).toEqual({ stage: "social.drafts", count: 2, stuck: 0, stuckReason: null, oldestDays: null });
    expect(draftsFlow({ drafts: 0, work: [{ kind: "first_plan", createdAt: ago(3) }, { kind: "first_plan", createdAt: ago(4) }, { kind: "first_plan", createdAt: ago(1) }] }, NOW)).toMatchObject({
      count: 3,
      stuck: 2,
      stuckReason: "2 first plans over 2 days old with no draft",
    });
  });

  function flowRows(opts: { drafted?: number; issueStatus?: string } = {}) {
    return (sql: string, params: unknown[]): unknown[] => {
      if (sql.includes("status = 'draft'")) return [{ drafts: "3" }];
      // First plans (the connect-time trigger) have their own query; none here.
      if (sql.includes(`FROM ${T("handoffs")}`) && sql.includes("kind = 'plan'")) return [];
      if (sql.includes(`FROM ${T("handoffs")}`)) return [HANDOFF];
      if (sql.includes("jsonb_to_recordset")) return [{ key: HANDOFF.key, drafts: opts.drafted ?? 0 }];
      if (sql.includes("created_at >= $2::timestamptz")) return [{ n: params[1] === ago(4) ? "0" : "1" }];
      if (sql.includes("status = 'review'")) return [{ n: "2", late: "1", oldest: ago(6) }];
      if (sql.includes("AS approved_late")) return [{ scheduled: "5", approved: "2", approved_late: "1", failed: "1", oldest: ago(3) }];
      return [];
    };
  }
  // The weekly routine's issues are the host's routine_execution issues: their origin id is the routine's own id.
  const issues = (status = "todo") => ({
    issues: {
      get: vi.fn(async () => ({ id: "iss-r", status })),
      list: vi.fn(async () => [{ id: "plan-1", status: "in_progress", createdAt: ago(4) }, { id: "plan-0", status: "done", createdAt: ago(11) }]),
    },
    routines: { managed: { get: vi.fn(async () => ({ routineId: "routine-1" })) } },
  });

  it("reports all three stages from Social's own data", async () => {
    const ctx = ctxWith(flowRows(), issues());
    expect(await socialFlows(ctx, "co", NOW)).toEqual([
      { stage: "social.drafts", count: 5, stuck: 2, stuckReason: "1 repurpose task and the weekly plan over 2 days old with no draft", oldestDays: 4 },
      { stage: "social.approval", count: 2, stuck: 1, stuckReason: "1 post past its proposed time", oldestDays: 6 },
      { stage: "social.scheduled", count: 8, stuck: 2, stuckReason: "1 post failed to publish; 1 approved post with no time for over a day", oldestDays: 3 },
    ]);
    // Every statement passed the host SQL guard copy, and nothing was written.
    expect(ctx.fakeDb.executes).toEqual([]);
    const scheduledSql = ctx.fakeDb.queries.find((q) => q.sql.includes("AS approved_late"))!.sql;
    expect(scheduledSql).toContain("d.status = 'failed'");
    // The weekly plan is found by the routine's own id (the host's routine_execution origin), never an origin string of our own.
    const list = (ctx as unknown as { issues: { list: ReturnType<typeof vi.fn> } }).issues.list;
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0]![0]).toMatchObject({ companyId: "co", originId: "routine-1" });
  });

  it("without the routine there is no weekly plan to look for", async () => {
    const ctx = ctxWith(flowRows(), { ...issues(), routines: { managed: { get: vi.fn(async () => ({ routineId: null })) } } });
    const flows = await socialFlows(ctx, "co", NOW);
    expect(flows[0]).toMatchObject({ count: 4, stuck: 1, stuckReason: "1 repurpose task over 2 days old with no draft" });
    expect((ctx as unknown as { issues: { list: ReturnType<typeof vi.fn> } }).issues.list).not.toHaveBeenCalled();
  });

  it("a scope's open first plan with nothing drafted in it is waiting for drafts; one with a draft, or closed, is not", async () => {
    const claim = { issue_id: "iss-p", payload: { scope: "company:c1", clientName: "Acme" }, created_at: ago(3) };
    const rows = (made: string) => (sql: string, params: unknown[]): unknown[] => {
      if (sql.includes(`FROM ${T("handoffs")}`) && sql.includes("kind = 'plan'")) return [claim];
      // postsMadeInScope for a client scope: company, kind, id, since
      if (sql.includes("source NOT IN ('rss', 'inbox_reply') AND client_ref = $3")) {
        expect(params).toEqual(["co", "company", "c1", ago(3)]);
        return [{ n: made }];
      }
      return flowRows()(sql, params);
    };
    const waiting = await socialFlows(ctxWith(rows("0"), issues()), "co", NOW);
    expect(waiting[0]).toMatchObject({ count: 6, stuck: 3, stuckReason: "1 repurpose task, the weekly plan and a first plan over 2 days old with no draft" });
    const drafted = await socialFlows(ctxWith(rows("2"), issues()), "co", NOW);
    expect(drafted[0]).toMatchObject({ count: 5, stuck: 2 });
    // The first plan's issue is closed (and the repurpose one, which shares the stub): only the weekly routine's open issue waits.
    const closed = await socialFlows(ctxWith(rows("0"), issues("done")), "co", NOW);
    expect(closed[0]).toMatchObject({ count: 4, stuck: 1, stuckReason: "the weekly plan over 2 days old with no draft" });
  });

  it("a drafted page, or a repurpose issue a person closed, is not waiting for drafts", async () => {
    const drafted = await socialFlows(ctxWith(flowRows({ drafted: 1 }), issues()), "co", NOW);
    expect(drafted[0]).toMatchObject({ count: 4, stuck: 1, stuckReason: "the weekly plan over 2 days old with no draft" });
    const closed = await socialFlows(ctxWith(flowRows(), issues("done")), "co", NOW);
    expect(closed[0]).toMatchObject({ count: 4, stuck: 1 });
  });

  it("a stage whose query fails reports nothing; the others still report", async () => {
    const ctx = ctxWith((sql, params) => {
      if (sql.includes("status = 'review'")) throw new Error("boom");
      return flowRows()(sql, params);
    }, issues());
    expect((await socialFlows(ctx, "co", NOW)).map((f) => f.stage)).toEqual(["social.drafts", "social.scheduled"]);
  });

  it("the Cockpit snapshot carries them", async () => {
    const ctx = ctxWith(flowRows(), {
      ...issues(),
      state: { get: vi.fn(async () => null), set: vi.fn(), delete: vi.fn() },
      agents: { get: vi.fn(async () => null), managed: { get: vi.fn(async () => ({ agentId: null })) } },
      events: { emit: vi.fn(), on: vi.fn() },
    });
    const snap = await cockpitSnapshot(ctx, "co");
    expect(snap.flows?.map((f) => f.stage)).toEqual(["social.drafts", "social.approval", "social.scheduled"]);
  });
});

describe("drafts linked to a repurposed page (create-post handoffKey)", () => {
  const VIEWER: Viewer = { companyId: "co", userId: null, agentId: "social-1", runId: "run-1", isAgent: true };
  function world() {
    const inserted: unknown[][] = [];
    const posts = new Map<string, Row>();
    const ctx = fakeCtx(
      { config: { get: vi.fn(async () => ({})) }, companies: { get: vi.fn(async () => ({ id: "co", issuePrefix: "PIB" })) } },
      {
        queryResult: (sql, params) => {
          if (sql.includes(`FROM ${T("handoffs")}`)) return params[1] === HANDOFF.key ? [HANDOFF] : [];
          if (sql.includes(T("crm_companies"))) return params[1] === "c1" ? [{ id: "c1", name: "Acme", domain: "acme.co.za", lifecycle: "customer" }] : [];
          if (sql.includes(`FROM ${T("posts")} WHERE id = $1`)) return posts.has(String(params[0])) ? [posts.get(String(params[0]))] : [];
          return [];
        },
        executeResult: (sql, params) => {
          if (sql.startsWith(`INSERT INTO ${T("posts")}`)) {
            inserted.push(params);
            const [id, company_id, body, , , status, scope, owner_user_id, first_comment, client_kind, client_ref, client_name, source, source_ref] = params;
            posts.set(String(id), { id, company_id, body, overrides: {}, media: [], status, scope, owner_user_id, first_comment, client_kind, client_ref, client_name, source, source_ref, scheduled_at: null });
          }
          return 1;
        },
      },
    );
    return { ctx, inserted };
  }

  it("links the draft to the page and keeps it in the page's scope", async () => {
    const w = world();
    const post = (await createPostRecord(w.ctx, VIEWER, { body: "What a website costs in 2026 → acme.co.za/blog/website-cost", handoffKey: HANDOFF.key })) as { client: string | null; handoffKey: string | null; source: string };
    expect(post).toMatchObject({ client: "company:c1", handoffKey: "seo:content:ct-1", source: "repurpose" });
    expect(w.inserted[0]!.slice(9, 14)).toEqual(["company", "c1", "Acme", "repurpose", "seo:content:ct-1"]);
  });

  it("refuses an unknown key, or a draft in another scope", async () => {
    await expect(createPostRecord(world().ctx, VIEWER, { body: "x", handoffKey: "seo:content:nope" })).rejects.toThrow(/Unknown hand-off key/);
    await expect(createPostRecord(world().ctx, VIEWER, { body: "x", handoffKey: HANDOFF.key, client: "own" })).rejects.toThrow(/belongs to company:c1/);
  });

  it("the tool, the repurpose issue and the skill tell the agent about it", () => {
    const create = SOCIAL_TOOLS.find((t) => t.name === "create-post")!.parametersSchema as { properties: Record<string, { description?: string }> };
    expect(create.properties.handoffKey!.description).toContain("seo:content:<id>");
    const text = repurposeDescription({ key: HANDOFF.key, url: HANDOFF.payload.url, title: HANDOFF.payload.title, publishedAt: ago(3) }, { client_kind: "company", client_ref: "c1", client_name: "Acme" });
    expect(text).toContain('`handoffKey: "seo:content:ct-1"`');
    expect(text).toContain("The close is checked");
    expect(SOCIAL_PUBLISH_BODY).toContain("When you close an issue this module opened, it checks the work; if it reopens, it lists what's missing: finish those.");
    expect(SOCIAL_PUBLISH_BODY).toContain("handoffKey");
  });
});
