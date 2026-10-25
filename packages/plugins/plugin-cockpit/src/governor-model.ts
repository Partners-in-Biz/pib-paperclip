/**
 * Governor: pausing agents when quota errors exceed a threshold, and resuming when safe (pure model, no I/O).
 *
 * The governor detects when adapter failures breach a configured threshold of failures per agent.
 * When triggered, it pauses agents in a predetermined order (preserving canary integrity),
 * then resumes them in reverse batches once the canary confirms recovery.
 */

export interface LimitFailures {
  total: number;
  byAgent: Array<{ agentId: string; count: number }>;
}

export interface GovernorAgent {
  id: string;
  name: string;
}

// Agents that should pause first (in order). Summarizer is deliberately removed—it is the canary.
export const DEFAULT_PAUSE_ORDER = [
  "Dogfood Tester",
  "Product Designer",
  "SEO Specialist",
  "Outbound & Social",
  "Wiki Maintainer",
  "Afrikaans Editor",
  "Developer",
  "Kai",
  "Ren",
  "Iris",
  "Mira",
  "Nadia",
  "Theo",
  "Senior Developer",
  "Code Reviewer",
  "Planner",
  "Plan Critic",
  "Release Engineer",
  "Loyalty Plus Engineer",
] as const;

// Agents that must never pause. Summarizer is the governor canary.
export const NEVER_PAUSE = [
  "Elon",
  "PiB",
  "Delivery Lead",
  "Operator",
  "Reviewer",
  "Reflection Coach",
  "Acceptance",
  "Summarizer",
] as const;

export const DEFAULT_TRIGGER_FAILURES = 3;
export const DEFAULT_TRIGGER_AGENTS = 2;
export const FAILURE_WINDOW_MINUTES = 30;
export const RESUME_BATCH_SIZE = 5;
export const CANARY_MAX_TRIES = 4;
export const CANARY_RETRY_MINUTES = 15;
export const RESET_FALLBACK_MS = 3_600_000; // 1 hour
export const STUCK_AFTER_RESET_HOURS = 6;

/**
 * Decides whether to trigger a pause based on failure counts.
 * The window (how old failures matter) is applied by the caller.
 * @param failures Failure counts already windowed by the caller
 * @param opts Optional override for trigger thresholds
 */
export function shouldTrigger(
  failures: LimitFailures,
  opts?: { triggerFailures?: number; triggerAgents?: number },
): boolean {
  const triggerFailures = opts?.triggerFailures ?? DEFAULT_TRIGGER_FAILURES;
  const triggerAgents = opts?.triggerAgents ?? DEFAULT_TRIGGER_AGENTS;
  return failures.total >= triggerFailures && failures.byAgent.length >= triggerAgents;
}

/**
 * Builds the pause list from agent registry, respecting the pause order.
 * Names compared trimmed + case-insensitive. Agent in neverList is never included.
 * Agents not in order are ignored. Names in order with no matching agent are skipped.
 * @param order Predetermined pause order
 * @param agents All available agents
 * @param neverList Agent names that must never pause
 */
