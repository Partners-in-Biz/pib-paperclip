import { describe, expect, it, vi } from "vitest";
import type { AccountRow, InboxItemRow } from "../src/db.js";
import { CONTENT_PUBLISHED_EVENT, leadPayload, onContentPublished, parseContentPublished, repurposeDescription } from "../src/handoff.js";
import { NAMESPACE } from "../src/namespace.js";
import { POST_REVIEW_CHECKS, postReviewDescription } from "../src/review.js";
import { transitionPost, type Viewer } from "../src/service.js";
import { isLead, readTriage, triageInbox } from "../src/triage.js";
import type { SocialConfig } from "../src/config.js";
import { fakeCtx } from "./helpers.js";

const T = (name: string) => `${NAMESPACE}.${name}`;
const PERSON: Viewer = { companyId: "co", userId: "user-1", agentId: null, runId: null, isAgent: false };
const AGENT: Viewer = { companyId: "co", userId: "user-1", agentId: "ag-1", runId: "run-1", isAgent: true };

function account(id: string): AccountRow {
  return {
    id, company_id: "co", platform: "linkedin", scope: "org", owner_user_id: null, status: "connected", secret_ref: null, display_name: "PiB",
    external_id: "ext", handle: null, avatar_url: null, token_enc: "v1.x", refresh_token_enc: null, token_expires_at: null, scopes: [],
    client_kind: null, client_ref: null, client_name: null, last_error: null, meta: {}, key_version: 1, created_by_user_id: "user-1",
    reconnect_issue_id: null, last_refreshed_at: null, created_at: new Date(), updated_at: new Date(),
  } as AccountRow;
}

