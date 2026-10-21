/**
 * Google Drive export helper for SEO previews and audit snapshots.
 * Wraps driveSave from pib-plugin-kit with error handling and name generation.
 * Never throws; Drive failures only log warnings.
 */
import { driveSave, type DriveSaveResult } from "@partnersinbiz/pib-plugin-kit";
import type { PluginContext } from "@paperclipai/plugin-sdk";

const NAME_PATTERN = /^(\d{4}-\d{2}-\d{2}\s+.+\s+v\d+\.\w+|[A-Z]+-\d+-\d+\.\w+)$/;

export interface ExportDriveFileOptions {
  companyId: string;
  kind: "seo";
  name: string;
  mimeType: string;
  bytes?: Uint8Array | Buffer;
  publicUrl?: string;
  subfolder: "03 Deliverables" | "04 Reports";
  requestId?: string;
  timeoutMs?: number;
}

/** Safe Drive export: never throws, only logs warnings on failure. */
export async function exportToDrive(ctx: Pick<PluginContext, "logger" | "events">, opts: ExportDriveFileOptions): Promise<DriveSaveResult> {
  try {
    // Validate name pattern
    if (!NAME_PATTERN.test(opts.name)) {
      ctx.logger.warn("Invalid Drive export name", { name: opts.name, pattern: "YYYY-MM-DD <what> v<n>.<ext>" });
      return { status: "failed", requestId: opts.requestId ?? "unknown", reason: "invalid_name" };
    }

    // Validate date part if present
    const dateMatch = opts.name.match(/^(\d{4})-(\d{2})-(\d{2})\s/);
    if (dateMatch) {
      const [, yStr, mStr, dStr] = dateMatch;
      const y = parseInt(yStr, 10), m = parseInt(mStr, 10), d = parseInt(dStr, 10);
      const testDate = new Date(Date.UTC(y, m - 1, d));
      if (testDate.getUTCFullYear() !== y || testDate.getUTCMonth() + 1 !== m || testDate.getUTCDate() !== d) {
        ctx.logger.warn("Invalid Drive export date", { date: `${yStr}-${mStr}-${dStr}` });
        return { status: "failed", requestId: opts.requestId ?? "unknown", reason: "invalid_name" };
      }
    }

    // Call driveSave with subfolder and other options
    const result = await driveSave(ctx, {
      companyId: opts.companyId,
      kind: opts.kind,
      name: opts.name,
      mimeType: opts.mimeType,
      subfolder: opts.subfolder,
      ...(opts.bytes !== undefined ? { bytes: opts.bytes } : { publicUrl: opts.publicUrl ?? "" }),
      requestId: opts.requestId,
      timeoutMs: opts.timeoutMs ?? 10_000,
    });

    // Log results
    if (result.status === "saved") {
      ctx.logger.info("Drive export saved", { subfolder: opts.subfolder, name: opts.name, driveFileId: result.driveFileId });
    } else if (result.status === "failed") {
      ctx.logger.warn("Drive export failed", { subfolder: opts.subfolder, name: opts.name, reason: result.reason, hint: result.hint });
    } else {
      ctx.logger.warn("Drive export no ack", { subfolder: opts.subfolder, name: opts.name });
    }

    return result;
  } catch (error) {
    ctx.logger.warn("Drive export error", { error: error instanceof Error ? error.message : String(error) });
    return { status: "failed", requestId: opts.requestId ?? "unknown", reason: "error" };
  }
}
