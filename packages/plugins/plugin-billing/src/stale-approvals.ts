/**
 * Stale approvals: an invoice, quote or bill still marked "waiting on a person" (`pending_action`) after
 * the approval issue was cancelled or deleted.
 *
 * What went wrong live (2026-11): a quote's send approval was cancelled by the owner, but the Billing page kept
 * listing "Approve sending quote ..." under Waiting on you. The flag only cleared when Billing heard the
 * `issue.updated` event; an event lost to a restart, a deploy or a host hiccup left it set for good.
 *
 * So the flag is no longer trusted on its own. Before the page loads, and again every hour, each open flag is
 * checked against its issue. A cancelled or missing issue is a refusal: the flag is cleared (through the same
 * handler a live cancel uses, so a refused invoice goes back to "Drafts to send"). An issue that is done
 * but never heard of is left alone: that is an approval, and sending is not guessed at here.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { table } from "./db.js";
import { onIssueUpdated } from "./inbound.js";
import { errorMessage } from "./util.js";

interface Pending {
  issue_id: string;
  kind: "invoice" | "quote" | "bill" | "decision";
}

export async function clearStaleApprovals(ctx: PluginContext, companyId: string): Promise<number> {
  let cleared = 0;

  // The document itself moved on while the flag stayed (a quote declined, an invoice sent by hand): nothing left to approve.
  for (const sql of [
    `UPDATE ${table(ctx, "invoices")} SET pending_action = NULL, updated_at = now() WHERE company_id = $1 AND pending_action = 'send' AND status <> 'draft'`,
    `UPDATE ${table(ctx, "quotes")} SET pending_action = NULL, updated_at = now() WHERE company_id = $1 AND pending_action = 'send' AND status NOT IN ('draft', 'sent')`,
    `UPDATE ${table(ctx, "bills")} SET pending_action = NULL, updated_at = now() WHERE company_id = $1 AND pending_action = 'approve' AND status <> 'draft'`,
  ]) {
    const res = await ctx.db.execute(sql, [companyId]).catch((error: unknown) => {
      ctx.logger.info("Stale approval check skipped", { companyId, error: errorMessage(error) });
      return null;
    });
    cleared += res?.rowCount ?? 0;
  }

  const open = await ctx.db.query<Pending>(
    `SELECT approval_issue_id AS issue_id, 'invoice' AS kind FROM ${table(ctx, "invoices")} WHERE company_id = $1 AND pending_action IS NOT NULL AND approval_issue_id IS NOT NULL
     UNION ALL
     SELECT approval_issue_id, 'quote' FROM ${table(ctx, "quotes")} WHERE company_id = $1 AND pending_action IS NOT NULL AND approval_issue_id IS NOT NULL
     UNION ALL
     SELECT approval_issue_id, 'bill' FROM ${table(ctx, "bills")} WHERE company_id = $1 AND pending_action IS NOT NULL AND approval_issue_id IS NOT NULL
     UNION ALL
     SELECT issue_id, 'decision' FROM ${table(ctx, "decision_issues")} WHERE company_id = $1 AND status = 'open'`,
    [companyId],
  );

  for (const row of open) {
    const issue = await ctx.issues.get(row.issue_id, companyId).catch((error: unknown) => {
      // A failed read says nothing about the issue: leave the flag.
      ctx.logger.info("Stale approval check skipped", { companyId, issueId: row.issue_id, error: errorMessage(error) });
      return undefined;
    });
    if (issue === undefined) continue;
    if (issue) {
      // Cancelled is a refusal: the live handler clears the flag (and dismisses a decision). Anything else is still open, or done.
      if (issue.status !== "cancelled") continue;
      await onIssueUpdated(ctx, issue.id, companyId, "user");
      cleared += 1;
      continue;
    }
    // The issue is gone.
    const id = row.issue_id;
    const sql = row.kind === "invoice"
      ? `UPDATE ${table(ctx, "invoices")} SET pending_action = NULL, updated_at = now() WHERE approval_issue_id = $1 AND company_id = $2 AND pending_action IS NOT NULL`
      : row.kind === "quote"
        ? `UPDATE ${table(ctx, "quotes")} SET pending_action = NULL, updated_at = now() WHERE approval_issue_id = $1 AND company_id = $2 AND pending_action IS NOT NULL`
        : row.kind === "bill"
          ? `UPDATE ${table(ctx, "bills")} SET pending_action = NULL, updated_at = now() WHERE approval_issue_id = $1 AND company_id = $2 AND pending_action IS NOT NULL`
          : `UPDATE ${table(ctx, "decision_issues")} SET status = 'dismissed', resolved_at = now() WHERE issue_id = $1 AND company_id = $2 AND status = 'open'`;
    const res = await ctx.db.execute(sql, [id, companyId]);
    cleared += res.rowCount ?? 0;
  }

  if (cleared > 0) ctx.logger.info("Cleared approvals that no longer wait on a person", { companyId, cleared });
  return cleared;
}
