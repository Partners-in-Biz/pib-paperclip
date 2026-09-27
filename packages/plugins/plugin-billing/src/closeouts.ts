/**
 * Decisions that are not needed any more. When an invoice becomes paid (by
 * any path), open "Record payment…" and "Approve payment reminder…" issues
 * for it are withdrawn, so a person never records the same money twice or
 * chases a customer who has paid.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { table } from "./db.js";

export async function withdrawPaidDecisions(ctx: PluginContext, companyId: string, invoiceId: string, number: string): Promise<number> {
  const rows = await ctx.db.query<{ issue_id: string }>(
    `SELECT issue_id FROM ${table(ctx, "decision_issues")} WHERE company_id = $1 AND subject_id = $2 AND kind IN ('payment', 'reminder') AND status = 'open'`,
    [companyId, invoiceId],
  );
  let withdrawn = 0;
  for (const row of rows) {
    const res = await ctx.db.execute(
      `UPDATE ${table(ctx, "decision_issues")} SET status = 'dismissed', resolved_at = now() WHERE issue_id = $1 AND status = 'open'`,
      [row.issue_id],
    );
    if ((res.rowCount ?? 0) === 0) continue;
    withdrawn += 1;
    try {
      await ctx.issues.createComment(row.issue_id, `Not needed any more: invoice ${number} is paid. Nothing was recorded or sent from this issue.`, companyId);
      await ctx.issues.update(row.issue_id, { status: "cancelled" }, companyId);
    } catch (error) {
      ctx.logger.info("Could not withdraw a Billing decision", { issueId: row.issue_id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return withdrawn;
}
