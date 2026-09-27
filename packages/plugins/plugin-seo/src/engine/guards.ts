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
}

export const MIN_TRACKED_KEYWORDS = 5;

/** "1 keyword" / "3 keywords". */
function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Live content rows with social posts a post-repurpose task needs (w5: post 1, w6: posts 1 and 2). */
export function socialPostsNeeded(templateKey: string | null | undefined): number {
  return templateKey === "w6-repurpose-2" ? 2 : 1;
}

export function completionBlocker(taskType: string, facts: CompletionFacts, templateKey?: string | null): string | null {
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
    case "audit-snapshot":
      return facts.latestSnapshotDay == null || facts.latestSnapshotDay < 90
        ? "No day-90 (or later) audit snapshot exists yet. Run run-audit-snapshot first."
        : null;
    default:
      return null;
  }
}
