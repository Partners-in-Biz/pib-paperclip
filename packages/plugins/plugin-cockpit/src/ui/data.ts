/**
 * Loads everything the Cockpit page and widget show for one company.
 * Live snapshots come from each installed, ready, switched-on plugin; the
 * stored projection fills in for any that cannot answer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { pluginUiBaseFromModule } from "@partnersinbiz/pib-plugin-kit/oauth-client";
import { fetchModules } from "@partnersinbiz/pib-plugin-kit/setup-client";
import type { ModuleKey, SetupStatus } from "@partnersinbiz/pib-plugin-kit/setup";
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
  MODULE_PLUGIN_KEYS,
} from "./api.js";

export interface RawData {
  load: LoadResult;
  installed: Record<string, InstalledLite> | null;
  modules: Partial<Record<ModuleKey, boolean>> | null;
  live: Record<string, CockpitSnapshot | null>;
  approvals: ApprovalLite[];
  myIssues: IssueLite[];
  setupMissing: number | null;
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

function uiBase(): string | null {
  try {
    return pluginUiBaseFromModule(import.meta.url);
  } catch {
    return null;
  }
}

export function useCockpitData(companyId: string | null | undefined, options: { light?: boolean; windowHours?: number } = {}): CockpitData {
  const loadAction = usePluginAction("cockpit.load");
  const [raw, setRaw] = useState<RawData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const token = useRef(0);
  const light = options.light === true;

  const reload = useCallback(async () => {
    if (!companyId) return;
    const mine = ++token.current;
    setLoading(true);
    setError(null);
    try {
      const installed = await fetchInstalledPlugins();
      const report = installed ? Object.fromEntries(Object.entries(installed).map(([key, p]) => [key, { id: p.id, status: p.status }])) : undefined;
      const [load, modules] = await Promise.all([
        loadAction({ ...(report ? { installed: report } : {}), uiBase: uiBase(), team: !light }) as Promise<LoadResult>,
        fetchModules(companyId),
      ]);
      const livePlugins = light
        ? []
        : MODULE_PLUGIN_KEYS.filter((key) => pluginEnabled(modules, key) && (!installed || installed[key]?.status === "ready"));
      const [liveList, approvals, myIssues, setupLoad, agents, hostActivity, runs, backup] = await Promise.all([
        Promise.all(livePlugins.map(async (key) => [key, await fetchLiveSnapshot(key, companyId)] as const)),
        fetchApprovals(companyId),
        fetchMyIssues(companyId),
        fetchSetupLoad(companyId),
        light ? Promise.resolve([] as AgentLite[]) : fetchAgents(companyId),
        light ? Promise.resolve([] as HostActivityLite[]) : fetchActivity(companyId),
        light ? Promise.resolve([] as RunLite[]) : fetchRuns(companyId),
        light ? Promise.resolve(null) : fetchBackup(),
      ]);
      if (mine !== token.current) return;
      const setupMissing = setupLoad
        ? setupMissingCount(
          Object.fromEntries(Object.entries(setupLoad.statuses ?? {}).map(([key, row]) => [key, (row?.status ?? null) as SetupStatus | null])),
          (setupLoad.modules ?? modules) as Partial<Record<ModuleKey, boolean>> | null,
        )
        : null;
      setRaw({
        load,
        installed,
        modules,
        live: Object.fromEntries(liveList),
        approvals,
        myIssues,
        setupMissing,
        agents,
        hostActivity,
        runs,
        backup,
      });
    } catch (err) {
      if (mine !== token.current) return;
      setError(err instanceof Error ? err.message : "Could not load the Cockpit");
    } finally {
      if (mine === token.current) setLoading(false);
    }
  }, [companyId, loadAction, light]);

  useEffect(() => {
    setRaw(null);
    void reload();
  }, [companyId]);

  const windowMs = (options.windowHours ?? 24) * 3_600_000;
  const view = useMemo(() => (raw ? buildView({ ...raw, now: new Date(), windowMs }) : null), [raw, windowMs]);
  return { loading, error, raw, view, reload };
}
