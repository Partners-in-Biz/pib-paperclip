import { describe, expect, it } from "vitest";
import { assignReplies, clockSkew, nearestRank, rowSteps, TurnClock, timingStamp, turnStats, type ReplyGroup, type TurnRow } from "../src/ui/turn-timing.js";

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

describe("assignReplies, the plan's cases", () => {
  it("(a) turn 1 at 0 s, turn 2 at 10 s, run A at 20 s, run B at 35 s: agent 20 s and 25 s", () => {
    const rows = assignReplies([turn(1, 0), turn(2, 10_000)], [group("A", 20_000), group("B", 35_000)]);
    expect(rowSteps(rows[0]!, 0).agent).toBe(20_000);
    expect(rowSteps(rows[1]!, 0).agent).toBe(25_000);
    expect(rows[0]!.queuedTurns).toBe(2);
    expect(rows[1]!.queuedTurns).toBeUndefined();
  });

  it("(b) run A posts at 5 s and 20 s: first reply 5 s, agentFinal 20 s, two comments", () => {
    const c = new TurnClock();
    c.addTurn({ endAt: 0, endKind: "end", textAt: 0 }).serverPostedAt = 0;
    c.noteReply({ id: "a1", runId: "A", createdAt: new Date(5_000).toISOString() }, 5_100, "event");
    c.noteReply({ id: "a2", runId: "A", createdAt: new Date(20_000).toISOString() }, 20_100, "event");
    const row = c.rows()[0]!;
    expect(row.replyServerAt).toBe(5_000);
    expect(row.replyComments).toBe(2);
    const steps = rowSteps(row, 0);
    expect(steps.agent).toBe(5_000);
    expect(steps.agentFinal).toBe(20_000);
    expect(turnStats(c.rows()).steps.agentFinal.p50).toBe(20_000);
  });

  it("(c) one group while two turns are unanswered: the oldest gets it with queuedTurns 2, the other has no reply", () => {
    const rows = assignReplies([turn(2, 10_000), turn(1, 0)], [group("A", 20_000)]);
    const one = rows.find((r) => r.n === 1)!;
    const two = rows.find((r) => r.n === 2)!;
    expect(one).toMatchObject({ replyServerAt: 20_000, queuedTurns: 2 });
    expect(two.replyServerAt).toBeUndefined();
    expect(rowSteps(two, 0).agent).toBeUndefined();
  });

  it("(d) comments with no run id are one group each", () => {
    const c = new TurnClock();
    c.addTurn({ endAt: 0, endKind: "end", textAt: 0 }).serverPostedAt = 0;
    c.addTurn({ endAt: 0, endKind: "end", textAt: 0 }).serverPostedAt = 1;
    c.noteReply({ id: "x", runId: null, createdAt: new Date(2_000).toISOString() }, 2_100, "poll");
    c.noteReply({ id: "y", runId: null, createdAt: new Date(3_000).toISOString() }, 3_100, "poll");
    const rows = c.rows();
    expect(rows.map((r) => [r.replyServerAt, r.replyComments])).toEqual([[2_000, 1], [3_000, 1]]);
  });
});

describe("turnStats, the plan's fixtures", () => {
  const sttRow = (n: number, seconds: number, over: Partial<TurnRow> = {}): TurnRow => ({ n, endAt: 0, endKind: "end", textAt: seconds * 1000, ...over });

  it("nearest-rank p50/p95 on n = 1, 2 and 10", () => {
    expect(turnStats([sttRow(1, 7)]).steps.stt).toEqual({ n: 1, p50: 7_000, p95: 7_000 });
    expect(turnStats([sttRow(1, 2), sttRow(2, 4)]).steps.stt).toEqual({ n: 2, p50: 2_000, p95: 4_000 });
    const ten = Array.from({ length: 10 }, (_, i) => sttRow(i + 1, i + 1));
    expect(turnStats(ten).steps.stt).toEqual({ n: 10, p50: 5_000, p95: 10_000 });
  });

  it("leaves an empty step out of n while other steps have data", () => {
    const stats = turnStats([sttRow(1, 1), sttRow(2, 2, { postedAt: 2_500 })]);
    expect(stats.steps.stt.n).toBe(2);
    expect(stats.steps.post).toEqual({ n: 1, p50: 500, p95: 500 });
    expect(stats.steps.tts).toEqual({ n: 0, p50: null, p95: null });
  });

  it("counts Gemini and Grok turns from each turn's provider", () => {
    const stats = turnStats([sttRow(1, 1, { provider: "gemini" }), sttRow(2, 1, { provider: "grok" }), sttRow(3, 1, { provider: "grok" }), sttRow(4, 1)]);
    expect([stats.gemini, stats.grok]).toEqual([1, 2]);
  });

  it("counts a split at a 1.0 s gap and not at 2.0 s", () => {
    const a: TurnRow = { n: 1, startAt: 0, endAt: 3_000, endKind: "end" };
    expect(turnStats([a, { n: 2, startAt: 4_000, endAt: 6_000, endKind: "end" }]).splits).toBe(1);
    expect(turnStats([a, { n: 2, startAt: 5_000, endAt: 6_000, endKind: "end" }]).splits).toBe(0);
  });

  it("skew: server times 5 s ahead give the same detect as no skew (+-50 ms)", () => {
    const fixture = (skew: number): TurnRow[] =>
      [0, 10_000, 20_000].map((base, i) => ({
        n: i + 1,
        endAt: base,
        endKind: "end" as const,
        textAt: base + 800,
        postStartAt: base + 1_000,
        postedAt: base + 1_100,
        serverPostedAt: base + 1_050 + skew,
        replyServerAt: base + 3_000 + skew,
        finalServerAt: base + 3_000 + skew,
        seenAt: base + 3_400,
      }));
    const plain = turnStats(fixture(0));
    const ahead = turnStats(fixture(5_000));
    expect(ahead.skewMs).toBe(5_000);
    expect(Math.abs(ahead.steps.detect.p50! - plain.steps.detect.p50!)).toBeLessThanOrEqual(50);
    expect(ahead.steps.detect.p50).toBe(400);
  });
});
