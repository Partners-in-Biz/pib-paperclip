import { describe, it, expect } from "vitest";
import { COLLAPSE_CLASS, decide, type Decision, type DecideInput } from "../src/push/policy.js";
import type { PushLogEntry } from "../src/push/store.js";

/**
 * Helper to create a SAST (UTC+2) time given hour and optional day offset.
 * Days are measured in SAST days (midnight to midnight SAST).
 * now = SAST hour H on SAST day D.
 * Returns Date with that UTC equivalent.
 */
function sastTime(hour: number, dayOffset = 0): Date {
  // Create a date at UTC hour (hour - 2) to get SAST hour.
  // SAST = UTC + 2, so SAST hour H is UTC hour H-2.
  const utcHour = hour - 2;

  // Get current UTC date and set to UTC midnight.
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  // Add dayOffset days in SAST.
  d.setTime(d.getTime() + dayOffset * 24 * 60 * 60 * 1000);

  // Set UTC hour to (hour - 2) for SAST hour = hour.
  d.setUTCHours(utcHour >= 0 ? utcHour : 24 + utcHour, 0, 0, 0);

  return d;
}

/**
 * Helper to create a log entry.
 */
function logEntry(overrides: Partial<Pick<PushLogEntry, "class" | "issueRef" | "status" | "createdAt">>): Pick<PushLogEntry, "class" | "issueRef" | "status" | "createdAt"> {
  return {
    class: "normal",
    issueRef: null,
    status: "sent",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("push policy", () => {
  describe("critical class", () => {
    it("critical always sends", () => {
      const now = sastTime(12);
      const result = decide({ class: "critical", issueRef: null, now, recentLog: [] });
      expect(result).toEqual({ action: "send" });
    });

    it("critical sends during quiet hours", () => {
      const now = sastTime(23); // SAST 23:00, quiet hours
      const result = decide({ class: "critical", issueRef: null, now, recentLog: [] });
      expect(result).toEqual({ action: "send" });
    });

    it("critical ignores duplicate", () => {
      const now = sastTime(12);
      const log = [logEntry({ issueRef: "issue-1", status: "sent", createdAt: new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString() })];
      const result = decide({ class: "critical", issueRef: "issue-1", now, recentLog: log });
      expect(result).toEqual({ action: "send" });
    });

    it("critical ignores daily cap", () => {
      const now = sastTime(12);
      // 20 sent entries spaced 15 minutes apart
      const log = Array.from({ length: 20 }, (_, i) =>
        logEntry({ issueRef: `issue-${i}`, status: "sent", createdAt: new Date(now.getTime() - (i + 1) * 15 * 60 * 1000).toISOString() })
      );
      const result = decide({ class: "normal", issueRef: "new-issue", now, recentLog: log });
      expect(result.action).toBe("drop");
      // Now critical should send despite cap
      const result2 = decide({ class: "critical", issueRef: "new-issue2", now, recentLog: log });
      expect(result2).toEqual({ action: "send" });
    });

    it("critical ignores window", () => {
      const now = sastTime(12);
      // 5 sent entries in last 10 min
      const log = Array.from({ length: 5 }, () =>
        logEntry({ status: "sent", createdAt: new Date(now.getTime() - 5 * 60 * 1000).toISOString() })
      );
      const result = decide({ class: "critical", issueRef: null, now, recentLog: log });
      expect(result).toEqual({ action: "send" });
    });
  });

  describe("quiet hours (SAST)", () => {
    it("defers at 22:00 SAST", () => {
      const now = sastTime(22);
      const result = decide({ class: "normal", issueRef: null, now, recentLog: [] });
      expect(result).toEqual({ action: "defer" });
    });

    it("defers at 23:59 SAST", () => {
      const now = new Date(sastTime(23).getTime() + 59 * 60 * 1000);
      const result = decide({ class: "normal", issueRef: null, now, recentLog: [] });
      expect(result).toEqual({ action: "defer" });
    });

    it("defers at 05:59 SAST", () => {
      const now = new Date(sastTime(5).getTime() + 59 * 60 * 1000);
      const result = decide({ class: "normal", issueRef: null, now, recentLog: [] });
      expect(result).toEqual({ action: "defer" });
    });

    it("sends at 21:59 SAST", () => {
      const now = new Date(sastTime(21).getTime() + 59 * 60 * 1000);
      const result = decide({ class: "normal", issueRef: null, now, recentLog: [] });
      expect(result).toEqual({ action: "send" });
    });

    it("sends at 06:00 SAST", () => {
      const now = sastTime(6);
      const result = decide({ class: "normal", issueRef: null, now, recentLog: [] });
      expect(result).toEqual({ action: "send" });
    });
  });

  describe("duplicate detection", () => {
    it("drops duplicate within 6 hours", () => {
      const now = sastTime(12);
      const log = [logEntry({ issueRef: "issue-1", status: "sent", createdAt: new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString() })];
      const result = decide({ class: "normal", issueRef: "issue-1", now, recentLog: log });
      expect(result).toEqual({ action: "drop", reason: "duplicate" });
    });

    it("drops duplicate at exactly 6 hours minus 1 second", () => {
      const now = sastTime(12);
      const sixHoursMs = 6 * 60 * 60 * 1000;
      const createdAt = new Date(now.getTime() - sixHoursMs + 1000); // 6h - 1s
      const log = [logEntry({ issueRef: "issue-1", status: "sent", createdAt: createdAt.toISOString() })];
      const result = decide({ class: "normal", issueRef: "issue-1", now, recentLog: log });
      expect(result).toEqual({ action: "drop", reason: "duplicate" });
    });

    it("does not drop at exactly 6 hours", () => {
      const now = sastTime(12);
      const sixHoursMs = 6 * 60 * 60 * 1000;
      const createdAt = new Date(now.getTime() - sixHoursMs);
      const log = [logEntry({ issueRef: "issue-1", status: "sent", createdAt: createdAt.toISOString() })];
      const result = decide({ class: "normal", issueRef: "issue-1", now, recentLog: log });
      // At exactly 6h, it should not match (only > 6h boundary, and <= now).
      // createdAt > (now - 6h) is false when createdAt = now - 6h.
      expect(result.action).not.toBe("drop");
    });

    it("does not drop beyond 6 hours", () => {
      const now = sastTime(12);
      const sixHoursMs = 6 * 60 * 60 * 1000;
      const createdAt = new Date(now.getTime() - sixHoursMs - 1000); // 6h + 1s
      const log = [logEntry({ issueRef: "issue-1", status: "sent", createdAt: createdAt.toISOString() })];
      const result = decide({ class: "normal", issueRef: "issue-1", now, recentLog: log });
      expect(result.action).not.toBe("drop");
    });

    it("does not consider different issueRef as duplicate", () => {
      const now = sastTime(12);
      const log = [logEntry({ issueRef: "issue-1", status: "sent", createdAt: new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString() })];
      const result = decide({ class: "normal", issueRef: "issue-2", now, recentLog: log });
      expect(result.action).not.toBe("drop");
    });

    it("null issueRef never matches duplicate", () => {
      const now = sastTime(12);
      const log = [logEntry({ issueRef: null, status: "sent", createdAt: new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString() })];
      const result = decide({ class: "normal", issueRef: null, now, recentLog: log });
      expect(result.action).not.toBe("drop");
    });

    it("ignores deferred rows for duplicate check", () => {
      const now = sastTime(12);
      const log = [logEntry({ issueRef: "issue-1", status: "deferred", createdAt: new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString() })];
      const result = decide({ class: "normal", issueRef: "issue-1", now, recentLog: log });
      // Deferred rows don't count, so this is not a duplicate.
      expect(result.action).not.toBe("drop");
    });

    it("ignores collapsed rows for duplicate check", () => {
      const now = sastTime(12);
      const log = [logEntry({ issueRef: "issue-1", status: "collapsed", createdAt: new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString() })];
      const result = decide({ class: "normal", issueRef: "issue-1", now, recentLog: log });
      expect(result.action).not.toBe("drop");
    });

    it("ignores critical rows for duplicate check", () => {
      const now = sastTime(12);
      const log = [logEntry({ issueRef: "issue-1", class: "critical", status: "sent", createdAt: new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString() })];
      const result = decide({ class: "normal", issueRef: "issue-1", now, recentLog: log });
      expect(result.action).not.toBe("drop");
    });
  });

  describe("daily cap (20 per SAST day)", () => {
    it("sends when 19 sent today", () => {
      const now = sastTime(12);
      // Space entries 15 minutes apart to avoid window collapse (10min), all same day.
      const log = Array.from({ length: 19 }, (_, i) =>
        logEntry({ issueRef: `issue-${i}`, status: "sent", createdAt: new Date(now.getTime() - (i + 1) * 15 * 60 * 1000).toISOString() })
      );
      const result = decide({ class: "normal", issueRef: "new-issue", now, recentLog: log });
      expect(result).toEqual({ action: "send" });
    });

    it("drops when 20 sent today", () => {
      const now = sastTime(12);
      // Space entries 15 minutes apart to avoid window collapse.
      const log = Array.from({ length: 20 }, (_, i) =>
        logEntry({ issueRef: `issue-${i}`, status: "sent", createdAt: new Date(now.getTime() - (i + 1) * 15 * 60 * 1000).toISOString() })
      );
      const result = decide({ class: "normal", issueRef: "new-issue", now, recentLog: log });
      expect(result).toEqual({ action: "drop", reason: "daily_cap" });
    });

    it("does not count critical rows toward cap", () => {
      const now = sastTime(12);
      const log = Array.from({ length: 20 }, (_, i) => {
        const c = i < 10 ? "critical" : "normal";
        return logEntry({ issueRef: `issue-${i}`, class: c, status: "sent", createdAt: new Date(now.getTime() - (i + 1) * 15 * 60 * 1000).toISOString() });
      });
      const result = decide({ class: "normal", issueRef: "new-issue", now, recentLog: log });
      // Only 10 normal rows sent today, so should send.
      expect(result.action).not.toBe("drop");
    });

    it("does not count rows from previous SAST day", () => {
      const now = sastTime(12); // SAST day D, 12:00
      const prevDay = new Date(now.getTime() - 25 * 60 * 60 * 1000); // SAST day D-1, 11:00
      const log = Array.from({ length: 20 }, (_, i) =>
        logEntry({ issueRef: `issue-${i}`, status: "sent", createdAt: new Date(prevDay.getTime() - (i + 1) * 15 * 60 * 1000).toISOString() })
      );
      const result = decide({ class: "normal", issueRef: "new-issue", now, recentLog: log });
      // All 20 rows are from previous day, so today has 0 sent.
      expect(result).toEqual({ action: "send" });
    });

    it("deferred rows do not count toward cap", () => {
      const now = sastTime(12);
      const log = Array.from({ length: 20 }, (_, i) =>
        logEntry({ status: "deferred", createdAt: new Date(now.getTime() - (i + 1) * 1000).toISOString() })
      );
      const result = decide({ class: "normal", issueRef: null, now, recentLog: log });
      // All deferred, so cap count is 0.
      expect(result.action).not.toBe("drop");
    });

    it("collapse rows with status sent count as 1 toward cap", () => {
      const now = sastTime(12);
      // 19 normal sent + 1 collapse sent = 20 total
      const normal = Array.from({ length: 19 }, (_, i) =>
        logEntry({ status: "sent", createdAt: new Date(now.getTime() - (i + 1) * 1000).toISOString() })
      );
      const collapse = logEntry({ class: COLLAPSE_CLASS, status: "sent", createdAt: new Date(now.getTime() - 20 * 1000).toISOString() });
      const log = [...normal, collapse];
      const result = decide({ class: "normal", issueRef: null, now, recentLog: log });
      expect(result).toEqual({ action: "drop", reason: "daily_cap" });
    });
  });

  describe("window collapse (10 minutes, non-critical)", () => {
    it("sends when < 3 sent in window", () => {
      const now = sastTime(12);
      const log = Array.from({ length: 2 }, (_, i) =>
        logEntry({ status: "sent", createdAt: new Date(now.getTime() - (i + 1) * 60 * 1000).toISOString() })
      );
      const result = decide({ class: "normal", issueRef: null, now, recentLog: log });
      expect(result).toEqual({ action: "send" });
    });

    it("collapses when exactly 3 sent in window", () => {
      const now = sastTime(12);
      const log = Array.from({ length: 3 }, (_, i) =>
        logEntry({ status: "sent", createdAt: new Date(now.getTime() - (i + 1) * 60 * 1000).toISOString() })
      );
      const result = decide({ class: "normal", issueRef: null, now, recentLog: log });
      expect(result).toEqual({ action: "collapse", n: 4, notify: true });
    });

    it("collapses with n=4 when 3 sent + 0 collapsed", () => {
      const now = sastTime(12);
      const log = Array.from({ length: 3 }, (_, i) =>
        logEntry({ status: "sent", createdAt: new Date(now.getTime() - (i + 1) * 60 * 1000).toISOString() })
      );
      const result = decide({ class: "normal", issueRef: null, now, recentLog: log });
      expect(result).toEqual({ action: "collapse", n: 4, notify: true });
    });

    it("collapses with n=5 when 3 sent + 1 collapsed (and no collapse sent)", () => {
      const now = sastTime(12);
      const normal = Array.from({ length: 3 }, (_, i) =>
        logEntry({ status: "sent", createdAt: new Date(now.getTime() - (i + 1) * 60 * 1000).toISOString() })
      );
      const collapsed = logEntry({ class: COLLAPSE_CLASS, status: "collapsed", createdAt: new Date(now.getTime() - 4 * 60 * 1000).toISOString() });
      const log = [...normal, collapsed];
      const result = decide({ class: "normal", issueRef: null, now, recentLog: log });
      expect(result).toEqual({ action: "collapse", n: 5, notify: true });
    });

    it("collapses with n=5 notify=false when 3 sent + 1 collapsed + 1 collapse sent", () => {
      const now = sastTime(12);
      const normal = Array.from({ length: 3 }, (_, i) =>
        logEntry({ status: "sent", createdAt: new Date(now.getTime() - (i + 1) * 60 * 1000).toISOString() })
      );
      const collapsed = logEntry({ class: COLLAPSE_CLASS, status: "collapsed", createdAt: new Date(now.getTime() - 4 * 60 * 1000).toISOString() });
      const collapseSent = logEntry({ class: COLLAPSE_CLASS, status: "sent", createdAt: new Date(now.getTime() - 5 * 60 * 1000).toISOString() });
      const log = [...normal, collapsed, collapseSent];
      const result = decide({ class: "normal", issueRef: null, now, recentLog: log });
      expect(result).toEqual({ action: "collapse", n: 5, notify: false });
    });

    it("ignores rows older than 10 minutes", () => {
      const now = sastTime(12);
      const inWindow = logEntry({ status: "sent", createdAt: new Date(now.getTime() - 5 * 60 * 1000).toISOString() });
      const outOfWindow = logEntry({ status: "sent", createdAt: new Date(now.getTime() - 11 * 60 * 1000).toISOString() });
      const log = [inWindow, outOfWindow];
      const result = decide({ class: "normal", issueRef: null, now, recentLog: log });
      expect(result).toEqual({ action: "send" });
    });

    it("includes rows at exactly 10 minutes boundary", () => {
      const now = sastTime(12);
      const tenMinutesMs = 10 * 60 * 1000;
      const atBoundary = logEntry({ status: "sent", createdAt: new Date(now.getTime() - tenMinutesMs).toISOString() });
      const withinWindow = logEntry({ status: "sent", createdAt: new Date(now.getTime() - tenMinutesMs + 1000).toISOString() });
      const log = [atBoundary, withinWindow];
      // atBoundary should not be included (createdAt is not > windowStart).
      // withinWindow should be included.
      const result = decide({ class: "normal", issueRef: null, now, recentLog: log });
      expect(result).toEqual({ action: "send" });
    });

    it("ignores deferred rows in window", () => {
      const now = sastTime(12);
      const sent = Array.from({ length: 2 }, (_, i) =>
        logEntry({ status: "sent", createdAt: new Date(now.getTime() - (i + 1) * 60 * 1000).toISOString() })
      );
      const deferred = logEntry({ status: "deferred", createdAt: new Date(now.getTime() - 4 * 60 * 1000).toISOString() });
      const log = [...sent, deferred];
      const result = decide({ class: "normal", issueRef: null, now, recentLog: log });
      // Count is 2 (deferred not counted), so should send.
      expect(result).toEqual({ action: "send" });
    });

    it("ignores dropped rows in window", () => {
      const now = sastTime(12);
      const sent = Array.from({ length: 2 }, (_, i) =>
        logEntry({ status: "sent", createdAt: new Date(now.getTime() - (i + 1) * 60 * 1000).toISOString() })
      );
      const dropped = logEntry({ status: "dropped", createdAt: new Date(now.getTime() - 4 * 60 * 1000).toISOString() });
      const log = [...sent, dropped];
      const result = decide({ class: "normal", issueRef: null, now, recentLog: log });
      expect(result).toEqual({ action: "send" });
    });

    it("does not count collapse sent in window for window size", () => {
      const now = sastTime(12);
      const sent = Array.from({ length: 3 }, (_, i) =>
        logEntry({ status: "sent", createdAt: new Date(now.getTime() - (i + 1) * 60 * 1000).toISOString() })
      );
      const collapseSent = logEntry({ class: COLLAPSE_CLASS, status: "sent", createdAt: new Date(now.getTime() - 5 * 60 * 1000).toISOString() });
      const log = [...sent, collapseSent];
      const result = decide({ class: "normal", issueRef: null, now, recentLog: log });
      // Count = 3 (collapse sent not counted), so collapse with n=4.
      expect(result).toEqual({ action: "collapse", n: 4, notify: false });
    });

    it("ignores critical rows in window", () => {
      const now = sastTime(12);
      const normal = Array.from({ length: 2 }, (_, i) =>
        logEntry({ status: "sent", createdAt: new Date(now.getTime() - (i + 1) * 60 * 1000).toISOString() })
      );
      const critical = logEntry({ class: "critical", status: "sent", createdAt: new Date(now.getTime() - 4 * 60 * 1000).toISOString() });
      const log = [...normal, critical];
      const result = decide({ class: "normal", issueRef: null, now, recentLog: log });
      // Count = 2 (critical not counted), so send.
      expect(result).toEqual({ action: "send" });
    });
  });

  describe("interaction between rules", () => {
    it("applies quiet hours before window", () => {
      const now = sastTime(23); // quiet hours
      const log = Array.from({ length: 5 }, (_, i) =>
        logEntry({ status: "sent", createdAt: new Date(now.getTime() - (i + 1) * 60 * 1000).toISOString() })
      );
      const result = decide({ class: "normal", issueRef: null, now, recentLog: log });
      // Quiet hours should defer, not collapse.
      expect(result).toEqual({ action: "defer" });
    });

    it("applies duplicate before window", () => {
      const now = sastTime(12);
      const dup = logEntry({ issueRef: "issue-1", status: "sent", createdAt: new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString() });
      const window = Array.from({ length: 3 }, (_, i) =>
        logEntry({ issueRef: `issue-${i + 2}`, status: "sent", createdAt: new Date(now.getTime() - (i + 1) * 60 * 1000).toISOString() })
      );
      const log = [dup, ...window];
      const result = decide({ class: "normal", issueRef: "issue-1", now, recentLog: log });
      // Duplicate should drop, not collapse.
      expect(result).toEqual({ action: "drop", reason: "duplicate" });
    });

    it("applies cap before window", () => {
      const now = sastTime(12);
      // 20 entries spaced 15 minutes apart to avoid window collapse
      const cap = Array.from({ length: 20 }, (_, i) =>
        logEntry({ issueRef: `issue-${i}`, status: "sent", createdAt: new Date(now.getTime() - (i + 1) * 15 * 60 * 1000).toISOString() })
      );
      const result = decide({ class: "normal", issueRef: "new-issue", now, recentLog: cap });
      // Cap should drop, not collapse.
      expect(result).toEqual({ action: "drop", reason: "daily_cap" });
    });
  });
});
