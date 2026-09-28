/**
 * A client's websites and projects (migration 007).
 *
 * - Sites: several per client (CRM company or contact). Each says what it is
 *   built on and how agents reach it (repo project, PiB Connector, SFTP).
 *   The CRM keeps the Connector key; other plugins get a projection without
 *   it through `site.upserted` / `site.deleted`.
 * - Connector tools (`wp-*`): signed calls to the WordPress plugin, each write
 *   logged in `site_changes` (the site keeps its own log with undo).
 * - Projects: the Paperclip projects (code folders) that belong to a client,
 *   shown on the client's CRM page.
 *
 * One statement per call, writes only to the CRM namespace, lists as JSON text.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  CONNECTOR_STATUSES,
  pluginUiBase,
  SITE_ACCESS_KINDS,
  SITE_PLATFORMS,
  SITE_SEO_PLUGINS,
  siteKey,
  siteSummary,
  type ConnectorStatus,
  type CrmSiteEvent,
  type SiteAccessKind,
  type SitePlatform,
  type SiteSeoPlugin,
} from "@partnersinbiz/pib-plugin-kit";
import {
  callConnector,
  CONNECTOR_ENDPOINTS,
  ConnectorError,
  connectorKeyId,
  isConnectionFailure,
  newConnectorKey,
  type ConnectorEndpoint,
} from "./connector.js";
import { asRecord, asStringList, table } from "./db.js";
import { CrmError, type Viewer } from "./domain.js";
import { sendHandoff } from "./handoffs.js";
import { parseClientRef, requireClient } from "./lookup.js";
import { companyPrefix, pagePath, refOf, type ClientKind } from "./refs.js";

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface SiteRecord {
  id: string;
  companyId: string;
  clientKind: ClientKind;
  clientRef: string;
  label: string | null;
  url: string;
  platform: SitePlatform;
  seoPlugin: SiteSeoPlugin | null;
  hosting: string | null;
  access: SiteAccessKind[];
  projectId: string | null;
  webRoot: string | null;
  notes: string | null;
  connectorKey: string | null;
  connectorStatus: ConnectorStatus;
  connectorVersion: string | null;
  connectorSeenAt: string | null;
  connectorError: string | null;
  health: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string;
}

interface SiteRow {
  id: string;
  company_id: string;
  client_kind: string;
  client_ref: string;
  label: string | null;
  url: string;
  platform: string;
  seo_plugin: string | null;
  hosting: string | null;
  access: unknown;
  project_id: string | null;
  web_root: string | null;
  notes: string | null;
  connector_key: string | null;
  connector_status: string;
  connector_version: string | null;
  connector_seen_at: unknown;
  connector_error: string | null;
  health: unknown;
  created_at: unknown;
  updated_at: unknown;
}

const SITE_SELECT = `id, company_id, client_kind, client_ref, label, url, platform, seo_plugin, hosting, access, project_id, web_root, notes,
  connector_key, connector_status, connector_version, connector_seen_at, connector_error, health, created_at, updated_at`;

function iso(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function member<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T) : null;
}

function mapSite(row: SiteRow): SiteRecord {
  return {
    id: row.id,
    companyId: row.company_id,
    clientKind: row.client_kind === "contact" ? "contact" : "company",
    clientRef: row.client_ref,
    label: row.label ?? null,
    url: row.url,
    platform: member(SITE_PLATFORMS, row.platform) ?? "other",
    seoPlugin: member(SITE_SEO_PLUGINS, row.seo_plugin),
    hosting: row.hosting ?? null,
    access: asStringList(row.access).filter((kind): kind is SiteAccessKind => (SITE_ACCESS_KINDS as readonly string[]).includes(kind)),
    projectId: row.project_id ?? null,
    webRoot: row.web_root ?? null,
    notes: row.notes ?? null,
    connectorKey: row.connector_key ?? null,
    connectorStatus: member(CONNECTOR_STATUSES, row.connector_status) ?? "none",
    connectorVersion: row.connector_version ?? null,
    connectorSeenAt: iso(row.connector_seen_at),
    connectorError: row.connector_error ?? null,
    health: asRecord(row.health),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at) ?? new Date().toISOString(),
  };
}

export async function listSites(ctx: PluginContext, companyId: string, kind: ClientKind, ref: string): Promise<SiteRecord[]> {
  const rows = await ctx.db.query<SiteRow>(
    `SELECT ${SITE_SELECT} FROM ${table(ctx, "client_sites")}
      WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3
      ORDER BY created_at`,
    [companyId, kind, ref],
  );
  return rows.map(mapSite);
}

export async function getSite(ctx: PluginContext, companyId: string, id: string): Promise<SiteRecord | null> {
  const rows = await ctx.db.query<SiteRow>(`SELECT ${SITE_SELECT} FROM ${table(ctx, "client_sites")} WHERE company_id = $1 AND id = $2`, [companyId, id]);
  return rows[0] ? mapSite(rows[0]) : null;
}

async function siteByKey(ctx: PluginContext, companyId: string, key: string): Promise<SiteRecord | null> {
  const rows = await ctx.db.query<SiteRow>(`SELECT ${SITE_SELECT} FROM ${table(ctx, "client_sites")} WHERE company_id = $1 AND site_key = $2`, [companyId, key]);
  return rows[0] ? mapSite(rows[0]) : null;
}

/** Sites changed in the last `sinceSeconds` seconds (all when null), for the emit jobs. */
export async function sitesChangedSince(ctx: PluginContext, companyId: string, sinceSeconds: number | null): Promise<SiteRecord[]> {
  const rows = await ctx.db.query<SiteRow>(
    `SELECT ${SITE_SELECT} FROM ${table(ctx, "client_sites")}
      WHERE company_id = $1 AND ($2::int IS NULL OR updated_at > now() - make_interval(secs => $2::int))
      ORDER BY updated_at`,
    [companyId, sinceSeconds == null ? null : Math.max(1, Math.floor(sinceSeconds))],
  );
  return rows.map(mapSite);
}

