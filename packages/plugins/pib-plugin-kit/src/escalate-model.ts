/**
 * Escalation model: when a blocked issue has no way out after 24h, escalate to
 * the next manager in the chain or the owner. Caps at 20 per day per company,
 * with 24h cooldown per level per issue.
 */
import { teamRoleHealth } from "./team.js";

export const ESCALATION_MARK = "pib:escalation";
export const ESCALATION_COOLDOWN_MS = 24 * 3600_000;
export const ESCALATION_DAILY_CAP = 20;
export const ESCALATION_DEADLINE_MS = 24 * 3600_000;

export type EscalationTarget = { kind: "agent"; agentId: string } | { kind: "owner" };
export type EscalationLevel = { level: number; target: EscalationTarget };
export type AgentHealthInput = { agentStatus: string | null | undefined; hireOpen: boolean; missingSkills?: number };
export type StartLevel = number | "owner";

/**
 * Chain managers (nearest first, head last; assignee not included).
 * Keeps only managers with teamRoleHealth === "ok", numbers them 1..n,
 * then appends owner as level n+1. Empty chain or no usable manager
 * returns owner only. startLevel number drops levels < n; "owner" returns
 * only the owner level.
 */
export function pickLevels(
  chain: readonly string[],
  healthByAgent: Readonly<Record<string, AgentHealthInput | undefined>>,
  startLevel?: StartLevel,
): EscalationLevel[] {
  const kept: string[] = [];
  for (const agentId of chain) {
    const health = healthByAgent[agentId];
    if (health === undefined) continue;
    const status = teamRoleHealth(health);
    if (status === "ok") {
      kept.push(agentId);
    }
  }

  const levels: EscalationLevel[] = kept.map((agentId, i) => ({
    level: i + 1,
    target: { kind: "agent" as const, agentId },
  }));

  const ownerLevel = levels.length + 1;
  levels.push({ level: ownerLevel, target: { kind: "owner" } });

  if (levels.length === 1) {
    return [{ level: 1, target: { kind: "owner" } }];
  }

  if (startLevel === undefined) {
    return levels;
  }

  if (typeof startLevel === "number") {
    return levels.filter((l) => l.level >= startLevel);
  }

  return levels.filter((l) => l.target.kind === "owner");
}

export function escalationOriginId(issueId: string, level: number): string {
  return `escalate:${issueId}:L${level}`;
}

export type ExistingEscalation = { originId: string; createdAt: string | Date; open: boolean };
export type EscalationDecision =
  | { action: "create"; originId: string }
  | { action: "skip"; reason: "dedupe" | "cooldown" | "cap" | "below-start"; originId: string };

/**
 * Decides whether to create an escalation. Checks in order: below-start,
 * dedupe, cooldown, cap.
 */
export function escalationDecide(input: {
  issueId: string;
  existing: readonly ExistingEscalation[];
  now: Date;
  todayCount: number;
  level: EscalationLevel;
  startLevel?: StartLevel;
}): EscalationDecision {
  const { issueId, existing, now, todayCount, level, startLevel } = input;
  const originId = escalationOriginId(issueId, level.level);

  if (startLevel !== undefined) {
    if (typeof startLevel === "number" && level.level < startLevel) {
      return { action: "skip", reason: "below-start", originId };
    }
    if (startLevel === "owner" && level.target.kind !== "owner") {
      return { action: "skip", reason: "below-start", originId };
    }
  }

  const same = existing.filter((e) => e.originId === originId);
  if (same.some((e) => e.open)) {
    return { action: "skip", reason: "dedupe", originId };
  }

  const closedItems = same.filter((e) => !e.open);
  if (closedItems.length > 0) {
    const newest = closedItems.reduce((a, b) => {
      const aTime = typeof a.createdAt === "string" ? new Date(a.createdAt).getTime() : a.createdAt.getTime();
      const bTime = typeof b.createdAt === "string" ? new Date(b.createdAt).getTime() : b.createdAt.getTime();
      return bTime > aTime ? b : a;
    });
    const createdAt = typeof newest.createdAt === "string" ? new Date(newest.createdAt) : newest.createdAt;
    const ageMs = now.getTime() - createdAt.getTime();
    if (ageMs < ESCALATION_COOLDOWN_MS) {
      return { action: "skip", reason: "cooldown", originId };
    }
  }

  if (todayCount >= ESCALATION_DAILY_CAP) {
    return { action: "skip", reason: "cap", originId };
  }

  return { action: "create", originId };
}

