/**
 * Content of the weekly "Finish setup" issue (pure).
 */
import { MODULES, setupProgress, type ModuleKey, type SetupItem, type SetupStatus } from "./kit-setup.js";
import { ORDERED_MODULES, effectiveModules } from "./modules.js";
import { linkFor, standInStatus } from "./status.js";

export interface InstalledPlugin {
  id: string;
  status?: string | null;
}

export interface FinishSetupInput {
  modules: Partial<Record<ModuleKey, boolean>> | null;
  /** Latest status per plugin key (from the projection). */
  statuses: Record<string, SetupStatus | null | undefined>;
  /** Installed plugins by key, as last seen by the Setup page. Null = unknown. */
  installed: Record<string, InstalledPlugin> | null;
  /** Company issue prefix for links, e.g. `PIB`. */
  prefix: string | null;
}

export interface FinishSetupMissing {
  module: ModuleKey;
  pluginKey: string;
  item: SetupItem;
}

export interface FinishSetupContent {
  title: string;
  description: string;
  missing: FinishSetupMissing[];
}

/**
 * Missing required items of enabled modules, plus enabled installed modules
 * that never reported ("settings not saved yet"). Null when nothing required
 * is missing.
 */
export function finishSetupMissing(input: FinishSetupInput): { missing: FinishSetupMissing[]; notInstalled: ModuleKey[]; sections: Array<{ module: ModuleKey; pluginKey: string; status: SetupStatus; missing: SetupItem[] }> } {
  const modules = effectiveModules(input.modules);
  const missing: FinishSetupMissing[] = [];
  const notInstalled: ModuleKey[] = [];
  const sections: Array<{ module: ModuleKey; pluginKey: string; status: SetupStatus; missing: SetupItem[] }> = [];
  for (const module of ORDERED_MODULES) {
    if (!modules[module]) continue;
    for (const pluginKey of MODULES[module].plugins as readonly string[]) {
      let status = input.statuses[pluginKey] ?? null;
      if (!status) {
        const installed = input.installed ? input.installed[pluginKey] : undefined;
        if (input.installed && !installed) {
          notInstalled.push(module);
          continue;
        }
        status = standInStatus({ pluginKey, module, kind: "no-settings", pluginId: installed?.id ?? null });
      }
      const items = setupProgress(status.items ?? []).missing;
      if (items.length === 0) continue;
      sections.push({ module, pluginKey, status, missing: items });
      for (const item of items) missing.push({ module, pluginKey, item });
    }
  }
  return { missing, notInstalled, sections };
}

function itemLine(item: SetupItem, prefix: string | null): string {
  const parts = [`- [ ] **${item.title}**`];
  if (item.status === "blocked") parts.push("(waiting on another item)");
  if (item.detail) parts.push(`— ${item.detail}`);
  if (item.href) parts.push(`[${item.hrefLabel || "Open"}](${linkFor(item.href, prefix)})`);
  const lines = [parts.join(" ")];
  if (item.action) lines.push(`  - The Setup page can do this for you: "${item.action.label}".`);
  if (item.agentNext) lines.push(`  - Once done: ${item.agentNext}`);
  return lines.join("\n");
}

export function finishSetupContent(input: FinishSetupInput): FinishSetupContent | null {
  const { missing, notInstalled, sections } = finishSetupMissing(input);
  if (missing.length === 0) return null;
  const setupLink = linkFor("/setup", input.prefix);
  const lines: string[] = [
    `Setup is not finished for this company: ${missing.length} required ${missing.length === 1 ? "item is" : "items are"} missing. Each one links to where it is fixed.`,
    "",
    `[Open the Setup page](${setupLink}) for guided setup and "Do it for me".`,
  ];
  for (const section of sections) {
    const progress = setupProgress(section.status.items ?? []);
    lines.push("", `## ${MODULES[section.module].title} (${progress.done} of ${progress.total} done)`, "");
    for (const item of section.missing) lines.push(itemLine(item, input.prefix));
  }
  if (notInstalled.length > 0) {
    lines.push("", `Switched on but not installed: ${notInstalled.map((key) => MODULES[key].title).join(", ")}. Install them in [Settings → Plugins](${linkFor("/company/settings/instance/plugins", input.prefix)}), or switch them off on the Setup page.`);
  }
  lines.push("", "This issue updates itself and closes when everything required is done.");
  return {
    title: `Finish setup: ${missing.length} ${missing.length === 1 ? "item" : "items"} left`,
    description: lines.join("\n"),
    missing,
  };
}
