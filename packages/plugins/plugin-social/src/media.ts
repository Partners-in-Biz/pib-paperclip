/**
 * Media on Cloudflare R2.
 *
 * Browsers upload straight to the bucket with a presigned PUT (the bucket's
 * CORS must allow the Paperclip origin), then register the asset. Agents
 * import from a URL: the worker downloads with native fetch after checking
 * the URL is public https, then PUTs to R2.
 */
import { createHash, randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { clientProjectIds, objectKeyFor, r2PutObject, r2Upload } from "@partnersinbiz/pib-plugin-kit";
import { inScope, scopeColumns, scopeFromParams, scopeLabel, scopeOut, type ClientScope } from "./clients.js";
import { loadSocialConfig, r2PublicHost, type SocialConfig } from "./config.js";
import { findMediaBySource, getMediaAssets, insertMediaAsset, mediaRefFromAsset, type MediaAssetRow, type MediaRef } from "./db.js";
import { mediaKindFromMime, SocialError } from "./domain.js";
import { isSocialProject } from "./issues.js";
import { describeUnsupported, mediaInfo, mimeFromName, shapeNotes, sniffMime } from "./media-info.js";
import { downloadMedia } from "./oauth/http.js";
import { MEDIA_MAX_BYTES, SOCIAL_MEDIA_MIME } from "./platforms.js";

export const R2_PREFIX = "social";

export function assertUploadable(input: { mime: string; bytes: number }): void {
  if (!SOCIAL_MEDIA_MIME.includes(input.mime)) {
    throw new SocialError(`Unsupported file type ${input.mime}. Use JPEG, PNG, GIF, WebP, MP4 or MOV.`);
  }
  if (!Number.isFinite(input.bytes) || input.bytes <= 0) throw new SocialError("File size is required");
  if (input.bytes > MEDIA_MAX_BYTES) throw new SocialError("Files are limited to 512 MB");
}

export function mediaKey(companyId: string, mime: string, fileName?: string): string {
  return objectKeyFor({ prefix: R2_PREFIX, companyId, mime, fileName });
}

export async function presignUpload(ctx: PluginContext, companyId: string, input: { fileName: string; mime: string; bytes: number }) {
  assertUploadable(input);
  const config = await loadSocialConfig(ctx, companyId);
  const r2 = await config.r2();
  const key = mediaKey(companyId, input.mime, input.fileName);
  const { uploadUrl, publicUrl } = r2Upload(r2, key, 900);
  return { uploadUrl, publicUrl, key, headers: { "Content-Type": input.mime }, expiresInSeconds: 900 };
}

function assetOut(row: MediaAssetRow) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    kind: row.kind,
    mime: row.mime,
    bytes: row.bytes == null ? null : Number(row.bytes),
    width: row.width,
    height: row.height,
    durationS: row.duration_s == null ? null : Number(row.duration_s),
    altText: row.alt_text,
    r2Key: row.r2_key,
    ...scopeOut(row),
  };
}

export { assetOut };

function optionalNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Keys we issued look like social/<companyId>/<yyyy-mm>/<uuid>[-name].<ext>. */
function assertOwnKey(companyId: string, key: string): void {
  if (!key.startsWith(`${R2_PREFIX}/${companyId}/`) || key.includes("..")) throw new SocialError("That upload key does not belong to this company");
}

