/**
 * Save sent invoice and quote PDFs to Drive in the "03 Deliverables" subfolder.
 * The CRM handles the upload and replies with drive.file.saved or drive.file.failed.
 * Failures never delay or fail the send: fire-and-forget pattern.
 */
import { driveSave, type DriveSaveResult } from "@partnersinbiz/pib-plugin-kit";
import type { PluginContext } from "@paperclipai/plugin-sdk";

export const DELIVERABLES_SUBFOLDER = "03 Deliverables";

/**
 * Build the sent copy filename: "YYYY-MM-DD Invoice INV-0042 v01.pdf"
 * Matches pattern: /^\d{4}-\d{2}-\d{2}\s+.+\s+v\d+\.\w+$/
 */
export function sentCopyName(kind: "invoice" | "quote", number: string, on: Date, seq: number): string {
  const date = on.toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const docType = kind === "invoice" ? "Invoice" : "Quote";
  const sanitized = number.replace(/[^A-Za-z0-9-]/g, "");
  const seqPadded = String(seq).padStart(2, "0");
  return `${date} ${docType} ${sanitized} v${seqPadded}.pdf`;
}

/**
 * Save the sent PDF to Drive as a fire-and-forget operation.
 * Never throws or rejects; logs warnings on failure.
 */
export async function saveSentCopy(
  ctx: PluginContext,
  args: {
    companyId: string;
    kind: "invoice" | "quote";
    number: string;
    seq: number;
    bytes: Uint8Array;
    customerKind: string;
    customerRef: string;
    now?: Date;
  },
): Promise<DriveSaveResult | null> {
  try {
    const { companyId, kind, number, seq, bytes, customerKind, customerRef, now } = args;
    const name = sentCopyName(kind, number, now ?? new Date(), seq);

    const result = await driveSave(ctx, {
      companyId,
      kind: "client",
      name,
      mimeType: "application/pdf",
      bytes,
      subfolder: DELIVERABLES_SUBFOLDER,
      client: { kind: customerKind, ref: customerRef },
    });

    // Log warnings only on failure; do not log bytes/base64/URLs
    if (result.status === "failed" || result.status === "no_ack") {
      ctx.logger.warn("billing: could not save the sent PDF to Drive", {
        companyId,
        kind,
        status: result.status,
        reason: result.status === "failed" ? result.reason : undefined,
      });
    }

    return result;
  } catch (error) {
    // Never throw: wrap errors and log them
    ctx.logger.warn("billing: could not save the sent PDF to Drive", {
      companyId: args.companyId,
      kind: args.kind,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
