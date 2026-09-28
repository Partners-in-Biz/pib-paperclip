/**
 * A client's websites, as the CRM keeps them (browser-safe, no node imports;
 * import via `@partnersinbiz/pib-plugin-kit/client-sites`).
 *
 * A client (CRM company or contact) can have several sites. Each site says
 * what it is built on and how agents may reach it:
 * - `repo`: a Paperclip project whose workspace holds the site's code;
 * - `connector`: the PiB Connector WordPress plugin (signed SEO changes);
 * - `sftp`: file access for deploying our own WordPress plugins, with the
 *   login bound as env on the site's Paperclip project.
 *
 * The CRM owns the records and the Connector key. Other plugins get a
 * projection (no key) through `site.upserted` / `site.deleted` events.
 */

export const SITE_PLATFORMS = ["wordpress", "nextjs", "custom", "shopify", "wix", "other"] as const;
export type SitePlatform = (typeof SITE_PLATFORMS)[number];

export const SITE_SEO_PLUGINS = ["yoast", "rankmath", "none"] as const;
export type SiteSeoPlugin = (typeof SITE_SEO_PLUGINS)[number];

export const SITE_ACCESS_KINDS = ["repo", "connector", "sftp"] as const;
export type SiteAccessKind = (typeof SITE_ACCESS_KINDS)[number];

export const CONNECTOR_STATUSES = ["none", "pending", "connected", "error"] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

export const SITE_PLATFORM_LABELS: Record<SitePlatform, string> = {
  wordpress: "WordPress",
  nextjs: "Next.js",
  custom: "Custom code",
  shopify: "Shopify",
  wix: "Wix",
  other: "Other",
};

export const SITE_SEO_PLUGIN_LABELS: Record<SiteSeoPlugin, string> = {
  yoast: "Yoast SEO",
  rankmath: "Rank Math",
  none: "No SEO plugin",
};

export const CONNECTOR_STATUS_LABELS: Record<ConnectorStatus, string> = {
  none: "Not connected",
  pending: "Waiting for the key",
  connected: "Connected",
  error: "Not answering",
};

/** The site as other plugins see it (never carries the Connector key). */
export interface CrmSiteEvent {
  id: string;
  clientKind: "company" | "contact";
  clientRef: string;
  label: string | null;
  url: string;
  platform: SitePlatform;
  seoPlugin: SiteSeoPlugin | null;
  hosting: string | null;
  access: SiteAccessKind[];
  projectId: string | null;
  connectorStatus: ConnectorStatus;
  connectorVersion: string | null;
  connectorSeenAt: string | null;
  updatedAt: string;
}

/** One line for pages and briefs: "WordPress · Yoast SEO · Connector connected". */
export function siteSummary(site: Pick<CrmSiteEvent, "platform" | "seoPlugin" | "access" | "connectorStatus">): string {
  const parts: string[] = [SITE_PLATFORM_LABELS[site.platform] ?? "Other"];
  if (site.platform === "wordpress" && site.seoPlugin) parts.push(SITE_SEO_PLUGIN_LABELS[site.seoPlugin]);
  if (site.access.includes("connector") || site.connectorStatus !== "none") {
    parts.push(site.connectorStatus === "connected" ? "Connector connected" : `Connector: ${CONNECTOR_STATUS_LABELS[site.connectorStatus].toLowerCase()}`);
  }
  if (site.access.includes("repo")) parts.push("Repo");
  if (site.access.includes("sftp")) parts.push("SFTP");
  return parts.join(" · ");
}

/** `https://www.Example.com/path/` → `https://example.com` style origin used to match sites. */
export function siteKey(url: string): string | null {
  try {
    const trimmed = url.trim();
    const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** True when two URLs point at the same site (host without www). */
export function sameSite(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ka = siteKey(a);
  return ka !== null && ka === siteKey(b);
}
