/**
 * The Reviewer's pass on a ledger approval (audit Q5-7), and the approval
 * routing that cannot end unassigned (audit Q5-6).
 *
 * Before 0.4 a manual journal, a bank reconciliation or a VAT201 went straight
 * to the owner, so nobody but the Bookkeeper looked at the categorisation or
 * the journal lines (the 18 live approvals have no Reviewer comment). Now,
 * when the company has a usable Reviewer and keeps "Review work before a person
 * approves" on (the Cockpit's `reviewOutward` switch; Accounting's own
 * `reviewLedger` setting can turn the pass off for the ledger):
 *
 * 1. The approval issue opens with the Reviewer (kit `openApprovalIssue`), whose
 *    brief says what to check and how to answer.
 * 2. The Reviewer records its verdict with the `record-review` tool. A pass hands
 *    the issue to the approver and is stored; changes needed sends it back to the
 *    Bookkeeper and withdraws the request, so a fixed version gets a fresh pass.
 * 3. The owner stays the final approver. The page offers Approve only after a
 *    recorded pass; the owner can still approve without one (the Reviewer may be
 *    down), and that is recorded and said on the issue, never silent. An approval
 *    made by marking the issue done is flagged the same way.
 *
 * With no Reviewer (not staffed, paused, review switched off) the approval goes
 * straight to the person as before and the review is `not_required`.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { openApprovalIssue, resolveApprover, routeWork, teamAgentId, wakeIssue, type ApproverRoute } from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import { AccountingError } from "../domain/util.js";
import { actorRecord, closeIssue, commentOn, errorMessage, ORIGIN, readSettings, type Actor } from "./common.js";

export const REVIEW_KINDS = {
  draft: { tool: "journal", label: "manual journal" },
  reconciliation: { tool: "reconciliation", label: "bank reconciliation" },
  vat: { tool: "vat201", label: "VAT201" },
} as const satisfies Record<db.ReviewKind, { tool: string; label: string }>;

/** The `kind` an agent passes to `record-review` → the stored kind. */
export function reviewKindFromTool(value: unknown): db.ReviewKind {
  for (const [kind, info] of Object.entries(REVIEW_KINDS)) if (info.tool === value) return kind as db.ReviewKind;
  throw new AccountingError("kind is journal, reconciliation or vat201");
}

/** What the Reviewer checks, per kind of approval. */
const CHECKS: Record<db.ReviewKind, string[]> = {
  draft: [
    "The memo says why the journal is needed and the date is in the period it belongs to.",
    "Every line uses the right account (list-accounts), debits equal credits, and VAT codes only where VAT really applies.",
    "It does not repeat a journal Billing or Payroll posts themselves (invoices, payments, bills, pay runs).",
  ],
  reconciliation: [
    "Open the lines of the period (list-bank-lines with the bank account and the period dates) and sample the categorisations: each account fits the description, transfers are not expenses, bank charges and interest carry no VAT.",
    "Anything categorised from a Jev suggestion or a rule is plausible; anything an agent accepted for an invoice or bill match was an exact match.",
    "The opening and closing balance match the statement and the difference is zero (the summary above).",
  ],
  vat: [
    "Read vat-summary for the period: the output and input VAT boxes agree with what the journals show and every warning above is explained.",
    "Manual boxes (10, 12, 14A, 15A, 16 to 18) have a reason, and bad debts and credit notes sit in the right boxes.",
    "The period is complete: no bank lines or Billing postings are still waiting for it.",
  ],
};

