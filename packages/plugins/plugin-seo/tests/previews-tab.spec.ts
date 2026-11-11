/** 0.41.0 (PAR-9131 T4, PAR-9145): the Previews tab words, filters and badge. */
import { describe, expect, it } from "vitest";
import { isPreviewFilter, previewDaysLeft, previewDecider, previewExpiryTone, previewStatus } from "../src/ui/words.js";

describe("previews tab words", () => {
  it("colours expiry amber under 7 days and red under 2", () => {
    expect(previewExpiryTone(7)).toBe("neutral");
    expect(previewExpiryTone(6)).toBe("warn");
    expect(previewExpiryTone(2)).toBe("warn");
    expect(previewExpiryTone(1)).toBe("bad");
    expect(previewExpiryTone(0)).toBe("bad");
  });
  it("counts whole days and never goes negative", () => {
    const now = Date.parse("2026-11-11T00:00:00Z");
    expect(previewDaysLeft("2026-11-14T12:00:00Z", now)).toBe(4);
    expect(previewDaysLeft("2026-11-01T00:00:00Z", now)).toBe(0);
  });
  it("accepts only the five filters", () => {
    expect(["awaiting", "approved", "declined", "applied", "expired"].every(isPreviewFilter)).toBe(true);
    expect(isPreviewFilter("all")).toBe(false);
    expect(isPreviewFilter(null)).toBe(false);
  });
  it("says who decided and where", () => {
    expect(previewDecider({ status: "approved", decisionSource: "email", decidedBy: "client:email-link" })).toBe("Approved: decided by the client · email");
    expect(previewDecider({ status: "declined", decisionSource: "cockpit", decidedBy: "u1" })).toBe("Declined: decided by a team member · cockpit");
  });
  it("labels the status chip", () => {
    const base = { status: "pending", expired: false, appliedAt: null, confirmedAt: null, reviewStatus: "passed", decisionSource: null };
    expect(previewStatus(base).label).toBe("Awaiting a decision");
    expect(previewStatus({ ...base, reviewStatus: "pending" }).label).toBe("Not ready");
    expect(previewStatus({ ...base, expired: true }).label).toBe("Expired");
    expect(previewStatus({ ...base, status: "approved", decisionSource: "email" }).label).toBe("Client approved");
    expect(previewStatus({ ...base, status: "approved", appliedAt: "2026-11-11" }).label).toBe("Applied");
  });
});
