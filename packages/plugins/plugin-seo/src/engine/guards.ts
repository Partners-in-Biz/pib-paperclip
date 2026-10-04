/**
 * Deterministic checks an agent must pass before `complete-task` closes
 * certain task types. They stop the old "flip the status" behaviour: the
 * sprint data has to show the work.
 */

export interface CompletionFacts {
  activeKeywords: number;
  keywordsWithoutIntent: number;
  priorityKeywords: number;
  /** Directory and citation backlinks still `not_started`. */
  directoriesNotStarted: number;
  /** Highest `day` among the sprint's audit snapshots. */
  latestSnapshotDay: number | null;
  /** Live content rows with at least one linked Social post. */
  liveContentWithSocial?: number;
  /** Days since the sprint's latest geo-audit (null when none was recorded). */
  geoAuditAgeDays?: number | null;
  /** Distinct (question, assistant) answers sampled in the last 14 days. */
  aiSamplesRecent?: number;
  /** AI search is switched off for the sprint: the tools a GEO task needs refuse, so the audit and samples it asks for cannot be made. */
  geoOff?: boolean;
}

/** A geo-audit must be this recent (days) when a GEO task closes, so its result is on record. */
export const GEO_AUDIT_MAX_AGE_DAYS = 14;
export const MIN_AI_SAMPLES = 5;

export const MIN_TRACKED_KEYWORDS = 5;

/** "1 keyword" / "3 keywords". */
function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Live content rows with social posts a post-repurpose task needs (w5: post 1, w6: posts 1 and 2). */
export function socialPostsNeeded(templateKey: string | null | undefined): number {
  return templateKey === "w6-repurpose-2" ? 2 : 1;
}

function geoAuditBlocker(facts: CompletionFacts): string | null {
  const age = facts.geoAuditAgeDays;
  return age == null || age > GEO_AUDIT_MAX_AGE_DAYS
    ? `No geo-audit was recorded in the last ${GEO_AUDIT_MAX_AGE_DAYS} days. Run geo-audit with the sprintId (after your change is live) so the result is on record, then complete.`
    : null;
}

export function completionBlocker(taskType: string, facts: CompletionFacts, templateKey?: string | null): string | null {
  // A GEO task left open after AI search was switched off can be closed or skipped: its tools refuse, so the audit it asks for cannot be made.
  if (facts.geoOff && taskType.startsWith("geo-")) return null;
  switch (taskType) {
    case "post-repurpose": {
      const needed = socialPostsNeeded(templateKey);
      const have = facts.liveContentWithSocial ?? 0;
      return have < needed
        ? `${count(have, "live content row")} ${have === 1 ? "has" : "have"} linked social posts; this task needs ${needed}. Mark the post live (update-content), wait for the Social agent's drafts, then link them with link-social-post. If they are not there yet, leave the task in progress.`
        : null;
    }
    case "keyword-discover":
    case "keyword-record":
      return facts.activeKeywords < MIN_TRACKED_KEYWORDS
        ? `Only ${count(facts.activeKeywords, "keyword")} ${facts.activeKeywords === 1 ? "is" : "are"} tracked. Add at least ${MIN_TRACKED_KEYWORDS} with add-keywords before completing.`
        : null;
    case "keyword-bucket":
      return facts.keywordsWithoutIntent > 0
        ? `${count(facts.keywordsWithoutIntent, "active keyword")} ${facts.keywordsWithoutIntent === 1 ? "has" : "have"} no intent. Set intent (problem, solution or brand) with update-keyword first.`
        : null;
    case "keyword-prioritize":
      return facts.priorityKeywords < 1
        ? "No keyword is marked priority. Mark the chosen keywords with update-keyword priority: true first."
        : null;
    case "directory-submission":
      return facts.directoriesNotStarted > 0
        ? `${count(facts.directoriesNotStarted, "directory or citation", "directories or citations")} ${facts.directoriesNotStarted === 1 ? "is" : "are"} still not started. Submit each (update-backlink status submitted with notes) or mark it rejected with a reason.`
        : null;
    case "geo-mention-check": {
      const samples = facts.aiSamplesRecent ?? 0;
      if (samples < MIN_AI_SAMPLES) return `Only ${count(samples, "AI answer")} ${samples === 1 ? "was" : "were"} sampled in the last ${GEO_AUDIT_MAX_AGE_DAYS} days. Ask at least ${MIN_AI_SAMPLES} questions and record each with record-ai-mentions first (if no tool of yours returns an AI assistant's answer, skip-task with that reason instead of guessing).`;
      return geoAuditBlocker(facts);
    }
    case "geo-crawler-access":
    case "geo-llms-txt":
    case "geo-entity-schema":
    case "geo-answer-blocks":
    case "geo-brand-consistency":
      return geoAuditBlocker(facts);
    case "audit-snapshot":
      return facts.latestSnapshotDay == null || facts.latestSnapshotDay < 90
        ? "No day-90 (or later) audit snapshot exists yet. Run run-audit-snapshot first."
        : null;
    default:
      return null;
  }
}
