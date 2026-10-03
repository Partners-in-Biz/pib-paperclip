/**
 * A client's WordPress sites, as the CRM projects them into `crm_sites`
 * (`site.upserted` / `site.deleted`). A `wordpress` sprint changes its site
 * through the CRM's PiB Connector tools; the projection never holds the key.
 */
import { getCrmSite, listCrmSites, type CrmSiteRow } from "@partnersinbiz/pib-plugin-kit";
import { sameSite, siteSummary, type ConnectorStatus, type SitePlatform, type SiteSeoPlugin, type SiteAccessKind } from "@partnersinbiz/pib-plugin-kit/client-sites";
import * as db from "../db.js";
import { wpConnectorItem, wpSftpItem } from "../engine/items.js";
import { verifyRouteOf, type VerifyFailure, type VerifyKind, type VerifyRoute } from "../engine/verify-route.js";
import type { NewNeedsYouItem } from "../engine/needs-you.js";
import { crmClientPath } from "../engine/setup.js";
import { NAMESPACE } from "../namespace.js";
import { SeoError, type Env } from "./common.js";

export interface WordPressSiteView {
  siteId: string;
  url: string;
  label: string | null;
  seoPlugin: string | null;
  hosting: string | null;
  connectorStatus: string;
  connected: boolean;
  connectorSeenAt: string | null;
  /** "WordPress · Yoast SEO · Connector connected" */
  summary: string;
}

function accessList(value: unknown): SiteAccessKind[] {
  if (Array.isArray(value)) return value.map(String) as SiteAccessKind[];
  // A text[] that came back as its Postgres literal, e.g. {repo,connector}.
  if (typeof value === "string") return value.replace(/^\{|\}$/g, "").split(",").map((v) => v.trim().replace(/^"|"$/g, "")).filter(Boolean) as SiteAccessKind[];
  return [];
}

function seenAt(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" && value ? value : null;
}

export function wordPressSiteView(site: CrmSiteRow): WordPressSiteView {
  return {
    siteId: site.id,
    url: site.url,
    label: site.label,
    seoPlugin: site.seo_plugin,
    hosting: site.hosting,
    connectorStatus: site.connector_status,
    connected: site.connector_status === "connected",
    connectorSeenAt: seenAt(site.connector_seen_at),
    summary: siteSummary({
      platform: site.platform as SitePlatform,
      seoPlugin: (site.seo_plugin as SiteSeoPlugin | null) ?? null,
      access: accessList(site.access),
      connectorStatus: (site.connector_status as ConnectorStatus) ?? "none",
    }),
  };
}

/** The projected site of a `wordpress` sprint, or null (other modes, or the site was removed from the CRM). */
export async function sprintWordPressSite(env: Env, sprint: db.Sprint): Promise<CrmSiteRow | null> {
  if (sprint.siteAccess !== "wordpress" || !sprint.siteId) return null;
  try {
    return await getCrmSite(env.ctx, NAMESPACE, sprint.companyId, sprint.siteId);
  } catch {
    return null;
  }
}

/** The sprint client's WordPress sites (none for PiB's own sprints). */
export async function clientWordPressSites(env: Env, sprint: Pick<db.Sprint, "companyId" | "clientKind" | "clientRef">): Promise<CrmSiteRow[]> {
  if (!sprint.clientRef) return [];
  const rows = await listCrmSites(env.ctx, NAMESPACE, sprint.companyId, { kind: sprint.clientKind ?? "company", id: sprint.clientRef });
  return rows.filter((site) => site.platform === "wordpress");
}

/** A CRM site this sprint may link in wordpress mode, or a plain-English refusal. */
export async function requireWordPressSite(env: Env, sprint: db.Sprint, siteId: string): Promise<CrmSiteRow> {
  if (!sprint.clientRef) {
    throw new SeoError("This is one of Partners in Biz's own sprints. A WordPress site from the CRM can only be linked to its own client's sprint.");
  }
  const site = await getCrmSite(env.ctx, NAMESPACE, sprint.companyId, siteId);
  if (!site) throw new SeoError(`Website ${siteId} was not found in the CRM. Add it on the CRM client page → Websites (the SEO plugin sees it a moment later).`);
  if (site.platform !== "wordpress") throw new SeoError(`${site.url} is not a WordPress site in the CRM, so the PiB Connector cannot reach it. Use projectId (repo) or noRepo instead.`);
  if (site.client_ref !== sprint.clientRef || (site.client_kind ?? "company") !== (sprint.clientKind ?? "company")) {
    throw new SeoError(`${site.url} belongs to a different CRM client than this sprint (${sprint.clientName ?? "its client"}).`);
  }
  return site;
}