export type EscalationMarker = { issue: string; level: number; deadline: string };

export function escalationMarker(m: EscalationMarker): string {
  return `<!-- ${ESCALATION_MARK} ${JSON.stringify(m)} -->`;
}

/**
 * Parses the LAST marker in body. Returns null when absent, JSON is bad,
 * or issue/deadline not strings or level not positive int or deadline not valid.
 */
export function parseMarker(body: string | null | undefined): EscalationMarker | null {
  if (typeof body !== "string") return null;

  const matches = Array.from(body.matchAll(new RegExp(`<!--\\s*${ESCALATION_MARK}\\s+(\\{.*?\\})\\s*-->`, "gs")));
  if (matches.length === 0) return null;

  const lastMatch = matches[matches.length - 1];
  if (!lastMatch || !lastMatch[1]) return null;

  try {
    const value = JSON.parse(lastMatch[1]) as Partial<EscalationMarker>;
    if (typeof value.issue !== "string" || typeof value.level !== "number" || typeof value.deadline !== "string") {
      return null;
    }
    if (value.level <= 0 || !Number.isInteger(value.level)) {
      return null;
    }
    const deadline = new Date(value.deadline);
    if (isNaN(deadline.getTime())) {
      return null;
    }
    return { issue: value.issue, level: value.level, deadline: value.deadline };
  } catch {
    return null;
  }
}

function truncateComment(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "...";
}

function neutralizeCommentMarkers(text: string): string {
  return text.replace(/<!--/g, "<!- -").replace(/-->/g, "- ->");
}

export function buildUnblockIssue(input: {
  issue: { id: string; identifier: string; title: string };
  level: EscalationLevel;
  reason: string;
  errorCode?: string | null;
  lastFailedRunId?: string | null;
  assigneeComments: readonly string[];
  redact: (text: string) => string;
  now: Date;
}): { title: string; description: string; originId: string; deadline: string; target: EscalationTarget } {
  const { issue, level, reason, errorCode, lastFailedRunId, assigneeComments, redact, now } = input;

  const title = `Unblock: ${issue.identifier} ${issue.title}`;
  const originId = escalationOriginId(issue.id, level.level);
  const deadline = new Date(now.getTime() + ESCALATION_DEADLINE_MS).toISOString();
  const target = level.target;

  const redactedReason = neutralizeCommentMarkers(redact(reason));
  const redactedErrorCode = neutralizeCommentMarkers(redact(errorCode ?? ""));
  const redactedRunId = lastFailedRunId ? neutralizeCommentMarkers(redact(lastFailedRunId)) : "";

  const lastThreeComments = assigneeComments.slice(-3);
  const commentLines = lastThreeComments.length > 0
    ? lastThreeComments
        .map((comment) => {
          const redactedComment = neutralizeCommentMarkers(redact(comment));
          const truncated = truncateComment(redactedComment, 500);
          return `> ${truncated}`;
        })
        .join("\n")
    : "_No comments._";

  const description = [
    redactedReason,
    "",
    `**Error code:** ${redactedErrorCode || "none"}`,
    "",
    `**Last failed run:** ${redactedRunId || "none"}`,
    "",
    "**Last comments by the assignee:**",
    commentLines,
    "",
    "**Ways out:**",
    "1. Reassign to a better-suited agent.",
    "2. Split into smaller issues.",
    "3. Cancel with a reason in a comment.",
    "4. Use the `ask-owner` tool when only the owner can unblock.",
    "",
    `**Deadline:** ${deadline}`,
    "",
    escalationMarker({ issue: issue.id, level: level.level, deadline }),
  ].join("\n");

  return { title, description, originId, deadline, target };
}