export async function registerAsset(
  ctx: PluginContext,
  companyId: string,
  params: Record<string, unknown>,
  config?: SocialConfig,
): Promise<ReturnType<typeof assetOut>> {
  const url = typeof params.url === "string" ? params.url.trim() : "";
  const name = (typeof params.name === "string" && params.name.trim()) || url.split("/").pop() || "Media";
  if (!/^https:\/\//i.test(url)) throw new SocialError("Asset URL must start with https://");
  const mime = typeof params.mime === "string" && params.mime ? params.mime : null;
  const kindInput = typeof params.kind === "string" ? params.kind.toLowerCase() : null;
  const kind = kindInput === "video" || kindInput === "image" ? kindInput : mime ? mediaKindFromMime(mime) : /\.(mp4|mov|m4v)(\?|$)/i.test(url) ? "video" : "image";
  let r2Key = typeof params.r2Key === "string" && params.r2Key ? params.r2Key : null;
  if (r2Key) {
    assertOwnKey(companyId, r2Key);
    const cfg = config ?? (await loadSocialConfig(ctx, companyId));
    const host = r2PublicHost(cfg);
    if (host && new URL(url).host.toLowerCase() !== host) throw new SocialError("The asset URL must be on the R2 public media domain");
  }
  // Media belongs to the scope it was added in: own work unless a client is named.
  const target = await scopeFromParams(ctx, companyId, params);
  const row: MediaAssetRow & { source_url?: string | null } = {
    id: randomUUID(),
    company_id: companyId,
    name: name.slice(0, 200),
    url,
    kind,
    r2_key: r2Key,
    mime,
    bytes: optionalNumber(params.bytes),
    width: optionalNumber(params.width),
    height: optionalNumber(params.height),
    duration_s: optionalNumber(params.durationS),
    alt_text: typeof params.altText === "string" && params.altText.trim() ? params.altText.trim().slice(0, 1500) : null,
    ...scopeColumns(target),
    created_at: null,
    source_url: typeof params.sourceUrl === "string" ? params.sourceUrl : null,
  };
  await insertMediaAsset(ctx, row);
  return assetOut(row);
}

/** Download a public https file and store it on R2 (agent tool). */
export async function importFromUrl(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const sourceUrl = typeof params.url === "string" ? params.url.trim() : "";
  if (!sourceUrl) throw new SocialError("url is required");
  // Refuse an unknown client before downloading anything.
  await scopeFromParams(ctx, companyId, params);
  const config = await loadSocialConfig(ctx, companyId);
  const r2 = await config.r2();
  const file = await downloadMedia(sourceUrl, { maxBytes: MEDIA_MAX_BYTES, label: "Import URL" });
  let mime = file.mime;
  if (mime === "image/jpg") mime = "image/jpeg";
  if (!SOCIAL_MEDIA_MIME.includes(mime)) throw new SocialError(`The URL returned ${mime}; only images (JPEG, PNG, GIF, WebP) and MP4/MOV videos can be imported`);
  const fileName = (typeof params.name === "string" && params.name) || new URL(sourceUrl).pathname.split("/").pop() || "import";
  const key = mediaKey(companyId, mime, fileName);
  const publicUrl = await r2PutObject(r2, key, file.bytes, mime);
  return registerAsset(ctx, companyId, {
    ...params,
    url: publicUrl,
    name: fileName,
    mime,
    bytes: file.size,
    r2Key: key,
    kind: mediaKindFromMime(mime),
    sourceUrl,
  }, config);
}

/**
 * Turn asset ids into the media array stored on a post (keeps the given
 * order). Every asset must belong to the post's scope.
 */
export async function mediaFromAssetIds(ctx: PluginContext, companyId: string, ids: unknown, scope: ClientScope): Promise<MediaRef[] | undefined> {
  if (ids === undefined) return undefined;
  if (ids === null) return [];
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw new SocialError("mediaAssetIds must be a list of media asset ids");
  const unique = Array.from(new Set(ids as string[]));
  const rows = await getMediaAssets(ctx, companyId, unique);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = unique.filter((id) => !byId.has(id));
  if (missing.length) throw new SocialError(`Unknown media asset ${missing[0]}. Use list-media-assets or import-media-from-url.`);
  const foreign = rows.find((row) => !inScope(row, scope));
  if (foreign) {
    throw new SocialError(`Media "${foreign.name}" belongs to ${scopeLabel(foreign)}. A post can only use media of its own client (or own work).`);
  }
  return unique.map((id) => mediaRefFromAsset(byId.get(id)!));
}

/** Media on a post whose asset is outside `scope` (legacy posts from before strict scopes). */
export async function foreignMedia(ctx: PluginContext, companyId: string, media: MediaRef[], scope: ClientScope): Promise<MediaAssetRow[]> {
  const ids = Array.from(new Set(media.map((m) => m.assetId).filter((id): id is string => Boolean(id))));
  if (ids.length === 0) return [];
  return (await getMediaAssets(ctx, companyId, ids)).filter((row) => !inScope(row, scope));
}

// ── issue attachments (Q1a-5, Q10-11) ───────────────────────────────────────

/**
 * An agent makes a file (a carousel slide, a branded image, a short video) in its run and attaches it to the
 * issue it is working on. These two tools turn that attachment into a media asset: the plugin reads the bytes
 * through the host (`issue.attachments.read`: company-scoped, audit-logged, bytes only) and puts them on R2.
 * The agent passes an id and gets an asset id back, never a link to private storage. A file in the agent's
 * workspace is attached to the issue first (the paperclip skill uploads attachments). Social deliberately does
 * not read a path an agent names: a worker CAN read the disk, so an agent-supplied path could reach credential files
 * that live under the same user on the server. The host's workspace folder access is text only
 * anyway. If a path import is ever wanted it needs `project.workspaces.read` plus a real-path check that keeps the
 * file inside the run's own workspace; until then the attachment is the way.
 *
 * The bytes pass through the worker as base64 over the host bridge, so the import is capped well under the 512 MB
 * a platform takes: larger files go through `import-media-from-url` or a person's upload on the Social page.
 */
export const ATTACHMENT_MAX_BYTES = 64 * 1024 * 1024;

/** Where an imported asset came from; stored as the asset's `source_url` so a repeat import returns the same asset. */
export function attachmentSource(issueId: string, attachmentId: string): string {
  return `paperclip-attachment:${issueId}/${attachmentId}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The issue (the host accepts an identifier like PIB-23 or an id; attachments are listed by id). Refuses an issue that is not in this company. */
async function issueOf(ctx: PluginContext, companyId: string, ref: string): Promise<{ id: string; projectId: string | null }> {
  const issue = await ctx.issues.get(ref, companyId).catch(() => null);
  if (!issue?.id) throw new SocialError(`Issue ${ref} was not found in this company. Pass the issue the file is attached to (the one you are working on).`);
  return { id: String(issue.id), projectId: issue.projectId ? String(issue.projectId) : null };
}

/**
 * A client's media library takes files from the client's own work. When the CRM has linked projects to the client, the attachment's
 * issue must be in one of them (or in the shared Social project, where unlinked work lives): an agent that is handed another
 * client's issue cannot put that client's file into this one's library by mistake. Own work, a client with no linked project and an
 * issue with no project are not checked (there is nothing to compare). The asset records where it came from either way.
 */
async function assertIssueInScope(ctx: PluginContext, companyId: string, issue: { id: string; projectId: string | null }, scope: ClientScope, clientName: string | null): Promise<void> {
  if (!scope || !issue.projectId) return;
  const linked = await clientProjectIds(ctx, companyId, scope).catch(() => [] as string[]);
  if (linked.length === 0 || linked.includes(issue.projectId)) return;
  if (await isSocialProject(ctx, companyId, issue.projectId)) return;
  const who = clientName ?? "this client";
  throw new SocialError(`That attachment is on an issue in another project than ${who}'s own. Client files stay with the client: attach the file to an issue in ${who}'s project (or the Social project) and import it from there.`);
}

/** The attachments of an issue, as metadata: id, name, size, what they probably are. No links, no bytes. */
export async function listIssueAttachments(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const ref = typeof params.issueId === "string" ? params.issueId.trim() : "";
  if (!ref) throw new SocialError("issueId is required (the issue the files are attached to)");
  const rows = await ctx.issues.listAttachments((await issueOf(ctx, companyId, ref)).id, companyId);
  return rows.slice(0, 100).map((row) => {
    const guess = mimeFromName(row.originalFilename) ?? (row.contentType !== "application/octet-stream" ? row.contentType : null);
    const mediaGuess = guess && SOCIAL_MEDIA_MIME.includes(guess);
    return {
      attachmentId: row.id,
      issueId: row.issueId,
      name: row.originalFilename,
      declaredType: row.contentType,
      bytes: row.byteSize,
      looksLike: guess,
      importable: Boolean(mediaGuess) && row.byteSize > 0 && row.byteSize <= ATTACHMENT_MAX_BYTES,
      ...(row.byteSize > ATTACHMENT_MAX_BYTES ? { problem: `over ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)} MB: too big to import from an attachment` } : {}),
    };
  });
}

/** Imports one issue attachment into the scope's media library (R2). Idempotent per attachment and scope. */
export async function importFromAttachment(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const ref = typeof params.issueId === "string" ? params.issueId.trim() : "";
  const attachmentId = typeof params.attachmentId === "string" ? params.attachmentId.trim() : "";
  if (!ref) throw new SocialError("issueId is required: the issue the file is attached to (list-issue-attachments shows its files)");
  if (!attachmentId) throw new SocialError("attachmentId is required (from list-issue-attachments)");
  // Refuse an unknown client before reading anything.
  const target = await scopeFromParams(ctx, companyId, params);
  const issue = await issueOf(ctx, companyId, ref);
  await assertIssueInScope(ctx, companyId, issue, target.scope, target.client?.name ?? null);
  const issueId = issue.id;
  const attachments = await ctx.issues.listAttachments(issueId, companyId);
  const meta = attachments.find((row) => row.id === attachmentId);
  if (!meta) throw new SocialError("That attachment is not on that issue (or the issue is not in this company). list-issue-attachments shows what is there.");
  if (meta.byteSize > ATTACHMENT_MAX_BYTES) throw new SocialError(`The file is ${Math.round(meta.byteSize / 1024 / 1024)} MB; attachments can be imported up to ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)} MB. Compress it, or host it somewhere public and use import-media-from-url.`);
  const source = attachmentSource(issueId, attachmentId);
  const reused = await findMediaBySource(ctx, companyId, source, target.scope);
  if (reused) return { ...assetOut(reused), reused: true, notes: [] as string[] };

  const content = await ctx.issues.getAttachmentContent(attachmentId, companyId, { maxBytes: ATTACHMENT_MAX_BYTES });
  if (!content) throw new SocialError("That attachment could not be read (it was removed, or it is another company's).");
  // A Buffer is a Uint8Array: no second copy of a file that can be 64 MB (the base64 text, one Buffer and nothing more).
  const bytes = Buffer.from(content.contentBase64, "base64");
  if (bytes.length === 0) throw new SocialError("The attachment is empty.");
  if (content.sha256 && content.sha256 !== sha256(bytes)) throw new SocialError("The attachment's bytes do not match its recorded checksum; attach it again.");
  const mime = sniffMime(bytes);
  if (!mime || !SOCIAL_MEDIA_MIME.includes(mime)) {
    throw new SocialError(`This is ${describeUnsupported(bytes, content.contentType, content.originalFilename)}. Social takes JPEG, PNG, GIF, WebP images and MP4 or MOV videos.`);
  }
  const info = mediaInfo(bytes, mime);
  const config = await loadSocialConfig(ctx, companyId);
  const r2 = await config.r2();
  const fileName = (typeof params.name === "string" && params.name.trim()) || content.originalFilename || "attachment";
  const key = mediaKey(companyId, mime, fileName);
  const publicUrl = await r2PutObject(r2, key, bytes, mime);
  const asset = await registerAsset(ctx, companyId, {
    ...params,
    url: publicUrl,
    name: fileName,
    mime,
    bytes: bytes.length,
    width: info.width,
    height: info.height,
    durationS: info.durationS,
    r2Key: key,
    kind: mediaKindFromMime(mime),
    sourceUrl: source,
  }, config);
  return { ...asset, reused: false, notes: shapeNotes(info, mime) };
}
