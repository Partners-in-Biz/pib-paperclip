/**
 * Loads everything the Cockpit page and widget show for one company.
 * Live snapshots come from each installed, ready, switched-on PiB plugin; the
 * stored projection fills in for any that cannot answer.
 *
 * Loaded once: the page, the sidebar rows and the widget share one base load
 * per company (the Cockpit's own data, approvals, your issues, Setup's count),
 * and a second mount within a few seconds (the host's StrictMode, a quick
 * remount) reuses the page load instead of sending every request again.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { pluginUiBaseFromModule } from "@partnersinbiz/pib-plugin-kit/oauth-client";
import { fetchModules } from "@partnersinbiz/pib-plugin-kit/setup-client";
import type { ModuleKey, SetupStatus } from "@partnersinbiz/pib-plugin-kit/setup";
import { fetchUiContributions } from "@partnersinbiz/pib-plugin-ui";
import { pluginEnabled, setupMissingCount, type AgentLite, type ApprovalLite, type CockpitSnapshot, type HostActivityLite, type IssueLite, type RunLite } from "../merge.js";
import { buildView, type CockpitView, type InstalledLite, type LoadResult } from "../view.js";
import {
  fetchActivity,
  fetchAgents,
  fetchApprovals,
  fetchBackup,
  fetchInstalledPlugins,
  fetchLiveSnapshot,
  fetchMyIssues,
  fetchRuns,
  fetchSetupLoad,
  LIVE_SNAPSHOT_KEYS,
  type SetupLoadLite,
} from "./api.js";

export interface RawData {
  load: LoadResult;
  installed: Record<string, InstalledLite> | null;
  modules: Partial<Record<ModuleKey, boolean>> | null;
  live: Record<string, CockpitSnapshot | null>;
  approvals: ApprovalLite[];
  myIssues: IssueLite[];
  /** Required setup steps left: Setup's own count when it sends one. */
  setupMissing: number | null;
  /** The open Finish setup issue (listed once, as the setup item). */
  setupIssueId: string | null;
  /** The setup statuses Setup stored, by plugin (the Flows tab's "settings not saved"). */
  setupStatuses: Record<string, unknown> | null;
  agents: AgentLite[];
  hostActivity: HostActivityLite[];
  runs: RunLite[];
  backup: { mtime: string | null; ageHours: number | null } | null;
}

export interface CockpitData {
  loading: boolean;
  error: string | null;
  raw: RawData | null;
  view: CockpitView | null;
  reload(): Promise<void>;
}

/** `/_plugins/<installation id>/ui/` of this bundle, or null outside the host. */
export function uiBase(): string | null {
  try {
    return pluginUiBaseFromModule(import.meta.url);
  } catch {
    return null;
  }
}

type LoadAction = (params: Record<string, unknown>) => Promise<unknown>;

interface BaseData {
  load: LoadResult;
  installed: Record<string, InstalledLite> | null;
  modules: Partial<Record<ModuleKey, boolean>> | null;
  approvals: ApprovalLite[];
  myIssues: IssueLite[];
  setupLoad: SetupLoadLite | null;
}

/** Setup's count (its page, sidebar and weekly issue show the same), else the same kit count over its stored statuses. */
export function setupCount(setupLoad: SetupLoadLite | null, modules: Partial<Record<ModuleKey, boolean>> | null): number | null {
  if (!setupLoad) return null;
  if (setupLoad.summary) return setupLoad.summary.requiredLeft;
  return setupMissingCount(
    Object.fromEntries(Object.entries(setupLoad.statuses ?? {}).map(([key, row]) => [key, (row?.status ?? null) as SetupStatus | null])),
    (setupLoad.modules ?? modules) as Partial<Record<ModuleKey, boolean>> | null,
  );
}

