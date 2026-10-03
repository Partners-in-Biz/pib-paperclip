/**
 * What the unsubscribe landing page needs to know (pure, so it is tested without a browser).
 *
 * The page is a static file the host serves at `/_plugins/<installation uuid>/ui/unsubscribe.html?t=<token>`.
 * It posts the token to the plugin's `unsubscribe` webhook on the same host,
 * `/api/plugins/<installation uuid>/webhooks/unsubscribe`. Nothing here checks
 * the signature (a browser cannot): the worker does, and refuses a bad token.
 */

/** The webhook address for a page address, or null when the page is not served from a plugin UI folder. */
export function apiUrlFrom(pathname: string): string | null {
  const match = /^(.*)\/_plugins\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/ui\//i.exec(pathname);
  return match ? `${match[1]}/api/plugins/${match[2]}/webhooks/unsubscribe` : null;
}

/** The token in `?t=...`, or null. */
export function readToken(search: string): string | null {
  const token = new URLSearchParams(search).get("t");
  return token && token.length <= 2000 && token.includes(".") ? token : null;
}

export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

/** The address the token names, masked, for the confirm line. The signature is not checked here. */
export function tokenEmail(token: string): string | null {
  try {
    const body = token.slice(0, token.indexOf("."));
    const base64 = body.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const json = new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
    const value = JSON.parse(json) as { e?: unknown };
    return typeof value.e === "string" && value.e.includes("@") ? maskEmail(value.e) : null;
  } catch {
    return null;
  }
}
