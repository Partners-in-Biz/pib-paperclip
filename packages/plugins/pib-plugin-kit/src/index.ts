export * from "./skills.js";
export * from "./crypto.js";
export * from "./config.js";
export * from "./r2.js";
export * from "./safe-fetch.js";
export * from "./issues.js";
export * from "./crm-projection.js";
export * from "./client-ref.js";
export * from "./agent-hire.js";
export * from "./contracts.js";
export * from "./outbox.js";
export * from "./decisions.js";
export * from "./experiments.js";
export * from "./pdf.js";
export * from "./tool-result.js";
export * from "./setup.js";

import type { PluginContext } from "@paperclipai/plugin-sdk";

const UI_BASE_RE = /^\/_plugins\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/ui\/$/;
const UI_BASE_STATE = { scopeKind: "instance" as const, namespace: "pib-kit", stateKey: "plugin-ui-base" };
let uiBaseCache: string | null = null;

/** `/_plugins/<installation uuid>/ui/` or null when the value is not that shape. */
export function parsePluginUiBase(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return UI_BASE_RE.test(trimmed) ? trimmed : null;
}

/**
 * Store the plugin's UI base the page reported (see `pluginUiBaseFromModule`).
 * The host serves static plugin files only by installation uuid, which the
 * worker cannot see, so OAuth redirect URIs are built from this.
 */
export async function rememberPluginUiBase(ctx: PluginContext, value: unknown): Promise<string | null> {
  const base = parsePluginUiBase(value);
  if (!base) return null;
  if (uiBaseCache === base) return base;
  try {
    const stored = await ctx.state.get(UI_BASE_STATE);
    if (stored !== base) await ctx.state.set(UI_BASE_STATE, base);
    uiBaseCache = base;
  } catch (error) {
    ctx.logger.info("Could not store the plugin UI base", { error: error instanceof Error ? error.message : String(error) });
  }
  return base;
}

/** The stored UI base, or null until the plugin's page has been opened once. */
export async function pluginUiBase(ctx: PluginContext): Promise<string | null> {
  if (uiBaseCache) return uiBaseCache;
  try {
    uiBaseCache = parsePluginUiBase(await ctx.state.get(UI_BASE_STATE));
  } catch {
    uiBaseCache = null;
  }
  return uiBaseCache;
}

/**
 * The redirect URI to register with providers:
 * `<publicBaseUrl>/_plugins/<installation uuid>/ui/oauth-callback.html`.
 * The uuid changes only if the plugin is uninstalled and installed again.
 */
export function oauthCallbackUrl(publicBaseUrl: string, uiBase: string): string {
  const base = parsePluginUiBase(uiBase);
  if (!base) throw new Error("The plugin's callback address is not known yet. Open the plugin's page once, then try again.");
  return `${publicBaseUrl.replace(/\/$/, "")}${base}oauth-callback.html`;
}

/** Plugin API route path as seen from the browser. */
export function pluginApiPath(pluginId: string, routePath: string): string {
  return `/api/plugins/${pluginId}/api${routePath.startsWith("/") ? routePath : `/${routePath}`}`;
}

export function requirePublicBaseUrl(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    throw new Error("Public base URL is not set. Add it in the plugin settings (e.g. https://paperclip.partnersinbiz.online).");
  }
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("Public base URL must use https (http is only allowed for localhost).");
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`;
}
