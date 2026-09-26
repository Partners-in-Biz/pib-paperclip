/**
 * Guided setup order and progress: pure helpers (no node imports).
 *
 * Guided mode walks one missing required item at a time: settings first, then
 * keys and connections, then agents, then first data. Within a phase CRM and
 * Mailbox come first (other modules use them), and an item never comes before
 * the items it waits on (`blockedBy`, same plugin).
 */
import { MODULES, setupProgress, type ModuleKey, type SetupItem, type SetupStatus } from "./kit-setup.js";
import { moduleRank } from "./modules.js";

export const PHASES = ["Settings", "Keys and connections", "Agents", "First data"] as const;

const CONNECTION_RE = /secret|api[_ -]?key|\bkey\b|token|gmail|oauth|connect|account|credential|service[_ -]?account|domain|verif|bank|login|webhook|r2|bucket|repo|github|smtp|dns/;
const AGENT_RE = /\bagents?\b|hire|skill|routine/;

/** 0 settings, 1 keys/connections, 2 agents, 3 first data. */
export function itemPhase(item: Pick<SetupItem, "key" | "title">): number {
  const key = item.key.toLowerCase();
  const title = (item.title ?? "").toLowerCase();
  if (key === "settings" || /(^|_)settings?$/.test(key)) return 0;
  if (/(^|_)(agent|agents|hire|skills?)($|_)/.test(key)) return 2;
  if (CONNECTION_RE.test(key) || CONNECTION_RE.test(title)) return 1;
  if (AGENT_RE.test(title)) return 2;
  return 3;
}

export interface ModuleState {
  module: ModuleKey;
  pluginKey: string;
  status: SetupStatus | null;
}

export interface GuideEntry {
  id: string;
  module: ModuleKey;
  moduleTitle: string;
  pluginKey: string;
  item: SetupItem;
  phase: number;
}

export function entryId(pluginKey: string, itemKey: string): string {
  return `${pluginKey}:${itemKey}`;
}

/** Missing required items across modules, in the order guided mode walks them. */
export function guidedOrder(modules: ModuleState[], skipped: ReadonlySet<string> = new Set()): GuideEntry[] {
  const entries: Array<GuideEntry & { rank: number; index: number }> = [];
  for (const state of modules) {
    if (!state.status) continue;
    const items = state.status.items ?? [];
    const missing = items.filter((item) => item.required && item.status !== "done");
    const byKey = new Map(missing.map((item) => [item.key, item]));
    const phaseMemo = new Map<string, number>();
    const phaseOf = (item: SetupItem, seen: Set<string>): number => {
      const cached = phaseMemo.get(item.key);
      if (cached !== undefined) return cached;
      let phase = itemPhase(item);
      for (const dep of item.blockedBy ?? []) {
        const blocker = byKey.get(dep);
        if (!blocker || seen.has(dep)) continue;
        phase = Math.max(phase, phaseOf(blocker, new Set([...seen, item.key])));
      }
      phaseMemo.set(item.key, phase);
      return phase;
    };
    missing.forEach((item, index) => {
      const id = entryId(state.pluginKey, item.key);
      if (skipped.has(id)) return;
      entries.push({
        id,
        module: state.module,
        moduleTitle: MODULES[state.module]?.title ?? state.status?.title ?? state.module,
        pluginKey: state.pluginKey,
        item,
        phase: phaseOf(item, new Set()),
        rank: moduleRank(state.module),
        index,
      });
    });
  }
  entries.sort((a, b) => a.phase - b.phase || a.rank - b.rank || a.index - b.index);
  // An item never comes before a missing item it waits on.
  for (let pass = 0; pass < entries.length; pass += 1) {
    let moved = false;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]!;
      const deps = new Set((entry.item.blockedBy ?? []).map((dep) => entryId(entry.pluginKey, dep)));
      if (deps.size === 0) continue;
      let last = -1;
      entries.forEach((other, j) => {
        if (deps.has(other.id)) last = Math.max(last, j);
      });
      if (last > i) {
        entries.splice(i, 1);
        entries.splice(last, 0, entry);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return entries.map(({ rank: _rank, index: _index, ...entry }) => entry);
}

/** Overall progress across the enabled modules that reported a status. */
export function overallProgress(statuses: Array<SetupStatus | null>): { done: number; total: number; percent: number } {
  let done = 0;
  let total = 0;
  for (const status of statuses) {
    if (!status) continue;
    const progress = setupProgress(status.items ?? []);
    done += progress.done;
    total += progress.total;
  }
  return { done, total, percent: total === 0 ? 100 : Math.round((done / total) * 100) };
}