/** Connector sites nobody has heard from in `staleHours` (the hourly check refreshes them). */
export async function staleConnectorSites(ctx: PluginContext, staleHours: number, limit: number): Promise<SiteRecord[]> {
  const rows = await ctx.db.query<SiteRow>(
    `SELECT ${SITE_SELECT} FROM ${table(ctx, "client_sites")}
      WHERE connector_key IS NOT NULL AND connector_status IN ('connected', 'error')
        AND (connector_seen_at IS NULL OR connector_seen_at < now() - make_interval(hours => $1::int))
      ORDER BY connector_seen_at NULLS FIRST
      LIMIT $2`,
    [Math.max(1, Math.floor(staleHours)), Math.max(1, Math.floor(limit))],
  );
  return rows.map(mapSite);
}

async function writeSite(ctx: PluginContext, site: SiteRecord, createdBy: string | null): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "client_sites")}
      (id, company_id, client_kind, client_ref, label, url, site_key, platform, seo_plugin, hosting, access, project_id, web_root, notes,
       connector_key, connector_status, connector_version, connector_seen_at, connector_error, health, created_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $21, now())
     ON CONFLICT (id) DO UPDATE SET
       client_kind = EXCLUDED.client_kind, client_ref = EXCLUDED.client_ref, label = EXCLUDED.label, url = EXCLUDED.url,
       site_key = EXCLUDED.site_key, platform = EXCLUDED.platform, seo_plugin = EXCLUDED.seo_plugin, hosting = EXCLUDED.hosting,
       access = EXCLUDED.access, project_id = EXCLUDED.project_id, web_root = EXCLUDED.web_root, notes = EXCLUDED.notes,
       connector_key = EXCLUDED.connector_key, connector_status = EXCLUDED.connector_status,
       connector_version = EXCLUDED.connector_version, connector_seen_at = EXCLUDED.connector_seen_at,
       connector_error = EXCLUDED.connector_error, health = EXCLUDED.health, updated_at = EXCLUDED.updated_at`,
    [
      site.id,
      site.companyId,
      site.clientKind,
      site.clientRef,
      site.label,
      site.url,
      siteKey(site.url),
      site.platform,
      site.seoPlugin,
      site.hosting,
      JSON.stringify(site.access),
      site.projectId,
      site.webRoot,
      site.notes,
      site.connectorKey,
      site.connectorStatus,
      site.connectorVersion,
      site.connectorSeenAt,
      site.connectorError,
      JSON.stringify(site.health ?? {}),
      createdBy,
    ],
  );
}

async function removeSite(ctx: PluginContext, companyId: string, id: string): Promise<void> {
  await ctx.db.execute(`DELETE FROM ${table(ctx, "client_sites")} WHERE company_id = $1 AND id = $2`, [companyId, id]);
}

async function recordChange(
  ctx: PluginContext,
  input: { companyId: string; siteId: string; endpoint: string; target: string | null; reason: string | null; changeRef: string | null; ok: boolean; error: string | null; actor: string | null },
): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "site_changes")} (id, company_id, site_id, endpoint, target, reason, change_ref, ok, error, actor)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [randomUUID(), input.companyId, input.siteId, input.endpoint, input.target, input.reason, input.changeRef, input.ok, input.error, input.actor],
  );
}

interface ChangeRow {
  id: string;
  endpoint: string;
  target: string | null;
  reason: string | null;
  change_ref: string | null;
  ok: boolean;
  error: string | null;
  actor: string | null;
  created_at: unknown;
}

async function recentChanges(ctx: PluginContext, companyId: string, siteId: string, limit: number) {
  const rows = await ctx.db.query<ChangeRow>(
    `SELECT id, endpoint, target, reason, change_ref, ok, error, actor, created_at
       FROM ${table(ctx, "site_changes")}
      WHERE company_id = $1 AND site_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [companyId, siteId, limit],
  );
  return rows.map((row) => ({
    endpoint: row.endpoint,
    target: row.target,
    reason: row.reason,
    changeId: row.change_ref,
    ok: row.ok,
    error: row.error,
    actor: row.actor,
    at: iso(row.created_at),
  }));
}

