/**
 * Canvas versions (named snapshots of a board) and card comments (PAR-8092). A version keeps the saved `doc` and its
 * revision; restoring one is an ordinary save from the caller's base revision, so the optimistic lock still refuses a
 * restore over someone else's newer save. Comments belong to a canvas and a card id and are never deleted with the
 * card: restore a version that has the card and its thread is there again.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { iso, num, table } from "./db.js";
import { StudioError } from "./errors.js";
import { getCanvas, saveCanvas } from "./canvas.js";
import { MAX_TITLE } from "./canvas-rules.js";

export const MAX_VERSIONS = 100;
export const MAX_COMMENT = 2000;

interface VersionRow { id: string; name: string; doc: unknown; revision: number | string; created_by_user_id: string | null; created_at: unknown }
interface CommentRow { id: string; card_id: string; body: string; canvas_revision: number | string; author_user_id: string | null; created_at: unknown }

function text(value: unknown, what: string, max: number): string {
  const t = typeof value === "string" ? value.trim() : "";
  if (!t) throw new StudioError(`Write a ${what} first.`, "bad_canvas");
  if (t.length > max) throw new StudioError(`A ${what} is at most ${max} characters.`, "bad_canvas");
  return t;
}

function cardId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new StudioError("cardId is required.", "bad_canvas");
  return id;
}

function cardCount(doc: unknown): number {
  const d = typeof doc === "string" ? JSON.parse(doc) : doc;
  return Array.isArray((d as { nodes?: unknown })?.nodes) ? (d as { nodes: unknown[] }).nodes.length : 0;
}

const versionView = (r: VersionRow) => ({ id: r.id, name: r.name, revision: num(r.revision), cards: cardCount(r.doc), createdByUserId: r.created_by_user_id, createdAt: iso(r.created_at) });
const commentView = (r: CommentRow) => ({ id: r.id, cardId: r.card_id, body: r.body, revision: num(r.canvas_revision), authorUserId: r.author_user_id, createdAt: iso(r.created_at) });

/** Snapshots the board as it is saved now (not the caller's unsaved edits). */
export async function saveVersion(ctx: PluginContext, companyId: string, params: Record<string, unknown>, actor: { userId: string }) {
  const name = text(params.name, "version name", MAX_TITLE);
  const canvas = await getCanvas(ctx, companyId, String(params.canvasId ?? ""));
  const [count] = await ctx.db.query<{ n: number | string }>(`SELECT count(*) AS n FROM ${table(ctx, "canvas_versions")} WHERE company_id = $1 AND canvas_id = $2`, [companyId, canvas.id]);
  if (num(count?.n) >= MAX_VERSIONS) throw new StudioError(`A canvas keeps at most ${MAX_VERSIONS} versions.`, "bad_canvas");
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "canvas_versions")} (id, company_id, canvas_id, name, doc, revision, created_by_user_id) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [id, companyId, canvas.id, name, JSON.stringify(canvas.doc), canvas.revision, actor.userId],
  );
  return { id, name, revision: canvas.revision, cards: canvas.doc.nodes.length };
}

export async function listVersions(ctx: PluginContext, companyId: string, canvasId: string) {
  const canvas = await getCanvas(ctx, companyId, canvasId);
  const rows = await ctx.db.query<VersionRow>(
    `SELECT id, name, doc, revision, created_by_user_id, created_at FROM ${table(ctx, "canvas_versions")} WHERE company_id = $1 AND canvas_id = $2 ORDER BY created_at DESC, id LIMIT ${MAX_VERSIONS}`,
    [companyId, canvas.id],
  );
  return rows.map(versionView);
}

/** Puts a version's board back as a new save from `baseRevision`. Returns the new revision. */
export async function restoreVersion(ctx: PluginContext, companyId: string, params: Record<string, unknown>, actor: { userId: string }) {
  const canvasId = String(params.canvasId ?? "").trim();
  const rows = await ctx.db.query<VersionRow>(
    `SELECT id, name, doc, revision, created_by_user_id, created_at FROM ${table(ctx, "canvas_versions")} WHERE id = $1 AND company_id = $2 AND canvas_id = $3`,
    [String(params.versionId ?? ""), companyId, canvasId],
  );
  if (!rows[0]) throw new StudioError("That version was not found on this canvas.", "unknown_version");
  const doc = typeof rows[0].doc === "string" ? JSON.parse(rows[0].doc) : rows[0].doc;
  return saveCanvas(ctx, companyId, { canvasId, baseRevision: params.baseRevision, doc }, actor);
}

export async function addComment(ctx: PluginContext, companyId: string, params: Record<string, unknown>, actor: { userId: string }) {
  const card = cardId(params.cardId);
  const body = text(params.body, "comment", MAX_COMMENT);
  const canvas = await getCanvas(ctx, companyId, String(params.canvasId ?? ""));
  if (!canvas.doc.nodes.some((n) => n.id === card)) throw new StudioError("That card is not on the saved canvas yet. Wait for the save, then comment.", "bad_canvas");
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "canvas_comments")} (id, company_id, canvas_id, card_id, body, canvas_revision, author_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, companyId, canvas.id, card, body, canvas.revision, actor.userId],
  );
  return { id, cardId: card, body, revision: canvas.revision, authorUserId: actor.userId };
}

/** A card's thread, oldest first. Works for a card no longer on the board (its comments are kept). */
export async function listComments(ctx: PluginContext, companyId: string, canvasId: string, card: unknown) {
  const canvas = await getCanvas(ctx, companyId, canvasId);
  const rows = await ctx.db.query<CommentRow>(
    `SELECT id, card_id, body, canvas_revision, author_user_id, created_at FROM ${table(ctx, "canvas_comments")} WHERE company_id = $1 AND canvas_id = $2 AND card_id = $3 ORDER BY created_at, id LIMIT 500`,
    [companyId, canvas.id, cardId(card)],
  );
  return rows.map(commentView);
}
