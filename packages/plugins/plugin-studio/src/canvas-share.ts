/**
 * Read-only share links for a canvas (PAR-8093). A plugin has no public GET route, but the host serves the plugin's own
 * `dist/ui` folder to anyone at `/_plugins/<plugin>/ui/<path>`, reading the file on every request (the CRM signing pages
 * work the same way). So a share is a static page `dist/ui/s/<share id>.html`: the board drawn as plain HTML, with no
 * script (its CSP forbids one) and no controls. The share id is the secret: 24 random characters, 120 bits, never a `-`
 * or `.`, so the host never mistakes the file for a content-hashed asset and caches it.
 *
 * The page carries signed preview links, so it is rewritten every few minutes with fresh 10-minute links and reloads
 * itself. Revoking deletes the file at once; the one-minute job deletes any page that is not a live share (revoked,
 * expired, canvas archived) and writes missing ones again (after a deploy). Agents never get a share or a signed link:
 * creating, listing and revoking are person actions.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { assetUrlForPerson } from "./assets.js";
import { getCanvas } from "./canvas.js";
import { StudioConfig } from "./config.js";
import type { CanvasDoc, CanvasNode } from "./canvas-rules.js";
import { iso, num, table } from "./db.js";
import { StudioError } from "./errors.js";

export const SHARE_SUBDIR = "s";
/** Preview links on a share page last ten minutes; pages are rewritten after four and reload after four. */
export const SHARE_LINK_SECONDS = 600;
export const REPUBLISH_MS = 4 * 60_000;
export const DEFAULT_DAYS = 7;
export const MAX_DAYS = 30;
export const MAX_LIVE_SHARES = 10;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const SHARE_ID = /^[a-z2-7]{24}$/;

export type Signer = (companyId: string, assetId: string) => Promise<string>;
type Preview = { url: string; kind: string };

interface ShareRow {
  id: string;
  company_id: string;
  canvas_id: string;
  expires_at: unknown;
  published_at: unknown;
  created_at: unknown;
}

export function newShareId(): string {
  const bytes = randomBytes(24);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export const isShareId = (value: unknown): value is string => typeof value === "string" && SHARE_ID.test(value);
/** Relative to the plugin's ui folder; the page builds the full link from where its own bundle is served. */
export const sharePath = (id: string) => `${SHARE_SUBDIR}/${id}.html`;

let override: string | null | undefined;
/** Tests: write pages here (or nowhere). `undefined` goes back to finding the folder from where the worker runs. */
export function configureShareDir(dir: string | null | undefined): void {
  override = dir;
}

/** `dist/ui/s` next to the running `dist/worker.js`, or null when not running from an installed plugin. */
export function shareDir(): string | null {
  if (override !== undefined) return override;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return basename(here) === "dist" ? join(here, "ui", SHARE_SUBDIR) : null;
  } catch {
    return null;
  }
}

function shareOut(row: ShareRow) {
  return { id: row.id, canvasId: row.canvas_id, path: sharePath(row.id), expiresAt: iso(row.expires_at), createdAt: iso(row.created_at) };
}

function removePage(id: string): void {
  const dir = shareDir();
  if (dir && isShareId(id)) rmSync(join(dir, `${id}.html`), { force: true });
}

/**
 * One signer per request or job run, with one StudioConfig per company in it: a page of 30 cards, or ten pages, cost
 * one secret lookup, not one per card (the host allows 30 a minute per company, shared with the Studio page; PAR-8102).
 */
export function defaultSigner(ctx: PluginContext): Signer {
  const configs = new Map<string, StudioConfig>();
  return (companyId, assetId) => {
    let config = configs.get(companyId);
    if (!config) {
      config = new StudioConfig(ctx, companyId);
      configs.set(companyId, config);
    }
    return assetUrlForPerson(ctx, companyId, assetId, SHARE_LINK_SECONDS, config);
  };
}