async function loadBase(companyId: string, loadAction: LoadAction): Promise<BaseData> {
  const installed = await fetchInstalledPlugins();
  const report = installed ? Object.fromEntries(Object.entries(installed).map(([key, p]) => [key, { id: p.id, status: p.status }])) : undefined;
  // The page has no Team tab: the team views (`team: true`) are Setup's to load.
  const [load, modules, approvals, myIssues, setupLoad] = await Promise.all([
    loadAction({ ...(report ? { installed: report } : {}), uiBase: uiBase(), team: false }) as Promise<LoadResult>,
    fetchModules(companyId),
    fetchApprovals(companyId),
    fetchMyIssues(companyId),
    fetchSetupLoad(companyId),
  ]);
  return { load, installed, modules, approvals, myIssues, setupLoad };
}

/**
 * The PiB plugins to ask for a live snapshot: module on, and installed and
 * ready (from the plugin list, else the host's UI contributions, which only
 * list ready plugins; one shared request for every PiB bundle on the page).
 */
export async function livePluginKeys(base: Pick<BaseData, "installed" | "modules">, contributions: () => Promise<Array<{ pluginKey: string }> | null> = fetchUiContributions): Promise<string[]> {
  let ready: Set<string> | null = null;
  if (base.installed) ready = new Set(Object.entries(base.installed).filter(([, p]) => p.status === "ready").map(([key]) => key));
  else {
    const list = await contributions().catch(() => null);
    if (list) ready = new Set(list.map((c) => c.pluginKey));
  }
  return LIVE_SNAPSHOT_KEYS.filter((key) => pluginEnabled(base.modules, key) && (!ready || ready.has(key)));
}

function rawFrom(base: BaseData, extra: Partial<Pick<RawData, "live" | "agents" | "hostActivity" | "runs" | "backup">> = {}): RawData {
  return {
    load: base.load,
    installed: base.installed,
    modules: base.modules,
    live: extra.live ?? {},
    approvals: base.approvals,
    myIssues: base.myIssues,
    setupMissing: setupCount(base.setupLoad, base.modules),
    setupIssueId: base.setupLoad?.finishIssueId ?? null,
    setupStatuses: base.setupLoad ? Object.fromEntries(Object.entries(base.setupLoad.statuses ?? {}).map(([key, row]) => [key, row?.status ?? null])) : null,
    agents: extra.agents ?? [],
    hostActivity: extra.hostActivity ?? [],
    runs: extra.runs ?? [],
    backup: extra.backup ?? null,
  };
}

// ---------------------------------------------------------------------------
// Shared loads
// ---------------------------------------------------------------------------

/** The base (sidebar, widget and page) is shared this long. */
const BASE_TTL_MS = 20_000;
/** A second page mount within this reuses the page load (StrictMode, quick remounts). */
const FULL_TTL_MS = 5_000;

type Entry<T> = { at: number; promise: Promise<T> };
const baseCache = new Map<string, Entry<BaseData>>();
const fullCache = new Map<string, Entry<RawData>>();
const liveCache = new Map<string, Entry<Record<string, CockpitSnapshot | null>>>();

function shared<T>(cache: Map<string, Entry<T>>, key: string, ttl: number, now: () => number, fresh: boolean, run: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (!fresh && hit && now() - hit.at < ttl) return hit.promise;
  const promise = run();
  cache.set(key, { at: now(), promise });
  // A failed load is not kept: the next ask tries again.
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  return promise;
}

/**
 * Everything the Cockpit needs for one company. `light` (the sidebar and the
 * widget) skips agents, activity, runs and backups. `fresh`
 * (the Refresh button) asks again instead of reusing a recent load.
 */
