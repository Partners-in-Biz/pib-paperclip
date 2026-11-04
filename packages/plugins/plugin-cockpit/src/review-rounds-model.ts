/**
 * Review rounds cap (W1c F3): pure logic. A "round" is one Code Reviewer comment whose verdict line is
 * `REVIEW: CHANGES NEEDED`. One definition: per verdict comment, not per sha. A PASS between rounds does not reset the count.
 * The reviewer's own skill text stops a fourth round; this is the Cockpit side that hands the issue to the Planner at the third.
 */

export const REVIEW_ROUNDS_CAP = 3;

export interface RoundComment {
  authorAgentId: string | null;
  body: string;
  deletedAt?: string | Date | null;
}

const CHANGES_LINE = /^\s*REVIEW:\s*CHANGES NEEDED\b/m;

export function isChangesNeeded(body: string): boolean {
  return CHANGES_LINE.test(body);
}

/** Number of CHANGES NEEDED verdict comments written by one of the Code Reviewer agents. Other authors are ignored. */
export function countChangesRounds(comments: RoundComment[], codeReviewerIds: string[]): number {
  return comments.filter((c) => !c.deletedAt && c.authorAgentId !== null && codeReviewerIds.includes(c.authorAgentId) && isChangesNeeded(c.body)).length;
}

/** Hand over when the cap is reached and it was not done before (the caller keeps `alreadyHandedOver`). */
export function shouldHandOver(rounds: number, alreadyHandedOver: boolean): boolean {
  return rounds >= REVIEW_ROUNDS_CAP && !alreadyHandedOver;
}

export function renderCapComment(planner: { id: string; name: string }): string {
  return `Round cap reached, handing to Planner. The Code Reviewer has asked for changes ${REVIEW_ROUNDS_CAP} times on this issue; no fourth round starts. [@${planner.name}](agent://${planner.id}) please decide how this goes on (re-scope, split, or a different builder).`;
}
