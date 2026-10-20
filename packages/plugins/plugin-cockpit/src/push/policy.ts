/**
 * Push notification policy: decision engine for send/collapse/defer/drop.
 * Pure module, no I/O or Date.now() calls. All logic is deterministic based on inputs.
 *
 * Rules (applied in order):
 * 1. Critical class always sends (ignores quiet hours, cap, window, duplicate).
 * 2. Quiet hours (SAST 22:00-05:59) defer non-critical.
 * 3. Duplicate: same issueRef, status "sent", not critical, within 6h -> drop.
 *    Note: Deferred/dropped/capped rows do not count toward duplicate check (only "sent" rows do).
 * 4. Daily cap: 20+ sent non-critical in same SAST day -> drop daily_cap.
 *    Note: Deferred/dropped rows don't count; collapse rows with status="sent" do count as 1.
 * 5. Window (10min): count (status="sent" AND class != "collapse") OR status="collapsed", non-critical only.
 *    If < 3 -> send; else collapse with n+1, notify=true only if no collapse class "sent" in window.
 *    Note: Deferred, dropped rows not counted; collapse notification (status="sent", class="collapse") not counted.
 */

import type { PushLogEntry } from "./store.js";

/**
 * Push notification severity class.
 * "critical" bypasses quiet hours, cap, window, and duplicate checks.
 */
export type PolicyClass = "critical" | string;

/**
 * Constant for collapse-action rows; when status="sent", represents a notification grouping.
 */
export const COLLAPSE_CLASS = "collapse";

/**
 * Policy decision: how to handle a push notification.
 */
export type Decision =
  | { action: "send" }
  | { action: "collapse"; n: number; notify: boolean }
  | { action: "defer" }
  | { action: "drop"; reason: "duplicate" | "daily_cap" };

/**
 * Input to the decision engine.
 */
export interface DecideInput {
  /** Push notification severity class. */
  class: string;
  /** Issue reference, or null if not tied to a specific issue. */
  issueRef: string | null;
  /** Current time (used for quiet hours, cap, window, duplicate checks). */
  now: Date;
  /** Recent log entries to check against (typically the last few hours). */
  recentLog: Pick<PushLogEntry, "class" | "issueRef" | "status" | "createdAt">[];
}

/**
 * Convert a Date to SAST (UTC+2) hour and day-since-epoch.
 * SAST is Africa/Johannesburg, UTC+2 fixed (no DST).
 * Returns { hour: 0-23 } where hour increments at 00:00 SAST.
 * Returns day as an integer (days since epoch in SAST).
 */
export function getSastTime(now: Date): { hour: number; day: number } {
  // SAST = UTC+2, so add 2 hours to UTC timestamp.
  const timestamp = now.getTime();
  const sastTime = timestamp + 2 * 60 * 60 * 1000;

  // Extract SAST hour (UTC hour of the shifted time).
  const sastDate = new Date(sastTime);
  const hour = sastDate.getUTCHours();

  // Day since epoch in SAST timezone.
  const day = Math.floor(sastTime / (24 * 60 * 60 * 1000));

  return { hour, day };
}

/**
 * Calculate the most recent 22:00 SAST before `now`.
 * If `now` is at or after 22:00 SAST, returns today's 22:00 SAST (in UTC).
 * Otherwise, returns yesterday's 22:00 SAST (in UTC).
 */
export function getOvernightWindow(now: Date): Date {
  const sast = getSastTime(now);
  const sastMs = now.getTime() + 2 * 60 * 60 * 1000;

  // Start of today in SAST (midnight)
  const sastDayStart = Math.floor(sastMs / (24 * 60 * 60 * 1000)) * (24 * 60 * 60 * 1000);

  // 22:00 on today's SAST date = 22 hours into the day
  const todayAt22SastMs = sastDayStart + 22 * 60 * 60 * 1000;

  // Convert back to UTC
  const todayAt22UtcMs = todayAt22SastMs - 2 * 60 * 60 * 1000;

  // If current time is at or after today's 22:00 SAST, use that
  if (now.getTime() >= todayAt22UtcMs) {
    return new Date(todayAt22UtcMs);
  }

  // Otherwise, use yesterday's 22:00 SAST
  return new Date(todayAt22UtcMs - 24 * 60 * 60 * 1000);
}

/**
 * Check if current SAST hour is in quiet hours (22:00-05:59).
 */
function isQuietHours(hour: number): boolean {
  return hour >= 22 || hour < 6;
}

/**
 * Rule 1: Critical class always sends, ignoring all other rules.
 */
function checkCritical(input: DecideInput): Decision | null {
  if (input.class === "critical") {
    return { action: "send" };
  }
  return null;
}

/**
 * Rule 2: Quiet hours (SAST 22:00-05:59) defer non-critical.
 */
