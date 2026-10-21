/**
 * Copy an executed ad creative's text into the client's Drive (`02 Assets`) through the CRM's save-request route.
 * Best effort: the creative already exists on the platform, so a Drive failure is logged and never fails the run.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { driveSave, type DriveSaveOptions, type DriveSaveResult } from "@partnersinbiz/pib-plugin-kit";

export type DriveSaveFn = (ctx: Pick<PluginContext, "events">, opts: DriveSaveOptions & { subfolder?: string }) => Promise<DriveSaveResult>;

export interface CreativeDriveCopy {
  companyId: string;
  /** The proposal id, which makes the file name unique per creative. */
  proposalId: string;
  name: string;
  platform: string;
  fields: Record<string, unknown>;
  savedAt?: Date;
  driveSave?: DriveSaveFn;
}

function cleanPart(part: string): string {
  return part.replace(/[\/\\]/g, "-").replace(/[\x00-\x1f\x7f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
}

export function creativeFileName(c: Pick<CreativeDriveCopy, "proposalId" | "name" | "platform" | "savedAt">): string {
  const day = (c.savedAt ?? new Date()).toISOString().slice(0, 10);
  return `${day} ${cleanPart(c.platform) || "ads"} ${cleanPart(c.name) || "creative"} ${c.proposalId.replace(/-/g, "").slice(0, 8)} v01.json`;
}

/** Never throws. Returns true only when Drive confirmed the save. */
export async function saveCreativeToDrive(ctx: PluginContext, c: CreativeDriveCopy): Promise<boolean> {
  try {
    const save = c.driveSave ?? driveSave;
    const result = await save(ctx, {
      companyId: c.companyId,
      kind: "ads",
      name: creativeFileName(c),
      mimeType: "application/json",
      bytes: Buffer.from(JSON.stringify({ name: c.name, platform: c.platform, ...c.fields }, null, 2), "utf-8"),
      subfolder: "02 Assets",
      timeoutMs: 10_000,
    });
    if (result.status !== "saved") {
      ctx.logger.warn("Could not copy the ad creative to Drive", { status: result.status, reason: "reason" in result ? result.reason : undefined });
      return false;
    }
    return true;
  } catch (error) {
    ctx.logger.warn("Error copying the ad creative to Drive", { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
