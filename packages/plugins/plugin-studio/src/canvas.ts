/**
 * Canvas boards: cards (prompt, image, video, source, output) and the connections between them, saved per company with
 * an optional client and project. The document uses React Flow's names (`type`, `position`, `source`, `target`) so the
 * page maps it one to one, but only the fields below are kept. Saving is an optimistic lock on `revision`: a save made
 * from an older revision (a second tab, a second person) is refused, never silently merged or overwritten.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sameClient, scopeOfRow, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { iso, num, table } from "./db.js";
import { StudioError } from "./errors.js";
import { clientFilter } from "./page.js";
import { scopeForWork, scopeInput } from "./scope.js";
import { canConnect, emptyDoc, hasCycle, MAX_EDGES, MAX_LABEL, MAX_NODES, MAX_TEXT, MAX_TITLE, NODE_TYPES, type CanvasDoc, type CanvasEdge, type CanvasNode, type NodeType } from "./canvas-rules.js";

// The rules live in canvas-rules.ts so the page bundle shares them; existing imports from this file keep working.
export { canConnect, emptyDoc, hasCycle, MAX_EDGES, MAX_NODES, MAX_TEXT, NODE_TYPES };
export type { CanvasDoc, CanvasEdge, CanvasNode, NodeType };

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Per card type, the data fields kept and their kind. Anything else is dropped. */
const FIELDS: Record<NodeType, Record<string, "text" | "label" | "id">> = {
  prompt: { label: "label", text: "text" },
  // assetId: the card's last result; groupId: the generation still running for it (cleared when it finishes).
  image: { label: "label", prompt: "text", model: "label", ratio: "label", resolution: "label", assetId: "id", groupId: "id" },
  video: { label: "label", prompt: "text", model: "label", ratio: "label", resolution: "label", assetId: "id", groupId: "id" },
  source: { label: "label", assetId: "id" },
  // generated: set on output cards the canvas made for a finished generation (a wired output card is refilled, these are kept).
  output: { label: "label", assetId: "id", generated: "label" },
};

function bad(message: string): never {
  throw new StudioError(message, "bad_canvas");
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function coord(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(-1e6, Math.min(1e6, Math.round(n * 100) / 100)) : fallback;
}

/** Validates and trims a board from the page. Throws a message a person can act on. */
export function normalizeDoc(input: unknown): CanvasDoc {
  const raw = obj(input);
  const nodesIn = Array.isArray(raw.nodes) ? raw.nodes : [];
  const edgesIn = Array.isArray(raw.edges) ? raw.edges : [];
  if (nodesIn.length > MAX_NODES) bad(`A canvas holds at most ${MAX_NODES} cards.`);
  if (edgesIn.length > MAX_EDGES) bad(`A canvas holds at most ${MAX_EDGES} connections.`);

  const nodes: CanvasNode[] = [];
  const byId = new Map<string, CanvasNode>();
  for (const item of nodesIn) {
    const n = obj(item);
    const id = String(n.id ?? "");
    if (!ID.test(id)) bad("A card has a missing or invalid id.");
    if (byId.has(id)) bad(`Two cards share the id ${id}.`);
    const type = String(n.type ?? "") as NodeType;
    if (!NODE_TYPES.includes(type)) bad(`Unknown card type "${String(n.type ?? "")}".`);
    const dataIn = obj(n.data);
    const data: Record<string, string> = {};
    for (const [key, kind] of Object.entries(FIELDS[type])) {
      const v = dataIn[key];
      if (v === undefined || v === null || v === "") continue;
      if (typeof v !== "string") bad(`Card ${id}: ${key} must be text.`);
      const max = kind === "text" ? MAX_TEXT : kind === "label" ? MAX_LABEL : 64;
      if (v.length > max) bad(`Card ${id}: ${key} is longer than ${max} characters.`);
      if (kind === "id" && !/^[A-Za-z0-9-]{1,64}$/.test(v)) bad(`Card ${id}: ${key} is not an asset id.`);
      data[key] = v;
    }
    const pos = obj(n.position);
    const node: CanvasNode = { id, type, position: { x: coord(pos.x), y: coord(pos.y) }, data };
    nodes.push(node);
    byId.set(id, node);
  }

  const edges: CanvasEdge[] = [];
  const pairs = new Set<string>();
  const ids = new Set<string>();
  for (const item of edgesIn) {
    const e = obj(item);
    const id = String(e.id ?? "");
    if (!ID.test(id) || ids.has(id)) bad("A connection has a missing, invalid or repeated id.");
    const from = byId.get(String(e.source ?? ""));
    const to = byId.get(String(e.target ?? ""));
    if (!from || !to) bad(`Connection ${id} points at a card that isn't on the canvas.`);
    if (from.id === to.id) bad("A card can't connect to itself.");
    if (!canConnect(from.type, to.type)) bad(`A ${from.type} card can't feed a ${to.type} card.`);
    const pair = `${from.id}>${to.id}`;
    if (pairs.has(pair)) continue;
    pairs.add(pair);
    ids.add(id);
    edges.push({ id, source: from.id, target: to.id });
  }
  if (hasCycle(nodes, edges)) bad("Connections can't go round in a loop.");

  const vp = obj(raw.viewport);
  const zoom = coord(vp.zoom, 1);
  return { nodes, edges, viewport: { x: coord(vp.x), y: coord(vp.y), zoom: zoom > 0 ? Math.min(zoom, 8) : 1 } };
}

function title(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) bad("Give the canvas a name.");
  if (text.length > MAX_TITLE) bad(`A canvas name is at most ${MAX_TITLE} characters.`);
  return text;
}

