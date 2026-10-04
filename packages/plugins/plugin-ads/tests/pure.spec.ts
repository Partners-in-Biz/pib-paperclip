import { describe, expect, it } from "vitest";
import { budgetAlerts, detectCpaOverTarget, detectSpendSpike, detectZeroDelivery, type SeriesPoint } from "../src/alerts.js";
import { activeDaysThisMonth, capImpact, monthPace } from "../src/budgets.js";
import { checkCreative } from "../src/creative.js";
import { addDays, daysInMonth, isDay, isMonth, isoWeek, monthEnd, todayIn } from "../src/dates.js";
import { canonicalJson, minorField, scopeKeyOf, scopeOfKey, stringList, validScopeKey, AdsError } from "../src/domain.js";
import { derive, median, sumRows } from "../src/metrics.js";
import { currencyExponent, decimalToMinor, formatMoney, microsToMinor, minorToMicros } from "../src/money.js";
import type { ApprovalRow } from "../src/db.js";
import { reviewStands, signoffState } from "../src/signoffs.js";
import { MAX_BACKFILL_DAYS, syncWindow } from "../src/sync.js";
import { budgetToneOf, inputFromMinor, minorFromInput, spendSeries } from "../src/ui/series.js";

describe("money", () => {
  it("turns decimal text into minor units without floating point error", () => {
    expect(decimalToMinor("12.34", "ZAR")).toBe(1234);
    expect(decimalToMinor("0.1", "USD")).toBe(10);
    expect(decimalToMinor("19.995", "USD")).toBe(2000);
    expect(decimalToMinor("19.994", "USD")).toBe(1999);
    expect(decimalToMinor("1234567.89", "EUR")).toBe(123456789);
    expect(decimalToMinor("1500", "JPY")).toBe(1500);
    expect(decimalToMinor("12.345", "KWD")).toBe(12345);
    expect(decimalToMinor("abc", "ZAR")).toBeNull();
    expect(decimalToMinor("", "ZAR")).toBeNull();
  });

  it("knows the minor unit of zero- and three-decimal currencies", () => {
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("usd")).toBe(2);
    expect(currencyExponent("KWD")).toBe(3);
  });

  it("converts Google micros both ways", () => {
    expect(microsToMinor("12340000", "ZAR")).toBe(1234);
    expect(microsToMinor(12_340_000, "USD")).toBe(1234);
    expect(microsToMinor("1500000000", "JPY")).toBe(1500);
    expect(minorToMicros(1234, "ZAR")).toBe(12_340_000);
    expect(minorToMicros(1500, "JPY")).toBe(1_500_000_000);
    expect(microsToMinor("nope", "ZAR")).toBe(0);
  });

  it("formats money for people", () => {
    expect(formatMoney(123456, "ZAR")).toBe("ZAR 1,234.56");
    expect(formatMoney(-5, "USD")).toBe("-USD 0.05");
    expect(formatMoney(1500, "JPY")).toBe("JPY 1,500");
    expect(formatMoney(null, "ZAR")).toBe("n/a");
  });
});

describe("dates", () => {
  it("validates calendar days and months", () => {
    expect(isDay("2026-02-29")).toBe(false);
    expect(isDay("2026-10-15")).toBe(true);
    expect(isMonth("2026-13")).toBe(false);
    expect(isMonth("2026-10")).toBe(true);
  });
  it("does month arithmetic", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(daysInMonth("2028-02")).toBe(29);
    expect(monthEnd("2026-10")).toBe("2026-10-31");
    expect(isoWeek("2026-10-05")).toBe("2026-W41");
    expect(todayIn("Africa/Johannesburg", new Date("2026-10-15T23:30:00Z"))).toBe("2026-10-16");
  });
});

