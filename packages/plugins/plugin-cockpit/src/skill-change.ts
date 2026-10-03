/**
 * `propose-skill-change`, worker part (Q10-4, Q2-4): applies the proposal's diff to
 * the skill's real text, refuses what the guardrails refuse, records the change in
 * the improvements ledger with the number it should move, and returns the pull
 * request package an agent opens. The rules and the PR text are in
 * `skill-change-model.ts`.
 */
import { skillContentHash } from "./eval-model.js";
import { ownSkills, type SkillInfo } from "./evals.js";
import type { Env } from "./env.js";
import { proposeImprovement } from "./improvements.js";
import { ImprovementError } from "./improvements-model.js";
import { diffHash, pullRequestPackage, reviewProposal, SkillChangeError, type ProposalReview, type PullRequestPackage } from "./skill-change-model.js";

export interface ChangeInput {
  skill: string;
  diff: string;
  file: string;
  reason: string;
  evidence: string[];
  sourceIssueId: string | null;
  metricKey: string;
  direction?: "lower" | "higher";
  baselineValue?: number;
  targetValue?: number;
  recheckInDays: number;
  kind: string;
}

export interface ChangeResult {
  package: PullRequestPackage;
  review: ProposalReview | null;
  hash: { before: string; after: string } | null;
  improvement: { id: string; metricKey: string; recheckAt: string; deduped: boolean };
  verified: boolean;
  next: string[];
}

/** The text of one file of a skill as the plugin ships it, or null when the Cockpit does not ship that skill. */
function currentText(info: SkillInfo | undefined, file: string): string | null {
  if (!info) return null;
  if (file === "SKILL.md") return info.markdown;
  const found = info.files.find((f) => f.path === file);
  if (!found) throw new SkillChangeError(`${info.slug} has no file ${file}. Its files: SKILL.md${info.files.length ? `, ${info.files.map((f) => f.path).join(", ")}` : ""}.`);
  return found.content;
}

export async function proposeSkillChange(env: Env, companyId: string, input: ChangeInput, actor: { agentId: string | null }): Promise<ChangeResult> {
  const date = env.now().toISOString().slice(0, 10);
  const info = ownSkills().find((s) => s.slug === input.skill);
  const current = currentText(info, input.file);
  let review: ProposalReview | null = null;
  let hash: ChangeResult["hash"] = null;
  if (info && current !== null) {
    review = reviewProposal({ slug: info.slug, file: input.file, current, diff: input.diff });
    if (!review.allowed) throw new SkillChangeError(`The change cannot become a pull request yet: ${review.checks.filter((c) => !c.ok && c.severity === "blocks").map((c) => c.detail).join("; ")}.`);
    const markdown = input.file === "SKILL.md" ? review.newText : info.markdown;
    const files = input.file === "SKILL.md" ? info.files : info.files.map((f) => (f.path === input.file ? { path: f.path, content: review!.newText } : f));
    hash = { before: info.hash, after: skillContentHash({ markdown, files }) };
  }
  // Measured before it ships, so the verdict later compares like with like (and the same proposal is never recorded twice).
  const sourceRef = `skillchange:${input.skill}:${diffHash(input.diff)}`;
  let recorded;
  try {
    recorded = await proposeImprovement(
      env,
      companyId,
      {
        title: `Skill ${input.skill}: ${input.reason}`.slice(0, 160),
        kind: input.kind,
        targetRef: input.skill,
        summary: `${input.reason} A pull request changes the skill; it is measured again after it ships. Evidence: ${input.evidence.slice(0, 5).join(", ") || "none given"}.`.slice(0, 600),
        metricKey: input.metricKey,
        ...(input.direction ? { direction: input.direction } : {}),
        ...(input.baselineValue !== undefined ? { baselineValue: input.baselineValue } : {}),
        ...(input.targetValue !== undefined ? { targetValue: input.targetValue } : {}),
        recheckInDays: input.recheckInDays,
        sourceRef,
        ...(input.sourceIssueId ? { sourceIssueId: input.sourceIssueId } : {}),
      },
      { agentId: actor.agentId, userId: null },
    );
  } catch (error) {
    if (error instanceof ImprovementError) throw new SkillChangeError(`The change cannot be measured yet: ${error.message}`);
    throw error;
  }
  const improvement = { id: recorded.improvement.id, metricKey: recorded.improvement.metricKey, recheckAt: recorded.improvement.recheckAt, deduped: recorded.deduped };
  const pr = pullRequestPackage({ slug: input.skill, file: input.file, reason: input.reason, evidence: input.evidence, diff: input.diff, date, review, hash, improvement, sourceIssue: input.sourceIssueId });
  const next: string[] = [];
  if (review?.needsOwner) next.push("The change drops a \"never\" rule. Put ONE question to the owner (ask-owner, kind decision) and merge nothing until they say yes.");
  next.push(`Open the pull request into development: branch ${pr.branch}, then follow the steps (they include the eval gate).`);
  if (recorded.deduped) next.push("This exact change was already proposed and is still open in the ledger; no second entry was made.");
  if (!review) next.push("The Cockpit does not ship this skill, so it could not check the diff against the text. Apply it in the plugin that ships it; that plugin's tests are the check.");
  return { package: pr, review, hash, improvement, verified: !!review, next };
}
