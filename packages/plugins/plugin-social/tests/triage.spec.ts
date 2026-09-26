import { afterEach, describe, expect, it, vi } from "vitest";
import { socialConfigFrom } from "../src/config.js";
import type { AccountRow, InboxItemRow } from "../src/db.js";
import { NAMESPACE } from "../src/namespace.js";
import { createIssueSafely } from "../src/issues.js";
import { correctTriage, readTriage, triageInbox, triageOut, triageState, TRIAGE_QUESTIONS } from "../src/triage.js";
import { fakeCtx, json, jsonOf, mockFetch, TEST_UI_BASE } from "./helpers.js";

const T = (name: string) => `${NAMESPACE}.${name}`;
const NOW = new Date("2026-09-26T10:00:00Z");

afterEach(() => {
  vi.unstubAllGlobals();
});

function item(id: string, body: string, extra: Partial<InboxItemRow> = {}): InboxItemRow {
  return {
    id, company_id: "co", account_id: "acc1", platform: "facebook", kind: "comment", author: `Fan ${id}`, body, status: "new", external_id: `ext-${id}`,
    parent_external_id: null, permalink: `https://fb.test/${id}`, destination_id: "d1", post_id: "post1", reply_draft: null, reply_body: null,
    reply_external_id: null, replied_at: null, received_at: NOW, client_kind: null, client_ref: null, client_name: null, triage: null, triaged_at: null,
    triage_attempts: 0, triage_issue_id: null, created_at: NOW, ...extra,
  };
}

const ACCOUNT = {
  id: "acc1", company_id: "co", platform: "facebook", scope: "org", owner_user_id: null, status: "connected", secret_ref: null, display_name: "PiB Page",
  external_id: "page1", handle: null, avatar_url: null, token_enc: "v1.x", refresh_token_enc: null, token_expires_at: null, scopes: [], client_kind: null,
  client_ref: null, client_name: null, last_error: null, meta: {}, key_version: 1, created_by_user_id: "creator", reconnect_issue_id: null,
  last_refreshed_at: null, created_at: NOW, updated_at: NOW,
} as AccountRow;

/** Jev answers per inbox text. */
function answers(kind: "spam" | "reply" | "risk" | "chat" | "unsure-spam") {
  const base = {
    needs_reply: { type: "noul", noul: 0.1 },
    intent: { type: "choice", choice: "other", probabilities: {}, confidence: 0.8 },
    sentiment: { type: "score", score: 1, probabilities: {}, confidence: 0.8 },
    escalate: { type: "noul", noul: 0.05 },
  };
  if (kind === "spam") return { ...base, intent: { ...base.intent, choice: "spam", confidence: 0.92 } };
  if (kind === "unsure-spam") return { ...base, intent: { ...base.intent, choice: "spam", confidence: 0.55 } };
  if (kind === "reply") return { ...base, needs_reply: { type: "noul", noul: 0.95 }, intent: { ...base.intent, choice: "question", confidence: 0.9 } };
  if (kind === "risk") return { ...base, needs_reply: { type: "noul", noul: 0.95 }, intent: { ...base.intent, choice: "complaint" }, sentiment: { ...base.sentiment, score: 0.1 }, escalate: { type: "noul", noul: 0.9 } };
  return base;
}

