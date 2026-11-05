/**
 * Review: approve or reject an asset. Approving hands the file to Social through the `asset.approved` event
 * (Social subscribes as `plugin.<studio id>.asset.approved` and imports the file by URL into the client's library).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { StudioConfig } from "./config.js";
import { table } from "./db.js";
import { StudioError } from "./errors.js";
import { assetOut, getAssetRow, type AssetRow } from "./assets.js";
import { objectUrl } from "./storage.js";

export const ASSET_APPROVED_EVENT = "asset.approved";
/** Long enough for Social to download it after a queued delivery. */
export const APPROVED_URL_SECONDS = 3600;

export type ReviewDecision = "approved" | "rejected";

/** Which statuses each decision may move from. An approved asset is already in Social, so it can't be rejected here. */
const FROM: Record<ReviewDecision, string[]> = {
  approved: ["draft", "rejected"],
  rejected: ["draft"],
};

export interface ApprovedPayload {
  assetId: string;
  url: string;
  expiresAt: string;
  name: string;
  kind: string;
  mime: string;
  altText: string | null;
  client: { kind: string; id: string; name: string | null } | null;
  projectId: string | null;
  approvedBy: { userId: string | null; agentId: string | null };
}

export interface ReviewDeps {
  signUrl?: (row: AssetRow, companyId: string) => Promise<string>;
  now?: () => Date;
}

function decisionOf(value: unknown): ReviewDecision {
  if (value === "approved" || value === "approve") return "approved";
  if (value === "rejected" || value === "reject") return "rejected";
  throw new StudioError('decision must be "approved" or "rejected".', "bad_request");
}

function affected(result: unknown): number {
  const count = (result as { rowCount?: unknown } | null | undefined)?.rowCount;
  return typeof count === "number" ? count : 0;
}

/**
 * One guarded UPDATE decides the race: of two clicks (or a person and an agent) only one moves the status, and only
 * that one emits the event. If the emit fails, the status goes back, so a retry can approve and emit again.
 */
export async function reviewAsset(
  ctx: PluginContext,
  companyId: string,
  params: Record<string, unknown>,
  actor: { userId?: string | null; agentId?: string | null },
  deps: ReviewDeps = {},
) {
  const assetId = String(params.assetId ?? "").trim();
  if (!assetId) throw new StudioError("assetId is required.", "bad_request");
  const decision = decisionOf(params.decision);
  const before = await getAssetRow(ctx, companyId, assetId);
  if (before.status === decision) return { asset: assetOut(before), changed: false, exported: false };

  const from = FROM[decision];
  const result = await ctx.db.execute(
    `UPDATE ${table(ctx, "assets")} SET status = $3, updated_at = now() WHERE company_id = $1 AND id = $2 AND status = ANY($4::text[])`,
    [companyId, assetId, decision, from],
  );
  if (affected(result) !== 1) {
    const now = await getAssetRow(ctx, companyId, assetId);
    if (now.status === decision) return { asset: assetOut(now), changed: false, exported: false };
    throw new StudioError(`This asset is ${now.status}; it can't be ${decision} from there.`, "bad_transition");
  }

  const row = { ...before, status: decision };
  if (decision === "rejected") return { asset: assetOut(row), changed: true, exported: false };

  try {
    const signUrl = deps.signUrl ?? (async (r: AssetRow, id: string) => objectUrl(await new StudioConfig(ctx, id).bucket(), id, "GET", r.r2_key, APPROVED_URL_SECONDS));
    const url = await signUrl(row, companyId);
    const now = deps.now?.() ?? new Date();
    const payload: ApprovedPayload = {
      assetId,
      url,
      expiresAt: new Date(now.getTime() + APPROVED_URL_SECONDS * 1000).toISOString(),
      name: row.name,
      kind: row.kind,
      mime: row.mime,
      altText: row.alt_text,
      client: row.client_ref && row.client_kind ? { kind: row.client_kind, id: row.client_ref, name: row.client_name } : null,
      projectId: row.project_id,
      approvedBy: { userId: actor.userId ?? null, agentId: actor.agentId ?? null },
    };
    await ctx.events.emit(ASSET_APPROVED_EVENT, companyId, payload);
  } catch (error) {
    await ctx.db.execute(
      `UPDATE ${table(ctx, "assets")} SET status = $3, updated_at = now() WHERE company_id = $1 AND id = $2 AND status = 'approved'`,
      [companyId, assetId, before.status],
    );
    throw new StudioError(`Approval was undone because the hand-off to Social failed: ${error instanceof Error ? error.message : String(error)}`, "export_failed");
  }
  return { asset: assetOut(row), changed: true, exported: true };
}
