/** Risk tier model for PAR-4002 (W1c F1a). */
export type Tier = "low" | "medium" | "high";
export type Verdict = "pass" | "changes" | "stale" | "none";
export interface TierRoles {
  planner: string[];
  deliveryLead: string[];
  codeReviewer: string[];
  dogfoodTester: string[];
  reviewer: string[];
}
export interface PinnedTier { tier: Tier; trusted: boolean }
export interface VerdictComment {
  authorAgentId?: string | null;
  body: string;
  createdAt: string | Date;
  deletedAt?: string | Date | null;
}
export interface StatusChange { actorAgentId?: string | null; at: string | Date }
export interface Verdicts { codeReviewer: Verdict; dogfood: Verdict; reviewer: Verdict }
export type CloseDecision = "close" | "wait" | "never";
export const tierRank = { low: 1, medium: 2, high: 3 };

export function parseTier(description: string | null | undefined): Tier {
  if (!description) return "high";
  let result: Tier = "high", found = false;
  for (const line of description.split("\n")) {
    const m = line.match(/^\s*Risk tier:\s*(\S+)\s*$/i);
    if (!m) continue;
    const val = m[1].toLowerCase();
    if (!Object.hasOwn(tierRank, val)) return "high";
    const t = val as Tier;
    if (!found) {
      result = t;
      found = true;
    } else if (tierRank[t] > tierRank[result]) {
      result = t;
    }
  }
  return result;
}

export function maxTier(a: Tier, b: Tier): Tier {
  const aRank = Object.hasOwn(tierRank, a) ? tierRank[a] : tierRank.high;
  const bRank = Object.hasOwn(tierRank, b) ? tierRank[b] : tierRank.high;
  return aRank >= bRank ? a : b;
}

export function resolveTier({
  stored,
  description,
  createdByAgentId,
  roles,
}: {
  stored?: PinnedTier;
  description?: string | null;
  createdByAgentId?: string | null;
  roles: TierRoles;
}): PinnedTier {
  const parsed = parseTier(description);
  if (!stored) {
    const trusted = !!(
      createdByAgentId &&
      (roles.planner.includes(createdByAgentId) || roles.deliveryLead.includes(createdByAgentId))
    );
    return { tier: trusted ? parsed : "high", trusted };
  }
  return { tier: maxTier(stored.tier, parsed), trusted: stored.trusted };
}

function parseVerdict(prefix: "REVIEW" | "DOGFOOD", body: string, strictPass: RegExp): Verdict {
  const loosePassRegex = new RegExp(`^\\s*${prefix}:\\s*PASS\\b`);
  const changesRegex = new RegExp(`^\\s*${prefix}:\\s*(CHANGES NEEDED|FAIL)\\b`);
  let hasPass = false, hasChanges = false;
  for (const line of body.split("\n")) {
    if (strictPass.test(line)) hasPass = true;
    else if (loosePassRegex.test(line)) hasChanges = true;
    if (changesRegex.test(line)) hasChanges = true;
  }
  return hasChanges ? "changes" : hasPass ? "pass" : "none";
}

function lastVerdict(
  comments: VerdictComment[],
  roleIds: string[],
  parse: (body: string) => Verdict,
): { verdict: Verdict; index: number } {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (c.authorAgentId && roleIds.includes(c.authorAgentId)) {
      const v = parse(c.body);
      if (v !== "none") return { verdict: v, index: i };
    }
  }
  return { verdict: "none", index: -1 };
}

function invalidates(
  actorId: string | null | undefined,
  assigneeAgentId: string | null | undefined,
  roles: TierRoles,
): boolean {
  if (!actorId) return false;
  const isRoleHolder = (id: string) =>
    roles.codeReviewer.includes(id) ||
    roles.dogfoodTester.includes(id) ||
    roles.reviewer.includes(id);
  if (isRoleHolder(actorId)) return false;
  const isInAnyRole = (id: string) =>
    roles.planner.includes(id) ||
    roles.deliveryLead.includes(id) ||
    roles.codeReviewer.includes(id) ||
    roles.dogfoodTester.includes(id) ||
    roles.reviewer.includes(id);
  return actorId === assigneeAgentId || !isInAnyRole(actorId);
}

