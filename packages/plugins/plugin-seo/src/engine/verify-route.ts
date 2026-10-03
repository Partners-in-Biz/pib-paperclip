/**
 * Site verification on WordPress: from Connector 1.2 the CRM's `wp-verify`
 * tool prints verification meta tags and serves root key files, so the agent
 * does Search Console, Bing and IndexNow verification itself. Pure rules the
 * tools, the Needs you logic and the setup checklist share.
 */

/** The first Connector version (protocol 1.2) with `verify/get` and `verify/set`. */
export const VERIFY_MIN_VERSION = "1.2.0";

/**
 * available: a connected Connector that has wp-verify; update: connected but older (or its version unknown),
 * run wp-connector update first; none: not a wordpress sprint or the Connector is not connected.
 */
export type VerifyRoute = "available" | "update" | "none";

function versionParts(value: unknown): [number, number, number] | null {
  if (typeof value !== "string") return null;
  const match = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value);
  return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : null;
}

/** True when `version` is at least `min` (false when it is not a version). */
export function versionAtLeast(version: unknown, min: string): boolean {
  const left = versionParts(version);
  const right = versionParts(min);
  if (!left || !right) return false;
  for (let i = 0; i < 3; i++) {
    if (left[i]! !== right[i]!) return left[i]! > right[i]!;
  }
  return true;
}

export function verifyRouteOf(input: { siteAccess: string; connectorStatus: string | null | undefined; connectorVersion: string | null | undefined }): VerifyRoute {
  if (input.siteAccess !== "wordpress" || input.connectorStatus !== "connected") return "none";
  return versionAtLeast(input.connectorVersion, VERIFY_MIN_VERSION) ? "available" : "update";
}

export type VerifyKind = "google" | "indexnow" | "bing";

/** What the sprint remembers when the wp-verify route did not work (so the fallback is never silent). */
export interface VerifyFailure {
  at: string;
  error: string;
}

/** Which verification a Needs you item is about, from its key and title; null when it is about something else. */
export function verificationKindOf(item: { key: string; title: string }): VerifyKind | null {
  // Standard grants are not verification work: an API key, an OAuth reconnect, DNS, the Connector itself, the repo.
  if (/^(bing_key|service_account|github_token|site_project|wp_connector|gsc_dns|gsc_reconnect|playbook_changes|indexing_followup|pr:)/.test(item.key)) return null;
  const text = `${item.key} ${item.title}`.toLowerCase();
  if (/indexnow/.test(text)) return "indexnow";
  if (/msvalidate|bingsiteauth|bing[\s_-]*(site|verif|meta|webmaster)/.test(text)) return "bing";
  if (/^gsc_access\b|search console (access|verif|owner|property)|add (our|the) service account|google[\s_-]*site[\s_-]*verif|gsc[\s_-]*(access|verif)|verification[\s_-]*(file|tag|meta)/.test(text)) return "google";
  return null;
}

/** The instruction an agent gets in place of a Needs you item for this kind of verification. */
export function verifyInstruction(kind: VerifyKind, siteId: string): string {
  const base = `Do it yourself with the CRM's \`wp-verify\` tool (siteId \`${siteId}\`): op get, then op set with the existing entries plus your addition and a reason.`;
  if (kind === "google") {
    return `${base} Google: gsc-verification-token (method META, property url) → wp-verify set metaTags [{ name: "google-site-verification", content }] → check-meta on the live home page → gsc-verify-site. The service account becomes a verified owner of a URL-prefix property; the client does not need to add anything.`;
  }
  if (kind === "bing") {
    return `${base} Bing: bing-add-site → wp-verify set metaTags [{ name: "msvalidate.01", content }] (or files [{ path: "/BingSiteAuth.xml", content }]) → fetch the live tag or file → bing-verify-site.`;
  }
  return `${base} IndexNow: indexnow-key → wp-verify set files [{ path: "/<key>.txt", content: "<key>" }] → indexnow-key again (it checks the live file) → request-indexing.`;
}
