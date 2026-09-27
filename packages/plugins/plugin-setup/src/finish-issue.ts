/**
 * The weekly "Finish setup" issue and the one setup count (pure).
 *
 * The issue, the sidebar badge, the page summary and the Cockpit all count
 * with the kit's `setupSummary` over the same statuses: one per switched-on
 * module's plugin (the stored status, else a stand-in for a plugin that is not
 * installed or never reported). The Setup page shows the same statuses (a live
 * check first) and reports what it checked, so every number agrees.
 */
import { MODULES, setupLeftLabel, setupProgress, setupSummary, type ModuleKey, type SetupItem, type SetupStatus, type SetupSummary } from "./kit-setup.js";
import { ORDERED_MODULES, effectiveModules } from "./modules.js";
import { linkFor, standInStatus, unreportedStatus } from "./status.js";
import { withTeamLinks } from "./team.js";

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
  summary: SetupSummary;
}

export interface CountedStatus {
  module: ModuleKey;
  pluginKey: string;
  status: SetupStatus;
}

/**
 * The status counted for every switched-on module's plugin: the stored one,
 * else "install the plugin" (not installed) or "save its settings" (installed,
 * never reported). Items about an agent role link to Setup → Team.
 */
export function countedStatuses(input: Pick<FinishSetupInput, "modules" | "statuses" | "installed">): CountedStatus[] {
  const modules = effectiveModules(input.modules);
  const out: CountedStatus[] = [];
  for (const module of ORDERED_MODULES) {
    if (!modules[module]) continue;
    for (const pluginKey of MODULES[module].plugins as readonly string[]) {
      let status = input.statuses[pluginKey] ?? null;
      if (!status) {
        const installed = input.installed ? input.installed[pluginKey] : undefined;
        status = input.installed && !installed
          ? standInStatus({ pluginKey, module, kind: "not-installed" })
          : unreportedStatus({ pluginKey, module, pluginId: installed?.id ?? null });
      }
      // Agent roles (and who gets the daily brief) are staffed in Setup → Team.
      out.push({ module, pluginKey, status: withTeamLinks(status, pluginKey) });
    }
  }
  return out;
}

/** Kit `setupSummary` over `countedStatuses`: the "N steps left" every page shows. */
export function finishSetupSummary(input: Pick<FinishSetupInput, "modules" | "statuses" | "installed">): SetupSummary {
  return setupSummary(countedStatuses(input).map((entry) => ({ module: entry.module, items: entry.status.items ?? [] })), input.modules);
}

/** Required steps not done, per switched-on module (plus the flat list). */
export function finishSetupMissing(input: FinishSetupInput): { missing: FinishSetupMissing[]; sections: Array<{ module: ModuleKey; pluginKey: string; status: SetupStatus; missing: SetupItem[] }> } {
  const missing: FinishSetupMissing[] = [];
  const sections: Array<{ module: ModuleKey; pluginKey: string; status: SetupStatus; missing: SetupItem[] }> = [];
  for (const { module, pluginKey, status } of countedStatuses(input)) {
    const items = setupProgress(status.items ?? []).missing;
    if (items.length === 0) continue;
    sections.push({ module, pluginKey, status, missing: items });
    for (const item of items) missing.push({ module, pluginKey, item });
  }
  return { missing, sections };
}

function itemLine(item: SetupItem, prefix: string | null): string {
  const parts = [`- [ ] **${item.title}**`];
  if (item.status === "blocked") parts.push("(waiting on another step)");
  if (item.detail) parts.push(`— ${item.detail}`);
  if (item.href) parts.push(`[${item.hrefLabel || "Open"}](${linkFor(item.href, prefix)})`);
  const lines = [parts.join(" ")];
  if (item.action) lines.push(`  - The Setup page can do this for you: "${item.action.label}".`);
  if (item.agentNext) lines.push(`  - Once done: ${item.agentNext}`);
  return lines.join("\n");
}

export function finishSetupContent(input: FinishSetupInput): FinishSetupContent | null {
  const summary = finishSetupSummary(input);
  const { missing, sections } = finishSetupMissing(input);
  if (summary.requiredLeft === 0 || missing.length === 0) return null;
  const setupLink = linkFor("/setup", input.prefix);
  const lines: string[] = [
    `Setup is not finished for this company: ${setupLeftLabel(summary.requiredLeft)} (${summary.requiredDone} of ${summary.requiredTotal} required steps done). Each one links to where it is fixed.`,
    "",
    `[Open the Setup page](${setupLink}) for guided setup and "Do it for me". A module this company does not use can be switched off there.`,
  ];
  for (const section of sections) {
    const progress = setupProgress(section.status.items ?? []);
    lines.push("", `## ${MODULES[section.module].title} (${progress.done} of ${progress.total} done)`, "");
    for (const item of section.missing) lines.push(itemLine(item, input.prefix));
  }
  lines.push("", "This issue updates itself and closes when everything required is done.");
  return {
    title: `Finish setup: ${setupLeftLabel(summary.requiredLeft)}`,
    description: lines.join("\n"),
    missing,
    summary,
  };
}
