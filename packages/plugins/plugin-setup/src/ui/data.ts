/**
 * Loads everything the Setup page and widget show for one company:
 * saved module choice, installed plugins, and each enabled module's status
 * (live check → stored projection → stand-in).
 *
 * The page reports what it checked live (`setup.report-statuses`), so the
 * stored statuses, the sidebar badge, the Finish setup issue and the Cockpit
 * count exactly what the page shows.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { MODULES, setupSummary, type ModuleKey, type SetupStatus, type SetupSummary } from "../kit-setup.js";
import { effectiveModules, ORDERED_MODULES } from "../modules.js";
import { memoryStatus, WIKI_PLUGIN, type WikiSnapshot } from "../memory.js";
import { parseSetupStatus, standInStatus } from "../status.js";
import { withTeamLinks } from "../team.js";
import { fetchInstalledPlugins, fetchLiveStatus, type LiveResult, type PluginRecordLite } from "./api.js";
import { fetchMemoryLive } from "./memory-client.js";

export interface LoadResult {
  modules: Partial<Record<ModuleKey, boolean>> | null;
  updatedAt: string | null;
  updatedBy: string | null;
  statuses: Record<string, { status: SetupStatus; receivedAt: string }>;
  finishIssueId: string | null;
  settingsSaved: boolean;
  installed: Record<string, { id: string; status?: string | null }> | null;
  /** The one setup count from the stored statuses (older workers do not send it). */
  summary?: SetupSummary | null;
  /** Where the New company bootstrap stands (older workers do not send it). */
  bootstrap?: { status: string; updatedAt: string } | null;
}

export type StatusSource = "live" | "stored" | "stand-in";

export interface ModuleView {
  module: ModuleKey;
  pluginKey: string;
  enabled: boolean;
  installed: PluginRecordLite | null;
  status: SetupStatus | null;
  source: StatusSource | null;
  /** When the stored status was received (source "stored"). */
  receivedAt: string | null;
  /** Why the live check failed, when it did. */
  note: string | null;
}

/** Pure: pick the status to show for each module (team items link to Setup → Team). */
export function resolveModuleViews(input: {
  modules: Partial<Record<ModuleKey, boolean>> | null;
  installed: Record<string, PluginRecordLite> | null;
  live: Record<string, LiveResult | undefined>;
  stored: LoadResult["statuses"];
}): ModuleView[] {
  const enabled = effectiveModules(input.modules);
  const views: ModuleView[] = [];
  for (const module of ORDERED_MODULES) {
    for (const pluginKey of MODULES[module].plugins as readonly string[]) {
      const installed = input.installed?.[pluginKey] ?? null;
      const view: ModuleView = { module, pluginKey, enabled: enabled[module], installed, status: null, source: null, receivedAt: null, note: null };
      if (view.enabled) {
        const live = input.live[pluginKey];
        const stored = input.stored[pluginKey];
        const storedStatus = stored ? parseSetupStatus(stored.status, pluginKey) : null;
        if (input.installed && !installed) {
          view.status = standInStatus({ pluginKey, module, kind: "not-installed" });
          view.source = "stand-in";
        } else if (live?.ok) {
          view.status = live.status;
          view.source = "live";
        } else if (storedStatus) {
          view.status = storedStatus;
          view.source = "stored";
          view.receivedAt = stored?.receivedAt ?? null;
          view.note = live && !live.ok ? live.reason : null;
        } else if (installed && installed.status !== "ready") {
          view.status = standInStatus({ pluginKey, module, kind: "not-ready", pluginId: installed.id, reason: `The plugin is ${installed.status}. Enable or upgrade it, then check again.` });
          view.source = "stand-in";
        } else if (live && !live.ok) {
          view.status = pluginKey === WIKI_PLUGIN
            ? memoryStatus(null, { reason: live.reason })
            : standInStatus({ pluginKey, module, kind: "not-ready", pluginId: installed?.id ?? null, reason: live.reason });
          view.source = "stand-in";
        }
        // Agent roles (and who gets the daily brief) are staffed in Setup → Team.
        if (view.status) view.status = withTeamLinks(view.status, pluginKey);
      }
      views.push(view);
    }
  }
  return views;
}

/**
 * The page's setup count: kit `setupSummary` over the switched-on modules'
 * statuses, exactly like the sidebar, the Finish setup issue and the Cockpit.
 * Null while a module is still being checked.
 */
export function viewsSummary(views: ModuleView[], modules: Partial<Record<ModuleKey, boolean>> | null): SetupSummary | null {
  const enabled = views.filter((view) => view.enabled);
  if (enabled.some((view) => !view.status)) return null;
  return setupSummary(enabled.map((view) => ({ module: view.module, items: view.status!.items })), modules);
}

/** Statuses the page checked live, for `setup.report-statuses` (Company wiki reports on its own). */
export function reportableStatuses(live: Record<string, LiveResult | undefined>): Record<string, SetupStatus> {
  const out: Record<string, SetupStatus> = {};
  for (const [key, result] of Object.entries(live)) if (result?.ok && key !== WIKI_PLUGIN) out[key] = result.status;
  return out;
}