/**
 * On sprint creation: the client's one WordPress site at the sprint's URL
 * with a connected Connector, else null (then a person links it).
 */
export async function autoLinkWordPressSite(env: Env, sprint: db.Sprint): Promise<CrmSiteRow | null> {
  const matches = (await clientWordPressSites(env, sprint)).filter((site) => sameSite(site.url, sprint.siteUrl));
  if (matches.length !== 1) return null;
  return matches[0]!.connector_status === "connected" ? matches[0]! : null;
}

/** The CRM client page of a sprint (Websites is on it). */
export function sprintCrmPath(prefix: string | null, sprint: Pick<db.Sprint, "clientKind" | "clientRef">): string {
  return crmClientPath(prefix, sprint.clientRef ? { kind: sprint.clientKind ?? "company", id: sprint.clientRef } : null);
}

/** The standard `wp_connector` Needs you item for a sprint's WordPress site. */
export function wpConnectorItemFor(ctx: { prefix: string | null }, sprint: db.Sprint, site: CrmSiteRow | null, taskIds: string[] = []): NewNeedsYouItem {
  return wpConnectorItem({ clientName: sprint.clientName, clientPath: sprintCrmPath(ctx.prefix, sprint), siteUrl: site?.url ?? sprint.siteUrl }, taskIds);
}

export function wpSftpItemFor(ctx: { prefix: string | null }, sprint: db.Sprint, site: CrmSiteRow | null, taskIds: string[] = []): NewNeedsYouItem {
  return wpSftpItem(
    {
      clientName: sprint.clientName,
      clientPath: sprintCrmPath(ctx.prefix, sprint),
      siteUrl: site?.url ?? sprint.siteUrl,
      projectPath: sprint.clientProjectId ? `${ctx.prefix ? `/${ctx.prefix}` : ""}/projects/${sprint.clientProjectId}` : null,
    },
    taskIds,
  );
}

/** Whether the sprint's WordPress site has SFTP access recorded in the CRM (theme and template edits). */
export async function sprintHasSftp(env: Env, sprint: db.Sprint): Promise<boolean> {
  const site = await sprintWordPressSite(env, sprint);
  return Boolean(site && Array.isArray(site.access) && site.access.includes("sftp"));
}

/**
 * Whether the sprint's WordPress site can take verification tags and key files through the CRM's `wp-verify`
 * (Connector 1.2+). `update` = connected but older: run wp-connector update first.
 */
export async function sprintVerifyRoute(env: Env, sprint: db.Sprint): Promise<{ route: VerifyRoute; siteId: string | null; siteUrl: string | null; connectorVersion: string | null }> {
  const site = await sprintWordPressSite(env, sprint);
  if (!site) return { route: "none", siteId: null, siteUrl: null, connectorVersion: null };
  return {
    route: verifyRouteOf({ siteAccess: sprint.siteAccess, connectorStatus: site.connector_status, connectorVersion: site.connector_version }),
    siteId: site.id,
    siteUrl: site.url,
    connectorVersion: site.connector_version ?? null,
  };
}

/** The recorded failure of the wp-verify route for one kind of verification, or null. */
export function verifyFailureOf(sprint: Pick<db.Sprint, "verification">, kind: VerifyKind): VerifyFailure | null {
  const all = (sprint.verification.wpVerifyFailures ?? {}) as Partial<Record<VerifyKind, VerifyFailure>>;
  const entry = all[kind];
  return entry && typeof entry.at === "string" ? entry : null;
}

/**
 * Remember on the sprint that the wp-verify route failed for `kind` (or, with `error` null, that it now works), so
 * falling back to a person is never silent and a success reopens the self-serve route. No-op when nothing changes.
 */
export async function setVerifyFailure(env: Env, sprint: db.Sprint, kind: VerifyKind, error: string | null): Promise<db.Sprint> {
  const all = { ...((sprint.verification.wpVerifyFailures ?? {}) as Partial<Record<VerifyKind, VerifyFailure>>) };
  if (error === null) {
    if (!all[kind]) return sprint;
    delete all[kind];
  } else {
    all[kind] = { at: env.now().toISOString(), error: error.slice(0, 500) };
  }
  const verification = { ...sprint.verification, wpVerifyFailures: all };
  await db.updateSprint(env.ctx.db, sprint.companyId, sprint.id, { verification });
  return { ...sprint, verification };
}
