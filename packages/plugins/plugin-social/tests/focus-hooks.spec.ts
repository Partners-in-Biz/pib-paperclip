/**
 * 0.13.0: one focus a month per scope, posts built from tagged parts (hook, body, ask), and a board that says which
 * parts to make again. These tests cover the rules; `focus-hooks.pg.spec.ts` covers the SQL.
 */
import { describe, expect, it, vi } from "vitest";
import { focusOut, monthIn } from "../src/focus.js";
import { getPlaybookRecord, missingHookTag, setFocus, type GrowthActor, type GrowthEnv } from "../src/growth/service.js";
import { MIN_REACH, partOf, postTotals, rankParts } from "../src/hook-board.js";
import type { MetricsRow } from "../src/db.js";
import { POST_REVIEW_CHECKS } from "../src/review.js";
import { PLAN_ROUTINE_DESCRIPTION, SKILLS, SOCIAL_CRAFT_REFERENCE } from "../src/skills.js";
import { SOCIAL_TOOLS } from "../src/tools.js";
import { fakeCtx } from "./helpers.js";
import { memoryStore } from "./memory-store.js";

const AGENT: GrowthActor = { companyId: "co", userId: null, agentId: "agent-1", isAgent: true };
const PERSON: GrowthActor = { companyId: "co", userId: "user-1", agentId: null, isAgent: false };
const TZ = "Africa/Johannesburg";
const FOCUS = { theme: "Stop losing leads after hours", audience: "Owners of service firms who miss calls", offer: "Book a 20 minute call", proof: ["A client's missed-call log, March", "Screen of the after-hours reply"], metric: "10 booked calls from social" };

function setup() {
  const { store, db } = memoryStore();
  const ctx = fakeCtx({
    config: { get: vi.fn(async () => ({ publicBaseUrl: "https://paperclip.test", timezone: TZ })) },
    companies: { get: vi.fn(async () => ({ id: "co", issuePrefix: "PIB" })) },
  });
  const env: GrowthEnv = { ctx, store, now: () => new Date() };
  return { env, db };
}

describe("the month of a focus", () => {
  it("is the month in the company's time zone", () => {
    expect(monthIn(TZ, new Date("2026-10-31T22:30:00Z"))).toBe("2026-11");
    expect(monthIn("America/New_York", new Date("2026-11-01T02:00:00Z"))).toBe("2026-10");
    expect(monthIn("Not/AZone", new Date("2026-11-12T10:00:00Z"))).toBe("2026-11");
  });

  it("says what to do when there is none, or an old one", () => {
    expect(focusOut({ constraints: {} }, "2026-11")).toMatchObject({ focus: null, state: "none", thisMonth: "2026-11", past: [] });
    expect(focusOut({ constraints: {} }, "2026-11").note).toContain("set-focus");
    const old = { constraints: { focus: { ...FOCUS, month: "2026-10", setBy: "user:u", setAt: "x" } } };
    expect(focusOut(old, "2026-11")).toMatchObject({ state: "expired" });
    expect(focusOut(old, "2026-11").note).toContain("learned");
    expect(focusOut(old, "2026-10")).toMatchObject({ state: "current" });
    expect(focusOut(old, "2026-10").note).toBeUndefined();
    expect(focusOut(old, "2026-09")).toMatchObject({ state: "next" });
  });
});