// ---------------------------------------------------------------------------
// Shared work: the host's StrictMode mounts twice, and the sidebar, widget and
// page all load at once. The same request within a few seconds is sent once.
// ---------------------------------------------------------------------------

const SHARE_MS = 3000;
const shared = new Map<string, { at: number; promise: Promise<unknown> }>();

export function sharedRequest<T>(key: string, run: () => Promise<T>, fresh = false, now: () => number = Date.now): Promise<T> {
  const hit = shared.get(key);
  if (!fresh && hit && now() - hit.at < SHARE_MS) return hit.promise as Promise<T>;
  const promise = run();
  shared.set(key, { at: now(), promise });
  promise.catch(() => shared.delete(key));
  return promise;
}

export function clearSharedRequests(): void {
  shared.clear();
}

/** The sidebar badge follows the page: it reloads when the page reported new statuses. */
const listeners = new Set<() => void>();

export function onSetupChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setupChanged(): void {
  for (const listener of [...listeners]) listener();
}

export interface SetupData {
  loading: boolean;
  error: string | null;
  load: LoadResult | null;
  installed: Record<string, PluginRecordLite> | null;
  views: ModuleView[];
  checking: ReadonlySet<string>;
  reload(): Promise<void>;
  recheck(pluginKey: string): Promise<SetupStatus | null>;
}

export function useSetupData(companyId: string | null | undefined, options: { live?: boolean } = {}): SetupData {
  const loadAction = usePluginAction("setup.load");
  const reportMemory = usePluginAction("setup.report-memory");
  const reportAction = usePluginAction("setup.report-statuses");
  const [load, setLoad] = useState<LoadResult | null>(null);
  const [installed, setInstalled] = useState<Record<string, PluginRecordLite> | null>(null);
  const [live, setLive] = useState<Record<string, LiveResult | undefined>>({});
  const [checking, setChecking] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const token = useRef(0);
  const wantLive = options.live !== false;

  const checkPlugins = useCallback(async (keys: string[], company: string, fresh: boolean) => {
    if (keys.length === 0) return;
    setChecking((current) => new Set([...current, ...keys]));
    // Company wiki (upstream LLM Wiki) has no setup-status route: the page checks it and reports it.
    const check = (key: string) => sharedRequest(`live|${company}|${key}`, () => (key === WIKI_PLUGIN
      ? fetchMemoryLive(company, (snapshot: WikiSnapshot) => reportMemory({ snapshot }))
      : fetchLiveStatus(key, company)), fresh);
    const results = Object.fromEntries(await Promise.all(keys.map(async (key) => [key, await check(key)] as const)));
    setLive((current) => ({ ...current, ...results }));
    setChecking((current) => {
      const next = new Set(current);
      for (const key of keys) next.delete(key);
      return next;
    });
    // Store what the page saw, so the badge, the issue and the Cockpit count the same.
    const report = reportableStatuses(results);
    if (Object.keys(report).length) {
      try {
        await sharedRequest(`report|${company}|${Object.keys(report).sort().join(",")}`, () => reportAction({ statuses: report }), fresh);
      } catch {
        // The plugins' hourly pushes catch up.
      }
    }
    // Company wiki reported inside its check; either way the badge may have moved.
    if (Object.values(results).some((result) => result?.ok)) setupChanged();
    return results;
  }, [reportMemory, reportAction]);

  const reload = useCallback(async (fresh = true) => {
    if (!companyId) return;
    const mine = ++token.current;
    setLoading(true);
    setError(null);
    try {
      const { plugins, result } = await sharedRequest(`load|${companyId}`, async () => {
        const plugins = await fetchInstalledPlugins().catch(() => null);
        const report = plugins ? Object.fromEntries(Object.values(plugins).map((p) => [p.pluginKey, { id: p.id, status: p.status }])) : undefined;
        const result = (await loadAction(report ? { installed: report } : {})) as LoadResult;
        return { plugins, result };
      }, fresh);
      if (mine !== token.current) return;
      setInstalled(plugins);
      setLoad(result);
      setLoading(false);
      if (wantLive) {
        const enabled = effectiveModules(result.modules);
        const keys = ORDERED_MODULES.filter((module) => enabled[module])
          .flatMap((module) => [...MODULES[module].plugins] as string[])
          .filter((key) => !plugins || plugins[key]?.status === "ready");
        await checkPlugins(keys, companyId, fresh);
      }
    } catch (err) {
      if (mine !== token.current) return;
      setError(err instanceof Error ? err.message : "Could not load setup");
      setLoading(false);
    }
  }, [companyId, loadAction, checkPlugins, wantLive]);

  useEffect(() => {
    setLoad(null);
    setLive({});
    // A second mount within a few seconds (StrictMode, widget + page) reuses the same requests.
    void reload(false);
  }, [companyId]);

  const recheck = useCallback(async (pluginKey: string) => {
    if (!companyId) return null;
    const results = await checkPlugins([pluginKey], companyId, true);
    const result = results?.[pluginKey];
    return result?.ok ? result.status : null;
  }, [companyId, checkPlugins]);

  const views = load ? resolveModuleViews({ modules: load.modules, installed, live, stored: load.statuses }) : [];
  return { loading, error, load, installed, views, checking, reload: () => reload(true), recheck };
}
