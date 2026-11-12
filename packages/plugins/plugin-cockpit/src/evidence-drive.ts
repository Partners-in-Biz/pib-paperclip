/**
 * Save evidence screenshots to Drive in the "05 Evidence" subfolder.
 * Takes a base64-encoded PNG and saves it with a timestamp-based filename.
 * Failures never affect the step: fire-and-forget, logged as warnings.
 */
import { driveSave, type DriveSaveResult } from "@partnersinbiz/pib-plugin-kit";
import type { PluginContext } from "@paperclipai/plugin-sdk";

export const EVIDENCE_SUBFOLDER = "05 Evidence";

export const EVIDENCE_CLIENT_KINDS = ["company", "contact"] as const;
export type EvidenceClient = { kind: (typeof EVIDENCE_CLIENT_KINDS)[number]; ref: string };

/**
 * Check the optional `client` of evidence-save. Absent (undefined/null) = no
 * client (save under our own project). Anything else must be
 * `{kind: "company"|"contact", ref: non-empty string}`, else a clear error.
 */
export function parseEvidenceClient(raw: unknown): { client: EvidenceClient | null } | { error: string } {
  if (raw === undefined || raw === null) return { client: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "client must be an object {kind, ref}" };
  }
  const { kind, ref } = raw as { kind?: unknown; ref?: unknown };
  if (typeof kind !== "string" || !(EVIDENCE_CLIENT_KINDS as readonly string[]).includes(kind)) {
    return { error: `client.kind must be one of ${EVIDENCE_CLIENT_KINDS.join(", ")}` };
  }
  if (typeof ref !== "string" || !ref.trim()) {
    return { error: "client.ref is required and must be non-empty" };
  }
  return { client: { kind: kind as EvidenceClient["kind"], ref: ref.trim() } };
}

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
    client?: EvidenceClient | null;
    /**
     * The issue's Paperclip project (PAR-8128). When set it decides the folder: the CRM files the file there only
     * when the project is linked to a client or is the company's own Drive project, and refuses it otherwise.
     * The agent's `client` is then ignored. With neither a project nor a client the copy is skipped.
     */
    projectId?: string | null;
  },
): Promise<DriveSaveResult | null> {
  try {
    const { companyId, issueId, step, pngBase64 } = args;

    // Validate PNG signature (89 50 4E 47 is the PNG magic bytes)
    if (!pngBase64.startsWith("iVBORw0KGgo")) {
      ctx.logger.warn("cockpit: invalid PNG signature for evidence", { companyId, issueId });
      return null;
    }

    // Validate the optional client before anything is emitted
    const parsed = parseEvidenceClient(args.client);
    if ("error" in parsed) {
      ctx.logger.warn("cockpit: invalid client for evidence", { companyId, issueId, error: parsed.error });
      return null;
    }

    // Never guess the folder: no project and no client means we cannot tell whose work this is, so no copy.
    const projectId = typeof args.projectId === "string" && args.projectId.trim() ? args.projectId.trim() : null;
    if (!projectId && !parsed.client) {
      ctx.logger.warn("cockpit: evidence not copied to Drive (no project or client for the issue)", { companyId, issueId });
      return { status: "failed", requestId: "none", reason: "no_client", hint: "The issue has no project and no client was given, so the Drive copy was skipped." };
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
      timeoutMs: 20_000,
      bytes,
      subfolder: EVIDENCE_SUBFOLDER,
      ...(projectId ? { projectId } : { client: parsed.client! }),
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
