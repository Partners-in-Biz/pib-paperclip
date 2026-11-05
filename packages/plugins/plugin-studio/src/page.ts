/**
 * What the Studio page needs beyond the agent tools: the model list people may pick from, the asset library with
 * filters, one asset's provenance, and the progress of a person's own requests. None of it returns a link or a
 * storage key: signed links come only from the person-only actions in worker.ts.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { clientScopeFromInput, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { assetOut, getAssetRow, listAssets } from "./assets.js";
import { iso, num, table } from "./db.js";
import { StudioError } from "./errors.js";
import type { GenerationRow } from "./generation.js";

export interface PageModel {
  id: string;
  label: string;
  kind: "image" | "video";
  ratios: string[];
  resolutions: string[];
}

/**
 * Only models with a fixed price per output: the estimate is then the real cost. Per-second or per-token models
 * (Veo, Seedance and the like) stay out of the page; agents keep the full tool surface.
 */
export const PAGE_MODELS: readonly PageModel[] = [
  {
    id: "higgsfield-ai/soul/v2/standard",
    label: "Soul v2 (image)",
    kind: "image",
    ratios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"],
    resolutions: ["720p", "1080p"],
  },
];

/** Turns the page's form into the engine's request. Anything outside the offered models and values is refused. */
export function pageRequest(input: Record<string, unknown>): Record<string, unknown> {
  const model = PAGE_MODELS.find((m) => m.id === String(input.model ?? ""));
  if (!model) throw new StudioError("Pick one of the models the Studio page offers.", "bad_model");
  const ratio = String(input.ratio ?? model.ratios[0]);
  const resolution = String(input.resolution ?? model.resolutions[0]);
  if (!model.ratios.includes(ratio)) throw new StudioError(`${model.label} doesn't offer the ratio ${ratio}.`, "bad_request");
  if (!model.resolutions.includes(resolution)) throw new StudioError(`${model.label} doesn't offer ${resolution}.`, "bad_request");
  const out: Record<string, unknown> = {
    model: model.id,
    prompt: input.prompt,
    params: { aspect_ratio: ratio, resolution },
    batchSize: input.batchSize === undefined || input.batchSize === "" ? 1 : Number(input.batchSize),
  };
  if (typeof input.name === "string" && input.name.trim()) out.name = input.name;
  const client = typeof input.client === "string" ? input.client.trim() : "";
  if (client && client !== "own") out.client = client;
  return out;
}

/** The page's client filter: "" is everything, "own" is own work, else "company:<id>" or "contact:<id>". */
export function clientFilter(value: unknown): ClientScope | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return undefined;
  if (text === "own") return null;
  const scope = clientScopeFromInput({ client: text });
  if (!scope) throw new StudioError("That client filter is not one Studio knows.", "bad_client");
  return scope;
}

export const ASSET_STATUSES = ["draft", "approved", "rejected", "archived"] as const;

export async function pageAssets(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const kind = str(params.kind);
  if (kind && kind !== "image" && kind !== "video") throw new StudioError("kind is image or video.", "bad_request");
  return listAssets(ctx, companyId, {
    scope: clientFilter(params.client),
    projectId: str(params.projectId),
    kind,
    status: str(params.status),
    limit: typeof params.limit === "number" ? params.limit : 60,
  });
}

/** One asset with where it came from: prompt, model, cost, who made it, and what it's linked to. */
export async function assetDetail(ctx: PluginContext, companyId: string, assetId: string) {
  if (!assetId) throw new StudioError("assetId is required.", "bad_request");
  const row = await getAssetRow(ctx, companyId, assetId);
  const [made] = await ctx.db.query<{ created_by_agent_id: string | null; created_by_user_id: string | null; source_ref: string | null }>(
    `SELECT created_by_agent_id, created_by_user_id, source_ref FROM ${table(ctx, "assets")} WHERE company_id = $1 AND id = $2`,
    [companyId, assetId],
  );
  const links = await ctx.db.query<{ target_type: string; target_id: string }>(
    `SELECT target_type, target_id FROM ${table(ctx, "asset_links")} WHERE company_id = $1 AND asset_id = $2 ORDER BY created_at`,
    [companyId, assetId],
  );
  const gen = row.generation_id
    ? (await ctx.db.query<GenerationRow>(`SELECT * FROM ${table(ctx, "generations")} WHERE company_id = $1 AND id = $2`, [companyId, row.generation_id]))[0]
    : undefined;
  const issueId = gen?.issue_id ?? links.find((l) => l.target_type === "issue")?.target_id ?? null;
  const issue = issueId ? await ctx.issues.get(issueId, companyId).catch(() => null) : null;
  return {
    asset: assetOut(row),
    madeBy: { agentId: made?.created_by_agent_id ?? gen?.agent_id ?? null, userId: made?.created_by_user_id ?? gen?.user_id ?? null },
    generation: gen
      ? {
          id: gen.id,
          model: gen.model,
          prompt: gen.prompt,
          params: gen.params,
          estimatedCredits: num(gen.estimated_credits),
          actualCredits: gen.actual_credits == null ? null : num(gen.actual_credits),
          runId: (gen as GenerationRow & { run_id?: string | null }).run_id ?? null,
          createdAt: iso(gen.created_at),
          finishedAt: iso(gen.finished_at),
        }
      : null,
    issue: issue ? { id: String(issue.id), identifier: (issue as { identifier?: string | null }).identifier ?? null, title: (issue as { title?: string | null }).title ?? null } : null,
    links: links.map((l) => ({ targetType: l.target_type, targetId: l.target_id })),
  };
}

/** The progress of the batches a person asked for on the page, by group id. */
export async function pageGenerations(ctx: PluginContext, companyId: string, groupIds: unknown) {
  const ids = Array.isArray(groupIds) ? groupIds.filter((g): g is string => typeof g === "string" && g.length > 0).slice(0, 20) : [];
  if (ids.length === 0) return { generations: [] };
  const rows = await ctx.db.query<GenerationRow>(
    `SELECT * FROM ${table(ctx, "generations")} WHERE company_id = $1 AND group_id = ANY($2::text[]) ORDER BY created_at DESC`,
    [companyId, ids],
  );
  return {
    generations: rows.map((r) => ({
      id: r.id,
      groupId: r.group_id,
      status: r.status,
      model: r.model,
      name: r.name,
      assetId: r.asset_id,
      estimatedCredits: num(r.estimated_credits),
      error: r.error_message,
      createdAt: iso(r.created_at),
    })),
  };
}
