/**
 * Save sent client reports to Drive. "04 Reports" is the old numbered name the producers still send; the CRM translates it to the
 * drive's own "Deliverables" folder (LEGACY_SUBFOLDER_ALIASES). The kit's `subfolder` type lists only the numbered names until the producers migrate.
 * The CRM handles the upload via driveSave and replies with drive.file.saved or drive.file.failed.
 * Failures never delay or fail the send: fire-and-forget pattern.
 */
import { driveSave, type DriveSaveResult } from "@partnersinbiz/pib-plugin-kit";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ClientKey, ReportRecord } from "./care-store.js";

export const REPORTS_SUBFOLDER = "04 Reports";

/**
 * Build the report filename: "YYYY-MM-DD Client Name v01.html"
 * Matches pattern: /^\d{4}-\d{2}-\d{2}\s+.+\s+v\d+\.\w+$/
 */
export function reportFileName(clientName: string, period: string, seq: number): string {
  // period is YYYY-MM, take the first 10 chars to get YYYY-MM-DD (use first of month)
  const date = `${period}-01`;
  const sanitized = clientName.replace(/[^A-Za-z0-9\s-]/g, "").trim();
  const seqPadded = String(seq).padStart(2, "0");
  return `${date} ${sanitized} v${seqPadded}.html`;
}

/**
 * Save the sent report HTML to Drive as a fire-and-forget operation.
 * Never throws or rejects; logs warnings on failure.
 */
export async function saveReportCopy(
  ctx: PluginContext,
  args: {
    companyId: string;
    clientName: string;
    period: string;
    seq: number;
    html: string;
    client: ClientKey;
  },
): Promise<DriveSaveResult | null> {
  try {
    const { companyId, clientName, period, seq, html, client } = args;
    const name = reportFileName(clientName, period, seq);
    const bytes = new TextEncoder().encode(html);

    const result = await driveSave(ctx, {
      companyId,
      kind: "client",
      name,
      mimeType: "text/html",
      bytes,
      subfolder: REPORTS_SUBFOLDER,
      client: { kind: client.kind, ref: client.id },
    });

    // Log warnings only on failure; do not log HTML content
    if (result.status === "failed" || result.status === "no_ack") {
      ctx.logger.warn("crm: could not save the report to Drive", {
        companyId,
        period,
        status: result.status,
        reason: result.status === "failed" ? result.reason : undefined,
      });
    }

    return result;
  } catch (error) {
    // Never throw: wrap errors and log them
    ctx.logger.warn("crm: could not save the report to Drive", {
      companyId: args.companyId,
      period: args.period,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