/** The brief the Reviewer reads on the approval issue. It answers with `record-review`, which also hands the issue on. */
export function ledgerReviewerBrief(route: ApproverRoute, input: { kind: db.ReviewKind; subjectId: string; what: string }): string {
  const info = REVIEW_KINDS[input.kind];
  const handTo = route.approverUserId ? `the approver (user \`${route.approverUserId}\`)` : "a board member (unassign yourself so the board sees it)";
  return [
    "",
    "## Reviewer: check before the owner approves",
    `You are reviewing: ${input.what}. Nothing posts or locks until a person approves it, and your verdict is recorded and shown to them.`,
    "Check:",
    ...CHECKS[input.kind].map((c) => `- ${c}`),
    "",
    `Then record your verdict with \`partnersinbiz.accounting:record-review\`: kind \`${info.tool}\`, id \`${input.subjectId}\`, verdict \`pass\` or \`changes_needed\`, and findings (one line per problem). A pass hands this issue to ${handTo}; changes_needed sends it back to the Bookkeeper and withdraws this request. Do not approve, mark it done or post anything yourself.`,
    `If you cannot call that tool, comment **PASS** or **CHANGES NEEDED** with one line per problem and reassign this issue to ${handTo}; the approver then sees that no pass was recorded.`,
  ].join("\n");
}

export interface LedgerApprovalInput {
  companyId: string;
  kind: db.ReviewKind;
  subjectId: string;
  title: string;
  description: string;
  originId: string;
  priority?: "low" | "medium" | "high" | "critical";
  actor: Actor;
}

export interface LedgerApproval {
  id: string;
  assignedTo: "reviewer" | "person" | "operator" | "nobody";
  review: db.ReviewState;
  route: ApproverRoute;
}

/**
 * Opens the approval issue for a person, through the Reviewer first when there is one, and records the review state.
 * Never leaves the issue unassigned silently: the kit's chain (Reviewer, owner, host default owner, the person who
 * asked, the last owner seen, the Operator) ends with an issue that says why nobody was found.
 */
export async function openLedgerApproval(ctx: PluginContext, input: LedgerApprovalInput): Promise<LedgerApproval> {
  const settings = await readSettings(ctx, input.companyId);
  const approval = await openApprovalIssue(ctx, {
    companyId: input.companyId,
    title: input.title,
    description: input.description,
    originKind: ORIGIN,
    originId: input.originId,
    ...(input.priority ? { priority: input.priority } : {}),
    // The kit's `outward` flag is its switch for "the Reviewer checks this first, when the company reviews work and a usable Reviewer exists".
    // Nothing leaves the company here, but nothing posts or locks unreviewed either, so the ledger asks for it unless its own setting is off.
    outward: settings.reviewLedger,
    actorUserId: input.actor.kind === "user" ? input.actor.userId : null,
    reviewerBrief: (route) => ledgerReviewerBrief(route, { kind: input.kind, subjectId: input.subjectId, what: `the ${REVIEW_KINDS[input.kind].label} on this issue` }),
  });
  const review: db.ReviewState = approval.assignedTo === "reviewer" ? "pending" : "not_required";
  await db.startReview(ctx.db, { companyId: input.companyId, kind: input.kind, subjectId: input.subjectId, issueId: approval.id, state: review, preparedBy: actorRecord(input.actor) });
  return { id: approval.id, assignedTo: approval.assignedTo, review, route: approval.route };
}

// ---------------------------------------------------------------------------
// What the page shows
// ---------------------------------------------------------------------------

export interface ReviewView {
  state: db.ReviewState;
  /** The approver may approve from the page without ticking "approve without the Reviewer". */
  canApprove: boolean;
  findings: string | null;
  reviewedAt: string | null;
  waivedBy: string | null;
}

export function reviewView(row: db.ReviewRow | null | undefined): ReviewView | null {
  if (!row) return null;
  return { state: row.state, canApprove: row.state !== "pending" && row.state !== "changes_needed", findings: row.findings, reviewedAt: row.reviewedAt, waivedBy: row.waivedBy };
}

