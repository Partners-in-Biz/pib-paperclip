/**
 * Save evidence screenshots to Drive in the "05 Evidence" subfolder.
 * Takes a base64-encoded PNG and saves it with a timestamp-based filename.
 * Failures never affect the step: fire-and-forget, logged as warnings.
 */
import { driveSave, type DriveSaveResult } from "@partnersinbiz/pib-plugin-kit";
import type { PluginContext } from "@paperclipai/plugin-sdk";

export const EVIDENCE_SUBFOLDER = "05 Evidence";

/**
 * Build the evidence filename: "ISSUE-step-timestamp.png"
 * Example: "PAR-123-login-20261021T101500Z.png"
 * Matches pattern: /^[A-Z]+-\d+-.+-\d{8}T\d{6}Z\.png$/
 */
export function evidenceFileName(issueId: string, step: string, timestamp: string): string {
  // Extract the issue prefix (e.g., "PAR" from "PAR-123")
  const issueMatch = issueId.match(/^([A-Z]+)-(\d+)/);
  if (!issueMatch) throw new Error("Invalid issue identifier");

  const [, prefix, number] = issueMatch;
  const sanitizedStep = step.replace(/[^a-z0-9-]/gi, "-").replace(/--+/g, "-").toLowerCase();
  return `${prefix}-${number}-${sanitizedStep}-${timestamp}.png`;
}

/**
 * Save an evidence screenshot to Drive as a fire-and-forget operation.
 * Never throws or rejects; logs warnings on failure.
 */
export async function saveEvidenceToDrive(
  ctx: PluginContext,
  args: {
    companyId: string;
    issueId: string;
    step: string;
    pngBase64: string;
  },
): Promise<DriveSaveResult | null> {
  try {
    const { companyId, issueId, step, pngBase64 } = args;

    // Validate PNG signature (89 50 4E 47 is the PNG magic bytes)
    if (!pngBase64.startsWith("iVBORw0KGgo")) {
      ctx.logger.warn("cockpit: invalid PNG signature for evidence", { companyId, issueId });
      return null;
    }

    // Decode base64 to bytes
    const bytes = Buffer.from(pngBase64, "base64");

    // Generate timestamp in ISO format: 20261021T101500Z
    const now = new Date();
    const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

    const name = evidenceFileName(issueId, step, timestamp);

    const result = await driveSave(ctx, {
      companyId,
      kind: "ops",
      name,
      mimeType: "image/png",
      bytes,
      subfolder: EVIDENCE_SUBFOLDER,
    });

    // Log warnings only on failure; do not log PNG content
    if (result.status === "failed" || result.status === "no_ack") {
      ctx.logger.warn("cockpit: could not save evidence to Drive", {
        companyId,
        issueId,
        step,
        status: result.status,
        reason: result.status === "failed" ? result.reason : undefined,
      });
    }

    return result;
  } catch (error) {
    // Never throw: wrap errors and log them
    ctx.logger.warn("cockpit: could not save evidence to Drive", {
      companyId: args.companyId,
      issueId: args.issueId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
