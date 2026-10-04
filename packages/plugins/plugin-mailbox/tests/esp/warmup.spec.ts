import { describe, expect, it } from "vitest";
import { BOUNCE_RATE_LIMIT, clearanceOf, COMPLAINT_RATE_LIMIT, dailyCap, DEFAULT_STEADY_CAP, highestDailyCap, overCap, REPUTATION_MIN_SENDS_BOUNCE, REPUTATION_MIN_SENDS_COMPLAINT, reputationOf, softBounceBackoffUntil, utcDay, WARMUP_SCHEDULE, warmupDay } from "../../src/esp/warmup.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-10T08:00:00Z");
const row = (first: string | null, last: string | null = first, extra: Partial<{ warmup_exempt: boolean; daily_cap_override: number | null }> = {}) => ({ first_sent_at: first, last_sent_at: last, warmup_exempt: false, daily_cap_override: null as number | null, ...extra });

describe("warm-up", () => {
  it("documents the schedule: 50 a day at first, doubling roughly, 13 days, then the steady cap", () => {
    expect(WARMUP_SCHEDULE).toEqual([50, 100, 200, 400, 700, 1000, 1500, 2000, 3000, 4000, 5000, 6000, 8000]);
    expect(DEFAULT_STEADY_CAP).toBe(10_000);
  });

  it("a domain that has not sent is on day 1 with the smallest cap", () => {
    expect(dailyCap(row(null), 10_000, NOW)).toEqual({ cap: 50, day: 1, warming: true, source: "warm-up" });
  });

  it("counts UTC days from the first send: day 1 is that day, however late it was sent", () => {
    expect(warmupDay(row("2026-10-10T00:00:01Z"), NOW)).toBe(1);
    expect(warmupDay(row("2026-10-09T23:59:59Z", "2026-10-09T23:59:59Z"), NOW)).toBe(2);
    expect(warmupDay(row("2026-10-04T12:00:00Z", "2026-10-09T12:00:00Z"), NOW)).toBe(7);
    expect(dailyCap(row("2026-10-04T12:00:00Z", "2026-10-09T12:00:00Z"), 10_000, NOW).cap).toBe(1500);
  });

  it("is the steady cap from day 14, and never above it while warming", () => {
    expect(dailyCap(row("2026-09-28T12:00:00Z", "2026-10-09T12:00:00Z"), 10_000, NOW)).toMatchObject({ cap: 8000, day: 13, warming: true });
    expect(dailyCap(row("2026-09-27T12:00:00Z", "2026-10-09T12:00:00Z"), 10_000, NOW)).toEqual({ cap: 10_000, day: 14, warming: false, source: "steady" });
    // A small steady cap wins over the schedule.
    expect(dailyCap(row("2026-10-08T12:00:00Z", "2026-10-09T12:00:00Z"), 150, NOW).cap).toBe(150);
  });

  it("starts again after 30 idle days: the reputation has gone cold", () => {
    const idle = row("2026-06-01T00:00:00Z", "2026-08-20T00:00:00Z");
    expect(warmupDay(idle, NOW)).toBe(1);
    expect(dailyCap(idle, 10_000, NOW).cap).toBe(50);
    expect(warmupDay(row("2026-06-01T00:00:00Z", "2026-09-20T00:00:00Z"), NOW)).toBeGreaterThan(14);
  });

  it("a person can say a domain is established, or give it a cap of its own; that wins over the schedule", () => {
    expect(dailyCap(row(null, null, { warmup_exempt: true }), 10_000, NOW)).toEqual({ cap: 10_000, day: null, warming: false, source: "established" });
    expect(dailyCap(row(null, null, { daily_cap_override: 300 }), 10_000, NOW)).toEqual({ cap: 300, day: null, warming: false, source: "override" });
  });

  it("is over the cap only when the new recipients pass it", () => {
    expect(overCap(40, 10, 50)).toBe(false);
    expect(overCap(40, 11, 50)).toBe(true);
    expect(overCap(0, 51, 50)).toBe(true);
  });

  it("utcDay is the UTC date, not the local one", () => {
    expect(utcDay(Date.parse("2026-10-10T23:59:59Z"))).toBe("2026-10-10");
    expect(utcDay(Date.parse("2026-10-11T00:00:00Z"))).toBe("2026-10-11");
  });
});

