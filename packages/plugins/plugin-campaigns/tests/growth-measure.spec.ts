import { describe, expect, it } from "vitest";
import { campaignBatches } from "../src/growth-measure.js";
import type { StepEvent } from "../src/growth-adapter.js";

const NOW = new Date("2026-10-21T08:00:00Z");
const SINCE = new Date("2026-10-01T00:00:00Z");
const day = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const sends = (variant: "a" | "b", count: number, at: string, replies = 0): StepEvent[] =>
  Array.from({ length: count }, (_, i) => [
    { enrollmentId: `${variant}${i}`, stepPosition: 1, eventType: "sent", variant, occurredAt: at },
    ...(i < replies ? [{ enrollmentId: `${variant}${i}`, stepPosition: 1, eventType: "reply", variant, occurredAt: at }] : []),
  ]).flat();

describe("campaignBatches", () => {
  it("makes one batch per 5 sends and scores it with the reply rate; A is control, B variant", () => {
    const batches = campaignBatches([...sends("a", 10, day(10), 1), ...sends("b", 5, day(10), 5)], "c1", SINCE, NOW);
    expect(batches.filter((b) => b.arm === "control").map((b) => b.lifts[0])).toEqual([0.2, 0]);
    expect(batches.filter((b) => b.arm === "variant").map((b) => b.lifts[0])).toEqual([1]);
    expect(new Set(batches.map((b) => b.postId)).size).toBe(3);
  });

  it("leaves out an incomplete batch, sends inside the 7-day reply window and sends before the start", () => {
    const events = [...sends("a", 4, day(10)), ...sends("b", 5, day(3)), ...sends("b", 5, "2026-09-20T00:00:00Z")];
    expect(campaignBatches(events, "c1", SINCE, NOW)).toEqual([]);
  });
});
