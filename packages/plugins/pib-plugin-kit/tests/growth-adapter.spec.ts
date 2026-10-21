import { describe, expect, it } from "vitest";
import { hypothesisCandidates } from "../src/growth/engine.js";
import type { ChannelAdapter, MetricSource } from "../src/growth/types.js";

describe("ChannelAdapter", () => {
  it("defines a channel with metrics source and hypothesis candidates", async () => {
    const source: MetricSource = {
      channel: "email",
      async fetchMetrics() {
        return [];
      },
    };

    const adapter: ChannelAdapter = {
      channel: "email",
      defaultObjective: "Increase open rate",
      defaultMetric: "open rate",
      windowDays: 7,
      minPerArm: 3,
      hypothesisCandidates: (program) => hypothesisCandidates({ ...program, scoreboard: {} }),
      source,
    };

    expect(adapter.channel).toBe("email");
    expect(adapter.defaultObjective).toBe("Increase open rate");
    expect(adapter.windowDays).toBe(7);
    expect(adapter.minPerArm).toBe(3);
    expect(adapter.source).toBe(source);

    const candidates = adapter.hypothesisCandidates({ topics: [], featureQuestions: [] });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates).toContain("format:video");
  });
});