function isStale(
  verdict: Verdict,
  verdictIdx: number,
  comments: VerdictComment[],
  statusChanges: StatusChange[],
  assigneeAgentId: string | null | undefined,
  roles: TierRoles,
): Verdict {
  if (verdict !== "pass") return verdict;
  const verdictTime = verdictIdx >= 0 ? new Date(comments[verdictIdx].createdAt).getTime() : 0;
  for (let i = verdictIdx + 1; i < comments.length; i++) {
    if (!comments[i].deletedAt && invalidates(comments[i].authorAgentId, assigneeAgentId, roles)) {
      return "stale";
    }
  }
  for (const s of statusChanges) {
    if (new Date(s.at).getTime() >= verdictTime && invalidates(s.actorAgentId, assigneeAgentId, roles)) {
      return "stale";
    }
  }
  return verdict;
}

export function readVerdicts({
  comments,
  assigneeAgentId,
  statusChanges,
  roles,
}: {
  comments: VerdictComment[];
  assigneeAgentId?: string | null;
  statusChanges: StatusChange[];
  roles: TierRoles;
}): Verdicts {
  const active = comments.filter((c) => !c.deletedAt);
  active.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const reviewPass = /^\s*REVIEW: PASS\s+sha=([0-9a-f]{12})(?![0-9a-f])\s+ci=green\b/;
  const dogfoodPass = /^\s*DOGFOOD: PASS\b/;
  const crV = lastVerdict(active, roles.codeReviewer, (b) => parseVerdict("REVIEW", b, reviewPass));
  const dfV = lastVerdict(active, roles.dogfoodTester, (b) => parseVerdict("DOGFOOD", b, dogfoodPass));
  const revV = lastVerdict(active, roles.reviewer, (b) => parseVerdict("REVIEW", b, reviewPass));
  return {
    codeReviewer: isStale(crV.verdict, crV.index, active, statusChanges, assigneeAgentId, roles),
    dogfood: isStale(dfV.verdict, dfV.index, active, statusChanges, assigneeAgentId, roles),
    reviewer: isStale(revV.verdict, revV.index, active, statusChanges, assigneeAgentId, roles),
  };
}

export function closeDecision({ tier, verdicts }: { tier: Tier; verdicts: Verdicts }): CloseDecision {
  const t = Object.hasOwn(tierRank, tier) ? tier : "high";
  if (t === "high") return "never";
  const REQUIRED: Record<Tier, (keyof Verdicts)[]> = {
    low: ["codeReviewer", "dogfood"],
    medium: ["codeReviewer", "dogfood", "reviewer"],
    high: [],
  };
  const req = REQUIRED[t];
  if (req.some((k) => verdicts[k] === "changes")) return "wait";
  return req.every((k) => verdicts[k] === "pass") ? "close" : "wait";
}

export function evaluateIssue({
  stored,
  description,
  createdByAgentId,
  assigneeAgentId,
  comments,
  statusChanges,
  roles,
}: {
  stored?: PinnedTier;
  description?: string | null;
  createdByAgentId?: string | null;
  assigneeAgentId?: string | null;
  comments: VerdictComment[];
  statusChanges: StatusChange[];
  roles: TierRoles;
}): { pin: PinnedTier; verdicts: Verdicts; decision: CloseDecision } {
  const pin = resolveTier({ stored, description, createdByAgentId, roles });
  const verdicts = readVerdicts({ comments, assigneeAgentId, statusChanges, roles });
  const decision = closeDecision({ tier: pin.tier, verdicts });
  return { pin, verdicts, decision };
}