// ---------------------------------------------------------------------------
// Sharing with the other plugins
// ---------------------------------------------------------------------------

export function siteEvent(site: SiteRecord): CrmSiteEvent {
  return {
    id: site.id,
    clientKind: site.clientKind,
    clientRef: site.clientRef,
    label: site.label,
    url: site.url,
    platform: site.platform,
    seoPlugin: site.seoPlugin,
    hosting: site.hosting,
    access: site.access,
    projectId: site.projectId,
    connectorStatus: site.connectorStatus,
    connectorVersion: site.connectorVersion,
    connectorSeenAt: site.connectorSeenAt,
    updatedAt: site.updatedAt,
  };
}

async function emitSite(ctx: PluginContext, companyId: string, id: string): Promise<void> {
  const fresh = await getSite(ctx, companyId, id);
  if (!fresh) return;
  try {
    await ctx.events.emit("site.upserted", companyId, siteEvent(fresh));
  } catch (error) {
    ctx.logger.info("CRM site emit failed; re-sent by the emit jobs", { siteId: id, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function emitSites(ctx: PluginContext, companyId: string, sinceSeconds: number | null): Promise<number> {
  const sites = await sitesChangedSince(ctx, companyId, sinceSeconds);
  for (const site of sites) await ctx.events.emit("site.upserted", companyId, siteEvent(site));
  return sites.length;
}

// ---------------------------------------------------------------------------
// What people and agents see (never the key)
// ---------------------------------------------------------------------------

export function siteOut(site: SiteRecord, prefix: string | null) {
  const health = site.health;
  return {
    id: site.id,
    client: refOf(site.clientKind, site.clientRef),
    label: site.label,
    url: site.url,
    platform: site.platform,
    seoPlugin: site.seoPlugin,
    hosting: site.hosting,
    access: site.access,
    projectId: site.projectId,
    projectLink: site.projectId ? pagePath(prefix, `/projects/${site.projectId}`) : null,
    webRoot: site.webRoot,
    notes: site.notes,
    summary: siteSummary(site),
    connector: {
      status: site.connectorStatus,
      keyId: site.connectorKey ? connectorKeyId(site.connectorKey) : null,
      version: site.connectorVersion,
      seenAt: site.connectorSeenAt,
      error: site.connectorError,
    },
    health: Object.keys(health).length > 0 ? health : null,
    updatedAt: site.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function str(params: Record<string, unknown>, key: string, max = 500): string | null | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new CrmError(`${key} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new CrmError(`${key} is too long (max ${max} characters)`);
  return trimmed || null;
}

/** `acme.co.za` / `https://www.acme.co.za/` → `https://www.acme.co.za` (scheme and host only). */
export function normalizeSiteUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new CrmError("url is required, e.g. https://acme.co.za");
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new CrmError(`${trimmed} is not a website address`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new CrmError("The site must use http or https");
  if (!parsed.hostname.includes(".") || parsed.username || parsed.password) throw new CrmError(`${trimmed} is not a public website address`);
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ""}`;
}

function accessList(value: unknown): SiteAccessKind[] {
  if (!Array.isArray(value)) throw new CrmError(`access must be a list: ${SITE_ACCESS_KINDS.join(", ")}`);
  const unknown = value.filter((item) => !(SITE_ACCESS_KINDS as readonly unknown[]).includes(item));
  if (unknown.length > 0) throw new CrmError(`Unknown access: ${unknown.join(", ")}. Use ${SITE_ACCESS_KINDS.join(", ")}.`);
  return SITE_ACCESS_KINDS.filter((kind) => value.includes(kind));
}

function actorOf(viewer: Viewer): string | null {
  return viewer.agentId ? `agent:${viewer.agentId}` : viewer.userId ? `user:${viewer.userId}` : null;
}

async function requireProject(ctx: PluginContext, companyId: string, projectId: string): Promise<{ id: string; name: string }> {
  const project = await ctx.projects.get(projectId, companyId).catch(() => null);
  if (!project) throw new CrmError(`Project ${projectId} was not found in this company (list-client-projects shows the projects)`);
  return { id: String(project.id), name: String((project as { name?: unknown }).name ?? "Project") };
}

async function requireSite(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>): Promise<SiteRecord> {
  const id = typeof params.siteId === "string" ? params.siteId.trim() : "";
  if (!id) throw new CrmError("siteId is required (list-client-sites shows the ids)");
  const site = await getSite(ctx, viewer.companyId, id);
  if (!site) throw new CrmError(`Site ${id} was not found (list-client-sites shows the ids)`);
  await requireClient(ctx, viewer, { kind: site.clientKind, id: site.clientRef });
  return site;
}

function requirePerson(viewer: Viewer, source: "agent" | "human", what: string): void {
  if (source !== "human" || viewer.agentId) throw new CrmError(`Only a person can ${what}. Ask them on the CRM client page (Websites).`);
}

// ---------------------------------------------------------------------------
// Sites: tools and actions
// ---------------------------------------------------------------------------

export async function listClientSitesTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const client = parseClientRef(params.client);
  const name = await requireClient(ctx, viewer, client);
  const prefix = await companyPrefix(ctx, viewer.companyId);
  const sites = await listSites(ctx, viewer.companyId, client.kind, client.id);
  return {
    client: refOf(client.kind, client.id),
    name,
    sites: sites.map((site) => siteOut(site, prefix)),
    ...(sites.length === 0 ? { next: "No websites yet. Add each one with save-client-site (url, platform, and for WordPress the SEO plugin)." } : {}),
  };
}

export async function saveClientSite(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>, source: "agent" | "human") {
  const siteId = typeof params.siteId === "string" && params.siteId.trim() ? params.siteId.trim() : null;
  const existing = siteId ? await requireSite(ctx, viewer, { siteId }) : null;
  let clientKind: ClientKind;
  let clientRef: string;
  if (existing) {
    clientKind = existing.clientKind;
    clientRef = existing.clientRef;
    if (params.client !== undefined) {
      const moved = parseClientRef(params.client);
      if (moved.kind !== clientKind || moved.id !== clientRef) {
        requirePerson(viewer, source, "move a website to another client");
        await requireClient(ctx, viewer, moved);
        clientKind = moved.kind;
        clientRef = moved.id;
      }
    }
  } else {
    const client = parseClientRef(params.client);
    await requireClient(ctx, viewer, client);
    clientKind = client.kind;
    clientRef = client.id;
  }

  const url = params.url !== undefined || !existing ? normalizeSiteUrl(params.url) : existing.url;
  const key = siteKey(url);
  if (!key) throw new CrmError(`${url} is not a website address`);
  const clash = await siteByKey(ctx, viewer.companyId, key);
  if (clash && clash.id !== existing?.id) {
    throw new CrmError(`${key} is already saved as a website of ${refOf(clash.clientKind, clash.clientRef)} (site ${clash.id}). Change that one instead.`);
  }
  if (existing && existing.connectorKey && siteKey(existing.url) !== key) {
    requirePerson(viewer, source, "change the address of a connected WordPress site");
  }

  const platform = params.platform !== undefined ? member(SITE_PLATFORMS, params.platform) : existing?.platform ?? "other";
  if (!platform) throw new CrmError(`platform must be one of ${SITE_PLATFORMS.join(", ")}`);
  let seoPlugin: SiteSeoPlugin | null = existing?.seoPlugin ?? null;
  if (params.seoPlugin !== undefined) {
    if (params.seoPlugin === null || params.seoPlugin === "") seoPlugin = null;
    else {
      seoPlugin = member(SITE_SEO_PLUGINS, params.seoPlugin);
      if (!seoPlugin) throw new CrmError(`seoPlugin must be one of ${SITE_SEO_PLUGINS.join(", ")}`);
    }
  }
  if (platform !== "wordpress") seoPlugin = null;
  let access = params.access !== undefined ? accessList(params.access) : existing?.access ?? [];
  if (existing?.connectorKey && !access.includes("connector")) {
    // The key stays until a person disconnects the site; keep the access in step with it.
    access = SITE_ACCESS_KINDS.filter((kind) => kind === "connector" || access.includes(kind));
  }
  if (access.includes("connector") && platform !== "wordpress") throw new CrmError("The PiB Connector only works on WordPress sites (set platform: wordpress)");

  let projectId = existing?.projectId ?? null;
  if (params.projectId !== undefined) {
    const raw = str(params, "projectId", 100);
    projectId = raw ? (await requireProject(ctx, viewer.companyId, raw)).id : null;
  }
  if ((access.includes("repo") || access.includes("sftp")) && !projectId) {
    throw new CrmError("repo and sftp access need the site's Paperclip project (projectId): its workspace holds the code, and its env holds the SFTP login");
  }

  const next: SiteRecord = {
    id: existing?.id ?? randomUUID(),
    companyId: viewer.companyId,
    clientKind,
    clientRef,
    label: params.label !== undefined ? str(params, "label", 80) ?? null : existing?.label ?? null,
    url,
    platform,
    seoPlugin,
    hosting: params.hosting !== undefined ? str(params, "hosting", 60) ?? null : existing?.hosting ?? null,
    access,
    projectId,
    webRoot: params.webRoot !== undefined ? webRoot(params.webRoot) : existing?.webRoot ?? null,
    notes: params.notes !== undefined ? str(params, "notes", 2000) ?? null : existing?.notes ?? null,
    connectorKey: existing?.connectorKey ?? null,
    connectorStatus: existing?.connectorStatus ?? "none",
    connectorVersion: existing?.connectorVersion ?? null,
    connectorSeenAt: existing?.connectorSeenAt ?? null,
    connectorError: existing?.connectorError ?? null,
    health: existing?.health ?? {},
    createdAt: existing?.createdAt ?? null,
    updatedAt: new Date().toISOString(),
  };
  await writeSite(ctx, next, existing ? null : actorOf(viewer));
  await emitSite(ctx, viewer.companyId, next.id);
  const prefix = await companyPrefix(ctx, viewer.companyId);
  const saved = (await getSite(ctx, viewer.companyId, next.id))!;
  return {
    site: siteOut(saved, prefix),
    created: !existing,
    ...(saved.platform === "wordpress" && !saved.connectorKey
      ? { next: "WordPress site: a person connects the PiB Connector on the CRM client page (Websites → Connect WordPress). Until then SEO changes go through Needs you." }
      : {}),
  };
}

/** A path under the SFTP home, e.g. `public_html`. No `..`, no shell characters. */
function webRoot(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new CrmError("webRoot must be text, e.g. public_html");
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  if (trimmed.length > 200 || trimmed.split("/").includes("..") || !/^[A-Za-z0-9._\-/~]+$/.test(trimmed)) {
    throw new CrmError("webRoot must be a plain folder path, e.g. public_html or /usr/www/users/acme/public_html");
  }
  return trimmed;
}

export async function deleteClientSite(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>, source: "agent" | "human") {
  requirePerson(viewer, source, "remove a website");
  const site = await requireSite(ctx, viewer, params);
  await removeSite(ctx, viewer.companyId, site.id);
  await sendHandoff(ctx, viewer.companyId, "site.deleted", { key: `site:${site.id}:deleted`, id: site.id });
  return { removed: site.id, note: site.connectorKey ? "The Connector plugin is still installed on the site. Deactivate it in wp-admin → Plugins if it is no longer needed." : undefined };
}

/**
 * A person starts (or restarts) pairing: a new key, shown once. The old key
 * stops working as soon as the site has the new one.
 */
export async function connectClientSite(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>, source: "agent" | "human") {
  const site = await requireSite(ctx, viewer, params);
  const byAgent = source !== "human" || Boolean(viewer.agentId);
  // An agent may pair only a site it can already change over SFTP: the key gives it nothing new.
  if (byAgent && !(site.access.includes("sftp") && site.projectId)) {
    requirePerson(viewer, source, "connect a WordPress site without SFTP access");
  }
  if (site.platform !== "wordpress") throw new CrmError("Only WordPress sites use the PiB Connector. Set the platform to WordPress first.");
  const key = newConnectorKey();
  const next: SiteRecord = {
    ...site,
    connectorKey: key,
    connectorStatus: "pending",
    connectorError: null,
    access: SITE_ACCESS_KINDS.filter((kind) => kind === "connector" || site.access.includes(kind)),
    updatedAt: new Date().toISOString(),
  };
  await writeSite(ctx, next, null);
  await emitSite(ctx, viewer.companyId, site.id);
  const base = await pluginUiBase(ctx);
  if (byAgent) {
    const root = site.webRoot ?? "<webRoot>";
    return {
      siteId: site.id,
      key,
      keyId: connectorKeyId(key),
      download: base ? `${base}pib-connector.zip` : null,
      steps: [
        "Download pib-connector.zip: `download` is a path on this Paperclip server, so fetch the origin of $PAPERCLIP_API_URL plus that path (curl -fsSLO), then unzip it.",
        `Upload the pib-connector folder to ${root}/wp-content/plugins/pib-connector/ over SFTP (pib-wp-deploy skill: backup, upload, sha256 readback).`,
        `Write ${root}/wp-content/pib-connector-key.php with exactly: <?php return '<the key>'; (never print the key in comments or logs).`,
        `Copy pib-connector/mu-loader/pib-connector-loader.php to ${root}/wp-content/mu-plugins/ so it loads without activation.`,
        "Call check-client-site. Connected: note it on the issue; the key id must match.",
      ],
      note: "Treat the key like a password: it is only in this result and in the key file on the site.",
    };
  }
  return {
    siteId: site.id,
    key,
    keyId: connectorKeyId(key),
    download: base ? `${base}pib-connector.zip` : null,
    steps: [
      "Download pib-connector.zip (the link on this panel).",
      `In ${site.url}/wp-admin → Plugins → Add New → Upload Plugin, upload the zip and activate it.`,
      "Open Settings → PiB Connector, paste the key and save. The page then shows the same key id as here.",
      "Come back here and press Check.",
    ],
    note: "The key is shown only now. If you lose it, press Connect again for a new one.",
  };
}

/** Ping and read health; records the result on the site. People and agents may check. */
export async function checkClientSite(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const site = await requireSite(ctx, viewer, params);
  return refreshSite(ctx, site, actorOf(viewer));
}

export async function refreshSite(ctx: PluginContext, site: SiteRecord, actor: string | null) {
  const prefix = await companyPrefix(ctx, site.companyId);
  if (!site.connectorKey) {
    return { site: siteOut(site, prefix), connected: false, error: "No Connector key yet: a person presses Connect WordPress on the CRM client page." };
  }
  try {
    const ping = await callConnector(ctx, site, "ping", {}, { actor });
    const health = await callConnector(ctx, site, "health", {}, { actor });
    const detected = member(SITE_SEO_PLUGINS, asRecord(health.seoPlugin).key);
    const connector = asRecord(health.connector);
    const next: SiteRecord = {
      ...site,
      seoPlugin: detected ?? site.seoPlugin,
      connectorStatus: "connected",
      connectorVersion: typeof connector.version === "string" ? connector.version : typeof asRecord(ping.connector).version === "string" ? String(asRecord(ping.connector).version) : site.connectorVersion,
      connectorSeenAt: new Date().toISOString(),
      connectorError: null,
      health: healthSnapshot(health),
      updatedAt: new Date().toISOString(),
    };
    await writeSite(ctx, next, null);
    await emitSite(ctx, site.companyId, site.id);
    return { site: siteOut((await getSite(ctx, site.companyId, site.id))!, prefix), connected: true, warnings: healthWarnings(health) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markConnectorError(ctx, site, message);
    return { site: siteOut((await getSite(ctx, site.companyId, site.id))!, prefix), connected: false, error: message };
  }
}

async function markConnectorError(ctx: PluginContext, site: SiteRecord, message: string): Promise<void> {
  // A pending site stays pending until it has answered once.
  const status: ConnectorStatus = site.connectorStatus === "pending" ? "pending" : "error";
  if (site.connectorStatus === status && site.connectorError === message) return;
  await writeSite(ctx, { ...site, connectorStatus: status, connectorError: message.slice(0, 500), updatedAt: new Date().toISOString() }, null);
  await emitSite(ctx, site.companyId, site.id);
}

/** The parts of `health` worth keeping on the record (small, no plugin list beyond names and versions). */
function healthSnapshot(health: Record<string, unknown>): Record<string, unknown> {
  const plugins = Array.isArray(health.plugins) ? health.plugins.slice(0, 80) : [];
  return {
    checkedAt: new Date().toISOString(),
    wordpress: asRecord(health.wordpress).version ?? null,
    php: asRecord(health.php).version ?? null,
    theme: asRecord(health.theme).name ?? null,
    seoPlugin: health.seoPlugin ?? null,
    sitemap: health.sitemap ?? null,
    redirectsProvider: health.redirectsProvider ?? null,
    blogPublic: asRecord(health.site).blogPublic ?? null,
    features: asRecord(health.connector).features ?? null,
    updates: health.updates ?? null,
    plugins: plugins.map((p) => {
      const row = asRecord(p);
      return { name: row.name ?? row.file ?? null, version: row.version ?? null, active: row.active ?? null };
    }),
  };
}

function healthWarnings(health: Record<string, unknown>): string[] {
  const out: string[] = [];
  const site = asRecord(health.site);
  if (site.blogPublic === false || site.blogPublic === 0 || site.blogPublic === "0") {
    out.push("Search engines are discouraged on this site (Settings → Reading). Nothing will rank until that is switched off: wp-robots allowSearchEngines: true.");
  }
  const seo = asRecord(health.seoPlugin);
  if (seo.key === "none") out.push("No SEO plugin: the Connector prints titles, descriptions and schema itself.");
  const updates = asRecord(health.updates);
  if (Number(updates.plugins ?? 0) > 5) out.push(`${updates.plugins} plugin updates are waiting.`);
  return out;
}

// ---------------------------------------------------------------------------
// Connector tools (wp-*)
// ---------------------------------------------------------------------------

/** Tool name → op → endpoint. */
const WP_TOOLS: Record<string, Record<string, ConnectorEndpoint>> = {
  "wp-health": { get: "health" },
  "wp-seo": { get: "seo/get", set: "seo/set" },
  "wp-schema": { get: "schema/get", set: "schema/set" },
  "wp-redirects": { list: "redirects/list", set: "redirects/set", delete: "redirects/delete" },
  "wp-robots": { get: "robots/get", set: "robots/set" },
  "wp-sitemap": { get: "sitemap/get", set: "sitemap/set" },
  "wp-plugins": { list: "plugins/list", backups: "plugins/backups", install: "plugins/install", rollback: "plugins/rollback" },
  "wp-log": { get: "log" },
  "wp-undo": { set: "undo" },
};

export const WP_TOOL_NAMES = Object.keys(WP_TOOLS);

/** Parameters each endpoint passes through to the site (everything else is dropped). */
const PASS: Partial<Record<ConnectorEndpoint, string[]>> = {
  "seo/get": ["url", "postId"],
  "seo/set": ["url", "postId", "title", "description", "canonical", "noindex", "nofollow", "focusKeyword", "ogTitle", "ogDescription", "reason"],
  "schema/get": ["url", "postId", "site"],
  "schema/set": ["url", "postId", "site", "id", "piece", "remove", "reason"],
  "redirects/set": ["from", "to", "code", "reason"],
  "redirects/delete": ["from", "reason"],
  "robots/set": ["extraLines", "allowSearchEngines", "reason"],
  "sitemap/set": ["seoPluginSitemap", "excludePostIds", "reason"],
  "plugins/install": ["zipUrl", "sha256", "slug", "reason"],
  "plugins/rollback": ["backupId", "reason"],
  log: ["limit"],
  undo: ["changeId", "reason"],
};

function targetOf(params: Record<string, unknown>): string | null {
  for (const key of ["url", "from", "slug", "backupId", "changeId"]) {
    if (typeof params[key] === "string" && params[key]) return String(params[key]).slice(0, 300);
  }
  if (typeof params.postId === "number") return `post:${params.postId}`;
  if (params.site === true) return "site";
  return null;
}

export async function runWpTool(ctx: PluginContext, viewer: Viewer, name: string, params: Record<string, unknown>, source: "agent" | "human") {
  const ops = WP_TOOLS[name];
  if (!ops) throw new CrmError(`Unknown tool ${name}`);
  const opNames = Object.keys(ops);
  const op = typeof params.op === "string" && params.op ? params.op : opNames.length === 1 ? opNames[0]! : "";
  const endpoint = ops[op];
  if (!endpoint) throw new CrmError(`op must be one of ${opNames.join(", ")}`);
  const site = await requireSite(ctx, viewer, params);
  if (site.platform !== "wordpress") throw new CrmError(`${site.url} is not a WordPress site`);
  if (!site.connectorKey) {
    throw new CrmError(`${site.url} has no PiB Connector yet. A person connects it on the CRM client page (Websites → Connect WordPress); until then put the exact change set on Needs you.`);
  }
  const writes = CONNECTOR_ENDPOINTS[endpoint];
  const reason = typeof params.reason === "string" ? params.reason.trim().slice(0, 500) : "";
  if (writes && !reason) throw new CrmError("reason is required for a change: one line on why (it is kept in the site's log)");
  if (endpoint === "plugins/install" || endpoint === "plugins/rollback") {
    requirePerson(viewer, source, "install or roll back WordPress plugins through the Connector");
  }
  const body: Record<string, unknown> = {};
  for (const key of PASS[endpoint] ?? []) if (params[key] !== undefined) body[key] = params[key];
  if (reason) body.reason = reason;
  const actor = actorOf(viewer);
  try {
    const data = await callConnector(ctx, site, endpoint, body, { actor });
    if (writes) {
      await recordChange(ctx, {
        companyId: viewer.companyId,
        siteId: site.id,
        endpoint,
        target: targetOf(params),
        reason: reason || null,
        changeRef: typeof data.changeId === "string" ? data.changeId : null,
        ok: true,
        error: null,
        actor,
      });
    }
    if (site.connectorStatus !== "connected") {
      await writeSite(ctx, { ...site, connectorStatus: "connected", connectorError: null, connectorSeenAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, null);
      await emitSite(ctx, viewer.companyId, site.id);
    }
    return {
      siteId: site.id,
      site: site.url,
      endpoint,
      ...data,
      ...(writes
        ? { next: "Check it on the live site (check-meta, validate-schema, check-sitemap or crawler-sim). A page cache can hold the old version for a few minutes. wp-undo with the changeId reverts it." }
        : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (writes) {
      await recordChange(ctx, { companyId: viewer.companyId, siteId: site.id, endpoint, target: targetOf(params), reason: reason || null, changeRef: null, ok: false, error: message.slice(0, 500), actor }).catch(() => undefined);
    }
    if (isConnectionFailure(error)) await markConnectorError(ctx, site, message).catch(() => undefined);
    if (error instanceof ConnectorError && error.code === "pib_disabled") {
      throw new CrmError(`${message} A person switches it on in ${site.url}/wp-admin → Settings → PiB Connector.`);
    }
    throw error;
  }
}

export async function siteChangesTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const site = await requireSite(ctx, viewer, params);
  const limit = Math.min(100, Math.max(1, Number(params.limit ?? 30) || 30));
  return { siteId: site.id, site: site.url, changes: await recentChanges(ctx, viewer.companyId, site.id, limit) };
}

// ---------------------------------------------------------------------------
// Client projects
// ---------------------------------------------------------------------------

interface ProjectLinkRow {
  id: string;
  client_kind: string;
  client_ref: string;
  project_id: string;
  created_at: unknown;
}

async function projectLinks(ctx: PluginContext, companyId: string): Promise<ProjectLinkRow[]> {
  return ctx.db.query<ProjectLinkRow>(
    `SELECT id, client_kind, client_ref, project_id, created_at FROM ${table(ctx, "client_projects")} WHERE company_id = $1 ORDER BY created_at`,
    [companyId],
  );
}

interface ProjectSummary {
  id: string;
  name: string;
  urlKey: string | null;
  status: string | null;
  repoUrl: string | null;
  archived: boolean;
  pluginManaged: boolean;
}

async function companyProjects(ctx: PluginContext, companyId: string): Promise<ProjectSummary[]> {
  const projects = await ctx.projects.list({ companyId, limit: 500 });
  return projects.map((project) => {
    const p = project as unknown as Record<string, unknown> & { managedByPlugin?: unknown };
    const primary = (p.primaryWorkspace ?? null) as { repoUrl?: string | null } | null;
    const codebase = (p.codebase ?? null) as { repoUrl?: string | null } | null;
    return {
      id: String(p.id),
      name: String(p.name ?? "Project"),
      urlKey: typeof p.urlKey === "string" ? p.urlKey : null,
      status: typeof p.status === "string" ? p.status : null,
      repoUrl: primary?.repoUrl ?? codebase?.repoUrl ?? null,
      archived: Boolean(p.archivedAt),
      pluginManaged: Boolean(p.managedByPlugin),
    };
  });
}

function projectOut(project: ProjectSummary, prefix: string | null) {
  return {
    projectId: project.id,
    name: project.name,
    status: project.status,
    repoUrl: project.repoUrl,
    archived: project.archived,
    link: pagePath(prefix, `/projects/${project.urlKey ?? project.id}`),
  };
}

function words(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3 && !["and", "the", "pty", "ltd"].includes(word));
}

/** The client's projects, and (with `candidates`) the company's projects that belong to no client yet. */
export async function clientProjects(ctx: PluginContext, viewer: Viewer, client: { kind: ClientKind; id: string }, name: string, options: { candidates: boolean }) {
  const prefix = await companyPrefix(ctx, viewer.companyId);
  const [links, projects] = await Promise.all([projectLinks(ctx, viewer.companyId), companyProjects(ctx, viewer.companyId).catch(() => [] as ProjectSummary[])]);
  const byId = new Map(projects.map((project) => [project.id, project]));
  const mine = links.filter((link) => link.client_kind === client.kind && link.client_ref === client.id);
  const linked = mine.map((link) => {
    const project = byId.get(link.project_id);
    return project ? projectOut(project, prefix) : { projectId: link.project_id, name: "Project not found (deleted?)", status: null, repoUrl: null, archived: true, link: null };
  });
  if (!options.candidates) return { linked };
  const taken = new Set(links.map((link) => link.project_id));
  const tokens = words(name);
  const candidates = projects
    .filter((project) => !taken.has(project.id) && !project.archived && !project.pluginManaged)
    .map((project) => ({ ...projectOut(project, prefix), suggested: tokens.length > 0 && tokens.some((token) => project.name.toLowerCase().includes(token)) }))
    .sort((a, b) => Number(b.suggested) - Number(a.suggested) || a.name.localeCompare(b.name));
  return { linked, candidates };
}

export async function listClientProjectsTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const client = parseClientRef(params.client);
  const name = await requireClient(ctx, viewer, client);
  const { linked, candidates } = await clientProjects(ctx, viewer, client, name, { candidates: true });
  return {
    client: refOf(client.kind, client.id),
    name,
    projects: linked,
    unlinkedProjects: (candidates ?? []).slice(0, 40),
    ...(linked.length === 0 ? { next: "No projects linked yet. link-client-project links one of unlinkedProjects (suggested ones match the client's name)." } : {}),
  };
}

export async function linkClientProject(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const client = parseClientRef(params.client);
  await requireClient(ctx, viewer, client);
  const projectId = typeof params.projectId === "string" ? params.projectId.trim() : "";
  if (!projectId) throw new CrmError("projectId is required (list-client-projects shows them)");
  const project = await requireProject(ctx, viewer.companyId, projectId);
  const existing = (await projectLinks(ctx, viewer.companyId)).find((link) => link.project_id === project.id);
  if (existing) {
    if (existing.client_kind === client.kind && existing.client_ref === client.id) return { projectId: project.id, name: project.name, client: refOf(client.kind, client.id), alreadyLinked: true };
    throw new CrmError(`${project.name} already belongs to ${refOf(existing.client_kind as ClientKind, existing.client_ref)}. A person unlinks it there first.`);
  }
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "client_projects")} (id, company_id, client_kind, client_ref, project_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (company_id, project_id) DO NOTHING`,
    [randomUUID(), viewer.companyId, client.kind, client.id, project.id, actorOf(viewer)],
  );
  return { projectId: project.id, name: project.name, client: refOf(client.kind, client.id), linked: true };
}

export async function unlinkClientProject(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>, source: "agent" | "human") {
  requirePerson(viewer, source, "unlink a project from a client");
  const client = parseClientRef(params.client);
  await requireClient(ctx, viewer, client);
  const projectId = typeof params.projectId === "string" ? params.projectId.trim() : "";
  if (!projectId) throw new CrmError("projectId is required");
  await ctx.db.execute(
    `DELETE FROM ${table(ctx, "client_projects")} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3 AND project_id = $4`,
    [viewer.companyId, client.kind, client.id, projectId],
  );
  return { projectId, unlinked: true };
}

/** Sites and projects for the client workspace page. */
export async function clientSitesAndProjects(ctx: PluginContext, viewer: Viewer, client: { kind: ClientKind; id: string }, name: string) {
  const prefix = await companyPrefix(ctx, viewer.companyId);
  const [sites, projects, base] = await Promise.all([
    listSites(ctx, viewer.companyId, client.kind, client.id).catch(() => [] as SiteRecord[]),
    clientProjects(ctx, viewer, client, name, { candidates: true }).catch(() => ({ linked: [], candidates: [] })),
    pluginUiBase(ctx),
  ]);
  return {
    sites: sites.map((site) => siteOut(site, prefix)),
    projects: projects.linked,
    projectOptions: projects.candidates ?? [],
    connectorDownload: base ? `${base}pib-connector.zip` : null,
  };
}
