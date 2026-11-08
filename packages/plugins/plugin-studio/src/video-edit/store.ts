/**
 * Video edits: a timeline document (timeline.ts) saved per company with an optional client and project, plus named
 * versions of it. Saving is an optimistic lock on `revision`, like canvases (canvas.ts `saveCanvas`): a save made from
 * an older revision (a second tab, an agent) is refused with `edit_conflict`, never merged or overwritten.
 * Every clip's asset must be in the edit's own company and client. Restoring a version comes in Phase B.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sameClient, scopeOfRow, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { iso, num, table } from "../db.js";
import { StudioError } from "../errors.js";
import { clientFilter } from "../page.js";
import { scopeForWork, scopeInput } from "../scope.js";
import { editDuration, normalizeEdit, type EditDoc } from "./timeline.js";

export const MAX_EDIT_TITLE = 200;
export const MAX_EDIT_VERSIONS = 100;

export interface EditActor {
  userId?: string | null;
  agentId?: string | null;
}

interface EditRow {
  id: string;
  company_id: string;
  client_kind: string | null;
  client_ref: string | null;
  client_name: string | null;
  project_id: string | null;
  title: string;
  doc: unknown;
  revision: number | string;
  source_asset_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

interface VersionRow {
  id: string;
  name: string;
  revision: number | string;
  created_by_user_id: string | null;
  created_by_agent_id: string | null;
  created_at: unknown;
}

function bad(message: string): never {
  throw new StudioError(message, "bad_edit");
}

function text(value: unknown, what: string, max: number): string {
  const t = typeof value === "string" ? value.trim() : "";
  if (!t) bad(`Give the ${what} a name.`);
  if (t.length > max) bad(`A ${what} name is at most ${max} characters.`);
  return t;
}

function editId(value: unknown): string {
  return String(value ?? "").trim();
}

function parse(doc: unknown): unknown {
  return typeof doc === "string" ? JSON.parse(doc) : doc;
}

function summary(row: EditRow) {
  const doc = parse(row.doc) as Partial<EditDoc> | null;
  const tracks = Array.isArray(doc?.tracks) ? doc.tracks : [];
  return {
    id: row.id,
    title: row.title,
    client: row.client_ref ? { kind: row.client_kind, id: row.client_ref, name: row.client_name } : null,
    projectId: row.project_id,
    sourceAssetId: row.source_asset_id,
    revision: num(row.revision),
    size: doc?.project?.size ?? null,
    clips: tracks.reduce((n, t) => n + (Array.isArray(t?.clips) ? t.clips.length : 0), 0),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const versionView = (r: VersionRow) => ({
  id: r.id,
  name: r.name,
  revision: num(r.revision),
  createdByUserId: r.created_by_user_id,
  createdByAgentId: r.created_by_agent_id,
  createdAt: iso(r.created_at),
});

async function getRow(ctx: PluginContext, companyId: string, id: string): Promise<EditRow> {
  const rows = await ctx.db.query<EditRow>(`SELECT * FROM ${table(ctx, "video_edits")} WHERE id = $1 AND company_id = $2 AND archived_at IS NULL`, [id, companyId]);
  if (!rows[0]) throw new StudioError("That video edit was not found in this company.", "unknown_edit");
  return rows[0];
}

/** The asset ids a timeline uses (media and audio clips). */
export function editAssetIds(doc: EditDoc): string[] {
  const ids = new Set<string>();
  for (const track of doc.tracks) {
    for (const clip of track.clips as Array<{ assetId?: unknown }>) {
      if (typeof clip.assetId === "string" && clip.assetId) ids.add(clip.assetId);
    }
  }
  return [...ids];
}

/** Every asset must be in this company's library and belong to the edit's client (or be own work for own work). */
export async function assertAssets(ctx: PluginContext, companyId: string, scope: ClientScope, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const marks = ids.map((_, i) => `$${i + 2}`).join(", ");
  const rows = await ctx.db.query<{ id: string; client_kind: string | null; client_ref: string | null }>(
    `SELECT id, client_kind, client_ref FROM ${table(ctx, "assets")} WHERE company_id = $1 AND id IN (${marks})`,
    [companyId, ...ids],
  );
  const found = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    const row = found.get(id);
    if (!row) bad(`Asset ${id} is not in this company's Studio library.`);
    if (!sameClient(scopeOfRow(row), scope)) bad(`Asset ${id} belongs to another client than this video edit.`);
  }
}

