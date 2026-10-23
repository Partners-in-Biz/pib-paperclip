import { describe, expect, it } from "vitest";
import { testFeedback } from "../src/ui/test-feedback.js";

describe("testFeedback", () => {
  it("does not say there are no devices when push is off but devices are registered", () => {
    const feedback = testFeedback({ results: [], disabled: true, capped: false, deviceCount: 1 });
    expect(feedback.tone).toBe("bad");
    expect(feedback.text).not.toContain("No devices to test");
    expect(feedback.text).toContain("Push is turned off");
    expect(feedback.text).toContain("still registered");
  });

  it("says the hourly limit was reached instead of no devices", () => {
    const feedback = testFeedback({ results: [], disabled: false, capped: true, deviceCount: 1 });
    expect(feedback.text).not.toContain("No devices to test");
    expect(feedback.text).toContain("hourly push limit");
  });

  it("keeps the empty-list message when nothing is registered", () => {
    expect(testFeedback({ results: [], disabled: false, capped: false, deviceCount: 0 }).text).toBe(
      "No devices to test",
    );
  });

  it("reports a sent outcome, including a refused endpoint", () => {
    const feedback = testFeedback({
      results: [{ label: "iPhone", outcome: "refused", error: "endpoint_not_allowed" }],
      disabled: false,
      capped: false,
      deviceCount: 1,
    });
    expect(feedback.tone).toBe("ok");
    expect(feedback.text).toContain("iPhone: refused");
    expect(feedback.text).toContain("endpoint_not_allowed");
  });
});