function world(items: InboxItemRow[], options: { jev?: boolean; digest?: string | null; agent?: boolean } = {}) {
  const created: Array<Record<string, unknown>> = [];
  const comments: Array<{ issueId: string; body: string }> = [];
  const state = new Map<string, unknown>();
  if (options.digest) state.set("digest:acc1:2026-09-26", options.digest);
  const ctx = fakeCtx({
    issues: {
      create: vi.fn(async (input: Record<string, unknown>) => {
        created.push(input);
        return { id: `iss-${created.length}` };
      }),
      createComment: vi.fn(async (issueId: string, body: string) => {
        comments.push({ issueId, body });
      }),
      requestWakeup: vi.fn(async () => ({ queued: true })),
    },
    companies: { get: vi.fn(async () => ({ id: "co", issuePrefix: "PIB", defaultResponsibleUserId: "default-person" })) },
    projects: { managed: { get: vi.fn(async () => ({ projectId: "proj-social" })) } },
    agents: {
      get: vi.fn(async (id: string) => (options.agent && id === "agent-1" ? { id, status: "idle", name: "Social Media Manager" } : null)),
      managed: { get: vi.fn(async () => ({ agentId: null })) },
    },
    state: {
      get: vi.fn(async (key: { namespace?: string; stateKey: string }) => {
        if (key.stateKey === "plugin-ui-base") return TEST_UI_BASE;
        if (key.namespace === "pib-hire") return options.agent ? { agentId: "agent-1" } : null;
        return state.get(key.stateKey) ?? null;
      }),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => {
        state.set(key.stateKey, value);
      }),
    },
  }, {
    queryResult: (sql, params) => {
      if (sql.includes("triaged_at IS NULL")) return items;
      if (sql.includes(`FROM ${T("posts")} WHERE id = $1`)) return [{ id: params[0], company_id: "co", body: "Our new winter menu is here", owner_user_id: "post-owner", status: "published" }];
      if (sql.includes(`FROM ${T("accounts")} WHERE id = $1`)) return [ACCOUNT];
      if (sql.includes(`FROM ${T("inbox_items")} WHERE id = $1`)) return items.filter((i) => i.id === params[0]);
      return [];
    },
  });
  const config = socialConfigFrom(ctx, "co", {
    publicBaseUrl: "https://paperclip.test",
    timezone: "Africa/Johannesburg",
    ...(options.jev === false ? {} : { jev: { apiKey: "tsk-test", model: "jev-1.13.0" } }),
  }, TEST_UI_BASE);
  return { ctx, config, created, comments, state };
}

describe("triage mapping", () => {
  it("sends only platform, kind, clipped text and a post snippet", () => {
    const state = triageState({ platform: "instagram", kind: "comment", body: `  ${"a".repeat(900)}  ` }, `${"b".repeat(300)}`);
    expect(Object.keys(state)).toEqual(["platform", "kind", "text", "post"]);
    expect(state.platform).toBe("Instagram");
    expect(state.text).toHaveLength(600);
    expect(state.post).toHaveLength(200);
    expect(triageState({ platform: "x", kind: "mention", body: "hi" }, null)).toEqual({ platform: "X", kind: "mention", text: "hi" });
    expect(Object.keys(TRIAGE_QUESTIONS)).toEqual(["needs_reply", "intent", "sentiment", "escalate"]);
  });

  it("maps answers to actions with the kit thresholds", () => {
    const read = (kind: Parameters<typeof answers>[0]) => readTriage({ model: "jev-1.13.0", ids: {}, answers: answers(kind) as never });
    expect(read("spam").action).toBe("spam_read");
    expect(read("unsure-spam").action).toBe("none"); // spam below update (0.7) is left alone
    expect(read("reply")).toMatchObject({ action: "queued", needsReply: { yes: true }, intent: { value: "question" } });
    const risk = read("risk");
    expect(risk).toMatchObject({ action: "escalated", sentiment: { value: "negative" }, escalate: { yes: true } });
    expect(read("chat")).toMatchObject({ action: "none", sentiment: { value: "neutral" } });
    // Borderline needs_reply (p 0.7 → confidence 0.4) does not queue.
    expect(readTriage({ model: "m", ids: {}, answers: { ...answers("chat"), needs_reply: { type: "noul", noul: 0.7 } } as never }).action).toBe("none");
  });
});

