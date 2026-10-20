import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { table } from "../db.js";

export interface DriveFile {
  id: string;
  companyId: string;
  projectId: string | null;
  kind: string;
  folderId: string;
  name: string;
  sha256: string;
  driveFileId: string;
  webUrl: string;
  sourcePlugin: string | null;
  createdAt: string;
}

export interface ProjectDriveKind {
  companyId: string;
  projectId: string;
  kind: string;
  scopeRef: string | null;
  updatedBy: string | null;
  updatedAt: string;
}

interface DriveFileRow {
  id: string;
  company_id: string;
  project_id: string | null;
  kind: string;
  folder_id: string;
  name: string;
  sha256: string;
  drive_file_id: string;
  web_url: string;
  source_plugin: string | null;
  created_at: unknown;
}

interface KindRow {
  company_id: string;
  project_id: string;
  kind: string;
  scope_ref: string | null;
  updated_by: string | null;
  updated_at: unknown;
}

const FILE_COLS = "id, company_id, project_id, kind, folder_id, name, sha256, drive_file_id, web_url, source_plugin, created_at";

function asIso(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function mapFile(r: DriveFileRow): DriveFile {
  return {
    id: r.id,
    companyId: r.company_id,
    projectId: r.project_id,
    kind: r.kind,
    folderId: r.folder_id,
    name: r.name,
    sha256: r.sha256,
    driveFileId: r.drive_file_id,
    webUrl: r.web_url,
    sourcePlugin: r.source_plugin,
    createdAt: asIso(r.created_at),
  };
}

function mapKind(r: KindRow): ProjectDriveKind {
  return {
    companyId: r.company_id,
    projectId: r.project_id,
    kind: r.kind,
    scopeRef: r.scope_ref,
    updatedBy: r.updated_by,
    updatedAt: asIso(r.updated_at),
  };
}

async function getDriveFileByKey(ctx: PluginContext, companyId: string, folderId: string, name: string, sha256: string): Promise<DriveFileRow | null> {
  const rows = await ctx.db.query<DriveFileRow>(
    `SELECT ${FILE_COLS} FROM ${table(ctx, "drive_files")} WHERE company_id = $1 AND folder_id = $2 AND name = $3 AND sha256 = $4 LIMIT 1`,
    [companyId, folderId, name, sha256],
  );
  return rows[0] ?? null;
}

export async function upsertDriveFile(ctx: PluginContext, input: Omit<DriveFile, "id" | "createdAt">): Promise<{ file: DriveFile; created: boolean }> {
  if (!/^[a-f0-9]{64}$/i.test(input.sha256)) throw new Error("sha256 must be exactly 64 hexadecimal characters");
  if (!input.name || !input.folderId || !input.driveFileId || !input.webUrl) throw new Error("Required fields missing");
  const sha256 = input.sha256.toLowerCase(), id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "drive_files")} (id, company_id, project_id, kind, folder_id, name, sha256, drive_file_id, web_url, source_plugin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (company_id, folder_id, name, sha256) DO NOTHING`,
    [id, input.companyId, input.projectId ?? null, input.kind, input.folderId, input.name, sha256, input.driveFileId, input.webUrl, input.sourcePlugin ?? null],
  );
  const r = await getDriveFileByKey(ctx, input.companyId, input.folderId, input.name, sha256);
  if (!r) throw new Error("Failed to insert");
  return { file: mapFile(r), created: r.id === id };
}

export async function getDriveFile(ctx: PluginContext, companyId: string, id: string): Promise<DriveFile | null> {
  const rows = await ctx.db.query<DriveFileRow>(
    `SELECT ${FILE_COLS} FROM ${table(ctx, "drive_files")} WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, id],
  );
  return rows[0] ? mapFile(rows[0]) : null;
}

export async function findDriveFile(ctx: PluginContext, companyId: string, { folderId, name, sha256 }: { folderId: string; name: string; sha256: string }): Promise<DriveFile | null> {
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error("sha256 must be exactly 64 hexadecimal characters");
  const r = await getDriveFileByKey(ctx, companyId, folderId, name, sha256.toLowerCase());
  return r ? mapFile(r) : null;
}

export async function listDriveFiles(ctx: PluginContext, companyId: string, opts?: { projectId?: string; folderId?: string; limit?: number }): Promise<DriveFile[]> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));
  let sql = `SELECT ${FILE_COLS} FROM ${table(ctx, "drive_files")} WHERE company_id = $1`;
  const params: unknown[] = [companyId];
  if (opts?.projectId) {
    sql += ` AND project_id = $${params.length + 1}`;
    params.push(opts.projectId);
  }
  if (opts?.folderId) {
    sql += ` AND folder_id = $${params.length + 1}`;
    params.push(opts.folderId);
  }
  sql += ` ORDER BY created_at DESC, id LIMIT $${params.length + 1}`;
  params.push(limit);
  const rows = await ctx.db.query<DriveFileRow>(sql, params);
  return rows.map(mapFile);
}

export async function setProjectDriveKind(ctx: PluginContext, input: { companyId: string; projectId: string; kind: string; scopeRef?: string; updatedBy?: string }): Promise<ProjectDriveKind> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "project_drive_kind")} (company_id, project_id, kind, scope_ref, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, now()) ON CONFLICT (company_id, project_id) DO UPDATE SET kind = $3, scope_ref = $4, updated_by = $5, updated_at = now()`,
    [input.companyId, input.projectId, input.kind, input.scopeRef ?? null, input.updatedBy ?? null],
  );
  const rows = await ctx.db.query<KindRow>(
    `SELECT company_id, project_id, kind, scope_ref, updated_by, updated_at FROM ${table(ctx, "project_drive_kind")}
     WHERE company_id = $1 AND project_id = $2 LIMIT 1`,
    [input.companyId, input.projectId],
  );
  if (!rows[0]) throw new Error("Failed to set");
  return mapKind(rows[0]);
}

export async function getProjectDriveKind(ctx: PluginContext, companyId: string, projectId: string): Promise<ProjectDriveKind | null> {
  const rows = await ctx.db.query<KindRow>(
    `SELECT company_id, project_id, kind, scope_ref, updated_by, updated_at FROM ${table(ctx, "project_drive_kind")}
     WHERE company_id = $1 AND project_id = $2 LIMIT 1`,
    [companyId, projectId],
  );
  return rows[0] ? mapKind(rows[0]) : null;
}

export async function listProjectDriveKinds(ctx: PluginContext, companyId: string, projectIds?: string[]): Promise<ProjectDriveKind[]> {
  if (projectIds?.length === 0) projectIds = undefined;
  let sql = `SELECT company_id, project_id, kind, scope_ref, updated_by, updated_at FROM ${table(ctx, "project_drive_kind")} WHERE company_id = $1`;
  const params: unknown[] = [companyId];
  if (projectIds) {
    sql += ` AND project_id = ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb)))`;
    params.push(JSON.stringify(projectIds));
  }
  sql += ` ORDER BY project_id`;
  const rows = await ctx.db.query<KindRow>(sql, params);
  return rows.map(mapKind);
}
