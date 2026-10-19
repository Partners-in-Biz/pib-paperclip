import { isIP } from "node:net";

/**
 * The four allowed push service host families per the plan.
 */
export const ALLOWED_PUSH_HOSTS = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  // Wildcards for Apple and Windows
  ".push.apple.com", // Matches *.push.apple.com
  ".notify.windows.com", // Matches *.notify.windows.com
];

/**
 * Check if a push endpoint URL is allowed.
 * Never throws; returns false for invalid/disallowed URLs.
 *
 * Requirements:
 * - Protocol must be https
 * - No username/password
 * - No explicit port (reject any explicit port including 8443; :443 is OK as URL drops it)
 * - Hostname must not be an IP literal (no IPv4, IPv6, or IPv6 bracket form)
 * - Hostname must not be localhost
 * - Hostname must exactly match or be a proper subdomain of one of the allowed families
 *
 * @param url The endpoint URL to validate
 * @returns true if allowed, false otherwise
 */
export function isAllowedPushEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);

    // Check protocol
    if (parsed.protocol !== "https:") {
      return false;
    }

    // Check no username/password
    if (parsed.username || parsed.password) {
      return false;
    }

    // Check no explicit port (reject any explicit port)
    // URL drops :443 automatically, so if port is set it's explicit
    if (parsed.port) {
      return false;
    }

    let hostname = parsed.hostname;
    if (!hostname) {
      return false;
    }

    // Lowercase for comparison
    hostname = hostname.toLowerCase();

    // Strip trailing dot
    if (hostname.endsWith(".")) {
      hostname = hostname.slice(0, -1);
    }

    // Check not an IP literal (includes IPv4, IPv6, and IPv6 bracket form)
    if (isIP(hostname) !== 0) {
      return false;
    }

    // Also check IPv6 bracket form (e.g., [::1])
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      return false;
    }

    // Check not localhost
    if (hostname === "localhost") {
      return false;
    }

    // Check against allowed families
    for (const family of ALLOWED_PUSH_HOSTS) {
      if (family.startsWith(".")) {
        // Wildcard family (e.g., .push.apple.com matches *.push.apple.com)
        // Require at least one non-empty label before the suffix
        const suffix = family; // Includes the leading dot
        if (hostname.endsWith(suffix)) {
          // Extract the part before the suffix
          const prefix = hostname.slice(0, hostname.length - suffix.length);
          // Require at least one non-empty label (no bare apex like push.apple.com)
          if (prefix && prefix !== "" && !prefix.includes(".")) {
            // Single label before suffix (e.g., "api" in "api.push.apple.com")
            return true;
          } else if (prefix.includes(".")) {
            // Multiple labels (e.g., "sub.domain" in "sub.domain.push.apple.com")
            return true;
          }
        }
      } else {
        // Exact match only (no subdomains)
        if (hostname === family) {
          return true;
        }
      }
    }

    return false;
  } catch {
    // Any parsing error means invalid URL
    return false;
  }
}
