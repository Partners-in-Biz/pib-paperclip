import { describe, expect, it } from "vitest";
import { campaignsAdapter, judgeCampaign, MIN_SENDS_PER_ARM, type StepEvent } from "../src/growth-adapter.js";

const NOW = new Date("2026-10-21T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

/** `n` sends of one variant at one step; the first `replies` of every group of `per` get a reply (spread evenly: `pattern` is a list of 0/1 per send). */
function sends(variant: "a" | "b", pattern: number[], step = 1, prefix = variant): StepEvent[] {
  const out: StepEvent[] = [];
  pattern.forEach((replied, i) => {
    const enrollmentId = `${prefix}${step}-${i}`;
    out.push({ enrollmentId, stepPosition: step, eventType: "sent", variant, occurredAt: hoursAgo(100 - i * 0.5) });
    if (replied) out.push({ enrollmentId, stepPosition: step, eventType: "reply", variant, occurredAt: hoursAgo(10) });
  });
  return out;
}
/** `n` sends with a reply on the first `k` of every 5. */
const rate = (n: number, k: number) => Array.from({ length: n }, (_, i) => (i % 5 < k ? 1 : 0));

describe("campaigns growth adapter", () => {
  it("defaults to 30 sends per arm and a 7 day window", () => {
    expect(campaignsAdapter).toMatchObject({ channel: "campaigns", minPerArm: MIN_SENDS_PER_ARM, windowDays: 7 });
    expect(MIN_SENDS_PER_ARM).toBe(30);
  });

  it("is inconclusive below the minimum sends per arm", () => {
    const r = judgeCampaign([...sends("a", rate(29, 1)), ...sends("b", rate(40, 3))], { now: NOW });
    expect(r.winner).toBeNull();
    expect(r.steps[0]).toMatchObject({ verdict: "inconclusive", sends: { a: 29, b: 40 } });
  });

  it("calls a tie no change", () => {
    const r = judgeCampaign([...sends("a", rate(30, 2)), ...sends("b", rate(30, 2))], { now: NOW });
    expect(r.winner).toBeNull();
    expect(r.steps[0]?.verdict).toBe("no_change");
  });

  it("wins at +15% or more and sets B as the winner", () => {
    // Control batches reply 20%; variant batches 40% = +100%.
    const r = judgeCampaign([...sends("a", rate(30, 1)), ...sends("b", rate(30, 2))], { now: NOW });
    expect(r.steps[0]).toMatchObject({ verdict: "win", relativeChange: 1 });
    expect(r.winner).toBe("b");
  });

  it("does not win when the batch medians are equal", () => {
    // Control batches all 0.4; variant batches alternate 0.4 and 0.6, median 0.4 -> no change.
    const r = judgeCampaign([...sends("a", rate(50, 2)), ...sends("b", Array.from({ length: 50 }, (_, i) => (i % 5 < (Math.floor(i / 5) % 2 === 0 ? 2 : 3) ? 1 : 0)))], { now: NOW });
    expect(r.winner).toBeNull();
  });

  it("needs 60% consistency: a median lift carried by under 60% of batches is not a win", () => {
    // Control batches: 5 at 0.2 and 5 at 0.6 (median 0.4). Variant batches: 5 at 0.8, 5 at 0.4 (median 0.6 = +50%) but only 50% beat the control median.
    const ctl = [...rate(25, 1), ...rate(25, 3)];
    const variant = [...rate(25, 4), ...rate(25, 2)];
    const r = judgeCampaign([...sends("a", ctl), ...sends("b", variant)], { now: NOW });
    expect(r.steps[0]?.beatShare).toBeCloseTo(0.5);
    expect(r.steps[0]?.verdict).toBe("no_change");
    expect(r.winner).toBeNull();
  });

  it("gives A the win when B loses, and no winner when steps disagree", () => {
    expect(judgeCampaign([...sends("a", rate(30, 2)), ...sends("b", rate(30, 1))], { now: NOW }).winner).toBe("a");
    const split = judgeCampaign(
      [...sends("a", rate(30, 1), 1), ...sends("b", rate(30, 2), 1), ...sends("a", rate(30, 2), 2), ...sends("b", rate(30, 1), 2)],
      { now: NOW },
    );
    expect(split.steps.map((s) => s.verdict)).toEqual(["win", "loss"]);
    expect(split.winner).toBeNull();
  });

  it("ignores sends older than the 7 day window", () => {
    const old = sends("b", rate(30, 2)).map((e) => ({ ...e, occurredAt: hoursAgo(24 * 9) }));
    const r = judgeCampaign([...sends("a", rate(30, 1)), ...old], { now: NOW });
    expect(r.steps[0]?.sends.b).toBe(0);
    expect(r.winner).toBeNull();
  });
});