function checkQuietHours(input: DecideInput): Decision | null {
  const sast = getSastTime(input.now);
  if (isQuietHours(sast.hour)) {
    return { action: "defer" };
  }
  return null;
}

/**
 * Rule 3: Duplicate check.
 * If issueRef is non-null and recentLog contains a row with:
 *   - same issueRef
 *   - status "sent"
 *   - class not "critical"
 *   - createdAt in (now - 6h, now]
 * then drop as duplicate.
 * Note: Only "sent" status rows count; deferred/dropped/capped rows do not.
 */
function checkDuplicate(input: DecideInput): Decision | null {
  if (input.issueRef === null) {
    // No issueRef, cannot be a duplicate.
    return null;
  }

  const sixHoursMs = 6 * 60 * 60 * 1000;
  const cutoffTime = new Date(input.now.getTime() - sixHoursMs);

  for (const row of input.recentLog) {
    if (
      row.issueRef === input.issueRef &&
      row.status === "sent" &&
      row.class !== "critical"
    ) {
      const createdAt = new Date(row.createdAt);
      // Check if createdAt is in (cutoffTime, now].
      if (createdAt > cutoffTime && createdAt <= input.now) {
        return { action: "drop", reason: "duplicate" };
      }
    }
  }

  return null;
}

/**
 * Rule 4: Daily cap (20 sent non-critical per SAST day).
 * Count rows in same SAST day as now with:
 *   - status "sent"
 *   - class != "critical"
 * If count >= 20, drop this push with daily_cap reason.
 * Note: Deferred/dropped/capped rows don't count. Collapse rows with status="sent" count as 1.
 */
function checkDailyCap(input: DecideInput): Decision | null {
  const sast = getSastTime(input.now);
  const sentToday = input.recentLog.filter((row) => {
    if (row.status !== "sent" || row.class === "critical") {
      return false;
    }
    const rowSast = getSastTime(new Date(row.createdAt));
    return rowSast.day === sast.day;
  }).length;

  // If already 20+ sent today, drop the next one.
  if (sentToday >= 20) {
    return { action: "drop", reason: "daily_cap" };
  }

  return null;
}

/**
 * Rule 5: Window-based collapse (10 minutes).
 * Count rows in (now - 10min, now] with:
 *   - (status="sent" AND class != "collapse") OR status="collapsed"
 *   - class != "critical"
 * If count < 3 -> send.
 * Else -> collapse with n = count + 1.
 *   notify = true only if no row with class="collapse" AND status="sent" in window.
 *   (The collapse notification itself doesn't count toward the window.)
 * Note: Deferred/dropped rows not counted; the collapse notification (status="sent", class="collapse") is excluded.
 */
function checkWindow(input: DecideInput): Decision | null {
  const tenMinutesMs = 10 * 60 * 1000;
  const windowStart = new Date(input.now.getTime() - tenMinutesMs);

  // Count rows in window matching: (status="sent" AND class != "collapse") OR status="collapsed"
  // All must have class != "critical".
  const sentInWindow = input.recentLog.filter((row) => {
    if (row.class === "critical") {
      return false;
    }
    const createdAt = new Date(row.createdAt);
    if (!(createdAt > windowStart && createdAt <= input.now)) {
      return false;
    }
    // Include: (status="sent" AND class != "collapse") OR status="collapsed"
    return (row.status === "sent" && row.class !== COLLAPSE_CLASS) || row.status === "collapsed";
  }).length;

  if (sentInWindow < 3) {
    return { action: "send" };
  }

  // Check if collapse notification already sent in window.
  // (A row with class="collapse" AND status="sent" means the collapse was already sent.)
  const hasCollapseNotified = input.recentLog.some((row) => {
    if (row.class !== COLLAPSE_CLASS || row.status !== "sent") {
      return false;
    }
    const createdAt = new Date(row.createdAt);
    return createdAt > windowStart && createdAt <= input.now;
  });

  return {
    action: "collapse",
    n: sentInWindow + 1,
    notify: !hasCollapseNotified,
  };
}

/**
 * Main decision function: apply rules in order, return first matching decision.
 */
export function decide(input: DecideInput): Decision {
  // Rule 1: Critical sends.
  const critical = checkCritical(input);
  if (critical) return critical;

  // Rule 2: Quiet hours defer.
  const quiet = checkQuietHours(input);
  if (quiet) return quiet;

  // Rule 3: Duplicate drop.
  const dup = checkDuplicate(input);
  if (dup) return dup;

  // Rule 4: Daily cap drop.
  const cap = checkDailyCap(input);
  if (cap) return cap;

  // Rule 5: Window collapse/send.
  const win = checkWindow(input);
  if (win) return win;

  // Fallback (should not reach here if rules cover all cases).
  return { action: "send" };
}