describe("triage job", () => {
  it("does nothing without a Jev key (current behaviour)", async () => {
    const fetchMock = mockFetch([]);
    const w = world([item("i1", "Free followers!!!")], { jev: false });
    expect(await triageInbox(w.ctx, w.config, { now: NOW })).toMatchObject({ skipped: "no_jev", triaged: 0 });
    expect(fetchMock.calls).toHaveLength(0);
    expect(w.ctx.fakeDb.executes).toHaveLength(0);
    expect(w.ctx.fakeDb.queries).toHaveLength(0);
  });

  it("marks spam read, queues replies in one digest per account per day, and escalates risk to the post owner", async () => {
    const items = [item("spam", "Free followers!!!"), item("q1", "What time do you open?"), item("q2", "Do you deliver to Ballito?"), item("risk", "I got food poisoning and I am calling my lawyer")];
    const fetchMock = mockFetch([
      ["POST https://api.typesafe.ai/v1/systemone", (_url, init) => {
        const body = JSON.parse(String(init.body)) as { state: { text: string } };
        const kind = body.state.text.startsWith("Free") ? "spam" : body.state.text.includes("lawyer") ? "risk" : "reply";
        return json({ model: "jev-1.13.0", answers: answers(kind), usage: { input_tokens: 90 } });
      }],
    ]);
    const w = world(items, { agent: true });
    const summary = await triageInbox(w.ctx, w.config, { now: NOW });
    expect(summary).toEqual({ triaged: 4, spam: 1, queued: 2, escalated: 1, failed: 0 });

    // Minimal data: named fields only, one call per item with all four questions.
    expect(fetchMock.calls).toHaveLength(4);
    const request = jsonOf(fetchMock.calls[0]!);
    expect(request.model).toBe("jev-1.13.0");
    expect(request.state).toEqual({ platform: "Facebook", kind: "comment", text: "Free followers!!!", post: "Our new winter menu is here" });
    expect(Object.keys(request.questions as object)).toEqual(["needs_reply", "intent", "sentiment", "escalate"]);
    expect(fetchMock.calls[0]!.headers.get("authorization")).toBe("Bearer tsk-test");

    // Spam → read.
    expect(w.ctx.fakeDb.executes.some((x) => x.sql.includes(`UPDATE ${T("inbox_items")} SET status = $3`) && x.params[0] === "spam" && x.params[2] === "read")).toBe(true);
    // One digest issue for both replies, assigned to the agent and woken; one escalation for a person.
    expect(w.created).toHaveLength(2);
    const escalation = w.created.find((c) => String(c.originId).startsWith("inbox-escalate:"))!;
    expect(escalation).toMatchObject({ assigneeUserId: "post-owner", priority: "high", status: "todo" });
    expect(escalation.assigneeAgentId).toBeUndefined();
    const digest = w.created.find((c) => String(c.originId).startsWith("inbox:acc1:"))!;
    expect(digest).toMatchObject({ assigneeAgentId: "agent-1", originId: "inbox:acc1:2026-09-26", projectId: "proj-social" });
    expect(String(digest.description)).toContain("`q1`");
    expect(String(digest.description)).toContain("`q2`");
    expect(String(digest.description)).not.toContain("lawyer");
    expect(w.state.get("digest:acc1:2026-09-26")).toBe(`iss-${w.created.indexOf(digest) + 1}`);
    // Triage stored on every item; acted decisions flagged.
    const saved = w.ctx.fakeDb.executes.filter((x) => x.sql.includes("SET triage = $3::jsonb"));
    expect(new Set(saved.map((x) => x.params[0]))).toEqual(new Set(["spam", "q1", "q2", "risk"]));
    expect(JSON.parse(String(saved.find((x) => x.params[0] === "q1")!.params[2]))).toMatchObject({ action: "queued", intent: { value: "question" } });
    expect(w.ctx.fakeDb.executes.filter((x) => x.sql.includes(`UPDATE ${T("decisions")} SET acted = true`))).toHaveLength(4);
    expect(w.ctx.fakeDb.executes.filter((x) => x.sql.startsWith(`INSERT INTO ${T("decisions")}`))).toHaveLength(16);
  });

  it("adds later replies to today's digest as a comment and wakes the agent", async () => {
    mockFetch([["POST https://api.typesafe.ai/v1/systemone", () => json({ model: "jev-1.13.0", answers: answers("reply") })]]);
    const w = world([item("q3", "Are you open on Sunday?")], { agent: true, digest: "iss-today" });
    await triageInbox(w.ctx, w.config, { now: NOW });
    expect(w.created).toHaveLength(0);
    expect(w.comments).toEqual([{ issueId: "iss-today", body: expect.stringContaining("`q3`") }]);
    expect((w.ctx.issues as unknown as { requestWakeup: ReturnType<typeof vi.fn> }).requestWakeup).toHaveBeenCalledTimes(1);
  });

  it("counts a failed call and leaves the item for the next run", async () => {
    mockFetch([["POST https://api.typesafe.ai/v1/systemone", () => json({ error: "bad" }, 400)]]);
    const w = world([item("i1", "Hello")]);
    expect(await triageInbox(w.ctx, w.config, { now: NOW })).toMatchObject({ triaged: 0, failed: 1 });
    expect(w.ctx.fakeDb.executes.map((x) => x.sql)).toEqual([expect.stringContaining("SET triage_attempts = triage_attempts + 1")]);
  });
});