async function publish(ctx: PluginContext, row: ShareRow, sign: Signer): Promise<boolean> {
  const dir = shareDir();
  if (!dir) throw new StudioError("This worker is not running from an installed plugin folder, so there is nowhere to publish the page.", "share_unpublished");
  const board = await getCanvas(ctx, row.company_id, row.canvas_id);
  const ids = [...new Set(board.doc.nodes.map((n) => n.data.assetId).filter((id): id is string => Boolean(id)))].slice(0, 100);
  const previews: Record<string, Preview> = {};
  let complete = true;
  if (ids.length) {
    const marks = ids.map((_, i) => `$${i + 2}`).join(", ");
    const kinds = await ctx.db.query<{ id: string; kind: string }>(`SELECT id, kind FROM ${table(ctx, "assets")} WHERE company_id = $1 AND id IN (${marks})`, [row.company_id, ...ids]);
    for (const asset of kinds) {
      try {
        previews[asset.id] = { url: await sign(row.company_id, asset.id), kind: asset.kind };
      } catch {
        // No preview for that card this time; the page still shows it, and the next job run tries again.
        complete = false;
      }
    }
  }
  const html = renderSharePage({ title: board.title, doc: board.doc, previews, expiresAt: iso(row.expires_at) });
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const temp = join(dir, `.${row.id}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(temp, html, { encoding: "utf8", mode: 0o644 });
  renameSync(temp, join(dir, `${row.id}.html`));
  // A revoke (or expiry) can land while this page was being signed and written: its delete then ran before the
  // rename above. Check again after the rename and take the page down, so a revoked link never comes back.
  // A page with a missing preview keeps its old published_at, so the one-minute job writes it again soon.
  const still = await ctx.db.execute(
    `UPDATE ${table(ctx, "canvas_shares")} SET published_at = CASE WHEN $2::boolean THEN now() ELSE published_at END WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [row.id, complete],
  );
  if (num(still.rowCount)) return true;
  removePage(row.id);
  return false;
}

export async function createShare(ctx: PluginContext, companyId: string, params: Record<string, unknown>, actor: { userId: string }, sign: Signer = defaultSigner(ctx)) {
  const canvasId = String(params.canvasId ?? "").trim();
  await getCanvas(ctx, companyId, canvasId);
  const days = params.days === undefined ? DEFAULT_DAYS : Number(params.days);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new StudioError(`A share link lasts 1 to ${MAX_DAYS} days.`, "bad_share");
  if ((await listShares(ctx, companyId, canvasId)).length >= MAX_LIVE_SHARES) {
    throw new StudioError(`This canvas already has ${MAX_LIVE_SHARES} live links. Revoke one first.`, "too_many_shares");
  }
  const id = newShareId();
  const expires = new Date(Date.now() + days * 86_400_000).toISOString();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "canvas_shares")} (id, company_id, canvas_id, created_by_user_id, expires_at) VALUES ($1, $2, $3, $4, $5)`,
    [id, companyId, canvasId, actor.userId, expires],
  );
  const rows = await ctx.db.query<ShareRow>(`SELECT * FROM ${table(ctx, "canvas_shares")} WHERE id = $1`, [id]);
  await publish(ctx, rows[0]!, sign);
  return shareOut(rows[0]!);
}

/** Live links of a canvas: not revoked, not expired. */
export async function listShares(ctx: PluginContext, companyId: string, canvasId: string) {
  const rows = await ctx.db.query<ShareRow>(
    `SELECT * FROM ${table(ctx, "canvas_shares")} WHERE company_id = $1 AND canvas_id = $2 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
    [companyId, String(canvasId ?? "").trim()],
  );
  return rows.map(shareOut);
}