/** `{ id → review }` for the page lists (drafts, reconciliations, VAT returns). */
export async function reviewViews(ctx: PluginContext, companyId: string, kind: db.ReviewKind, ids: string[]): Promise<Record<string, ReviewView>> {
  const rows = await db.reviewsFor(ctx.db, companyId, kind, ids);
  const out: Record<string, ReviewView> = {};
  for (const [id, row] of rows) {
    const view = reviewView(row);
    if (view) out[id] = view;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gating the approval
// ---------------------------------------------------------------------------

export interface GateResult {
  /** The approval goes ahead without a recorded Reviewer pass (flagged once `confirm` runs). */
  waived: boolean;
  /**
   * Call after the approval has really taken effect (the journal posted, the period locked). Only then is the review
   * marked `waived` and the flag comment posted: an approval that fails (a locked period, numbers that moved) must not
   * leave a record saying it was approved. Never throws.
   */
  confirm: () => Promise<void>;
}

const NOTHING_TO_CONFIRM: GateResult = { waived: false, confirm: async () => undefined };

/**
 * Called before a person's approval takes effect.
 * - No review row, `not_required`, `passed` or `waived`: go ahead.
 * - `pending` or `changes_needed`, approving from the page: refused unless the person ticked "approve without the Reviewer"
 *   (`override`), which is recorded (by `confirm`, once the approval worked).
 * - The same, approving by marking the issue done: goes ahead and is flagged (the click already happened; the owner is the final approver).
 */
export async function reviewGate(
  ctx: PluginContext,
  companyId: string,
  kind: db.ReviewKind,
  subjectId: string,
  options: { via: "page" | "issue"; userId: string; override?: boolean },
): Promise<GateResult> {
  const row = await db.getReview(ctx.db, companyId, kind, subjectId);
  if (!row || (row.state !== "pending" && row.state !== "changes_needed")) return NOTHING_TO_CONFIRM;
  if (options.via === "page" && !options.override) {
    throw new AccountingError(
      row.state === "changes_needed"
        ? `The Reviewer sent this ${REVIEW_KINDS[kind].label} back for changes${row.findings ? ` (${row.findings.slice(0, 200)})` : ""}. Wait for the corrected version, or tick "Approve without the Reviewer" to approve it as it is.`
        : `The Reviewer has not passed this ${REVIEW_KINDS[kind].label} yet. Wait for its pass, or tick "Approve without the Reviewer" to approve it now.`,
      "review_pending",
    );
  }
  return {
    waived: true,
    confirm: async () => {
      try {
        // From pending/changes_needed only: when the Reviewer passed in the meantime there is nothing to flag.
        const moved = await db.setReview(ctx.db, companyId, kind, subjectId, ["pending", "changes_needed"], { state: "waived", waivedBy: options.userId });
        if (moved && row.issueId) {
          await commentOn(
            ctx,
            companyId,
            row.issueId,
            `Approved without a recorded Reviewer pass (${row.state === "changes_needed" ? "the Reviewer had asked for changes" : "the Reviewer had not answered"}) by user ${options.userId}${options.via === "issue" ? " by marking this issue done" : ""}. Flagged for the month-end review.`,
          );
        }
      } catch (error) {
        ctx.logger.warn("Could not record that an approval went ahead without the Reviewer", { kind, subjectId, error: errorMessage(error) });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The Reviewer's verdict (tool)
// ---------------------------------------------------------------------------

interface SubjectInfo {
  issueId: string | null;
  status: string;
  title: string;
}

async function subjectOf(ctx: PluginContext, companyId: string, kind: db.ReviewKind, id: string): Promise<SubjectInfo> {
  if (kind === "draft") {
    const draft = await db.getDraft(ctx.db, companyId, id);
    if (!draft) throw new AccountingError("Journal draft not found", "not_found");
    return { issueId: draft.approvalIssueId, status: draft.status, title: draft.memo || "manual journal" };
  }
  if (kind === "reconciliation") {
    const rec = await db.getReconciliation(ctx.db, companyId, id);
    if (!rec) throw new AccountingError("Reconciliation not found", "not_found");
    return { issueId: rec.approvalIssueId, status: rec.status, title: `reconciliation ${rec.periodStart} to ${rec.periodEnd}` };
  }
  const ret = await db.getVatReturn(ctx.db, companyId, id);
  if (!ret) throw new AccountingError("VAT return not found", "not_found");
  return { issueId: ret.approvalIssueId, status: ret.status, title: `VAT201 ${ret.periodStart} to ${ret.periodEnd}` };
}

/** Takes the request back from the approver: the subject returns to a state its preparer can fix and re-request. */
async function withdraw(ctx: PluginContext, companyId: string, kind: db.ReviewKind, id: string, findings: string): Promise<void> {
  if (kind === "draft") {
    // A draft has no agent edit tool: the Bookkeeper makes a corrected one with create-manual-journal.
    await db.setDraftStatus(ctx.db, companyId, id, ["pending_approval"], { status: "cancelled", error: `Reviewer: ${findings}`.slice(0, 500) });
  } else if (kind === "reconciliation") {
    await db.setReconciliationStatus(ctx.db, companyId, id, "pending_approval", { status: "draft" });
  } else {
    await db.setVatStatus(ctx.db, companyId, id, "pending_approval", { status: "draft" });
  }
}

const NEXT_AFTER_CHANGES: Record<db.ReviewKind, string> = {
  draft: "Make a corrected journal with `create-manual-journal` (this one is cancelled), then close this issue.",
  reconciliation: "Fix what is listed (re-categorise lines), then run `prepare-reconciliation` again. It opens a fresh approval for the Reviewer and cancels this issue itself: do not close this one.",
  vat: "Fix what is listed, then run `prepare-vat201` again. It opens a fresh approval for the Reviewer and cancels this issue itself: do not close this one.",
};

export interface RecordReviewInput {
  kind: unknown;
  id: unknown;
  verdict: unknown;
  findings?: unknown;
}

/**
 * `record-review`: the Reviewer's verdict on a ledger approval. Only an agent
 * that is not the preparer and either holds the approval issue or is the
 * company's Reviewer may record it. A pass hands the issue to the approver; changes
 * needed withdraws the request and hands the issue back to the Bookkeeper.
 */
export async function recordReview(ctx: PluginContext, companyId: string, actor: Actor, input: RecordReviewInput) {
  if (actor.kind !== "agent") throw new AccountingError("Only the Reviewer agent records a review. A person approves on the Accounting page or by marking the issue done.", "forbidden");
  const kind = reviewKindFromTool(input.kind);
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!id) throw new AccountingError("id is required (the draft, reconciliation or VAT return id from the issue)");
  const verdict = input.verdict === "pass" || input.verdict === "changes_needed" ? input.verdict : null;
  if (!verdict) throw new AccountingError("verdict is pass or changes_needed");
  const findings = typeof input.findings === "string" ? input.findings.trim().slice(0, 1500) : "";
  if (verdict === "changes_needed" && findings.length < 5) throw new AccountingError("Say what has to change (findings, one line per problem)");

  const subject = await subjectOf(ctx, companyId, kind, id);
  if (subject.status !== "pending_approval") throw new AccountingError(`This ${REVIEW_KINDS[kind].label} is ${subject.status.replace(/_/g, " ")}, so there is nothing to review.`, "conflict");
  const row = await db.getReview(ctx.db, companyId, kind, id);
  if (row?.preparedBy?.kind === "agent" && row.preparedBy.agentId === actor.agentId) {
    throw new AccountingError("You prepared this yourself, so you cannot review it. The Reviewer does.", "forbidden");
  }
  const issue = subject.issueId ? await ctx.issues.get(subject.issueId, companyId).catch(() => null) : null;
  const holdsIssue = Boolean(issue && issue.assigneeAgentId === actor.agentId);
  const isReviewer = (await teamAgentId(ctx, companyId, "reviewer").catch(() => null)) === actor.agentId;
  if (!holdsIssue && !isReviewer) throw new AccountingError("Only the Reviewer (or the agent this approval is assigned to) can record its review.", "forbidden");
  if (row?.state === "waived") throw new AccountingError("A person already approved this without the review.", "conflict");

  const reviewer = { agentId: actor.agentId, runId: actor.runId };
  const moved = await db.setReview(ctx.db, companyId, kind, id, ["not_required", "pending", "changes_needed", "passed"], { state: verdict === "pass" ? "passed" : "changes_needed", reviewer, findings: findings || null });
  if (!moved) {
    // No row (an approval opened before 0.4): start one so the verdict is kept.
    await db.startReview(ctx.db, { companyId, kind, subjectId: id, issueId: subject.issueId, state: verdict === "pass" ? "passed" : "changes_needed", preparedBy: null });
    await db.setReview(ctx.db, companyId, kind, id, ["passed", "changes_needed"], { state: verdict === "pass" ? "passed" : "changes_needed", reviewer, findings: findings || null });
  }

  if (verdict === "pass") {
    const route = await resolveApprover(ctx, companyId, { outward: false });
    if (subject.issueId) {
      await commentOn(ctx, companyId, subject.issueId, `**Reviewer pass.** ${findings || "No problems found."}\n\nThe approver can now mark this issue done (or approve on the Accounting page).`);
      await handTo(ctx, companyId, subject.issueId, route.approverUserId ? { assigneeUserId: route.approverUserId } : route.escalationAgentId ? { assigneeAgentId: route.escalationAgentId } : null);
    }
    return { kind: REVIEW_KINDS[kind].tool, id, verdict, state: "passed" as const, next: "Recorded. The issue is with the approver. Nothing more to do." };
  }

  await withdraw(ctx, companyId, kind, id, findings);
  if (subject.issueId) {
    const back = await routeWork(ctx, companyId, ["bookkeeper"]).catch(() => null);
    await commentOn(ctx, companyId, subject.issueId, `**Reviewer: changes needed.**\n${findings}\n\n${NEXT_AFTER_CHANGES[kind]}`);
    await handTo(ctx, companyId, subject.issueId, back?.assigneeAgentId ? { assigneeAgentId: back.assigneeAgentId } : back?.assigneeUserId ? { assigneeUserId: back.assigneeUserId } : null, true);
  }
  return { kind: REVIEW_KINDS[kind].tool, id, verdict, state: "changes_needed" as const, next: "Recorded. The request is withdrawn and the issue is back with the Bookkeeper." };
}

/** Reassigns the approval issue (agent or person), reopens it for them and wakes an agent. Never throws. */
async function handTo(ctx: PluginContext, companyId: string, issueId: string, to: { assigneeAgentId?: string; assigneeUserId?: string } | null, wake = false): Promise<void> {
  if (!to) return;
  try {
    await ctx.issues.update(issueId, { status: "todo", assigneeAgentId: to.assigneeAgentId ?? null, assigneeUserId: to.assigneeUserId ?? null }, companyId);
    if (wake && to.assigneeAgentId) await wakeIssue(ctx, issueId, companyId, "The Reviewer asked for changes");
  } catch (error) {
    ctx.logger.info("Could not hand the approval issue on after the review", { issueId, error: errorMessage(error) });
  }
}

/** A re-request replaces an older approval issue of the same subject (after a send-back): close the old one. */
export async function retireOldApprovalIssue(ctx: PluginContext, companyId: string, previousIssueId: string | null, newIssueId: string): Promise<void> {
  if (!previousIssueId || previousIssueId === newIssueId) return;
  await closeIssue(ctx, companyId, previousIssueId, "cancelled", "Replaced by a new approval request.");
}

/** Approvals still waiting on the Reviewer longer than `hours`, for the Cockpit. */
export async function stalledReviews(ctx: PluginContext, companyId: string, hours = 24, now = Date.now()): Promise<db.ReviewRow[]> {
  return (await db.openReviews(ctx.db, companyId)).filter((row) => row.state === "pending" && row.requestedAt && now - Date.parse(row.requestedAt) > hours * 3_600_000);
}