interface CanvasRow {
  id: string;
  company_id: string;
  client_kind: string | null;
  client_ref: string | null;
  client_name: string | null;
  project_id: string | null;
  title: string;
  doc: unknown;
  revision: number | string;
  created_at: unknown;
  updated_at: unknown;
}

function summary(row: CanvasRow) {
  const doc = obj(typeof row.doc === "string" ? JSON.parse(row.doc) : row.doc);
  return {
    id: row.id,
    title: row.title,
    client: row.client_ref ? { kind: row.client_kind, id: row.client_ref, name: row.client_name } : null,
    projectId: row.project_id,
    revision: num(row.revision),
    cards: Array.isArray(doc.nodes) ? doc.nodes.length : 0,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function getRow(ctx: PluginContext, companyId: string, id: string): Promise<CanvasRow> {
  const rows = await ctx.db.query<CanvasRow>(`SELECT * FROM ${table(ctx, "canvases")} WHERE id = $1 AND company_id = $2 AND archived_at IS NULL`, [id, companyId]);
  if (!rows[0]) throw new StudioError("That canvas was not found in this company.", "unknown_canvas");
  return rows[0];
}

/** Source and output cards may only show library assets of the canvas's own company and client. */
async function assertAssets(ctx: PluginContext, companyId: string, scope: ClientScope, doc: CanvasDoc): Promise<void> {
  const ids = [...new Set(doc.nodes.map((n) => n.data.assetId).filter((id): id is string => Boolean(id)))];
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
    if (!sameClient(scopeOfRow(row), scope)) bad(`Asset ${id} belongs to another client than this canvas.`);
  }
}

export async function createCanvas(ctx: PluginContext, companyId: string, params: Record<string, unknown>, actor: { userId?: string | null; agentId?: string | null }) {
  const name = title(params.title);
  const projectId = typeof params.projectId === "string" && params.projectId.trim() ? params.projectId.trim() : null;
  if (projectId) {
    const project = await ctx.projects.get(projectId, companyId).catch(() => null);
    if (!project) throw new StudioError(`Project ${projectId} was not found in this company.`, "unknown_project");
  }
  const where = await scopeForWork(ctx, companyId, scopeInput(params), projectId);
  const doc = params.doc === undefined ? emptyDoc() : normalizeDoc(params.doc);
  await assertAssets(ctx, companyId, where.scope, doc);
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "canvases")} (id, company_id, client_kind, client_ref, client_name, project_id, title, doc, created_by_user_id, created_by_agent_id, updated_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $9)`,
    [id, companyId, where.scope?.kind ?? null, where.scope?.id ?? null, where.client?.name ?? null, projectId, name, JSON.stringify(doc), actor.userId ?? null, actor.agentId ?? null],
  );
  return getCanvas(ctx, companyId, id);
}

export async function listCanvases(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
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
  const rows = await ctx.db.query<CanvasRow>(`SELECT * FROM ${table(ctx, "canvases")} ${where} ORDER BY updated_at DESC LIMIT $${values.length}`, values);
  return rows.map(summary);
}

export async function getCanvas(ctx: PluginContext, companyId: string, id: string) {
  const row = await getRow(ctx, companyId, String(id ?? "").trim());
  const doc = normalizeDoc(typeof row.doc === "string" ? JSON.parse(row.doc) : row.doc);
  return { ...summary(row), doc };
}

/** Saves the whole board, if nobody saved since `baseRevision`. Returns the new revision. */
export async function saveCanvas(ctx: PluginContext, companyId: string, params: Record<string, unknown>, actor: { userId: string }) {
  const id = String(params.canvasId ?? "").trim();
  const base = Number(params.baseRevision);
  if (!Number.isInteger(base) || base < 1) bad("baseRevision is required: the revision this save starts from.");
  const row = await getRow(ctx, companyId, id);
  const doc = normalizeDoc(params.doc);
  await assertAssets(ctx, companyId, scopeOfRow(row), doc);
  const name = params.title === undefined ? row.title : title(params.title);
  const out = await ctx.db.execute(
    `UPDATE ${table(ctx, "canvases")} SET doc = $1::jsonb, title = $2, revision = revision + 1, updated_by_user_id = $3, updated_at = now()
     WHERE id = $4 AND company_id = $5 AND revision = $6 AND archived_at IS NULL`,
    [JSON.stringify(doc), name, actor.userId, id, companyId, base],
  );
  if (!out.rowCount) {
    const now = await getRow(ctx, companyId, id);
    throw new StudioError(`Someone saved this canvas since you opened it (now revision ${num(now.revision)}). Reload to see their changes.`, "canvas_conflict");
  }
  return { id, revision: base + 1 };
}

export async function archiveCanvas(ctx: PluginContext, companyId: string, id: string) {
  await getRow(ctx, companyId, id);
  await ctx.db.execute(`UPDATE ${table(ctx, "canvases")} SET archived_at = now(), updated_at = now() WHERE id = $1 AND company_id = $2`, [id, companyId]);
  return { id, archived: true };
}
