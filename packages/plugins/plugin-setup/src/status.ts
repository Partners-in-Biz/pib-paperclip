/**
 * Setup status parsing and stand-in statuses (no node imports).
 */
import { MODULES, type ModuleKey, type SetupItem, type SetupItemStatus, type SetupStatus } from "./kit-setup.js";

export const PLUGINS_PAGE = "/company/settings/instance/plugins";

const ITEM_STATUSES: readonly SetupItemStatus[] = ["done", "missing", "optional", "blocked", "unknown"];

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseItem(raw: unknown): SetupItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const key = str(item.key);
  const title = str(item.title);
  if (!key || !title) return null;
  const status = ITEM_STATUSES.includes(item.status as SetupItemStatus) ? (item.status as SetupItemStatus) : "unknown";
  const action = item.action && typeof item.action === "object" && !Array.isArray(item.action) ? (item.action as Record<string, unknown>) : null;
  return {
    key,
    title,
    status,
    required: item.required === true,
    detail: str(item.detail),
    href: str(item.href) ?? null,
    hrefLabel: str(item.hrefLabel) ?? null,
    steps: Array.isArray(item.steps) ? item.steps.filter((step): step is string => typeof step === "string") : undefined,
    agentNext: str(item.agentNext) ?? null,
    action: action && str(action.plugin) && str(action.key)
      ? {
        plugin: action.plugin as string,
        key: action.key as string,
        label: str(action.label) ?? "Do it for me",
        params: action.params && typeof action.params === "object" && !Array.isArray(action.params) ? (action.params as Record<string, unknown>) : undefined,
      }
      : null,
    blockedBy: Array.isArray(item.blockedBy) ? item.blockedBy.filter((dep): dep is string => typeof dep === "string") : undefined,
  };
}

/**
 * A `SetupStatus` from a route body or event payload (plain, or wrapped in
 * `{ data }` / `{ status }`). Null when it is not a status.
 */
export function parseSetupStatus(body: unknown, fallbackPlugin?: string): SetupStatus | null {
  let root = body;
  for (let i = 0; i < 2; i += 1) {
    if (root && typeof root === "object" && !Array.isArray(root) && !Array.isArray((root as Record<string, unknown>).items)) {
      const inner = (root as Record<string, unknown>).data ?? (root as Record<string, unknown>).status;
      if (inner && typeof inner === "object") root = inner;
    }
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) return null;
  const source = root as Record<string, unknown>;
  if (!Array.isArray(source.items)) return null;
  const plugin = str(source.plugin) ?? fallbackPlugin;
  if (!plugin) return null;
  const items = source.items.map(parseItem).filter((item): item is SetupItem => item !== null);
  const module = typeof source.module === "string" && source.module in MODULES ? (source.module as ModuleKey) : null;
  const checkedAt = str(source.checkedAt) && !Number.isNaN(Date.parse(source.checkedAt as string)) ? (source.checkedAt as string) : new Date().toISOString();
  return {
    plugin,
    module,
    title: str(source.title) ?? plugin,
    version: str(source.version) ?? null,
    items,
    checkedAt,
  };
}

export type StandInKind = "not-ready" | "no-settings" | "not-installed";

/** One-item status for a plugin that cannot report (not installed, not ready, route missing, never reported). */
export function standInStatus(input: { pluginKey: string; module: ModuleKey; kind: StandInKind; pluginId?: string | null; reason?: string }): SetupStatus {
  const title = MODULES[input.module]?.title ?? input.pluginKey;
  const settingsHref = `${PLUGINS_PAGE}/${input.pluginId ?? input.pluginKey}`;
  const item: SetupItem = input.kind === "no-settings"
    ? {
      key: "settings",
      title: "Save the plugin settings",
      status: "missing",
      required: true,
      detail: "The plugin has not reported its setup yet. It does once its settings are saved for this company.",
      href: settingsHref,
      hrefLabel: "Open settings",
      steps: ["Open the plugin's settings page.", "Fill in what you have (secrets can come later).", "Click Save Configuration."],
      agentNext: null,
    }
    : input.kind === "not-installed"
      ? {
        key: "install",
        title: `Install the ${title} plugin`,
        status: "missing",
        required: true,
        detail: "This module is switched on, but its plugin is not installed on this Paperclip.",
        href: PLUGINS_PAGE,
        hrefLabel: "Open plugins",
        steps: ["Open Settings → Plugins.", `Install the ${title} plugin.`, "Come back here and check again."],
        agentNext: null,
      }
      : {
        key: "plugin",
        title: "Update or enable the plugin",
        status: "missing",
        required: true,
        detail: input.reason ?? "The plugin did not answer the setup check. It may be disabled, still starting, or older than this Setup page.",
        href: PLUGINS_PAGE,
        hrefLabel: "Open plugins",
        steps: ["Open Settings → Plugins.", "Enable or upgrade the plugin.", "Come back here and check again."],
        agentNext: null,
      };
  return { plugin: input.pluginKey, module: input.module, title, version: null, items: [item], checkedAt: new Date().toISOString() };
}

/** A Paperclip path (no company prefix) or https URL → a link for the given company prefix. */
export function linkFor(href: string, prefix: string | null): string {
  if (/^https?:\/\//i.test(href)) return href;
  const path = href.startsWith("/") ? href : `/${href}`;
  return prefix ? `/${prefix}${path}` : path;
}