const days = (rows: Array<[string, number, number, number, number]>) => rows.map(([day, sent, hard, soft, complaints]) => ({ day, sent, delivered: sent - hard, hard_bounces: hard, soft_bounces: soft, complaints }));

describe("reputation: 2% hard bounces, 0.1% complaints, over 7 days", () => {
  it("states the limits", () => {
    expect(BOUNCE_RATE_LIMIT).toBe(0.02);
    expect(COMPLAINT_RATE_LIMIT).toBe(0.001);
    expect(REPUTATION_MIN_SENDS_BOUNCE).toBe(100);
    expect(REPUTATION_MIN_SENDS_COMPLAINT).toBe(1000);
  });

  it("is quiet below both limits", () => {
    const r = reputationOf(days([["2026-10-09", 500, 5, 3, 0], ["2026-10-10", 500, 4, 0, 0]]), "d.co", NOW);
    expect(r).toMatchObject({ sent: 1000, hardBounces: 9, bounceRate: 0.009, complaintRate: 0, judged: true, problems: [] });
  });

  it("flags a 2% hard bounce rate, exactly at the limit, and says marketing is held back", () => {
    const r = reputationOf(days([["2026-10-10", 1000, 20, 0, 0]]), "d.co", NOW);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({ code: "esp_bounce_rate", severity: "bad", blocks: "marketing" });
    expect(r.problems[0]!.message).toMatch(/20 of 1000 recipients hard bounced.*2\.0%.*marketing mail from it is held back/);
    expect(reputationOf(days([["2026-10-10", 1000, 19, 0, 0]]), "d.co", NOW).problems).toEqual([]);
  });

  it("flags a 0.1% complaint rate", () => {
    const r = reputationOf(days([["2026-10-10", 1000, 0, 0, 1]]), "d.co", NOW);
    expect(r.problems.map((p) => p.code)).toEqual(["esp_complaint_rate"]);
    expect(r.problems[0]!.message).toMatch(/1 of 1000.*0\.10%/);
    expect(reputationOf(days([["2026-10-10", 1001, 0, 0, 1]]), "d.co", NOW).problems).toEqual([]);
  });

  it("only looks at the last 7 UTC days: older bounces fall out of the window", () => {
    const rows = days([["2026-10-03", 100, 30, 0, 0], ["2026-10-04", 100, 0, 0, 0], ["2026-10-10", 1000, 5, 0, 0]]);
    // 10-03 is 7 days before 10-10, outside the window of 10-04..10-10.
    expect(reputationOf(rows, "d.co", NOW)).toMatchObject({ sent: 1100, hardBounces: 5, problems: [] });
    expect(reputationOf(rows, "d.co", NOW - DAY)).toMatchObject({ hardBounces: 5 + 30 - 5 });
  });

  it("does not judge a rate on a handful of sends, but three hard bounces or two complaints are a problem on their own", () => {
    expect(reputationOf(days([["2026-10-10", 2, 1, 0, 0]]), "d.co", NOW)).toMatchObject({ judged: false, problems: [] });
    expect(reputationOf(days([["2026-10-10", 10, 3, 0, 0]]), "d.co", NOW).problems.map((p) => p.code)).toEqual(["esp_bounce_rate"]);
    expect(reputationOf(days([["2026-10-10", 10, 0, 0, 2]]), "d.co", NOW).problems.map((p) => p.code)).toEqual(["esp_complaint_rate"]);
  });

  it("one bounce or one complaint on a new domain's first 50 recipients is not a problem (it would be 2%): a rate needs a sample, and only the absolute floor applies under it", () => {
    // Day one of the warm-up: 50 recipients. One bounce is 2.0% and one complaint 2.0%, and neither may hold a client's marketing for a week.
    expect(reputationOf(days([["2026-10-10", 50, 1, 0, 0]]), "d.co", NOW)).toMatchObject({ judged: false, complaintsJudged: false, problems: [] });
    expect(reputationOf(days([["2026-10-10", 50, 2, 0, 1]]), "d.co", NOW).problems).toEqual([]);
    // The floor: three hard bounces, or two complaints.
    expect(reputationOf(days([["2026-10-10", 50, 3, 0, 0]]), "d.co", NOW).problems.map((p) => p.code)).toEqual(["esp_bounce_rate"]);
    expect(reputationOf(days([["2026-10-10", 50, 0, 0, 2]]), "d.co", NOW).problems.map((p) => p.code)).toEqual(["esp_complaint_rate"]);
  });

  it("the bounce rate is judged from 100 recipients and the complaint rate from 1,000, exactly", () => {
    // 2 bounces: 99 recipients is under the sample (floor of 3 not reached), 100 is judged and is 2%.
    expect(reputationOf(days([["2026-10-10", 99, 2, 0, 0]]), "d.co", NOW)).toMatchObject({ judged: false, problems: [] });
    expect(reputationOf(days([["2026-10-10", 100, 2, 0, 0]]), "d.co", NOW)).toMatchObject({ judged: true });
    expect(reputationOf(days([["2026-10-10", 100, 2, 0, 0]]), "d.co", NOW).problems.map((p) => p.code)).toEqual(["esp_bounce_rate"]);
    expect(reputationOf(days([["2026-10-10", 100, 1, 0, 0]]), "d.co", NOW).problems).toEqual([]);
    // 1 complaint: 999 recipients is under the sample, 1,000 is judged and is 0.1%.
    expect(reputationOf(days([["2026-10-10", 999, 0, 0, 1]]), "d.co", NOW)).toMatchObject({ complaintsJudged: false, problems: [] });
    expect(reputationOf(days([["2026-10-10", 1000, 0, 0, 1]]), "d.co", NOW)).toMatchObject({ complaintsJudged: true });
    expect(reputationOf(days([["2026-10-10", 1000, 0, 0, 1]]), "d.co", NOW).problems.map((p) => p.code)).toEqual(["esp_complaint_rate"]);
    // Both samples are independent: 500 recipients judge the bounce rate but not the complaint rate.
    expect(reputationOf(days([["2026-10-10", 500, 0, 0, 1]]), "d.co", NOW)).toMatchObject({ judged: true, complaintsJudged: false, problems: [] });
  });

  it("the highest a domain is ever handed in a day: the person's own cap, else the steady cap", () => {
    expect(highestDailyCap({ daily_cap_override: null }, 10_000)).toBe(10_000);
    expect(highestDailyCap({ daily_cap_override: 300 }, 10_000)).toBe(300);
    expect(highestDailyCap({ daily_cap_override: 0 }, 10_000)).toBe(10_000);
  });

  it("has no rate when nothing was sent", () => {
    expect(reputationOf([], "d.co", NOW)).toMatchObject({ sent: 0, bounceRate: null, complaintRate: null, problems: [] });
  });

  it("can raise both problems at once", () => {
    expect(reputationOf(days([["2026-10-10", 1000, 40, 0, 5]]), "d.co", NOW).problems.map((p) => p.code)).toEqual(["esp_bounce_rate", "esp_complaint_rate"]);
  });
});

