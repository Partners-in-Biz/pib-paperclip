import { describe, expect, it } from "vitest";
import { assignReplies, clockSkew, nearestRank, TurnClock, timingStamp, turnStats, type ReplyGroup, type TurnRow } from "../src/ui/turn-timing.js";

const turn = (n: number, serverPostedAt: number, over: Partial<TurnRow> = {}): TurnRow => ({ n, endAt: serverPostedAt - 1000, endKind: "end", serverPostedAt, ...over });
const group = (key: string, first: number, over: Partial<ReplyGroup> = {}): ReplyGroup => ({
  key,
  firstId: key,
  firstServerAt: first,
  finalServerAt: first,
  count: 1,
  seenAt: first,
  via: "event",
  ...over,
});

describe("assignReplies", () => {
  it("gives replies out first come, first served (0 s / 10 s / 20 s / 35 s)", () => {
    const turns = [turn(1, 0), turn(2, 10_000), turn(3, 20_000)];
    const rows = assignReplies(turns, [group("g1", 35_000), group("g2", 36_000), group("g3", 37_000)]);
    expect(rows.map((r) => r.replyServerAt)).toEqual([35_000, 36_000, 37_000]);
    expect(rows[0]!.queuedTurns).toBe(3);
    expect(rows[1]!.queuedTurns).toBe(2);
    expect(rows[2]!.queuedTurns).toBeUndefined();
  });

  it("does not give a reply to a turn posted after it, and leaves unreached turns bare", () => {
    const rows = assignReplies([turn(1, 0), turn(2, 10_000)], [group("g1", 5_000)]);
    expect(rows[0]!.replyServerAt).toBe(5_000);
    expect(rows[0]!.queuedTurns).toBeUndefined();
    expect(rows[1]!.replyServerAt).toBeUndefined();
  });

  it("carries the speak marks of the group", () => {
    const rows = assignReplies([turn(1, 0)], [group("g1", 2_000, { speak: { provider: "grok", playAt: 9, latencyKnown: true } })]);
    expect(rows[0]).toMatchObject({ provider: "grok", playAt: 9, latencyKnown: true });
  });
});

describe("TurnClock", () => {
  it("groups comments by run id and gives a comment without one its own group", () => {
    const c = new TurnClock();
    c.addTurn({ endAt: 0, endKind: "end", textAt: 1 }).serverPostedAt = 0;
    c.addTurn({ endAt: 0, endKind: "end", textAt: 1 }).serverPostedAt = 100;
    c.noteReply({ id: "a", runId: "r1", createdAt: new Date(1_000).toISOString() }, 1_100, "event");
    c.noteReply({ id: "b", runId: "r1", createdAt: new Date(3_000).toISOString() }, 3_100, "poll");
    c.noteReply({ id: "c", createdAt: new Date(4_000).toISOString() }, 4_100, "poll");
    const rows = c.rows();
    expect(rows[0]).toMatchObject({ replyServerAt: 1_000, finalServerAt: 3_000, replyComments: 2, via: "event" });
    expect(rows[1]).toMatchObject({ replyServerAt: 4_000, replyComments: 1, via: "poll" });
  });
});

describe("clockSkew", () => {
  it("is one median for the call, not per turn", () => {
    const mk = (skew: number, i: number): TurnRow => turn(i, 1_000 + skew, { postStartAt: 900, postedAt: 1_100 });
    expect(clockSkew([mk(500, 1), mk(520, 2), mk(9_000, 3)])).toBe(520);
    expect(clockSkew([])).toBe(0);
  });
});

describe("turnStats", () => {
  const full = (n: number, k: number): TurnRow => ({
    n,
    startAt: 0,
    endAt: 1_000 * k,
    endKind: "end",
    textAt: 1_000 * k + 800,
    postStartAt: 1_000 * k + 800,
    postedAt: 1_000 * k + 900,
    serverPostedAt: 1_000 * k + 850 + 5_000,
    replyServerAt: 1_000 * k + 850 + 5_000 + 4_000,
    finalServerAt: 1_000 * k + 850 + 5_000 + 6_000,
    seenAt: 1_000 * k + 900 + 4_500,
    speakStartAt: 1_000 * k + 900 + 4_800,
    audioAt: 1_000 * k + 900 + 5_800,
    playAt: 1_000 * k + 900 + 5_900,
    provider: "gemini",
    gap: 200,
  });

  it("computes each step with nearest-rank p50 and p95", () => {
    const stats = turnStats([full(1, 1), full(2, 2), full(3, 3)], 1_200);
    expect(stats.steps.stt).toEqual({ n: 3, p50: 800, p95: 800 });
    expect(stats.steps.post).toEqual({ n: 3, p50: 100, p95: 100 });
    expect(stats.steps.agent.p50).toBe(4_000);
    expect(stats.steps.agentFinal.p50).toBe(6_000);
    expect(stats.steps.queue.p50).toBe(300);
    expect(stats.steps.tts.p50).toBe(1_000);
    expect(stats.steps.start.p50).toBe(100);
    expect(stats.steps.gap.p50).toBe(200);
    expect(stats.skewMs).toBe(5_000);
    expect(stats.steps.detect.p50).toBe(550);
    expect(stats).toMatchObject({ turns: 3, answered: 3, gemini: 3, grok: 0 });
  });

  it("leaves out steps with no mark instead of counting zero", () => {
    const stats = turnStats([{ n: 1, endAt: 5, endKind: "end" }]);
    expect(stats.steps.stt).toEqual({ n: 0, p50: null, p95: null });
  });

  it("counts a turn that began under 1.5 s after the last without a reply as a split", () => {
    const a: TurnRow = { n: 1, startAt: 0, endAt: 3_000, endKind: "end" };
    const b: TurnRow = { n: 2, startAt: 4_000, endAt: 7_000, endKind: "end" };
    const c: TurnRow = { n: 3, startAt: 9_500, endAt: 12_000, endKind: "end" };
    expect(turnStats([a, b, c]).splits).toBe(1);
  });

  it("uses nearest rank", () => {
    const v = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(nearestRank(v, 50)).toBe(10);
    expect(nearestRank(v, 95)).toBe(19);
    expect(nearestRank([], 50)).toBeNull();
  });
});

describe("timingStamp", () => {
  it("names the version and the constants", () => {
    const s = timingStamp("0.2.3", { quietMs: 1200, firstChunkChars: 160, awaitPollMs: 10_000, fastWindowMs: 0, geminiPrefetch: false });
    expect(s).toBe("plugin-voice 0.2.3, quiet 1200 ms, first chunk 160 chars, await poll 10000 ms, fast window 0 ms, Gemini prefetch off");
  });
});