export async function loadRawData(companyId: string, loadAction: LoadAction, light: boolean, options: { fresh?: boolean; now?: () => number } = {}): Promise<RawData> {
  const now = options.now ?? Date.now;
  const fresh = options.fresh === true;
  const base = () => shared(baseCache, companyId, BASE_TTL_MS, now, fresh, () => loadBase(companyId, loadAction));
  if (light) {
    // The widget and sidebar read live snapshots too: the stored ones only move when a plugin
    // publishes an event, so a payment recorded in Billing left the Overdue tile stale (PAR-1905).
    const b = await base();
    const live = await shared(liveCache, companyId, BASE_TTL_MS, now, fresh, async () => {
      const keys = await livePluginKeys(b);
      return Object.fromEntries(await Promise.all(keys.map(async (key) => [key, await fetchLiveSnapshot(key, companyId)] as const)));
    });
    return rawFrom(b, { live });
  }
  return shared(fullCache, companyId, FULL_TTL_MS, now, fresh, async () => {
    const b = await base();
    const keys = await livePluginKeys(b);
    const [liveList, agents, hostActivity, runs, backup] = await Promise.all([
      Promise.all(keys.map(async (key) => [key, await fetchLiveSnapshot(key, companyId)] as const)),
      fetchAgents(companyId),
      fetchActivity(companyId),
      fetchRuns(companyId),
      fetchBackup(),
    ]);
    return rawFrom(b, { live: Object.fromEntries(liveList), agents, hostActivity, runs, backup });
  });
}

export function useCockpitData(companyId: string | null | undefined, options: { light?: boolean; windowHours?: number } = {}): CockpitData {
  const loadAction = usePluginAction("cockpit.load");
  const [raw, setRaw] = useState<RawData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const token = useRef(0);
  const light = options.light === true;

  const load = useCallback(async (fresh: boolean) => {
    if (!companyId) return;
    const mine = ++token.current;
    setLoading(true);
    setError(null);
    try {
      const next = await loadRawData(companyId, loadAction as LoadAction, light, { fresh });
      if (mine !== token.current) return;
      setRaw(next);
      // The sidebar follows a fresh page load.
      if (fresh) sidebarCache.delete(companyId);
    } catch (err) {
      if (mine !== token.current) return;
      setError(err instanceof Error ? err.message : "Could not load the Cockpit");
    } finally {
      if (mine === token.current) setLoading(false);
    }
  }, [companyId, loadAction, light]);

  useEffect(() => {
    setRaw(null);
    void load(false);
  }, [companyId]);

  const windowMs = (options.windowHours ?? 24) * 3_600_000;
  const view = useMemo(() => (raw ? buildView({ ...raw, now: new Date(), windowMs }) : null), [raw, windowMs]);
  return { loading, error, raw, view, reload: () => load(true) };
}

// ---------------------------------------------------------------------------
// Sidebar: one shared light load for the Cockpit row and the three groups
// ---------------------------------------------------------------------------

const SIDEBAR_TTL_MS = 30_000;
const SIDEBAR_REFRESH_MS = 60_000;
const sidebarCache = new Map<string, { at: number; promise: Promise<CockpitView | null> }>();

/**
 * The Cockpit view for the sidebar, shared by every sidebar row and loaded at
 * most every 30 seconds. On the Cockpit page it is built from the page's own
 * load, so the badge and the page count the same.
 */
export function sharedSidebarView(companyId: string, loadAction: LoadAction, now: () => number = Date.now): Promise<CockpitView | null> {
  const hit = sidebarCache.get(companyId);
  if (hit && now() - hit.at < SIDEBAR_TTL_MS) return hit.promise;
  const full = fullCache.get(companyId);
  const source = full && now() - full.at < SIDEBAR_TTL_MS ? full.promise : loadRawData(companyId, loadAction, true, { now });
  const promise = source
    .then((raw) => buildView({ ...raw, now: new Date(), windowMs: 24 * 3_600_000 }))
    .catch(() => null);
  sidebarCache.set(companyId, { at: now(), promise });
  return promise;
}

export function clearSidebarCache(): void {
  sidebarCache.clear();
  baseCache.clear();
  fullCache.clear();
  liveCache.clear();
}

/** Refreshes when you move between pages and once a minute (within the 30-second sharing window). */
export function useSidebarView(companyId: string | null | undefined, pathname: string): CockpitView | null {
  const loadAction = usePluginAction("cockpit.load") as LoadAction;
  const [view, setView] = useState<CockpitView | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), SIDEBAR_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!companyId) {
      setView(null);
      return;
    }
    let live = true;
    void sharedSidebarView(companyId, loadAction).then((next) => {
      if (live && next) setView(next);
    });
    return () => {
      live = false;
    };
  }, [companyId, pathname, tick]);
  return view;
}
