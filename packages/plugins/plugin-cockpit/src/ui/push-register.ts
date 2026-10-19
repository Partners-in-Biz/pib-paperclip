/**
 * @fileoverview Pure, testable helpers for service worker push notification registration.
 *
 * No direct use of window/navigator globals; everything is injected.
 * This module exports standard RFC 8291 web push helpers plus the registration flow.
 */

/**
 * The plugin's service worker script URL (plugin key-based, not UUID).
 * Built from PLUGIN_KEY in constants.ts.
 */
export const PUSH_SW_URL = "/_plugins/partnersinbiz.cockpit/ui/push-sw.js";

/**
 * Register a push service worker with auto-update on load.
 *
 * - Registers with updateViaCache: "none" so changed push-sw.js replaces the worker
 * - Calls reg.update() to ensure a changed script is picked up on next load
 * - Swallows update() errors and still returns the registration
 * - No explicit scope (defaults to the script's directory)
 *
 * @param sw - ServiceWorkerContainer with register method
 * @param scriptUrl - URL to the push service worker script
 * @returns Promise resolving to the registration
 */
export async function registerPushServiceWorker(
  sw: { register(url: string, opts?: { updateViaCache?: "none" | "all" | "imports"; scope?: string }): Promise<{ update?(): Promise<unknown> }> },
  scriptUrl = PUSH_SW_URL,
) {
  const registration = await sw.register(scriptUrl, { updateViaCache: "none" });
  // Attempt to update in the background; swallow errors so registration is still returned.
  if (registration.update) {
    registration.update().catch(() => {});
  }
  return registration;
}

/**
 * Convert a base64url-encoded string to Uint8Array.
 *
 * Standard helper for applicationServerKey in push subscription.
 * Handles base64url (uses - and _ instead of + and /), no padding.
 *
 * @param b64url - Base64url string (no padding)
 * @returns Uint8Array of the decoded bytes
 */
export function urlBase64ToUint8Array(b64url: string): Uint8Array {
  // Add padding if needed
  const padlen = 4 - (b64url.length % 4);
  const b64 = b64url + (padlen < 4 ? "=".repeat(padlen) : "");
  // Convert base64 to binary string
  const binaryString = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  // Convert binary string to Uint8Array
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Extract push subscription keys and encode them for the server.
 *
 * @param sub - Push subscription with endpoint and getKey method
 * @param label - User agent or other identifier (truncated to 60 chars)
 * @returns Object with endpoint and base64url-encoded p256dh/auth keys
 * @throws If a required key is missing
 */
export function subscriptionToPayload(
  sub: { endpoint: string; getKey(name: "p256dh" | "auth"): ArrayBuffer | null },
  label: string,
): { endpoint: string; p256dh: string; auth: string; label: string } {
  const p256dhBuf = sub.getKey("p256dh");
  const authBuf = sub.getKey("auth");
  if (!p256dhBuf || !authBuf) {
    throw new Error("Missing push subscription keys (p256dh or auth)");
  }
  return {
    endpoint: sub.endpoint,
    p256dh: uint8ArrayToBase64Url(new Uint8Array(p256dhBuf)),
    auth: uint8ArrayToBase64Url(new Uint8Array(authBuf)),
    label: label.slice(0, 60),
  };
}

/**
 * Convert Uint8Array to base64url (no padding).
 */
function uint8ArrayToBase64Url(arr: Uint8Array): string {
  const binaryString = String.fromCharCode(...arr);
  const b64 = btoa(binaryString);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Describe the push notification environment for display.
 *
 * @param env - Environment flags (self, top, feature availability, permission, standalone)
 * @returns Object with frame type ("host page" or "iframe") and status lines
 */
export function describePushEnvironment(env: {
  self: unknown;
  top: unknown;
  hasPushManager: boolean;
  hasServiceWorker: boolean;
  hasNotification: boolean;
  permission?: string;
  standalone?: boolean;
}): { frame: "host page" | "iframe"; lines: string[] } {
  const lines: string[] = [];
  const frame = env.self !== env.top ? "iframe" : "host page";

  if (!env.hasServiceWorker) {
    lines.push("ServiceWorker API not available");
  } else {
    lines.push("✓ ServiceWorker available");
  }

  if (!env.hasPushManager) {
    lines.push("PushManager not available (ServiceWorker API present but no push support)");
  } else {
    lines.push("✓ PushManager available");
  }

  if (!env.hasNotification) {
    lines.push("Notification API not available");
  } else {
    lines.push("✓ Notification API available");
    if (env.permission) {
      lines.push(`  Permission: ${env.permission}`);
    }
  }

  if (env.standalone) {
    lines.push("✓ Installed as app (PWA)");
  }

  return { frame, lines };
}
