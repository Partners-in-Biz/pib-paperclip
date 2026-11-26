/** 0.46.0 (PAR-9131 T4, PAR-9145): the Previews tab words, filters and badge. */
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

describe("previews tab filters and badge (PAR-9145)", async () => {
  const { previewsFor, awaitingCount } = await import("../src/ui/words.js");
  const p = (o: Record<string, unknown>) => ({ id: "x", status: "pending", reviewStatus: "passed", expired: false, superseded: false, appliedAt: null, ...o }) as never;
  const all = [
    p({ id: "await" }), p({ id: "notpassed", reviewStatus: "pending" }), p({ id: "exp", expired: true }),
    p({ id: "sup", superseded: true }), p({ id: "appr", status: "approved" }), p({ id: "dec", status: "declined" }),
    p({ id: "chg", status: "changes_requested" }), p({ id: "app", status: "approved", appliedAt: "2026-11-01T00:00:00Z" }),
    p({ id: "appsup", status: "approved", appliedAt: "2026-11-01T00:00:00Z", superseded: true }),
  ];
  const ids = (f: string) => previewsFor(all, f as never).map((r: { id: string }) => r.id);
  it("filters each tab and drops superseded rows except under applied", () => {
    expect(ids("awaiting")).toEqual(["await", "notpassed"]);
    expect(ids("approved")).toEqual(["appr"]);
    expect(ids("declined")).toEqual(["dec", "chg"]);
    expect(ids("applied")).toEqual(["app", "appsup"]);
    expect(ids("expired")).toEqual(["exp"]);
  });
  it("badge equals the Awaiting chip: pending, not expired, not superseded, any review state", () => {
    expect(awaitingCount(all)).toBe(2);
    expect(awaitingCount(all)).toBe(previewsFor(all, "awaiting").length);
    const mix = [p({ id: "n", reviewStatus: "pending" }), p({ id: "p1" }), p({ id: "p2" })];
    expect(awaitingCount(mix)).toBe(3);
    expect(previewsFor(mix, "awaiting")).toHaveLength(3);
    expect(awaitingCount(undefined)).toBe(0);
  });
});

describe("client redirect keeps the page's query (PAR-14506)", async () => {
  const { reopenParams } = await import("../src/ui/words.js");
  it("carries tab and filter, and omits what is unset", () => {
    expect(reopenParams(new URLSearchParams("sprint=s1&tab=previews&filter=declined"))).toEqual({ tab: "previews", filter: "declined" });
    expect(reopenParams(new URLSearchParams("sprint=s1&tab=previews"))).toEqual({ tab: "previews" });
    expect(reopenParams(new URLSearchParams("sprint=s1"))).toEqual({});
  });
});

describe("errorText (PAR-14691)", async () => {
  const { errorText } = await import("../src/ui/words.js");
  it("reads a message from an Error, a plain bridge object or a string", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText({ code: "x", message: "This sprint is archived." })).toBe("This sprint is archived.");
    expect(errorText("plain")).toBe("plain");
  });
  it("never shows [object Object] for a bare object", () => {
    for (const bad of [{}, { code: 1 }, { message: "" }, null, undefined, 42]) {
      const text = errorText(bad);
      expect(typeof text).toBe("string");
      expect(text).not.toContain("[object Object]");
      expect(text.length).toBeGreaterThan(0);
    }
  });
});
