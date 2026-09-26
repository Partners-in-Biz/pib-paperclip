/**
 * Loads everything the Setup page and widget show for one company:
 * saved module choice, installed plugins, and each enabled module's status
 * (live check → stored projection → stand-in).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { MODULES, type ModuleKey, type SetupStatus } from "../kit-setup.js";
import { effectiveModules, ORDERED_MODULES } from "../modules.js";
import { parseSetupStatus, standInStatus } from "../status.js";
import { fetchInstalledPlugins, fetchLiveStatus, type LiveResult, type PluginRecordLite } from "./api.js";

export interface LoadResult {
  modules: Partial<Record<ModuleKey, boolean>> | null;
  updatedAt: string | null;
  updatedBy: string | null;
  statuses: Record<string, { status: SetupStatus; receivedAt: string }>;
  finishIssueId: string | null;
  settingsSaved: boolean;
  installed: Record<string, { id: string; status?: string | null }> | null;
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

/** Pure: pick the status to show for each module. */
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
          view.status = standInStatus({ pluginKey, module, kind: "not-ready", pluginId: installed?.id ?? null, reason: live.reason });
          view.source = "stand-in";
        }
      }
      views.push(view);
    }
  }
  return views;
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
  const [load, setLoad] = useState<LoadResult | null>(null);
  const [installed, setInstalled] = useState<Record<string, PluginRecordLite> | null>(null);
  const [live, setLive] = useState<Record<string, LiveResult | undefined>>({});
  const [checking, setChecking] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const token = useRef(0);
  const wantLive = options.live !== false;

  const checkPlugins = useCallback(async (keys: string[], company: string) => {
    if (keys.length === 0) return;
    setChecking((current) => new Set([...current, ...keys]));
    const results = await Promise.all(keys.map(async (key) => [key, await fetchLiveStatus(key, company)] as const));
    setLive((current) => ({ ...current, ...Object.fromEntries(results) }));
    setChecking((current) => {
      const next = new Set(current);
      for (const key of keys) next.delete(key);
      return next;
    });
    return Object.fromEntries(results);
  }, []);

  const reload = useCallback(async () => {
    if (!companyId) return;
    const mine = ++token.current;
    setLoading(true);
    setError(null);
    try {
      const plugins = await fetchInstalledPlugins().catch(() => null);
      const report = plugins ? Object.fromEntries(Object.values(plugins).map((p) => [p.pluginKey, { id: p.id, status: p.status }])) : undefined;
      const result = (await loadAction(report ? { installed: report } : {})) as LoadResult;
      if (mine !== token.current) return;
      setInstalled(plugins);
      setLoad(result);
      setLoading(false);
      if (wantLive) {
        const enabled = effectiveModules(result.modules);
        const keys = ORDERED_MODULES.filter((module) => enabled[module])
          .flatMap((module) => [...MODULES[module].plugins] as string[])
          .filter((key) => !plugins || plugins[key]?.status === "ready");
        await checkPlugins(keys, companyId);
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
    void reload();
  }, [companyId]);

  const recheck = useCallback(async (pluginKey: string) => {
    if (!companyId) return null;
    const results = await checkPlugins([pluginKey], companyId);
    const result = results?.[pluginKey];
    return result?.ok ? result.status : null;
  }, [companyId, checkPlugins]);

  const views = load ? resolveModuleViews({ modules: load.modules, installed, live, stored: load.statuses }) : [];
  return { loading, error, load, installed, views, checking, reload, recheck };
}