describe("metrics", () => {
  it("derives CPC, CPA, ROAS and CTR and leaves out what has no denominator", () => {
    const t = sumRows([{ spend: 10_000, impressions: 5000, clicks: 100, conversions: 4, value: 40_000 }, { spend: 5000, impressions: 2500, clicks: 50, conversions: 1, value: 10_000 }]);
    expect(t).toEqual({ spend: 15_000, impressions: 7500, clicks: 150, conversions: 5, value: 50_000 });
    expect(derive(t)).toEqual({ ctr: 0.02, cpc: 100, cpm: 2000, cpa: 3000, roas: 3.33 });
    const none = derive({ spend: 500, impressions: 0, clicks: 0, conversions: 0, value: 0 });
    expect(none).toMatchObject({ ctr: null, cpc: null, cpa: null, cpm: null });
    expect(none.roas).toBe(0);
  });
  it("takes a median", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("budget pacing", () => {
  const base = { today: "2026-10-15", spentTodayMinor: 0, committedDailyMinor: 20_000, alertPct: 90 };

  it("has no state without a cap", () => {
    const pace = monthPace({ ...base, capMinor: null, spentMinor: 100_000, recentDaily: [10_000, 10_000] });
    expect(pace.state).toBe("no_cap");
    expect(pace.pctUsed).toBeNull();
    expect(pace.headroomMinor).toBeNull();
  });

  it("is ok on track, watch ahead of the month, alert at 90% and over at 100%", () => {
    const ok = monthPace({ ...base, capMinor: 600_000, spentMinor: 200_000, recentDaily: [10_000, 10_000, 10_000] });
    expect(ok.state).toBe("ok");
    expect(ok.daysLeft).toBe(16);
    const watch = monthPace({ ...base, capMinor: 600_000, spentMinor: 330_000, recentDaily: [22_000, 22_000, 22_000] });
    expect(watch.state).toBe("watch");
    expect(watch.onTrackToExceed).toBe(true);
    expect(monthPace({ ...base, capMinor: 600_000, spentMinor: 540_000, recentDaily: [30_000] }).state).toBe("alert");
    expect(monthPace({ ...base, capMinor: 600_000, spentMinor: 539_999, recentDaily: [30_000] }).state).not.toBe("alert");
    expect(monthPace({ ...base, capMinor: 600_000, spentMinor: 600_000, recentDaily: [30_000] }).state).toBe("over");
    expect(monthPace({ ...base, capMinor: 600_000, spentMinor: 700_000, recentDaily: [30_000] }).headroomMinor).toBe(-100_000);
  });

  it("the alert point is the scope's own", () => {
    expect(monthPace({ ...base, capMinor: 100_000, spentMinor: 80_000, recentDaily: [1000], alertPct: 80 }).state).toBe("alert");
    expect(monthPace({ ...base, capMinor: 100_000, spentMinor: 80_000, recentDaily: [1000], alertPct: 90 }).state).not.toBe("alert");
  });

  it("projects from the run rate and from the committed budgets separately", () => {
    const pace = monthPace({ ...base, capMinor: 900_000, spentMinor: 100_000, recentDaily: [10_000, 10_000], committedDailyMinor: 25_000, spentTodayMinor: 4_000 });
    // 16 days after today + the rest of today
    expect(pace.projectedRunRateMinor).toBe(100_000 + 10_000 * 16 + 6_000);
    expect(pace.projectedCommittedMinor).toBe(100_000 + 25_000 * 16 + 21_000);
  });

  it("checks what a change adds against the cap", () => {
    const pace = monthPace({ ...base, capMinor: 560_000, spentMinor: 100_000, recentDaily: [10_000], committedDailyMinor: 20_000 });
    // committed: 100k + 20k*16 + 20k = 440k
    const small = capImpact(pace, "2026-10-15", { dailyMinor: 5_000 });
    expect(small.projectedBeforeMinor).toBe(440_000);
    expect(small.addedThisMonthMinor).toBe(5_000 * 16 + 5_000);
    expect(small.state).toBe("within");
    const big = capImpact(pace, "2026-10-15", { dailyMinor: 10_000 });
    expect(big.addedThisMonthMinor).toBe(170_000);
    expect(big.state).toBe("exceeds");
    expect(big.headroomAfterMinor).toBe(560_000 - 440_000 - 170_000);
    expect(capImpact({ ...pace, capMinor: null }, "2026-10-15", { dailyMinor: 1 }).state).toBe("no_cap");
  });

  it("counts only the days a change is active in this month", () => {
    expect(activeDaysThisMonth("2026-10-15", {})).toBe(16);
    expect(activeDaysThisMonth("2026-10-15", { fromDay: "2026-10-20", toDay: "2026-10-25" })).toBe(6);
    expect(activeDaysThisMonth("2026-10-15", { fromDay: "2026-11-02" })).toBe(0);
    expect(activeDaysThisMonth("2026-10-15", { toDay: "2026-10-10" })).toBe(0);
  });
});

const point = (day: string, spend: number, impressions = 1000, conversions = 0): SeriesPoint => ({ day, spend, impressions, clicks: Math.round(impressions / 20), conversions });
const campaign = { accountId: "a1", externalId: "c1", name: "Leads", status: "active" };

describe("alert rules", () => {
  const week = ["2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"].map((d) => point(d, 10_000));

  it("flags a spend spike with the numbers, once per day, and not a small one", () => {
    const spike = detectSpendSpike({ campaign, currency: "ZAR", series: [...week, point("2026-10-15", 40_000)] });
    expect(spike).toMatchObject({ kind: "spend_spike", dedupeKey: "spike:a1:c1:2026-10-15", detail: { times: 4 } });
    expect(spike!.text).toContain("ZAR 400.00");
    expect(detectSpendSpike({ campaign, currency: "ZAR", series: [...week, point("2026-10-15", 24_000)] })).toBeNull();
    expect(detectSpendSpike({ campaign, currency: "ZAR", series: [...week.map((p) => ({ ...p, spend: 100 })), point("2026-10-15", 1000)] })).toBeNull();
    expect(detectSpendSpike({ campaign, currency: "ZAR", series: [point("2026-10-14", 10_000), point("2026-10-15", 90_000)] })).toBeNull();
  });

  it("flags no delivery only for an active campaign that delivered before and whose numbers are fresh", () => {
    const series = ["2026-10-11", "2026-10-12", "2026-10-13"].map((d) => point(d, 10_000));
    const input = { campaign, series, today: "2026-10-15", syncFresh: true };
    expect(detectZeroDelivery(input)).toMatchObject({ kind: "zero_delivery", dedupeKey: "zero:a1:c1:2026-10-14" });
    expect(detectZeroDelivery({ ...input, syncFresh: false })).toBeNull();
    expect(detectZeroDelivery({ ...input, campaign: { ...campaign, status: "paused" } })).toBeNull();
    expect(detectZeroDelivery({ ...input, series: [...series, point("2026-10-14", 9000)] })).toBeNull();
    expect(detectZeroDelivery({ ...input, series: [point("2026-10-13", 10_000)] })).toBeNull();
  });

  it("flags cost per result over target, and real spend with no result, never without a target", () => {
    const series = ["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"].map((d) => point(d, 20_000, 1000, 1));
    const over = detectCpaOverTarget({ campaign, series, today: "2026-10-15", targetCpaMinor: 10_000, currency: "ZAR" });
    expect(over).toMatchObject({ kind: "cpa_over_target", severity: "warn" });
    expect(over!.text).toContain("ZAR 200.00");
    expect(detectCpaOverTarget({ campaign, series, today: "2026-10-15", targetCpaMinor: 20_000, currency: "ZAR" })).toBeNull();
    expect(detectCpaOverTarget({ campaign, series, today: "2026-10-15", targetCpaMinor: null, currency: "ZAR" })).toBeNull();
    const none = detectCpaOverTarget({ campaign, series: series.map((p) => ({ ...p, conversions: 0 })), today: "2026-10-15", targetCpaMinor: 10_000, currency: "ZAR" });
    expect(none).toMatchObject({ severity: "bad", detail: { conversions: 0 } });
    expect(detectCpaOverTarget({ campaign, series: series.slice(0, 1).map((p) => ({ ...p, conversions: 0 })), today: "2026-10-15", targetCpaMinor: 50_000, currency: "ZAR" })).toBeNull();
  });

  it("the 90% budget alert asks for a decision (a pause request) and says nothing is paused by itself", () => {
    const pace = monthPace({ today: "2026-10-15", capMinor: 600_000, spentMinor: 560_000, spentTodayMinor: 0, recentDaily: [30_000], committedDailyMinor: 30_000, alertPct: 90 });
    const [alert] = budgetAlerts({ scopeKey: "own", scopeLabel: "PiB (own ads)", pace, currency: "ZAR", alertPct: 90 });
    expect(alert).toMatchObject({ kind: "budget_90", needsDecision: true, dedupeKey: "budget90:own:2026-10" });
    const over = budgetAlerts({ scopeKey: "own", scopeLabel: "PiB", pace: monthPace({ today: "2026-10-15", capMinor: 600_000, spentMinor: 610_000, spentTodayMinor: 0, recentDaily: [30_000], committedDailyMinor: 0, alertPct: 90 }), currency: "ZAR", alertPct: 90 });
    expect(over[0]).toMatchObject({ kind: "budget_100", severity: "bad" });
    const none = budgetAlerts({ scopeKey: "own", scopeLabel: "PiB", pace: monthPace({ today: "2026-10-15", capMinor: null, spentMinor: 610_000, spentTodayMinor: 0, recentDaily: [], committedDailyMinor: 0 }), currency: "ZAR", alertPct: 90 });
    expect(none).toEqual([]);
  });
});

describe("creative check", () => {
  const meta = { platform: "meta" as const };

  it("blocks the client's banned words, whole words only, in every field", () => {
    const r = checkCreative({ ...meta, headline: "Cheap loans for you", primaryText: "Our cheapest deal" }, { bannedWords: ["cheap", "free trial"] });
    expect(r.ok).toBe(false);
    expect(r.findings.filter((f) => f.rule === "banned_word")).toHaveLength(1);
    expect(r.findings.find((f) => f.rule === "banned_word")).toMatchObject({ level: "blocker", where: "headline" });
    expect(checkCreative({ ...meta, primaryText: "Start your FREE   trial" }, { bannedWords: ["free trial"] }).ok).toBe(false);
  });

  it("warns on claims platform policy rejects but does not block", () => {
    const r = checkCreative({ ...meta, headline: "Guaranteed results", primaryText: "Are you diabetic? 100% safe!!!" });
    expect(r.ok).toBe(true);
    expect(r.findings.map((f) => f.rule)).toEqual(expect.arrayContaining(["guarantee", "personal_attribute", "absolute_pct", "urgency_caps"]));
  });

  it("enforces Google's hard length limits and only warns about Meta's", () => {
    expect(checkCreative({ platform: "google", headline: "x".repeat(31) }).blockers).toBe(1);
    expect(checkCreative({ platform: "google", headline: "x".repeat(30), description: "y".repeat(91) }).blockers).toBe(1);
    const m = checkCreative({ ...meta, headline: "x".repeat(60) });
    expect(m.ok).toBe(true);
    expect(m.warnings).toBe(1);
  });

  it("requires an https landing page with no login and flags shorteners and special categories", () => {
    expect(checkCreative({ ...meta, headline: "ok", landingUrl: "http://acme.test" }).blockers).toBe(1);
    expect(checkCreative({ ...meta, headline: "ok", landingUrl: "not a url" }).blockers).toBe(1);
    expect(checkCreative({ ...meta, headline: "ok", landingUrl: "https://user:pw@acme.test" }).blockers).toBe(1);
    expect(checkCreative({ ...meta, headline: "ok", landingUrl: "https://bit.ly/x" }).findings[0]).toMatchObject({ rule: "landing_shortener", level: "warn" });
    expect(checkCreative({ ...meta, primaryText: "Apply for a home loan today" }).findings.map((f) => f.rule)).toContain("special_category");
    expect(checkCreative({ ...meta, primaryText: "Apply for a home loan today", specialAdCategories: ["CREDIT"] }).findings.map((f) => f.rule)).not.toContain("special_category");
    expect(checkCreative({ ...meta, headline: "Fresh coffee", landingUrl: "https://acme.test/coffee" })).toMatchObject({ ok: true, blockers: 0, warnings: 0 });
  });
});

describe("sign-offs", () => {
  const proposal = { content_hash: "h1", requires_signoffs: ["owner", "client"] as Array<"owner" | "client"> };
  const now = new Date("2026-10-15T10:00:00Z");
  const approval = (patch: Partial<ApprovalRow>): ApprovalRow => ({ id: "a", proposal_id: "p", role: "owner", decision: "approved", decided_by: "user:u1", content_hash: "h1", over_cap_ack: false, note: null, evidence_ref: null, expires_at: "2026-10-16T10:00:00Z", consumed_at: null, created_at: "2026-10-15T09:00:00Z", ...patch });

  it("is complete only with a valid yes for every required role", () => {
    expect(signoffState(proposal, [], now)).toMatchObject({ complete: false, missing: ["owner", "client"] });
    expect(signoffState(proposal, [approval({})], now)).toMatchObject({ complete: false, missing: ["client"] });
    expect(signoffState(proposal, [approval({}), approval({ id: "b", role: "client" })], now).complete).toBe(true);
  });

  it("ignores a yes for other numbers, an expired or used one, and anything not given by a person", () => {
    for (const bad of [{ content_hash: "old" }, { expires_at: "2026-10-15T09:59:00Z" }, { consumed_at: "2026-10-15T09:30:00Z" }, { decided_by: "agent:a1" }]) {
      expect(signoffState({ ...proposal, requires_signoffs: ["owner"] }, [approval(bad)], now).complete, JSON.stringify(bad)).toBe(false);
    }
  });

  it("a person's no on the current numbers ends it, even beside a yes", () => {
    const state = signoffState({ ...proposal, requires_signoffs: ["owner"] }, [approval({}), approval({ id: "r", decision: "rejected", role: "client" })], now);
    expect(state.rejected?.id).toBe("r");
    expect(state.complete).toBe(false);
  });

  it("the Reviewer's pass stands only for the hash it saw", () => {
    expect(reviewStands({ review_state: "not_required", review_hash: null, content_hash: "h1" })).toBe(true);
    expect(reviewStands({ review_state: "pass", review_hash: "h1", content_hash: "h1" })).toBe(true);
    expect(reviewStands({ review_state: "pass", review_hash: "old", content_hash: "h1" })).toBe(false);
    expect(reviewStands({ review_state: "pending", review_hash: null, content_hash: "h1" })).toBe(false);
    expect(reviewStands({ review_state: "changes", review_hash: "h1", content_hash: "h1" })).toBe(false);
    expect(reviewStands({ review_state: "waived", review_hash: null, content_hash: "h1" })).toBe(true);
  });
});

describe("domain helpers", () => {
  it("hashes the same numbers the same way whatever the key order", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe('{"a":[2,{"d":1}],"b":1}');
  });
  it("round-trips scope keys and rejects anything else", () => {
    expect(scopeKeyOf(null)).toBe("own");
    expect(scopeKeyOf({ kind: "company", id: "c1" })).toBe("company:c1");
    expect(scopeOfKey("contact:x9")).toEqual({ kind: "contact", id: "x9" });
    expect(validScopeKey("company:c1")).toBe(true);
    expect(validScopeKey("client:c1")).toBe(false);
    expect(validScopeKey("")).toBe(false);
  });
  it("takes money only as whole minor units and refuses obvious unit mistakes", () => {
    expect(minorField({ x: "15000" }, "x")).toBe(15_000);
    expect(minorField({}, "x")).toBeUndefined();
    expect(() => minorField({}, "x", { required: true })).toThrow(AdsError);
    expect(() => minorField({ x: 150.5 }, "x")).toThrow(/whole number/);
    expect(() => minorField({ x: -1 }, "x")).toThrow(/whole number/);
    expect(() => minorField({ x: 999_999_999_999_999 }, "x")).toThrow(/sane budget/);
  });
  it("cleans word lists", () => {
    expect(stringList("a, b\nA, c")).toEqual(["a", "b", "c"]);
    expect(stringList(["x", 5, " y "])).toEqual(["x", "y"]);
  });
});

describe("page helpers", () => {
  it("builds a 30-day spend series with zeros for missing days, one currency at a time", () => {
    const daily = { period: { since: "2026-09-16", until: "2026-10-15", label: "" }, hasData: true, totals: [], groups: [
      { key: "2026-10-15", label: "", currency: "ZAR", spendMinor: 12_000, spend: "", impressions: 0, clicks: 0, conversions: 0, cpc: null, cpa: null, roas: null, ctr: null },
      { key: "2026-10-13", label: "", currency: "ZAR", spendMinor: 5_000, spend: "", impressions: 0, clicks: 0, conversions: 0, cpc: null, cpa: null, roas: null, ctr: null },
      { key: "2026-10-14", label: "", currency: "USD", spendMinor: 9_000, spend: "", impressions: 0, clicks: 0, conversions: 0, cpc: null, cpa: null, roas: null, ctr: null },
    ] };
    const s = spendSeries(daily as never);
    expect(s.currency).toBe("ZAR");
    expect(s.values).toHaveLength(30);
    expect(s.values.slice(-3)).toEqual([50, 0, 120]);
    expect(s.others).toBe(1);
    expect(spendSeries(null).values).toEqual([]);
  });
  it("reads and writes money in the box the way people type it", () => {
    expect(minorFromInput("5000")).toBe(500_000);
    expect(minorFromInput("5 000,50")).toBe(500_050);
    expect(minorFromInput("12.5")).toBe(1250);
    expect(minorFromInput("-3")).toBeNull();
    expect(minorFromInput("abc")).toBeNull();
    expect(inputFromMinor(500_050)).toBe("5000.50");
    expect(inputFromMinor(null)).toBe("");
    expect(budgetToneOf({ state: "over" })).toBe("bad");
    expect(budgetToneOf({ state: "ok" })).toBe("ok");
  });
});


describe("how far back a sync reads", () => {
  const read = (lastOkAt: string | null, until: string, timezone = "UTC") => syncWindow({ lastOkAt, until, timezone });

  it("a normal read re-reads the last 3 days, and a day more for each day since the last good read", () => {
    expect(read("2026-10-15T08:00:00Z", "2026-10-15")).toEqual({ wantedDays: 3, days: 3, gapDays: 0, truncated: false });
    expect(read("2026-10-14T23:30:00Z", "2026-10-15")).toMatchObject({ days: 4, gapDays: 1 });
    // Six days with no good read: the six days AND the three before them (the platform restates those), so nothing between is missing.
    expect(read("2026-10-15T10:00:00Z", "2026-10-21")).toMatchObject({ days: 9, gapDays: 6, truncated: false });
  });

  it("a first read goes back 30 days, and at least to the start of the month so the month-to-date is whole", () => {
    expect(read(null, "2026-10-15")).toMatchObject({ days: 30, gapDays: null });
    expect(read(null, "2026-10-31")).toMatchObject({ days: 31 });
    expect(read("not a time", "2026-10-31")).toMatchObject({ days: 31, gapDays: null });
  });

  it("counts the last good read in the account's own day, not UTC's", () => {
    // 23:30 UTC on the 14th is 01:30 on the 15th in Johannesburg.
    expect(read("2026-10-14T23:30:00Z", "2026-10-15", "Africa/Johannesburg")).toMatchObject({ days: 3, gapDays: 0 });
    expect(read("2026-10-14T23:30:00Z", "2026-10-15", "UTC")).toMatchObject({ days: 4, gapDays: 1 });
  });

  it("never goes back further than the backfill limit, and says it was cut", () => {
    const cut = read("2026-06-01T00:00:00Z", "2026-10-15");
    expect(cut).toMatchObject({ days: MAX_BACKFILL_DAYS, truncated: true });
    expect(cut.wantedDays).toBeGreaterThan(MAX_BACKFILL_DAYS);
    // The limit always covers the current month, which is what the caps look at.
    expect(MAX_BACKFILL_DAYS).toBeGreaterThanOrEqual(31 + 3);
  });

  it("a clock that reads earlier than the last good read still reads a normal window", () => {
    expect(read("2026-10-20T00:00:00Z", "2026-10-15")).toMatchObject({ days: 3, gapDays: 0 });
  });
});
