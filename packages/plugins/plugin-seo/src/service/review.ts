/**
 * Reviewer routing (Company Cockpit roles) for outward-facing SEO work:
 * sign-off tasks (block-task review: true) and out-of-scope PRs on Needs you
 * (needs-you-add kind pr). With a Reviewer set, the Reviewer checks the work
 * first and hands it to the sprint owner with PASS / CHANGES NEEDED. The
 * owner still approves (closes the sign-off issue, merges the PR). With no
 * Reviewer nothing changes.
 */
import { reviewerAgentId, reviewerBrief } from "@partnersinbiz/pib-plugin-kit";
import { ORIGIN } from "../constants.js";
import type * as db from "../db.js";
import { withClientPrefix } from "../engine/copy.js";
import type { NewNeedsYouItem } from "../engine/needs-you.js";
import { assignableUser, errorMessage, type Env } from "./common.js";
import { openIssue } from "./issues.js";

export const SEO_REVIEW_CHECKS = [
  "The diff stays inside the allowed SEO scope (`check-change-scope`): only SEO files, no secrets, nothing the change policy forbids.",
  "Preview and CI checks passed, and the preview shows the change working.",
  "Copy is accurate: no invented numbers, rankings, reviews or claims; names and links are right.",
  "No pricing, legal, terms or privacy text changed.",
  "Client scope is right: only this sprint's site, repo and content.",
];

function ownerLabel(owner: string | null): { userId: string | null; label: string } {
  return { userId: owner, label: owner ? `user \`${owner}\` (the sprint owner)` : "the sprint owner (the sprint has none yet: ask the board)" };
}

/** Comment for a sign-off task issue routed to the Reviewer. Pure. */
export function signoffReviewBrief(title: string, ownerUserId: string | null): string {
  return [
    `This sign-off went to the Reviewer first. The owner approves it by marking the issue done; the Reviewer never does.`,
    reviewerBrief({ what: `the SEO sign-off "${title}"`, checks: SEO_REVIEW_CHECKS, handTo: ownerLabel(assignableUser(ownerUserId)) }),
  ].join("\n");
}

/** Issue text for an out-of-scope PR the Reviewer checks before the owner merges. Pure. */
export function prReviewDescription(item: Pick<NewNeedsYouItem, "title" | "why" | "steps" | "links" | "key">, sprint: Pick<db.Sprint, "siteName" | "siteUrl" | "ownerUserId">): string {
  return [
    `The SEO Specialist opened a PR it may not merge on its own for **${sprint.siteName}** (${sprint.siteUrl}). It is on the sprint's Needs you issue for the owner.`,
    "",
    `**${item.title}**`,
    "",
    item.why,
    ...(item.steps.length ? ["", ...item.steps.map((step, i) => `${i + 1}. ${step}`)] : []),
    ...(item.links.length ? ["", item.links.map((l) => `[${l.label}](${l.url})`).join(" · ")] : []),
    "",
    "The owner merges the PR and marks the Needs you item done. Closing this issue approves nothing.",
    reviewerBrief({ what: "an out-of-scope pull request before the owner merges it", checks: SEO_REVIEW_CHECKS, handTo: ownerLabel(assignableUser(sprint.ownerUserId)) }),
    "",
    `<sub>Needs you key: \`${item.key}\`</sub>`,
  ].join("\n");
}

/** A PR item was added to Needs you: open a review issue for the Reviewer when one is set. Never throws. */
export async function routePrReview(env: Env, sprint: db.Sprint, item: NewNeedsYouItem): Promise<string | null> {
  try {
    const reviewer = await reviewerAgentId(env.ctx, sprint.companyId);
    if (!reviewer) return null;
    const created = await openIssue(env, {
      companyId: sprint.companyId,
      title: withClientPrefix(`Review PR before the owner merges: ${item.title}`, sprint.clientName),
      description: prReviewDescription(item, sprint),
      originKind: ORIGIN.approval,
      originId: `review:${sprint.id}:${item.key}`,
      projectId: sprint.projectId,
      parentId: sprint.rootIssueId,
      assigneeAgentId: reviewer,
      priority: "medium",
      wakeReason: "SEO PR needs a review",
    });
    return created.id;
  } catch (error) {
    env.ctx.logger.info("SEO PR review routing skipped", { sprintId: sprint.id, key: item.key, error: errorMessage(error) });
    return null;
  }
}
