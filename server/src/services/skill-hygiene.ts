/**
 * Skill hygiene for nightly dreaming (draft only).
 *
 * Autoharness merges near-duplicates, archives unused skills it created,
 * and never touches a human-written or installed skill. This module is that
 * decision, adapted to company skills. It returns a plan. It does not write.
 *
 * The nightly-dreaming routine states the same thresholds. Keep them in sync.
 * A missing owner marker is protected. Unknown usage is not "unused".
 */

export const SKILL_HYGIENE_PROBATION_DAYS = 14;
export const SKILL_HYGIENE_MERGE_OVERLAP = 0.5;
export const SKILL_HYGIENE_MIN_SHARED_TOKENS = 3;
export const SKILL_INDEX_DESC_CHARS = 60;
export const AGENT_MANAGED_BY = "agent";

const STOP_TOKENS = new Set([
  "a", "an", "the", "and", "or", "to", "of", "for", "in", "on", "with", "from", "by", "is", "are",
]);

const INSTALLED_SOURCE_TYPES = new Set(["catalog", "github", "skills_sh", "url"]);
const INSTALLED_BADGES = new Set(["catalog", "github", "skills_sh", "url"]);
const INSTALLED_KEY_PREFIXES = ["paperclipai/", "plugin/"];

export type HygieneSkill = {
  key: string;
  name: string;
  description: string | null;
  /** Only the exact value "agent" can be agent-owned. Null, missing, or anything else is protected. */
  managedBy: string | null;
  sourceType: string | null;
  sourceBadge: string | null;
  /** Null means unknown. Unknown is not zero. */
  useCount: number | null;
  viewCount: number | null;
  ageDays: number | null;
};

export type SkillMergeProposal = {
  keepKey: string;
  absorbKey: string;
  sharedTokens: number;
  overlap: number;
};

export type SkillArchiveProposal = {
  key: string;
  reason: string;
};

export type SkillHygienePlan = {
  skillCountBefore: number;
  protectedCount: number;
  agentOwnedCount: number;
  mergeProposals: SkillMergeProposal[];
  archiveProposals: SkillArchiveProposal[];
  /** What the count would be if a reviewer applied every draft. This function does not apply. */
  skillCountAfterIfApplied: number;
  sessionIndex: string;
};

export function isInstalledSkill(skill: Pick<HygieneSkill, "key" | "sourceType" | "sourceBadge">): boolean {
  if (skill.sourceType && INSTALLED_SOURCE_TYPES.has(skill.sourceType)) return true;
  if (skill.sourceBadge && INSTALLED_BADGES.has(skill.sourceBadge)) return true;
  return INSTALLED_KEY_PREFIXES.some((prefix) => skill.key.startsWith(prefix));
}

/** Default deny. Installed skills stay protected even if mis-marked as agent-owned. */
export function isProtectedSkill(skill: HygieneSkill): boolean {
  if (isInstalledSkill(skill)) return true;
  return skill.managedBy !== AGENT_MANAGED_BY;
}

function tokensOf(skill: HygieneSkill): Set<string> {
  const raw = `${skill.name} ${skill.description ?? ""}`.toLowerCase();
  const parts = raw.split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !STOP_TOKENS.has(token));
  return new Set(parts);
}

function overlapOf(left: Set<string>, right: Set<string>): { shared: number; score: number } {
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  const union = left.size + right.size - shared;
  return { shared, score: union === 0 ? 0 : shared / union };
}

function useRank(skill: HygieneSkill): number {
  return typeof skill.useCount === "number" ? skill.useCount : -1;
}

function preferKeep(left: HygieneSkill, right: HygieneSkill): HygieneSkill {
  const useDelta = useRank(left) - useRank(right);
  if (useDelta !== 0) return useDelta > 0 ? left : right;
  const viewDelta = (left.viewCount ?? -1) - (right.viewCount ?? -1);
  if (viewDelta !== 0) return viewDelta > 0 ? left : right;
  return left.key < right.key ? left : right;
}

function isUnused(skill: HygieneSkill): boolean {
  if (isProtectedSkill(skill)) return false;
  if (skill.useCount !== 0 || skill.viewCount !== 0) return false;
  // Positive check. A negated comparison lets undefined and NaN through.
  const ageDays = skill.ageDays;
  if (typeof ageDays !== "number" || !Number.isFinite(ageDays) || !(ageDays >= SKILL_HYGIENE_PROBATION_DAYS)) return false;
  return true;
}