export async function revokeShare(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const id = String(params.shareId ?? "").trim();
  const out = isShareId(id)
    ? await ctx.db.execute(`UPDATE ${table(ctx, "canvas_shares")} SET revoked_at = now() WHERE id = $1 AND company_id = $2 AND revoked_at IS NULL`, [id, companyId])
    : { rowCount: 0 };
  if (!num(out.rowCount)) throw new StudioError("That share link was not found in this company, or is already revoked.", "unknown_share");
  removePage(id);
  return { id, revoked: true };
}

/** The one-minute job: delete pages that are no longer live shares, write missing or ageing ones. */
export async function refreshShares(ctx: PluginContext, sign: Signer = defaultSigner(ctx)): Promise<{ written: number; removed: number }> {
  const dir = shareDir();
  if (!dir) return { written: 0, removed: 0 };
  const rows = await ctx.db.query<ShareRow>(
    `SELECT s.* FROM ${table(ctx, "canvas_shares")} s JOIN ${table(ctx, "canvases")} c ON c.id = s.canvas_id AND c.company_id = s.company_id
     WHERE s.revoked_at IS NULL AND s.expires_at > now() AND c.archived_at IS NULL`,
  );
  const live = new Set(rows.map((r) => r.id));
  let removed = 0;
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    const id = name.endsWith(".html") ? name.slice(0, -5) : "";
    if (isShareId(id) && !live.has(id)) {
      rmSync(join(dir, name), { force: true });
      removed += 1;
    }
  }
  let written = 0;
  for (const row of rows) {
    const age = row.published_at ? Date.now() - new Date(String(iso(row.published_at))).getTime() : Infinity;
    if (age < REPUBLISH_MS && existsSync(join(dir, `${row.id}.html`))) continue;
    try {
      if (await publish(ctx, row, sign)) written += 1;
    } catch (error) {
      ctx.logger.warn("Studio share page not written", { share: row.id.slice(0, 4), error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { written, removed };
}

// ---- The page ----

const CARD_W = 240;
const CARD_H = 210;
const PAD = 32;
const TYPE_LABELS: Record<string, string> = { prompt: "Prompt", image: "Image", video: "Video", source: "Source", output: "Output" };

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function cardBody(node: CanvasNode, previews: Record<string, Preview>): string {
  const preview = node.data.assetId ? previews[node.data.assetId] : undefined;
  if (preview) {
    const alt = esc(node.data.label || TYPE_LABELS[node.type]);
    return preview.kind === "video" ? `<video class="media" src="${esc(preview.url)}" controls muted playsinline preload="metadata"></video>` : `<img class="media" src="${esc(preview.url)}" alt="${alt}" loading="lazy">`;
  }
  const text = node.type === "prompt" ? node.data.text : node.data.prompt;
  if (text) return `<p class="text">${esc(text)}</p>`;
  return `<p class="empty">${node.type === "image" || node.type === "video" ? "Not generated yet" : "Empty"}</p>`;
}

function card(node: CanvasNode, previews: Record<string, Preview>): string {
  const chips = [node.data.model, node.data.ratio].filter(Boolean).map((c) => `<span class="chip">${esc(c)}</span>`).join("");
  return `<header><span class="type type-${node.type}">${TYPE_LABELS[node.type]}</span><span class="label">${esc(node.data.label || "")}</span></header>${cardBody(node, previews)}${chips ? `<footer>${chips}</footer>` : ""}`;
}

/** The whole public page. Pure: tests read it as it would be served. */
export function renderSharePage(input: { title: string; doc: CanvasDoc; previews: Record<string, Preview>; expiresAt: string | null }): string {
  const { doc, previews } = input;
  const xs = doc.nodes.map((n) => n.position.x);
  const ys = doc.nodes.map((n) => n.position.y);
  const minX = xs.length ? Math.min(...xs) : 0;
  const minY = ys.length ? Math.min(...ys) : 0;
  const at = new Map(doc.nodes.map((n) => [n.id, { x: n.position.x - minX + PAD, y: n.position.y - minY + PAD }]));
  const width = (xs.length ? Math.max(...xs) - minX : 0) + CARD_W + PAD * 2;
  const height = (ys.length ? Math.max(...ys) - minY : 0) + CARD_H + PAD * 2;
  const paths = doc.edges
    .map((e) => {
      const a = at.get(e.source);
      const b = at.get(e.target);
      if (!a || !b) return "";
      const [x1, y1, x2, y2] = [a.x + CARD_W, a.y + CARD_H / 2, b.x, b.y + CARD_H / 2];
      const bend = Math.max(40, Math.abs(x2 - x1) / 2);
      return `<path d="M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}"/>`;
    })
    .join("");
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const ordered = [...doc.nodes].sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);
  const boardCards = doc.nodes.map((n) => `<article class="card" style="left:${at.get(n.id)!.x}px;top:${at.get(n.id)!.y}px">${card(n, previews)}</article>`).join("");
  const listCards = ordered
    .map((n) => {
      const feeds = doc.edges.filter((e) => e.source === n.id).map((e) => byId.get(e.target)).filter((t): t is CanvasNode => Boolean(t));
      const line = feeds.length ? `<p class="feeds">Feeds ${feeds.map((t) => esc(t.data.label || TYPE_LABELS[t.type])).join(", ")}</p>` : "";
      return `<article class="card">${card(n, previews)}${line}</article>`;
    })
    .join("");
  const expires = input.expiresAt ? new Date(input.expiresAt).toUTCString().replace(/:\d\d GMT$/, " UTC") : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https:; media-src https:; style-src 'unsafe-inline'">
<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">
<meta http-equiv="refresh" content="240">
<title>${esc(input.title)} · Studio board</title>
<style>
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f4f5f7;color:#1d2433}
.top{padding:16px 20px;background:#fff;border-bottom:1px solid #dde1e7}.top h1{margin:0;font-size:20px;overflow-wrap:anywhere}
.top p{margin:4px 0 0;color:#5b6475;font-size:13px}.wrap{overflow:auto;padding:8px}
.board{position:relative}.board svg{position:absolute;inset:0;pointer-events:none}.board path{fill:none;stroke:#8a94a6;stroke-width:2}
.card{background:#fff;border:1px solid #d3d8e0;border-radius:10px;padding:10px;overflow:hidden;display:flex;flex-direction:column;gap:6px}
.board .card{position:absolute;width:${CARD_W}px;height:${CARD_H}px}
header{display:flex;gap:6px;align-items:center;min-width:0}.label{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.type{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;padding:2px 6px;border-radius:6px;background:#e9edf3;flex:none}
.type-image{background:#e3eefc}.type-video{background:#efe5fb}.type-prompt{background:#fdf1dc}.type-output{background:#e1f4e8}
.media{width:100%;flex:1 1 auto;min-height:0;object-fit:contain;background:#eef0f3;border-radius:6px}
.text{margin:0;flex:1 1 auto;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere}.empty{margin:0;color:#7a8396}
footer{display:flex;gap:4px;flex-wrap:wrap}.chip{font-size:11px;padding:1px 6px;border:1px solid #d3d8e0;border-radius:999px;color:#5b6475}
.feeds{margin:0;font-size:12px;color:#5b6475;overflow-wrap:anywhere}.list{display:none;padding:12px;gap:12px;flex-direction:column}
.list .media{max-height:60vh}
@media (max-width:720px){.wrap{display:none}.list{display:flex}}
</style></head><body>
<div class="top"><h1>${esc(input.title)}</h1><p>View-only Studio board${expires ? ` · link expires ${esc(expires)}` : ""}</p></div>
<div class="wrap"><div class="board" style="width:${width}px;height:${height}px"><svg width="${width}" height="${height}" aria-hidden="true">${paths}</svg>${boardCards}</div></div>
<div class="list">${listCards || '<p class="empty">This board is empty.</p>'}</div>
</body></html>
`;
}
