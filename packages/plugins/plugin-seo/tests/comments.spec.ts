/**
 * 0.22.0: every comment the plugin posts is capped and the same notice is not posted twice in a row. On 2026-10-02
 * the plugin's own Reviewer notices (a 4,000-character note posted again for every round) grew two task threads to
 * about 103 KB, which the host cannot hand to an agent (spawn E2BIG).
 */
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { BLOCK_COMMENT_MAX, blockComment } from "../src/engine/copy.js";
import { capComment, COMMENT_DEDUPE_MS, COMMENT_MAX, commentFingerprint, isRepeatNotice, rememberNotice } from "../src/engine/thread.js";
import { NAMESPACE } from "../src/namespace.js";
import { createEnv, type Actor } from "../src/service/common.js";
import { commentOn } from "../src/service/issues.js";
import { reviewNoteExcerpt, reviewPreview } from "../src/service/preview.js";

describe("capComment", () => {
  it("leaves a comment that fits alone", () => {
    expect(capComment("short note")).toBe("short note");
    const exact = "x".repeat(COMMENT_MAX);
    expect(capComment(exact)).toBe(exact);
  });

  it("cuts a long one to the limit, notice included, with a pointer to the full text", () => {
    const body = Array.from({ length: 400 }, (_, i) => `Line ${i}: the listing is missing its price table.`).join("\n");
    const out = capComment(body, { pointer: "the whole note is on the preview" });
    expect(out.length).toBeLessThanOrEqual(COMMENT_MAX);
    expect(out).toContain("the whole note is on the preview");
    expect(out).toMatch(/\d+ more characters not shown/);
    expect(out.startsWith("Line 0: the listing is missing its price table.\nLine 1:")).toBe(true);
    // Cut between words, not in the middle of one.
    const kept = out.slice(0, out.indexOf("\n\n…"));
    expect(new Set(body.split(/\s+/)).has(kept.split(/\s+/).pop()!)).toBe(true);
  });

  it("honours a smaller limit, falls back to a default pointer and never gives a limit under 200", () => {
    const out = capComment("word ".repeat(2000), { max: 600 });
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out).toContain("SEO plugin's record");
    expect(capComment("a ".repeat(500), { max: 5 }).length).toBeLessThanOrEqual(200);
  });

  it("closes a code fence it cut inside of", () => {
    const body = `Intro\n\`\`\`\n${"code line\n".repeat(400)}\`\`\`\nOutro`;
    const out = capComment(body, { max: 500 });
    expect((out.match(/```/g) ?? []).length % 2).toBe(0);
    expect(out.length).toBeLessThanOrEqual(500);
  });
});

describe("repeat notices", () => {
  const at = "2026-10-03T08:00:00.000Z";
  const now = Date.parse(at);
  it("treats an identical notice within a day as a repeat, and a different or old one as new", () => {
    const hash = commentFingerprint("same notice");
    const memory = rememberNotice(null, { hash, at });
    expect(isRepeatNotice(memory, { hash, now: now + 1_000 })).toBe(true);
    expect(isRepeatNotice(memory, { hash: commentFingerprint("another notice"), now })).toBe(false);
    expect(isRepeatNotice(memory, { hash, now: now + COMMENT_DEDUPE_MS + 1 })).toBe(false);
    expect(isRepeatNotice(null, { hash, now })).toBe(false);
  });

  it("a keyed notice is posted once, whatever its text, and the key list stays bounded", () => {
    let memory = rememberNotice(null, { hash: "h1", key: "escalated:t-1", at });
    expect(isRepeatNotice(memory, { hash: "other", key: "escalated:t-1", now: now + 10 * COMMENT_DEDUPE_MS })).toBe(true);
    expect(isRepeatNotice(memory, { hash: "other", key: "escalated:t-2", now })).toBe(false);
    for (let i = 0; i < 60; i += 1) memory = rememberNotice(memory, { hash: `h${i}`, key: `k${i}`, at: new Date(now + i * 1000).toISOString() });
    expect(Object.keys(memory.keys ?? {}).length).toBeLessThanOrEqual(24);
    expect(memory.keys?.k59).toBeDefined();
    expect(memory.keys?.k0).toBeUndefined();
  });
});

type Row = Record<string, unknown>;

function host(options: { previewRow?: Row; rounds?: number; stateBroken?: boolean; refuse?: boolean } = {}) {
  const comments: Array<{ id: string; body: string }> = [];
  const executes: Array<{ sql: string; params: unknown[] }> = [];
  const wakes: string[] = [];
  const memory = new Map<string, unknown>();
  let clock = new Date("2026-10-03T08:00:00Z").getTime();
  const sprint: Row = {
    id: "sp-1", company_id: "co-1", name: "Acme", site_url: "https://acme.co.za", site_name: "Acme", client_ref: null, client_name: "Acme Ltd",
    status: "active", start_date: "2026-09-01", template_id: "outrank-90", template_version: 2, autopilot_mode: "safe", owner_user_id: "user-1",
    project_id: "proj-1", root_issue_id: "root-1", root_issue_identifier: "PIB-1", agent_id: "agent-1", site_access: "wordpress", site_id: "site-1",
    change_policy: "pr_only", notes: null, paused_reason: null, health: {}, scoreboard: {}, today: {}, current_day: 25, current_week: 4, current_phase: 1,
    last_daily_on: null, last_weekly_on: null, audit_days_done: [0], seeded_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
  };
  const task: Row = {
    id: "t-1", company_id: "co-1", sprint_id: "sp-1", template_key: "w3-homepage", week: 3, phase: 1, due_day: 20, focus: "Core Pages", title: "Home", description: null,
    task_type: "page-write", owner: "agent", autopilot_eligible: true, playbook_key: "w3-homepage", status: "in_progress", source: "template", parent_optimization_id: null,
    context: null, issue_id: "iss-1", issue_identifier: "PAR-9", issue_status: "in_progress", assignee_kind: "agent", blocker_reason: null, human_ask: null, evidence: null,
    started_at: null, completed_at: null, completed_by: null, created_at: null, updated_at: null,
  };
  const ctx = {
    db: {
      namespace: NAMESPACE,
      async query(sql: string) {
        if (/FROM plugin_seo_8099f8879a\.sprints WHERE id/.test(sql)) return [sprint];
        if (/FROM plugin_seo_8099f8879a\.sprint_tasks WHERE id/.test(sql)) return [task];
        if (/count\(\*\)/.test(sql)) return [{ n: options.rounds ?? 0 }];
        if (/needs_you/.test(sql)) return [];
        if (/FROM plugin_seo_8099f8879a\.previews/.test(sql)) return options.previewRow ? [options.previewRow] : [];
        return [];
      },
      async execute(sql: string, params: unknown[] = []) {
        executes.push({ sql, params });
        return { rowCount: 1 };
      },
    },
    config: { get: vi.fn(async () => ({})) },
    companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PAR" })) },
    state: {
      get: vi.fn(async (key: { stateKey: string; namespace?: string }) => {
        if (options.stateBroken) throw new Error("state down");
        return memory.get(`${key.namespace}:${key.stateKey}`) ?? null;
      }),
      set: vi.fn(async (key: { stateKey: string; namespace?: string }, value: unknown) => {
        if (options.stateBroken) throw new Error("state down");
        memory.set(`${key.namespace}:${key.stateKey}`, value);
      }),
    },
    issues: {
      create: vi.fn(async () => ({ id: "rev-1" })),
      createComment: vi.fn(async (id: string, body: string) => {
        if (options.refuse) throw new Error("host refused");
        comments.push({ id, body });
        return { id: "c" };
      }),
      requestWakeup: vi.fn(async (id: string) => {
        wakes.push(id);
        return { queued: true, runId: null };
      }),
      update: vi.fn(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch })),
    },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  } as unknown as PluginContext;
  const env = createEnv(ctx, { now: () => new Date(clock), fetch: vi.fn() as never, site: vi.fn() as never });
  return { env, comments, executes, wakes, advance: (ms: number) => void (clock += ms) };
}

describe("commentOn", () => {
  it("caps every comment it posts", async () => {
    const h = host();
    expect(await commentOn(h.env, "co-1", "iss-1", "A".repeat(12_000))).toBe(true);
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]!.body.length).toBeLessThanOrEqual(COMMENT_MAX);
    expect(h.comments[0]!.body).toMatch(/more characters not shown/);
    await commentOn(h.env, "co-1", "iss-1", "B".repeat(5_000), { max: 700, pointer: "see the record" });
    expect(h.comments[1]!.body.length).toBeLessThanOrEqual(700);
    expect(h.comments[1]!.body).toContain("see the record");
  });

  it("does not post the same notice twice in a row on an issue, but does after a day or on another issue", async () => {
    const h = host();
    expect(await commentOn(h.env, "co-1", "iss-1", "Waiting on a person: connect Search Console.")).toBe(true);
    expect(await commentOn(h.env, "co-1", "iss-1", "Waiting on a person: connect Search Console.")).toBe(true);
    expect(h.comments).toHaveLength(1);
    await commentOn(h.env, "co-1", "iss-1", "A different notice.");
    await commentOn(h.env, "co-1", "iss-1", "Waiting on a person: connect Search Console.");
    expect(h.comments).toHaveLength(3);
    await commentOn(h.env, "co-1", "iss-2", "A different notice.");
    expect(h.comments).toHaveLength(4);
    h.advance(COMMENT_DEDUPE_MS + 1_000);
    await commentOn(h.env, "co-1", "iss-2", "A different notice.");
    expect(h.comments).toHaveLength(5);
  });

  it("posts a keyed notice once per issue", async () => {
    const h = host();
    await commentOn(h.env, "co-1", "iss-1", "Sent back 3 times.", { dedupeKey: "escalated:t-1" });
    await commentOn(h.env, "co-1", "iss-1", "Sent back 4 times.", { dedupeKey: "escalated:t-1" });
    await commentOn(h.env, "co-1", "iss-1", "Sent back 3 times.", { dedupeKey: "escalated:t-2" });
    expect(h.comments.map((c) => c.body)).toEqual(["Sent back 3 times.", "Sent back 3 times."]);
  });

  it("still posts when its memory is unavailable, and reports a refusal", async () => {
    const broken = host({ stateBroken: true });
    expect(await commentOn(broken.env, "co-1", "iss-1", "Hello")).toBe(true);
    expect(await commentOn(broken.env, "co-1", "iss-1", "Hello")).toBe(true);
    expect(broken.comments).toHaveLength(2);
    const refused = host({ refuse: true });
    expect(await commentOn(refused.env, "co-1", "iss-1", "Hello")).toBe(false);
  });
});

describe("Reviewer notices on a task issue", () => {
  const row = { id: "p1", task_id: "t-1", issue_id: "iss-1", page_url: "https://acme.co.za/", title: "Home", created_by: "seo-1", stats: { rendered: { keptPct: 96 } } };
  const reviewer: Actor = { kind: "agent", agentId: "rev-agent", runId: "r2", responsibleUserId: null };
  const longNote = Array.from({ length: 70 }, (_, i) => `Problem ${i + 1}: the listing grid loses its price column on the phone layout.`).join("\n");

  it("puts a cut-down note on the issue and keeps the whole note on the preview", async () => {
    const h = host({ previewRow: row });
    await reviewPreview(h.env, "co-1", reviewer, { sprintId: "sp-1", previewId: "p1", verdict: "changes", notes: longNote.slice(0, 3_900) });
    const posted = h.comments[0]!.body;
    expect(posted.length).toBeLessThan(1_300);
    expect(posted).toContain("Problem 1:");
    expect(posted).toContain("partnersinbiz.seo:list-previews with sprintId sp-1 and previewId p1");
    const stored = h.executes.find((e) => /SET review_status/.test(e.sql))!;
    expect(String(stored.params[2])).toHaveLength(longNote.slice(0, 3_900).length);
  });

  it("keeps a short note whole", () => {
    expect(reviewNoteExcerpt("Listings are missing", "sp-1", "p1")).toBe("Listings are missing");
  });

  it("tells the task once that a page was sent back too often, without repeating the Reviewer's reason", async () => {
    const h = host({ previewRow: row, rounds: 3 });
    const first = await reviewPreview(h.env, "co-1", reviewer, { sprintId: "sp-1", previewId: "p1", verdict: "changes", notes: longNote.slice(0, 3_000) });
    const second = await reviewPreview(h.env, "co-1", reviewer, { sprintId: "sp-1", previewId: "p1", verdict: "changes", notes: `${longNote.slice(0, 2_000)} again` });
    expect(first).toMatchObject({ escalatedToOwner: true });
    expect(second).toMatchObject({ escalatedToOwner: true });
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]!.body).toMatch(/sent back 3 times/);
    expect(h.comments[0]!.body).not.toContain("Problem 1:");
    expect(h.comments[0]!.body.length).toBeLessThan(500);
  });
});

describe("sign-off and blocked comments keep their links and the way to approve", () => {
  const huge = { reason: "R".repeat(4_000), humanAsk: "A ".repeat(2_000), review: true, links: Array.from({ length: 20 }, (_, i) => `https://preview.partnersinbiz.online/p/hg/tok-${i}/${"x".repeat(900)}`) };

  it("clips each part on its own, so the closing line is never the part that is cut", () => {
    const text = blockComment(huge);
    expect(text.length).toBeLessThanOrEqual(BLOCK_COMMENT_MAX);
    expect(text).toContain("Mark this issue done to approve");
    expect(text).toContain("tok-0");
    expect(text).toContain("tok-5");
    expect(text).not.toContain("tok-6");
    expect(text).toContain("…and 14 more on the task's record");
    // Nothing is cut a second time by the plugin-wide cap, which would add its own notice.
    expect(capComment(text, { max: BLOCK_COMMENT_MAX })).toBe(text);
    const blocked = blockComment({ ...huge, review: false });
    expect(blocked.length).toBeLessThanOrEqual(BLOCK_COMMENT_MAX);
    expect(blocked).toContain("Mark the item done in the Needs you issue");
  });

  it("leaves a normal ask whole", () => {
    const text = blockComment({ reason: "Need DNS access", humanAsk: "Add the TXT record", review: false, links: ["https://x"] });
    expect(text).toContain("**What happened:** Need DNS access");
    expect(text).toContain("**What I need from you:** Add the TXT record");
    expect(text).toContain("- https://x");
    expect(text).not.toContain("…");
  });
});