describe("set-focus", () => {
  it("sets this month's focus for own work, and get-playbook returns it", async () => {
    const w = setup();
    const month = monthIn(TZ);
    const before = (await getPlaybookRecord(w.env, AGENT, {})) as { focus: { state: string; note?: string } };
    expect(before.focus.state).toBe("none");
    expect(before.focus.note).toContain("set-focus");

    const set = await setFocus(w.env, AGENT, { ...FOCUS });
    expect(set).toMatchObject({ state: "current", replaced: false, focus: { month, theme: FOCUS.theme, proof: FOCUS.proof, setBy: "agent:agent-1" } });
    const after = (await getPlaybookRecord(w.env, AGENT, {})) as { focus: { state: string; focus: { theme: string } } };
    expect(after.focus).toMatchObject({ state: "current", focus: { theme: FOCUS.theme } });
    // Other program constraints are kept.
    expect(w.db.programs[0]!.constraints).toHaveProperty("focus");
  });

  it("replaces the same month, and keeps the other constraints", async () => {
    const w = setup();
    await setFocus(w.env, PERSON, { ...FOCUS });
    w.db.programs[0]!.constraints = { ...w.db.programs[0]!.constraints, brandVoice: "Warm" };
    const again = await setFocus(w.env, PERSON, { ...FOCUS, theme: "A new theme", proof: "One line\nAnother line" });
    expect(again).toMatchObject({ replaced: true, focus: { theme: "A new theme", proof: ["One line", "Another line"], setBy: "user:user-1" } });
    expect(w.db.programs[0]!.constraints).toMatchObject({ brandVoice: "Warm" });
    expect((w.db.programs[0]!.constraints as { focusLog?: unknown[] }).focusLog).toBeUndefined();
  });

  it("closes an older focus only with what it taught, and logs it", async () => {
    const w = setup();
    await setFocus(w.env, PERSON, { ...FOCUS });
    const program = w.db.programs[0]!;
    (program.constraints as { focus: { month: string } }).focus.month = "2026-01";
    await expect(setFocus(w.env, AGENT, { ...FOCUS, theme: "Next" })).rejects.toThrow(/still open.*learned/s);
    const next = (await setFocus(w.env, AGENT, { ...FOCUS, theme: "Next", learned: "Price hooks won; tips lost." })) as unknown as { past: Array<{ month: string; learned: string }>; focus: { theme: string } };
    expect(next.focus.theme).toBe("Next");
    expect(next.past).toHaveLength(1);
    expect(next.past[0]).toMatchObject({ month: "2026-01", learned: "Price hooks won; tips lost." });
  });

  it("refuses a focus without real material, a far month, or a missing part", async () => {
    const w = setup();
    await expect(setFocus(w.env, AGENT, { ...FOCUS, proof: [] })).rejects.toThrow(/proof is required/);
    await expect(setFocus(w.env, AGENT, { ...FOCUS, month: "2020-01" })).rejects.toThrow(/this month/);
    await expect(setFocus(w.env, AGENT, { ...FOCUS, month: "soon" })).rejects.toThrow(/2026-11/);
    await expect(setFocus(w.env, AGENT, { ...FOCUS, offer: " " })).rejects.toThrow(/offer is required/);
    await expect(setFocus(w.env, AGENT, { ...FOCUS, theme: "x".repeat(201) })).rejects.toThrow(/at most 200/);
  });
});

describe("a post needs its hook tag once the scope has a focus", () => {
  const post = (overrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ scope: "org", client_kind: null, client_ref: null, overrides, reply_to_url: null, quote_url: null, ...extra });

  it("lets every post through while there is no focus", async () => {
    const w = setup();
    expect(await missingHookTag(w.env, "co", post())).toBeNull();
    await getPlaybookRecord(w.env, AGENT, {});
    expect(await missingHookTag(w.env, "co", post())).toBeNull();
  });

  it("refuses an untagged post, and lets tagged posts, replies and My Social through", async () => {
    const w = setup();
    await setFocus(w.env, AGENT, { ...FOCUS });
    const refusal = await missingHookTag(w.env, "co", post());
    expect(refusal).toContain("hook:<short name>");
    expect(refusal).toContain(FOCUS.theme);
    expect(await missingHookTag(w.env, "co", post({ tags: ["text-native"] }))).not.toBeNull();
    expect(await missingHookTag(w.env, "co", post({ tags: ["hook:missed calls"] }))).toBeNull();
    expect(await missingHookTag(w.env, "co", post({}, { reply_to_url: "https://x.com/a/status/1" }))).toBeNull();
    expect(await missingHookTag(w.env, "co", post({}, { quote_url: "https://x.com/a/status/1" }))).toBeNull();
    expect(await missingHookTag(w.env, "co", post({}, { scope: "personal" }))).toBeNull();
    // Another scope (a client without a focus) is not held to this one's.
    expect(await missingHookTag(w.env, "co", post({}, { client_kind: "company", client_ref: "c9" }))).toBeNull();
  });

  it("stops asking when the focus is last month's", async () => {
    const w = setup();
    await setFocus(w.env, AGENT, { ...FOCUS });
    (w.db.programs[0]!.constraints as { focus: { month: string } }).focus.month = "2026-01";
    expect(await missingHookTag(w.env, "co", post())).toBeNull();
  });
});

