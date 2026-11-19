/**
 * Save campaign send records to company Drive.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DRIVE_ACK_TIMEOUT_MS, driveSave, type DriveSaveOptions, type DriveSaveResult } from "@partnersinbiz/pib-plugin-kit";
import { getCampaign } from "./db.js";

export interface SaveSendRecordOptions {
  companyId: string;
  campaignId: string;
  enrollmentId: string;
  stepPosition: number;
  variant: string;
  subject: string;
  messageId: string | null;
  threadId: string | null;
  sentAt: Date;
  campaignName?: string | null;
  driveSave?: (ctx: Pick<PluginContext, "events">, opts: DriveSaveOptions) => Promise<DriveSaveResult>;
  /** Reads the campaign's client (default: the campaigns table). */
  loadCampaign?: (ctx: PluginContext, id: string) => Promise<{ clientKind: string | null; clientRef: string | null } | null>;
}

/**
 * Sanitize filename parts to match /^\d{4}-\d{2}-\d{2}\s+.+\s+v\d+\.\w+$/
 * No / \ or control chars.
 */
function sanitizePart(part: string): string {
  return part
    .replace(/[\/\\]/g, "-")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .slice(0, 200);
}

function shortId(enrollmentId: string): string {
  return enrollmentId.replace(/-/g, "").slice(0, 8);
}

export async function saveSendRecord(ctx: PluginContext, opts: SaveSendRecordOptions): Promise<void> {
  const drive = opts.driveSave || driveSave;
  const sentDate = opts.sentAt.toISOString().split("T")[0];
  const campaignLabel = sanitizePart(opts.campaignName || opts.campaignId);
  const enrollmentId = shortId(opts.enrollmentId);

  const record = {
    campaignId: opts.campaignId,
    enrollmentId: opts.enrollmentId,
    stepPosition: opts.stepPosition,
    variant: opts.variant,
    subject: opts.subject,
    messageId: opts.messageId,
    threadId: opts.threadId,
    sentAt: opts.sentAt.toISOString(),
  };

  try {
    const recordName = `${sentDate} ${campaignLabel} send ${enrollmentId} step ${opts.stepPosition} v1.json`;
    const recordBytes = Buffer.from(JSON.stringify(record), "utf-8");

    // Never mix clients (PAR-8128): a client campaign's record goes to that client's folder; our own campaign asks
    // for the own folder. When the campaign cannot be read we cannot tell whose it is, so no copy.
    let campaign: { clientKind: string | null; clientRef: string | null } | null = null;
    try {
      campaign = await (opts.loadCampaign ?? getCampaign)(ctx, opts.campaignId);
    } catch {
      campaign = null;
    }
    if (!campaign) {
      ctx.logger.warn("Campaign send record not copied to Drive: campaign not found", { campaignId: opts.campaignId });
      return;
    }
    const target = campaign.clientKind && campaign.clientRef ? { client: { kind: campaign.clientKind, ref: campaign.clientRef } } : { ownWork: true as const };

    const result = await drive(ctx, {
      companyId: opts.companyId,
      kind: "campaigns",
      name: recordName,
      mimeType: "application/json",
      bytes: recordBytes,
      subfolder: "03 Deliverables",
      timeoutMs: DRIVE_ACK_TIMEOUT_MS,
      ...target,
    });

    if (result.status === "failed") {
      ctx.logger.warn("Failed to save campaign send record to Drive", { status: result.status, reason: (result as any).reason });
    }
  } catch (error) {
    ctx.logger.warn("Error saving campaign send record to Drive", { error: error instanceof Error ? error.message : String(error) });
  }
}
