/** Where client preview links live, and how they read. Kept apart so the build hand-off can use them without a cycle through preview.ts. */
export const PREVIEW_BASE = "https://preview.partnersinbiz.online";

/**
 * The preview service's loopback-only render endpoint (same VPS as the worker): POST `{url}` -> `{html}`, the live
 * page's DOM after its scripts ran at 1280 px. Fixed on purpose: no tool parameter may change where this goes,
 * because it is called with `env.fetch` (the host's SSRF guard refuses loopback).
 */
// 3033, not 3032: 3032 is the Social approval service (pib-approval.service, behind Caddy) on the same VPS (PAR-8799).
export const PREVIEW_RENDER_URL = "http://127.0.0.1:3033/render";

/** The readable part of a preview link: the site's name, e.g. huntandgun for huntandgun.co.za. Cosmetic; the token is the secret. */
export function previewSlug(siteUrl: string): string {
  try {
    const host = new URL(/^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`).hostname.replace(/^www\./, "");
    return host.split(".")[0]!.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 30) || "site";
  } catch {
    return "site";
  }
}

export function previewLink(siteUrl: string, id: string): string {
  return `${PREVIEW_BASE}/p/${previewSlug(siteUrl)}/${id}`;
}

