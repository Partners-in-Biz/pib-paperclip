export const PUSH_SW_FILE = "push-sw.js";

/**
 * Build the push service worker URL from a plugin UI base.
 * Validates that the base matches the installation ID pattern.
 * @param uiBase - The plugin UI base URL (e.g., `/_plugins/<uuid>/ui/`)
 * @returns The full URL to push-sw.js
 * @throws Error if uiBase is invalid
 */
export function buildPushSwUrl(uiBase: string): string {
  const uuidPattern = /^\/_plugins\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/ui\/$/i;
  if (!uuidPattern.test(uiBase)) {
    throw new Error(`Invalid plugin UI base: must match /_plugins/<uuid>/ui/ pattern, got: ${uiBase}`);
  }
  return uiBase + PUSH_SW_FILE;
}

/**
 * Resolve the push service worker URL by installation ID.
 * First tries to extract the UUID from the module URL; if that fails,
 * queries the host API for the plugin installation ID.
 * @param moduleUrl - Optional module URL (typically import.meta.url from the UI bundle)
 * @returns The full URL to push-sw.js using the installation ID
 * @throws Error if the URL cannot be resolved
 */
export async function resolvePushSwUrl(moduleUrl?: string): Promise<string> {
  const { resolvePluginUiBase } = await import("@partnersinbiz/pib-plugin-kit/oauth-client");
  const uiBase = await resolvePluginUiBase("partnersinbiz.cockpit", moduleUrl);
  if (!uiBase) {
    throw new Error("Could not find the Cockpit plugin address");
  }
  return buildPushSwUrl(uiBase);
}

export type ServiceWorkerLike = {
  active?: { state: string } | null;
  installing?: { state: string; addEventListener(event: string, listener: () => void): void } | null;
  waiting?: { state: string; addEventListener(event: string, listener: () => void): void } | null;
  pushManager?: { subscribe(opts: unknown): Promise<unknown> };
  update?(): Promise<unknown>;
};

export async function registerPushServiceWorker(
  sw: { register(url: string, opts?: { updateViaCache?: "none" | "all" | "imports"; scope?: string }): Promise<ServiceWorkerLike> },
  scriptUrl: string,
): Promise<ServiceWorkerLike> {
  const registration = await sw.register(scriptUrl, { updateViaCache: "none" });
  if (registration.update) {
    registration.update().catch(() => {});
  }
  return registration;
}

export async function waitForActivated(
  registration: ServiceWorkerLike,
  timeoutMs = 10000,
): Promise<ServiceWorkerLike> {
  if (registration.active) return registration;
  const worker = registration.installing ?? registration.waiting;
  if (!worker) throw new Error("No installing or waiting worker found");
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("waitForActivated timeout")), timeoutMs);
    worker.addEventListener("statechange", () => {
      if (worker.state === "activated") {
        clearTimeout(timeout);
        resolve(registration);
      } else if (worker.state === "redundant") {
        clearTimeout(timeout);
        reject(new Error("Service worker became redundant"));
      }
    });
  });
}

export function urlBase64ToUint8Array(b64url: string): Uint8Array {
  const padlen = 4 - (b64url.length % 4);
  const b64 = b64url + (padlen < 4 ? "=".repeat(padlen) : "");
  const binaryString = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes;
}

export function subscriptionToPayload(
  sub: { endpoint: string; getKey(name: "p256dh" | "auth"): ArrayBuffer | null },
  label: string,
): { endpoint: string; p256dh: string; auth: string; label: string } {
  const p256dhBuf = sub.getKey("p256dh");
  const authBuf = sub.getKey("auth");
  if (!p256dhBuf || !authBuf) throw new Error("Missing push subscription keys (p256dh or auth)");
  return {
    endpoint: sub.endpoint,
    p256dh: uint8ArrayToBase64Url(new Uint8Array(p256dhBuf)),
    auth: uint8ArrayToBase64Url(new Uint8Array(authBuf)),
    label: label.slice(0, 60),
  };
}

function uint8ArrayToBase64Url(arr: Uint8Array): string {
  const binaryString = String.fromCharCode(...arr);
  const b64 = btoa(binaryString);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

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
  const frame = env.self === env.top ? "host page" : "iframe";
  if (!env.hasServiceWorker) lines.push("ServiceWorker API not available");
  else lines.push("✓ ServiceWorker available");
  if (!env.hasPushManager) lines.push("PushManager not available");
  else lines.push("✓ PushManager available");
  if (!env.hasNotification) lines.push("Notification API not available");
  else {
    lines.push("✓ Notification API available");
    if (env.permission) lines.push(`  Permission: ${env.permission}`);
  }
  if (env.standalone) lines.push("✓ Installed as app (PWA)");
  return { frame, lines };
}