/**
 * Changelog list of agent-owned skills only.
 * The dreaming routine may paste this into its own changelog.
 * Do not inject it into other agents' session starts.
 */
export function sessionIndexFor(skills: HygieneSkill[]): string {
  const owned = skills
    .filter((skill) => !isProtectedSkill(skill))
    .sort((left, right) => left.name.localeCompare(right.name) || left.key.localeCompare(right.key));
  if (owned.length === 0) return "(no agent-owned skills)";

  const groups = new Map<string, HygieneSkill[]>();
  for (const skill of owned) {
    const group = (skill.name.split("-")[0] || "other").slice(0, 24);
    const list = groups.get(group) ?? [];
    list.push(skill);
    groups.set(group, list);
  }

  const lines: string[] = [];
  for (const [group, list] of [...groups.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    lines.push(`## ${group}`);
    for (const skill of list) {
      const description = (skill.description ?? "").replace(/\s+/g, " ").trim().slice(0, SKILL_INDEX_DESC_CHARS);
      lines.push(`- ${skill.name}: ${description}`);
    }
  }
  return lines.join("\n");
}

export function planSkillHygiene(skills: HygieneSkill[]): SkillHygienePlan {
  const protectedCount = skills.filter(isProtectedSkill).length;
  const owned = skills.filter((skill) => !isProtectedSkill(skill));
  const tokenCache = new Map<string, Set<string>>();
  for (const skill of owned) tokenCache.set(skill.key, tokensOf(skill));

  const pairs: Array<SkillMergeProposal & { score: number }> = [];
  for (let i = 0; i < owned.length; i += 1) {
    for (let j = i + 1; j < owned.length; j += 1) {
      const left = owned[i];
      const right = owned[j];
      const overlap = overlapOf(tokenCache.get(left.key) ?? new Set(), tokenCache.get(right.key) ?? new Set());
      if (overlap.shared < SKILL_HYGIENE_MIN_SHARED_TOKENS) continue;
      if (overlap.score < SKILL_HYGIENE_MERGE_OVERLAP) continue;
      const keep = preferKeep(left, right);
      const absorb = keep === left ? right : left;
      pairs.push({
        keepKey: keep.key,
        absorbKey: absorb.key,
        sharedTokens: overlap.shared,
        overlap: overlap.score,
        score: overlap.score,
      });
    }
  }
  pairs.sort((left, right) => right.score - left.score || left.keepKey.localeCompare(right.keepKey) || left.absorbKey.localeCompare(right.absorbKey));

  const used = new Set<string>();
  const mergeProposals: SkillMergeProposal[] = [];
  for (const pair of pairs) {
    if (used.has(pair.keepKey) || used.has(pair.absorbKey)) continue;
    used.add(pair.keepKey);
    used.add(pair.absorbKey);
    mergeProposals.push({
      keepKey: pair.keepKey,
      absorbKey: pair.absorbKey,
      sharedTokens: pair.sharedTokens,
      overlap: pair.overlap,
    });
  }

  const archiveProposals: SkillArchiveProposal[] = owned
    .filter((skill) => isUnused(skill) && !used.has(skill.key))
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((skill) => ({
      key: skill.key,
      reason: `agent-owned, unused for ${skill.ageDays} days (use 0, view 0)`,
    }));

  return {
    skillCountBefore: skills.length,
    protectedCount,
    agentOwnedCount: owned.length,
    mergeProposals,
    archiveProposals,
    skillCountAfterIfApplied: skills.length - mergeProposals.length - archiveProposals.length,
    sessionIndex: sessionIndexFor(skills),
  };
}

/**
 * Map a company-skill API row. Missing usage and age stay null, so they are not unused.
 * Not wired into a write path. Callers must not invent counters.
 */
export function hygieneSkillFromApi(
  row: {
    key: string;
    name: string;
    description?: string | null;
    sourceType?: string | null;
    sourceBadge?: string | null;
    managedBy?: string | null;
  },
): HygieneSkill {
  return {
    key: row.key,
    name: row.name,
    description: row.description ?? null,
    managedBy: row.managedBy ?? null,
    sourceType: row.sourceType ?? null,
    sourceBadge: row.sourceBadge ?? null,
    useCount: null,
    viewCount: null,
    ageDays: null,
  };
}
