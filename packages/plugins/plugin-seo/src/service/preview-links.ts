/** Where client preview links live, and how they read. Kept apart so the build hand-off can use them without a cycle through preview.ts. */
export const PREVIEW_BASE = "https://preview.partnersinbiz.online";

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