describe("the parts of a post", () => {
  it("reads hook, body and ask from the tags", () => {
    const p = { overrides: { tags: ["text-native", "hook:missed calls", "body:demo", "cta:book a call", "hook:"] } };
    expect(partOf(p, "hook")).toBe("missed calls");
    expect(partOf(p, "body")).toBe("demo");
    expect(partOf(p, "cta")).toBe("book a call");
    expect(partOf({ overrides: {} }, "hook")).toBeNull();
    expect(partOf({ overrides: null }, "hook")).toBeNull();
    expect(partOf({ overrides: { tags: ["hook:"] } }, "hook")).toBeNull();
  });

  it("adds a post's destinations, and takes the best reading of each", () => {
    const row = (over: Partial<MetricsRow>): MetricsRow => ({ id: "m", company_id: "co", post_id: "p1", destination_id: "d1", account_id: "a1", platform: "facebook", metric_window: "24h", views: 0, likes: 0, comments: 0, shares: 0, impressions: null, reach: null, saves: null, clicks: null, recorded_at: null, ...over });
    const totals = postTotals([
      row({ reach: 40, likes: 2 }),
      row({ metric_window: "7d", reach: "90", likes: 5, comments: 1 }),
      row({ destination_id: "d2", account_id: "a2", platform: "tiktok", views: 300, shares: 4, saves: 2, clicks: 1 }),
      row({ post_id: "p2", destination_id: "d3", impressions: 10 }),
    ]);
    expect(totals.get("p1")).toEqual({ reach: 390, actions: 13 });
    expect(totals.get("p2")).toEqual({ reach: 10, actions: 0 });
  });
});

describe("ranking the parts", () => {
  const p = (name: string, reach: number, actions: number, id = `${name}-${reach}-${actions}`) => ({ id, name, reach, actions });

  it("gives no verdict under the reach floor", () => {
    const rows = rankParts([p("a", 40, 10), p("a", 50, 10), p("b", 5, 5)]);
    expect(MIN_REACH).toBe(100);
    expect(rows.map((r) => [r.name, r.rate, r.verdict])).toEqual([["a", null, "too little reach"], ["b", null, "too little reach"]]);
    expect(rows[0]).toMatchObject({ posts: 2, reach: 90, actions: 20 });
  });

  it("one ranked part has nothing to be compared with", () => {
    expect(rankParts([p("a", 200, 10)])[0]).toMatchObject({ rate: 5, verdict: "keep testing" });
  });

  it("names the winners and the losers against the middle", () => {
    const rows = rankParts([p("price", 400, 40), p("price", 100, 10), p("story", 300, 12), p("tip", 300, 3), p("new", 20, 9)]);
    expect(rows.map((r) => [r.name, r.rate, r.verdict])).toEqual([
      ["price", 10, "double down"],
      ["story", 4, "keep testing"],
      ["tip", 1, "drop"],
      ["new", null, "too little reach"],
    ]);
    expect(rows[0]!.postIds).toHaveLength(2);
  });

  it("never doubles down on nothing", () => {
    expect(rankParts([p("a", 200, 0), p("b", 300, 0)]).map((r) => r.verdict)).toEqual(["drop", "drop"]);
  });
});

describe("what agents are told", () => {
  const content = SKILLS.find((s) => s.skillKey === "social-content")!.markdown;
  const publish = SKILLS.find((s) => s.skillKey === "social-publish")!.markdown;

  it("the tools exist and both skills name them", () => {
    const names = SOCIAL_TOOLS.map((t) => t.name);
    expect(names).toContain("set-focus");
    expect(names).toContain("hook-board");
    const setFocusTool = SOCIAL_TOOLS.find((t) => t.name === "set-focus")!;
    expect((setFocusTool.parametersSchema as { required: string[] }).required).toEqual(expect.arrayContaining(["theme", "audience", "offer", "proof", "metric"]));
    for (const text of [content, publish]) {
      expect(text).toContain("set-focus");
      expect(text).toContain("hook-board");
    }
  });

  it("the craft reference carries the method: a focus a month, many hooks, a few bodies and asks, then double down", () => {
    for (const text of ["## 2. One focus a month", "## 4. Hooks, bodies, asks: test many, then double down", "write 50", "belief-breaker", "demonstration", "hook:<short name>", "body:<short name>", "cta:<short name>", "beat the control", "organic winners are the first ads", "An app's focus is usually downloads"]) {
      expect(SOCIAL_CRAFT_REFERENCE, text).toContain(text);
    }
    // Sections are numbered in order, with none missing.
    const numbers = [...SOCIAL_CRAFT_REFERENCE.matchAll(/^## (\d+)\. /gm)].map((m) => Number(m[1]));
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
    expect(numbers.length).toBe(11);
  });

  it("the weekly plan starts from the focus and the board, and the reviewer checks the picture and the tag", () => {
    for (const text of ["set-focus", "hook-board", "50 first lines", "double down", "hook:<short name>, body:<short name> and cta:<short name>", "cannot pass review"]) expect(PLAN_ROUTINE_DESCRIPTION, text).toContain(text);
    expect(content).toContain("In a focus's first week write 50 first lines");
    const checks = POST_REVIEW_CHECKS.join("\n");
    expect(checks).toContain("this month's focus");
    expect(checks).toContain("a reused file cannot pass");
    expect(checks).toContain("hook:<short name>");
  });
});