describe("a person lifting a reputation hold", () => {
  const base = { sent: 0, delivered: 0, hard_bounces: 0, soft_bounces: 0, complaints: 0 };
  const held = days([["2026-10-08", 30, 2, 0, 0], ["2026-10-09", 30, 2, 0, 0], ["2026-10-10", 40, 1, 0, 0]]);

  it("is held before, and judges only what comes after: the days before the clearing day are left out, the clearing day's counts at that moment are taken off", () => {
    expect(reputationOf(held, "d.co", NOW).problems.map((p) => p.code)).toEqual(["esp_bounce_rate"]);
    // Lifted on 10 Oct when that day stood at 40 sent and 1 bounce: nothing is counted yet.
    const lifted = reputationOf(held, "d.co", NOW, { day: "2026-10-10", baseline: { ...base, sent: 40, hard_bounces: 1 } });
    expect(lifted).toMatchObject({ sent: 0, hardBounces: 0, problems: [], clearedDay: "2026-10-10" });
    // More of the same day after it was lifted: only the new ones count (3 new bounces out of 10 new sends is over the floor).
    const later = days([["2026-10-08", 30, 2, 0, 0], ["2026-10-09", 30, 2, 0, 0], ["2026-10-10", 50, 4, 0, 0]]);
    expect(reputationOf(later, "d.co", NOW, { day: "2026-10-10", baseline: { ...base, sent: 40, hard_bounces: 1 } })).toMatchObject({ sent: 10, hardBounces: 3 });
    expect(reputationOf(later, "d.co", NOW, { day: "2026-10-10", baseline: { ...base, sent: 40, hard_bounces: 1 } }).problems.map((p) => p.code)).toEqual(["esp_bounce_rate"]);
    // Days AFTER the clearing day count in full.
    expect(reputationOf(held, "d.co", NOW + DAY, { day: "2026-10-10", baseline: { ...base, sent: 40, hard_bounces: 1 } }).sent).toBe(0);
    const next = days([["2026-10-08", 30, 2, 0, 0], ["2026-10-10", 40, 1, 0, 0], ["2026-10-11", 20, 3, 0, 0]]);
    expect(reputationOf(next, "d.co", NOW + DAY, { day: "2026-10-10", baseline: { ...base, sent: 40, hard_bounces: 1 } })).toMatchObject({ sent: 20, hardBounces: 3 });
  });

  it("leaves out the days before the clearing day even when the clearing day itself has no baseline", () => {
    expect(reputationOf(held, "d.co", NOW, { day: "2026-10-10", baseline: null })).toMatchObject({ sent: 40, hardBounces: 1, problems: [] });
  });

  it("stops mattering once the clearing day has left the 7-day window (every day in the window is after it)", () => {
    const old = { day: "2026-10-01", baseline: { ...base, sent: 99, hard_bounces: 50 } };
    expect(reputationOf(held, "d.co", NOW, old)).toEqual(reputationOf(held, "d.co", NOW, null));
    expect(reputationOf(held, "d.co", NOW, old).clearedDay).toBeUndefined();
  });

  it("never counts below zero (a counter that went down, a baseline taken from a later read)", () => {
    expect(reputationOf(held, "d.co", NOW, { day: "2026-10-10", baseline: { ...base, sent: 400, hard_bounces: 9 } })).toMatchObject({ sent: 0, hardBounces: 0 });
  });

  it("tells the person in the problem text when a clearing is in force, and says that only a person can lift a hold", () => {
    const again = reputationOf(days([["2026-10-10", 10, 4, 0, 0]]), "d.co", NOW, { day: "2026-10-10", baseline: null });
    expect(again.problems[0]!.message).toContain("since a person lifted the hold on 2026-10-10");
    expect(reputationOf(held, "d.co", NOW).problems[0]!.fix).toMatch(/a person can lift the hold \(Mailboxes tab, Email provider, Lift the hold\); an agent cannot/);
  });

  it("reads the clearance from a domain row, and none from a row nobody lifted", () => {
    expect(clearanceOf({ reputation_cleared_day: "2026-10-10", reputation_cleared_baseline: { ...base, sent: 5 } })).toEqual({ day: "2026-10-10", baseline: { ...base, sent: 5 } });
    expect(clearanceOf({ reputation_cleared_day: null, reputation_cleared_baseline: null })).toBeNull();
    expect(clearanceOf(null)).toBeNull();
  });
});

describe("soft bounce back-off", () => {
  it("waits 6, then 24, then 72 hours, and stays at 72", () => {
    const at = (n: number) => (Date.parse(softBounceBackoffUntil(n, NOW)) - NOW) / 3_600_000;
    expect([at(1), at(2), at(3), at(4), at(0)]).toEqual([6, 24, 72, 72, 6]);
  });
});