/** Posts in memory, host issues and cockpit roles in fakes. */
function world(opts: { reviewer?: string | null; reviewIssue?: string | null; issueStatus?: string } = {}) {
  const post: Record<string, unknown> = {
    id: "p1", company_id: "co", body: "We shipped the new site. Read the case study.", overrides: {}, media: [], status: "draft", scheduled_at: null, scope: "org",
    owner_user_id: "owner-1", client_kind: null, client_ref: null, client_name: null, first_comment: null, source: "manual", source_ref: null, failure_issue_id: null,
    published_at: null, error: null, created_by_agent_id: "ag-1", created_at: new Date(), updated_at: new Date(),
  };
  let reviewIssue = opts.reviewIssue ?? null;
  const created: Array<Record<string, unknown>> = [];
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const comments: Array<{ id: string; body: string }> = [];
  const wakeups: string[] = [];
  const ctx = fakeCtx(
    {
      state: {
        get: vi.fn(async (key: { namespace?: string; stateKey: string }) =>
          key.namespace === "pib-cockpit" && key.stateKey === "roles" && opts.reviewer !== undefined
            ? { companyId: "co", operatorAgentId: null, reviewerAgentId: opts.reviewer, ownerUserId: "owner-1", reviewOutward: true, updatedAt: "2026-09-26T00:00:00Z" }
            : null,
        ),
        set: vi.fn(async () => undefined),
      },
      companies: { get: vi.fn(async () => ({ id: "co", issuePrefix: "PIB", defaultResponsibleUserId: "boss-1" })) },
      projects: { managed: { get: vi.fn(async () => ({ projectId: "proj-social" })) } },
      issues: {
        get: vi.fn(async (id: string) => ({ id, status: opts.issueStatus ?? "todo" })),
        create: vi.fn(async (input: Record<string, unknown>) => {
          created.push(input);
          return { id: `iss-${created.length}` };
        }),
        update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
          updates.push({ id, patch });
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
    },
    {
      queryResult: (sql) => {
        if (sql.startsWith("SELECT review_issue_id")) return [{ review_issue_id: reviewIssue }];
        if (sql.includes(`FROM ${T("posts")} WHERE id = $1`)) return [{ ...post }];
        if (sql.includes(`FROM ${T("destinations")} WHERE post_id = $1`)) return [{ id: "d1", company_id: "co", post_id: "p1", account_id: "a1", status: "pending", attempts: 0 }];
        if (sql.includes(`FROM ${T("accounts")} WHERE company_id = $1 AND id = ANY`)) return [account("a1")];
        return [];
      },
      executeResult: (sql, params) => {
        if (sql.includes("SET status = $3")) post.status = params[2];
        if (sql.includes("SET review_issue_id = $3")) reviewIssue = String(params[2]);
        if (sql.includes("SET review_issue_id = NULL")) reviewIssue = null;
        return 1;
      },
    },
  );
  return { ctx, post, created, updates, comments, wakeups, reviewIssueId: () => reviewIssue };
}

describe("reviewer routing for posts", () => {
  it("with no Reviewer, sending for review opens nothing (as before)", async () => {
    const w = world();
    await transitionPost(w.ctx, AGENT, "p1", "review");
    expect(w.created).toEqual([]);
    expect(w.post.status).toBe("review");
  });

  it("routes a post sent for review to the Reviewer with the checks, handing it to the post owner", async () => {
    const w = world({ reviewer: "rev-1" });
    await transitionPost(w.ctx, AGENT, "p1", "review");
    expect(w.created).toHaveLength(1);
    const issue = w.created[0]!;
    expect(issue).toMatchObject({ companyId: "co", assigneeAgentId: "rev-1", status: "todo", originId: "review:p1", projectId: "proj-social" });
    expect(String(issue.title)).toBe("Review social post: We shipped the new site. Read the case study.");
    const description = String(issue.description);
    expect(description).toContain("## Reviewer: check before the person approves");
    for (const check of POST_REVIEW_CHECKS) expect(description).toContain(check);
    expect(description).toContain("reassign this issue to user `owner-1`");
    expect(description).toContain("LinkedIn · PiB");
    expect(description).toContain("Closing this issue does not approve it");
    expect(w.wakeups).toEqual(["iss-1"]);
    expect(w.reviewIssueId()).toBe("iss-1");
  });

  it("sent again while its issue is open: the same issue goes back to the Reviewer", async () => {
    const w = world({ reviewer: "rev-1", reviewIssue: "iss-9" });
    await transitionPost(w.ctx, AGENT, "p1", "review");
    expect(w.created).toEqual([]);
    expect(w.updates).toEqual([{ id: "iss-9", patch: { status: "todo", assigneeAgentId: "rev-1", assigneeUserId: null } }]);
    expect(w.comments[0]!.body).toContain("sent for review again");
  });

  it("a person's approval closes the Reviewer's issue; agents still cannot approve", async () => {
    const w = world({ reviewer: "rev-1", reviewIssue: "iss-9" });
    w.post.status = "review";
    await expect(transitionPost(w.ctx, AGENT, "p1", "approved")).rejects.toThrow("A person approves");
    await transitionPost(w.ctx, PERSON, "p1", "approved");
    expect(w.comments.map((c) => c.body)).toEqual(["A person approved the post. It can be scheduled now."]);
    expect(w.updates).toEqual([{ id: "iss-9", patch: { status: "done" } }]);
    expect(w.reviewIssueId()).toBeNull();
  });

  it("a person sending it back to draft counts a return (quality metric)", async () => {
    const w = world();
    w.post.status = "review";
    await transitionPost(w.ctx, PERSON, "p1", "draft");
    const bump = w.ctx.fakeDb.executes.find((e) => e.sql.includes("review_returns = review_returns + $3"));
    expect(bump?.params).toEqual(["p1", "co", 1]);
  });

  it("the description is plain and scoped", () => {
    const text = postReviewDescription({
      post: { id: "p2", body: "Spring sale", first_comment: "Link in bio", client_kind: "company", client_ref: "c1", client_name: "Acme", media: [{ url: "https://m/x.jpg", kind: "image" }] },
      destinations: [],
      pagePath: "/PIB/social?tab=posts&client=company%3Ac1",
      handTo: { userId: null, label: "a board user who approves posts" },
    });
    expect(text).toContain("Scope: client Acme");
    expect(text).toContain("image (no alt text)");
    expect(text).toContain("none yet");
    expect(text).toContain("First comment: Link in bio");
  });
});

describe("SEO → Social repurpose hand-off", () => {
  const payload = { key: "seo:content:ct-1", url: "https://acme.test/blog/pricing", title: "How we price websites", keyword: "website pricing", clientKind: "company", clientRef: "c1", publishedAt: "2026-09-26T08:00:00Z" };

  function repurposeWorld(opts: { saved?: boolean; claimed?: string | null } = {}) {
    const inbox = new Map<string, unknown>();
    const created: Array<Record<string, unknown>> = [];
    let claim = opts.claimed;
    const ctx = fakeCtx(
      {
        config: { get: vi.fn(async () => (opts.saved === false ? {} : { publicBaseUrl: "https://paperclip.partnersinbiz.online" })) },
        agents: { get: vi.fn(async (id: string) => ({ id, status: "idle" })), managed: { get: vi.fn(async () => ({ agentId: null })) } },
        companies: { get: vi.fn(async () => ({ id: "co", issuePrefix: "PIB", defaultResponsibleUserId: "boss-1" })) },
        projects: { managed: { get: vi.fn(async () => ({ projectId: "proj-social" })) } },
        issues: {
          create: vi.fn(async (input: Record<string, unknown>) => {
            created.push(input);
            return { id: `iss-${created.length}` };
          }),
          requestWakeup: vi.fn(async () => ({ queued: true })),
        },
      },
      {
        queryResult: (sql, params) => {
          if (sql.includes(`FROM ${T("inbox")} WHERE key = $1`)) return inbox.has(String(params[0])) ? [{ result: inbox.get(String(params[0])) }] : [];
          if (sql.includes(`FROM ${T("crm_companies")}`)) return [{ id: "c1", name: "Acme", domain: "acme.test", lifecycle: "customer" }];
          if (sql.includes(`FROM ${T("handoffs")} WHERE key = $1`)) return claim === undefined ? [] : [{ issue_id: claim }];
          return [];
        },
        executeResult: (sql, params) => {
          if (sql.startsWith(`INSERT INTO ${T("inbox")}`)) inbox.set(String(params[0]), JSON.parse(String(params[3])));
          if (sql.startsWith(`INSERT INTO ${T("handoffs")}`)) return claim === undefined ? ((claim = null), 1) : 0;
          if (sql.includes("SET issue_id = $3")) claim = String(params[2]);
          return 1;
        },
      },
    );
    return { ctx, created, inbox };
  }

  it("parses only usable payloads", () => {
    expect(parseContentPublished({ key: "k", url: "ftp://x" })).toBeNull();
    expect(parseContentPublished({ url: "https://x.test" })).toBeNull();
    expect(parseContentPublished({ key: "k", url: "https://x.test", clientKind: "planet", clientRef: "p" })).toMatchObject({ title: "https://x.test", clientKind: null, clientRef: null });
    expect(CONTENT_PUBLISHED_EVENT).toBe("plugin.partnersinbiz.seo.content.published");
  });

  it("opens one repurpose task for the Social agent in the page's client scope, once per key", async () => {
    const w = repurposeWorld();
    // The Social agent is linked through the hire flow (kit hire state).
    w.ctx.state.get = vi.fn(async (key: { stateKey: string }) => (key.stateKey.startsWith("role:") ? { agentId: "soc-1" } : null)) as never;
    const event = { eventType: CONTENT_PUBLISHED_EVENT, companyId: "co", payload } as never;
    const first = await onContentPublished(w.ctx, event);
    expect(first).toEqual({ issueId: "iss-1" });
    expect(w.created).toHaveLength(1);
    const issue = w.created[0]!;
    expect(issue).toMatchObject({ title: "[Acme] Repurpose for social: How we price websites", originId: "repurpose:seo:content:ct-1", status: "todo", assigneeAgentId: "soc-1" });
    const text = String(issue.description);
    expect(text).toContain("LinkedIn post");
    expect(text).toContain("X thread");
    expect(text).toContain("Instagram idea");
    expect(text).toContain("utm_source=linkedin");
    expect(text).toContain("Target keyword: website pricing");
    expect(text).toContain('clientKind: "company"');
    expect(text).toContain("Drafts only");
    // Re-emitted by SEO an hour later: nothing new.
    const again = await onContentPublished(w.ctx, event);
    expect(again).toEqual({ issueId: "iss-1" });
    expect(w.created).toHaveLength(1);
  });

  it("skips (without storing) when settings were never saved", async () => {
    const w = repurposeWorld({ saved: false });
    expect(await onContentPublished(w.ctx, { companyId: "co", payload } as never)).toBeNull();
    expect(w.created).toEqual([]);
    expect(w.inbox.size).toBe(0);
  });

  it("a key already handed off returns its issue without opening another", async () => {
    const w = repurposeWorld({ claimed: "iss-old" });
    expect(await onContentPublished(w.ctx, { companyId: "co", payload } as never)).toEqual({ issueId: "iss-old" });
    expect(w.created).toEqual([]);
  });

  it("the task text works for own work too", () => {
    const text = repurposeDescription({ key: "seo:content:x", url: "https://partnersinbiz.online/insights/a", title: "A", publishedAt: "2026-09-26" }, { client_kind: null, client_ref: null, client_name: null });
    expect(text).toContain("Scope: own work");
  });
});

describe("Social → CRM leads", () => {
  const item = {
    id: "i1", platform: "facebook", author: "Jane Doe", body: `${"I want a quote for a new website. ".repeat(20)}`, permalink: "https://facebook.com/c/1",
    client_kind: "company", client_ref: "c1", received_at: "2026-09-26T08:00:00Z", created_at: "2026-09-26T08:01:00Z",
  } as unknown as InboxItemRow;

  it("builds the LeadCaptured payload (key, handle, platform, text ≤ 300, permalink, scope, confidence)", () => {
    const lead = leadPayload(item, 0.87);
    expect(lead).toMatchObject({ key: "social:inbox:i1", source: "social", handle: "Jane Doe", platform: "facebook", url: "https://facebook.com/c/1", clientKind: "company", clientRef: "c1", confidence: 0.87, capturedAt: "2026-09-26T08:00:00.000Z" });
    expect(Array.from(lead.text).length).toBeLessThanOrEqual(300);
  });

  it("only non-spam, non-escalated leads count", () => {
    const base = { model: "jev", answers: {}, ids: {} };
    const lead = readTriage({ ...base, answers: { intent: { type: "choice", choice: "lead", probabilities: {}, confidence: 0.9 }, needs_reply: { type: "noul", noul: 0.9 } } } as never);
    expect(isLead(lead)).toBe(true);
    const risky = readTriage({ ...base, answers: { intent: { type: "choice", choice: "lead", probabilities: {}, confidence: 0.9 }, escalate: { type: "noul", noul: 0.95 } } } as never);
    expect(isLead(risky)).toBe(false);
  });

  it("triage emits lead.captured for a lead", async () => {
    const emit = vi.fn(async () => undefined);
    const inboxRow = { ...item, kind: "comment", status: "new", account_id: null, post_id: null, triage_attempts: 0 };
    const ctx = fakeCtx(
      { events: { emit }, secrets: { resolve: vi.fn(async () => "jev-key") }, companies: { get: vi.fn(async () => ({ id: "co" })) } },
      { queryResult: (sql) => (sql.includes("triaged_at IS NULL") ? [inboxRow] : []) },
    );
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ model: "jev-1", answers: { intent: { type: "choice", choice: "lead", probabilities: { lead: 0.93 }, confidence: 0.93 }, needs_reply: { type: "noul", noul: 0.2 }, escalate: { type: "noul", noul: 0.01 } }, usage: { input_tokens: 10 } }), { status: 200 }),
    );
    const config = { companyId: "co", timezone: "Africa/Johannesburg", raw: { jev: { apiKey: { type: "secret_ref", secretId: "s1" } } } } as unknown as SocialConfig;
    const summary = await triageInbox(ctx, config, { fetchImpl: fetchImpl as never });
    expect(summary).toMatchObject({ triaged: 1, leads: 1 });
    expect(emit).toHaveBeenCalledWith("lead.captured", "co", expect.objectContaining({ key: "social:inbox:i1", confidence: 0.93 }));
  });
});