export function pauseList(
  order: readonly string[],
  agents: readonly GovernorAgent[],
  neverList: readonly string[],
): GovernorAgent[] {
  const neverSet = new Set(neverList.map((n) => n.trim().toLowerCase()));
  const agentMap = new Map(agents.map((a) => [a.name.trim().toLowerCase(), a]));

  const result: GovernorAgent[] = [];
  const seen = new Set<string>();
  for (const name of order) {
    const trimmed = name.trim().toLowerCase();
    if (neverSet.has(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    const agent = agentMap.get(trimmed);
    if (agent) {
      result.push(agent);
      seen.add(trimmed);
    }
  }
  return result;
}

/**
 * Copied from server/src/services/recovery/service.ts:560 (parseProviderQuotaClockReset).
 * Host code is read-only for us; re-sync by hand if the host changes.
 * Parses provider quota clock reset times from error messages.
 * Returns a Date if parsed, null if no match or invalid.
 */
export function parseProviderQuotaClockReset(error: string, now: Date): Date | null {
  const match = error.match(
    /(?:try again at|resets?(?:\s+at)?)\s+(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?\s*m\.?)?(?:\s*\(([^)]+)\)|\s+([A-Z]{2,5}))?/i,
  );
  if (!match) return null;

  const hourValue = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  const meridiem = (match[3] ?? "").toLowerCase();
  if (!Number.isInteger(hourValue)) return null;
  if (meridiem ? hourValue < 1 || hourValue > 12 : hourValue < 0 || hourValue > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let hour = meridiem ? hourValue % 12 : hourValue;
  if (meridiem === "p") hour += 12;
  const timeZone = (match[4] ?? match[5])?.trim();
  if (!timeZone) {
    const retryAt = new Date(now);
    retryAt.setUTCHours(hour, minute, 0, 0);
    if (retryAt.getTime() <= now.getTime()) retryAt.setUTCDate(retryAt.getUTCDate() + 1);
    return retryAt;
  }

  try {
    const wallClock = (date: Date) =>
      Object.fromEntries(
        new Intl.DateTimeFormat("en-US", {
          timeZone,
          hourCycle: "h23",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })
          .formatToParts(date)
          .map((part) => [part.type, part.value]),
      );
    const nowParts = wallClock(now);
    const buildRetryAt = (dayOffset: number) => {
      const targetDay = new Date(
        Date.UTC(
          Number(nowParts.year),
          Number(nowParts.month) - 1,
          Number(nowParts.day) + dayOffset,
          hour,
          minute,
        ),
      );
      let candidate = targetDay;
      const targetMs = targetDay.getTime();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const actual = wallClock(candidate);
        const actualMs = Date.UTC(
          Number(actual.year),
          Number(actual.month) - 1,
          Number(actual.day),
          Number(actual.hour),
          Number(actual.minute),
        );
        const adjustment = targetMs - actualMs;
        if (adjustment === 0) break;
        candidate = new Date(candidate.getTime() + adjustment);
      }
      return candidate;
    };
    const sameDay = buildRetryAt(0);
    return sameDay.getTime() > now.getTime() ? sameDay : buildRetryAt(1);
  } catch {
    return null;
  }
}

/**
 * Finds the latest parsed reset time that is after now, or falls back to now + 1 hour on a miss (the canary guards an early resume).
 * @param errors Error strings to parse
 * @param now Current time
 */
export function resumeAtFor(errors: readonly string[], now: Date): Date {
  let latest: Date | null = null;
  for (const error of errors) {
    const parsed = parseProviderQuotaClockReset(error, now);
    if (parsed && parsed > now) {
      if (!latest || parsed > latest) latest = parsed;
    }
  }
  if (latest) return latest;
  return new Date(now.getTime() + RESET_FALLBACK_MS);
}

/**
 * True once now is more than 6 hours past the resume time (agents have stayed paused that long): the caller escalates to the owner.
 */
export function governorStuck(resumeAt: Date, now: Date): boolean {
  return now > new Date(resumeAt.getTime() + STUCK_AFTER_RESET_HOURS * 60 * 60 * 1000);
}

/**
 * Returns the next batch of agents to resume (up to 5, in reverse of pause order).
 * paused should be agent ids in the original pause order.
 * Returns empty list if canaryOk is false.
 * @param paused Agent ids in the original pause order
 * @param canaryOk Whether the canary has confirmed recovery
 */
export function nextResume(paused: readonly string[], canaryOk: boolean): string[] {
  if (!canaryOk) return [];
  if (paused.length === 0) return [];
  const reversed = [...paused].reverse();
  return reversed.slice(0, RESUME_BATCH_SIZE);
}

export type CanaryDecision = "succeeded" | "wait" | "retry" | "give_up";

/**
 * Decides canary run status.
 * @param runStatus The canary run's status (e.g., "succeeded", "failed", "running")
 * @param tries Number of attempts made so far, including this one
 */
export function canaryDecision(runStatus: string | null | undefined, tries: number): CanaryDecision {
  if (runStatus === "succeeded") return "succeeded";
  if (["queued", "scheduled_retry", "running"].includes(runStatus ?? "")) return "wait";
  if (["failed", "interrupted", "timed_out", "cancelled"].includes(runStatus ?? "")) {
    return tries >= CANARY_MAX_TRIES ? "give_up" : "retry";
  }
  return "wait";
}