export async function createVideoEdit(ctx: PluginContext, companyId: string, params: Record<string, unknown>, actor: EditActor) {
  const name = text(params.title, "video edit", MAX_EDIT_TITLE);
  const projectId = typeof params.projectId === "string" && params.projectId.trim() ? params.projectId.trim() : null;
  if (projectId) {
    const project = await ctx.projects.get(projectId, companyId).catch(() => null);
    if (!project) throw new StudioError(`Project ${projectId} was not found in this company.`, "unknown_project");
  }
  const where = await scopeForWork(ctx, companyId, scopeInput(params), projectId);
  const doc = normalizeEdit(params.doc === undefined ? { tracks: [] } : params.doc);
  const sourceAssetId = typeof params.sourceAssetId === "string" && params.sourceAssetId.trim() ? params.sourceAssetId.trim() : null;
  await assertAssets(ctx, companyId, where.scope, [...new Set([...editAssetIds(doc), ...(sourceAssetId ? [sourceAssetId] : [])])]);
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "video_edits")} (id, company_id, client_kind, client_ref, client_name, project_id, title, doc, source_asset_id, created_by_user_id, created_by_agent_id, updated_by_user_id, updated_by_agent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $10, $11)`,
    [id, companyId, where.scope?.kind ?? null, where.scope?.id ?? null, where.client?.name ?? null, projectId, name, JSON.stringify(doc), sourceAssetId, actor.userId ?? null, actor.agentId ?? null],
  );
  return getVideoEdit(ctx, companyId, id);
}

export async function listVideoEdits(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const values: unknown[] = [companyId];
  let where = "WHERE company_id = $1 AND archived_at IS NULL";
  const scope = clientFilter(params.client);
  if (scope) {
    values.push(scope.kind, scope.id);
    where += ` AND client_kind = $${values.length - 1} AND client_ref = $${values.length}`;
  } else if (scope === null) where += " AND client_ref IS NULL";
  if (typeof params.projectId === "string" && params.projectId.trim()) {
    values.push(params.projectId.trim());
    where += ` AND project_id = $${values.length}`;
  }
  values.push(Math.min(Math.max(typeof params.limit === "number" ? params.limit : 50, 1), 200));
  const rows = await ctx.db.query<EditRow>(`SELECT * FROM ${table(ctx, "video_edits")} ${where} ORDER BY updated_at DESC LIMIT $${values.length}`, values);
  return rows.map(summary);
}

export async function getVideoEdit(ctx: PluginContext, companyId: string, id: string) {
  const row = await getRow(ctx, companyId, editId(id));
  const doc = normalizeEdit(parse(row.doc));
  return { ...summary(row), duration: editDuration(doc), doc };
}

/** Saves the whole timeline, if nobody saved since `baseRevision`. Returns the new revision. */
export async function saveVideoEdit(ctx: PluginContext, companyId: string, params: Record<string, unknown>, actor: EditActor) {
  const id = editId(params.editId);
  const base = Number(params.baseRevision);
  if (!Number.isInteger(base) || base < 1) bad("baseRevision is required: the revision this save starts from.");
  const row = await getRow(ctx, companyId, id);
  const doc = normalizeEdit(params.doc);
  await assertAssets(ctx, companyId, scopeOfRow(row), editAssetIds(doc));
  const name = params.title === undefined ? row.title : text(params.title, "video edit", MAX_EDIT_TITLE);
  const out = await ctx.db.execute(
    `UPDATE ${table(ctx, "video_edits")} SET doc = $1::jsonb, title = $2, revision = revision + 1, updated_by_user_id = $3, updated_by_agent_id = $4, updated_at = now()
     WHERE id = $5 AND company_id = $6 AND revision = $7 AND archived_at IS NULL`,
    [JSON.stringify(doc), name, actor.userId ?? null, actor.agentId ?? null, id, companyId, base],
  );
  if (!out.rowCount) {
    const now = await getRow(ctx, companyId, id);
    throw new StudioError(`Someone saved this video edit since you opened it (now revision ${num(now.revision)}). Reload to see their changes.`, "edit_conflict");
  }
  return { id, revision: base + 1 };
}

export async function archiveVideoEdit(ctx: PluginContext, companyId: string, id: string) {
  const row = await getRow(ctx, companyId, editId(id));
  await ctx.db.execute(`UPDATE ${table(ctx, "video_edits")} SET archived_at = now(), updated_at = now() WHERE id = $1 AND company_id = $2`, [row.id, companyId]);
  return { id: row.id, archived: true };
}

/**
 * Deletes a video edit and its saved versions. With `client` (a client filter like the list takes), the edit must belong
 * to that client or own work. Refused while a render of the edit is queued, rendering or uploading. Rendered assets are
 * library files with their own lifecycle and stay; so do the render rows (history). The edit row goes in one statement
 * guarded against a render queued meanwhile.
 */
export async function deleteVideoEdit(ctx: PluginContext, companyId: string, id: string, clientParam?: unknown) {
  const row = await getRow(ctx, companyId, editId(id));
  const filter = clientFilter(clientParam);
  if (filter !== undefined && !sameClient(scopeOfRow(row), filter)) {
    throw new StudioError("That video edit belongs to another client.", "wrong_client");
  }
  const active = (status: string) => `EXISTS (SELECT 1 FROM ${table(ctx, "video_renders")} r WHERE r.company_id = $2 AND r.edit_id = $1 AND r.status IN (${status}))`;
  const busy = "'queued', 'rendering', 'uploading'";
  const refuse = () => new StudioError("This video edit has a render queued or running. Cancel it or wait for it to finish, then delete.", "render_active");
  const out = await ctx.db.execute(`DELETE FROM ${table(ctx, "video_edits")} WHERE id = $1 AND company_id = $2 AND NOT ${active(busy)}`, [row.id, companyId]);
  if (!out.rowCount) {
    const [still] = await ctx.db.query<{ id: string }>(`SELECT id FROM ${table(ctx, "video_edits")} WHERE id = $1 AND company_id = $2`, [row.id, companyId]);
    if (still) throw refuse();
    throw new StudioError("That video edit was not found in this company.", "unknown_edit");
  }
  await ctx.db.execute(`DELETE FROM ${table(ctx, "video_edit_versions")} WHERE edit_id = $1 AND company_id = $2`, [row.id, companyId]);
  return { id: row.id, deleted: true };
}

/** Snapshots the timeline as it is saved now (not the caller's unsaved edits). At most MAX_EDIT_VERSIONS per edit. */
export async function saveEditVersion(ctx: PluginContext, companyId: string, params: Record<string, unknown>, actor: EditActor) {
  const name = text(params.name, "version", MAX_EDIT_TITLE);
  const edit = await getVideoEdit(ctx, companyId, editId(params.editId));
  const [count] = await ctx.db.query<{ n: number | string }>(`SELECT count(*) AS n FROM ${table(ctx, "video_edit_versions")} WHERE company_id = $1 AND edit_id = $2`, [companyId, edit.id]);
  if (num(count?.n) >= MAX_EDIT_VERSIONS) bad(`A video edit keeps at most ${MAX_EDIT_VERSIONS} versions.`);
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "video_edit_versions")} (id, company_id, edit_id, name, doc, revision, created_by_user_id, created_by_agent_id) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
    [id, companyId, edit.id, name, JSON.stringify(edit.doc), edit.revision, actor.userId ?? null, actor.agentId ?? null],
  );
  return { id, name, revision: edit.revision };
}

export async function listEditVersions(ctx: PluginContext, companyId: string, id: string) {
  const edit = await getRow(ctx, companyId, editId(id));
  const rows = await ctx.db.query<VersionRow>(
    `SELECT id, name, revision, created_by_user_id, created_by_agent_id, created_at FROM ${table(ctx, "video_edit_versions")} WHERE company_id = $1 AND edit_id = $2 ORDER BY created_at DESC, id LIMIT ${MAX_EDIT_VERSIONS}`,
    [companyId, edit.id],
  );
  return rows.map(versionView);
}

/**
 * Restores a saved version: its timeline is saved as a NEW revision (history is never rewritten), only if nobody saved
 * since `baseRevision` (else `edit_conflict`). The timeline being replaced is first kept as a version named
 * "Before restore", unless the edit is already at MAX_EDIT_VERSIONS (then the restore still goes ahead).
 */
export async function restoreEditVersion(ctx: PluginContext, companyId: string, params: Record<string, unknown>, actor: EditActor) {
  const id = editId(params.editId);
  const base = Number(params.baseRevision);
  if (!Number.isInteger(base) || base < 1) bad("baseRevision is required: the revision this restore starts from.");
  const versionId = String(params.versionId ?? "").trim();
  const edit = await getVideoEdit(ctx, companyId, id);
  const [version] = await ctx.db.query<{ id: string; name: string; doc: unknown }>(
    `SELECT id, name, doc FROM ${table(ctx, "video_edit_versions")} WHERE id = $1 AND company_id = $2 AND edit_id = $3`,
    [versionId, companyId, edit.id],
  );
  if (!version) throw new StudioError("That version was not found for this video edit.", "unknown_version");
  if (edit.revision !== base) {
    throw new StudioError(`Someone saved this video edit since you opened it (now revision ${edit.revision}). Reload to see their changes.`, "edit_conflict");
  }
  const restored = normalizeEdit(parse(version.doc));
  const [count] = await ctx.db.query<{ n: number | string }>(`SELECT count(*) AS n FROM ${table(ctx, "video_edit_versions")} WHERE company_id = $1 AND edit_id = $2`, [companyId, id]);
  const keepCurrent = num(count?.n) < MAX_EDIT_VERSIONS;
  const saved = await saveVideoEdit(ctx, companyId, { editId: id, baseRevision: base, doc: restored }, actor);
  if (keepCurrent) {
    await ctx.db.execute(
      `INSERT INTO ${table(ctx, "video_edit_versions")} (id, company_id, edit_id, name, doc, revision, created_by_user_id, created_by_agent_id) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
      [randomUUID(), companyId, id, `Before restore (revision ${base})`, JSON.stringify(edit.doc), base, actor.userId ?? null, actor.agentId ?? null],
    );
  }
  return { id, revision: saved.revision, restoredVersionId: version.id, keptPrevious: keepCurrent };
}
