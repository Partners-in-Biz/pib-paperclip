// Owner defaults decision model: policy-driven auto-answer for asks.
export const POLICY_CLASSES = [
  "engineering-decision",
  "test-confirmation",
  "hire",
  "mapping-table",
] as const;
export type PolicyClass = (typeof POLICY_CLASSES)[number];

export const DEFAULT_MIN_HOURS = 4;

export interface OwnerDefaultsPolicy {
  enabled: boolean;
  name: string;
  rootIssueIds: string[];
  classes: PolicyClass[];
  minHours: number | null;
}

export interface OwnerDefaultsConfig {
  minHours?: number | null;
}

export interface PolicyAsk {
  key: string;
  issueId: string;
  kind: string;
  question: string;
  options: string[];
  recommended: string | null;
  policyClass: string | null;
  defaultAfterHours: number | null;
  effect: unknown | null;
  askedAt: string;
  deadlineAt: string | null;
}

export type Decision =
  | { action: "apply"; answer: string; reason: string; deadlineAt: string }
  | { action: "wait"; reason: string; deadlineAt: string }
  | { action: "escalate"; reason: string };

export interface EvaluateInput {
  ask: PolicyAsk;
  policy: OwnerDefaultsPolicy | null;
  now: Date;
  rootsOfIssue: readonly string[];
  config?: OwnerDefaultsConfig;
}

export function minHoursFloor(
  policy: OwnerDefaultsPolicy | null,
  config?: OwnerDefaultsConfig
): number {
  const p = policy?.minHours;
  if (p !== undefined && p !== null && Number.isFinite(p) && p > 0) return p;
  const c = config?.minHours;
  if (c !== undefined && c !== null && Number.isFinite(c) && c > 0) return c;
  return DEFAULT_MIN_HOURS;
}

export function pinDeadline(
  existingDeadlineAt: string | null,
  firstAskedAt: string,
  hours: number
): string | null {
  if (existingDeadlineAt) {
    const d = new Date(existingDeadlineAt);
    if (!Number.isNaN(d.getTime())) return existingDeadlineAt;
  }
  const asked = new Date(firstAskedAt);
  if (Number.isNaN(asked.getTime()) || !Number.isFinite(hours) || hours <= 0)
    return null;
  return new Date(asked.getTime() + hours * 3600000).toISOString();
}

export function textTripsScreen(text: string): boolean {
  const clean = text
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");
  const patterns = [
    /credentials?/i,
    /passcode|passphrase|password/i,
    /secret/i,
    /\bkeys?\b/i,
    /login|log in|sign in/i,
    /token/i,
    /payment|pay|paid/i,
    /invoice/i,
    /money/i,
    /legal/i,
    /contract/i,
    /refund/i,
    /bank/i,
    /client[- ]send/i,
    /send\s+.*to\s+(?:the|a|our)\s+client/i,
    /email\s+.*(?:to\s+)?(?:the|a|our\s+)?client/i,
  ];
  return patterns.some((p) => p.test(clean));
}

export function evaluate(input: EvaluateInput): Decision {
  const { ask, policy, now, rootsOfIssue, config } = input;

  // 1. Policy missing or disabled
  if (!policy || !policy.enabled)
    return { action: "escalate", reason: "Policy not enabled" };

  // 2. Any effect escalates
  if (ask.effect !== null && ask.effect !== undefined)
    return { action: "escalate", reason: "Effects not allowed" };

  // 3. Kind must be decision or info
  if (ask.kind !== "decision" && ask.kind !== "info")
    return {
      action: "escalate",
      reason: `Kind '${ask.kind}' requires escalation`,
    };

  // 4. policyClass valid and in policy.classes
  if (
    !ask.policyClass ||
    !POLICY_CLASSES.includes(ask.policyClass as PolicyClass) ||
    !policy.classes.includes(ask.policyClass as PolicyClass)
  )
    return { action: "escalate", reason: "Policy class mismatch" };

  // 5. Scope: issue in policy.rootIssueIds
  if (!rootsOfIssue.some((id) => policy.rootIssueIds.includes(id)))
    return { action: "escalate", reason: "Issue out of scope" };

  // 6. Recommended in options (trimmed)
  const rec = ask.recommended?.trim() ?? "";
  const opts = ask.options.map((o) => o.trim());
  if (!rec || !opts.includes(rec))
    return { action: "escalate", reason: "Recommended not in options" };

  // 7. Text screening
  if (
    textTripsScreen(ask.question) ||
    ask.options.some((o) => textTripsScreen(o)) ||
    textTripsScreen(ask.recommended || "")
  )
    return { action: "escalate", reason: "Sensitive content detected" };

  // 8. defaultAfterHours >= floor
  const hours = ask.defaultAfterHours;
  const floor = minHoursFloor(policy, config);
  if (
    hours === null ||
    hours === undefined ||
    !Number.isFinite(hours) ||
    hours < floor
  )
    return {
      action: "escalate",
      reason: `Hours ${hours} below floor ${floor}`,
    };

  // 9. Compute deadline
  const deadlineAt = pinDeadline(ask.deadlineAt, ask.askedAt, hours);
  if (!deadlineAt)
    return { action: "escalate", reason: "Invalid deadline calculation" };

  const deadline = new Date(deadlineAt);
  if (Number.isNaN(deadline.getTime()) || Number.isNaN(now.getTime()))
    return { action: "escalate", reason: "Invalid deadline or clock" };

  // 10. Apply or wait
  return now < deadline
    ? { action: "wait", reason: "Waiting for deadline", deadlineAt }
    : { action: "apply", answer: rec, reason: "Deadline reached", deadlineAt };
}