describe("triage corrections", () => {
  it("logs the correction against the decision and brings a not-spam item back", async () => {
    const triage = readTriage({ model: "jev-1.13.0", ids: { intent: "dec-intent", sentiment: "dec-sent" }, answers: answers("spam") as never });
    const w = world([item("i1", "Hi there", { status: "read", triage })]);
    const result = await correctTriage(w.ctx, "co", "user-1", { itemId: "i1", key: "intent", value: "question" });
    expect(result).toEqual({ itemId: "i1", key: "intent", value: "question", logged: true });
    const correction = w.ctx.fakeDb.executes.find((x) => x.sql.includes("SET corrected_to = $3"))!;
    expect(correction.params).toEqual(["dec-intent", "co", "question", "user-1"]);
    const saved = w.ctx.fakeDb.executes.find((x) => x.sql.includes("SET triage = $3::jsonb"))!;
    expect(triageOut(JSON.parse(String(saved.params[2])), NOW)).toMatchObject({ intent: "question", corrected: ["intent"] });
    expect(w.ctx.fakeDb.executes.some((x) => x.sql.includes("SET status = $3") && x.params[2] === "new")).toBe(true);
    await expect(correctTriage(w.ctx, "co", "user-1", { itemId: "i1", key: "intent", value: "angry" })).rejects.toThrow(/intent must be one of/);
    await expect(correctTriage(w.ctx, "co", "user-1", { itemId: "i1", key: "mood", value: "x" })).rejects.toThrow(/key must be one of/);
  });
});

describe("issue fallback", () => {
  it("creates the issue unassigned when the host refuses the assignee", async () => {
    const inputs: Array<Record<string, unknown>> = [];
    const ctx = fakeCtx({
      issues: {
        create: vi.fn(async (input: Record<string, unknown>) => {
          inputs.push(input);
          if (input.assigneeUserId) throw new Error("Assignee is not a member");
          return { id: "iss-9" };
        }),
        requestWakeup: vi.fn(),
      },
    });
    expect(await createIssueSafely(ctx, { companyId: "co", title: "t", assigneeUserId: "gone" })).toEqual({ id: "iss-9", woke: false });
    expect(inputs.map((i) => i.assigneeUserId ?? null)).toEqual(["gone", null]);
    const refusing = fakeCtx({ issues: { create: vi.fn(async () => { throw new Error("down"); }) } });
    await expect(createIssueSafely(refusing, { companyId: "co", title: "t" })).rejects.toThrow("down");
  });
});
