/**
 * Deterministic checks an agent must pass before `complete-task` closes
 * certain task types. They stop the old "flip the status" behaviour: the
 * sprint data has to show the work.
 */

export interface CompletionFacts {
  activeKeywords: number;
  keywordsWithoutIntent: number;
  priorityKeywords: number;
  /** Directory backlinks still `not_started`. */
  directoriesNotStarted: number;
  /** Highest `day` among the sprint's audit snapshots. */
  latestSnapshotDay: number | null;
}

export const MIN_TRACKED_KEYWORDS = 5;

export function completionBlocker(taskType: string, facts: CompletionFacts): string | null {
  switch (taskType) {
    case "keyword-discover":
    case "keyword-record":
      return facts.activeKeywords < MIN_TRACKED_KEYWORDS
        ? `Only ${facts.activeKeywords} keyword(s) are tracked. Add at least ${MIN_TRACKED_KEYWORDS} with add-keywords before completing.`
        : null;
    case "keyword-bucket":
      return facts.keywordsWithoutIntent > 0
        ? `${facts.keywordsWithoutIntent} active keyword(s) have no intent. Set intent (problem, solution or brand) with update-keyword first.`
        : null;
    case "keyword-prioritize":
      return facts.priorityKeywords < 1
        ? "No keyword is marked priority. Mark the chosen keywords with update-keyword priority: true first."
        : null;
    case "directory-submission":
      return facts.directoriesNotStarted > 0
        ? `${facts.directoriesNotStarted} directory backlink(s) are still not started. Submit each (update-backlink status submitted with notes) or mark it rejected with a reason.`
        : null;
    case "audit-snapshot":
      return facts.latestSnapshotDay == null || facts.latestSnapshotDay < 90
        ? "No day-90 (or later) audit snapshot exists yet. Run run-audit-snapshot first."
        : null;
    default:
      return null;
  }
}
