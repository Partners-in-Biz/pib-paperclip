import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { pluginsApi } from "@/api/plugins";
import { usePluginSlots, type ResolvedPluginSlot } from "@/plugins/slots";

/** How often the host asks each plugin whether its task side-panel tab should show. */
export const TASK_SIDE_PANEL_PLUGIN_TAB_REFRESH_MS = 10_000;

const EMPTY_SLOTS: ResolvedPluginSlot[] = [];

export function taskSidePanelPluginTabId(slot: Pick<ResolvedPluginSlot, "pluginKey" | "id">) {
  return `plugin-tab:${slot.pluginKey}:${slot.id}`;
}

/**
 * The `taskSidePanelTab` slots whose plugin currently reports `{ visible: true }`
 * for this task. Loading, any other answer, or an error hides the tab, so a
 * tab never appears before the plugin has said so (no flicker on mount).
 */
export function useTaskSidePanelPluginTabs(issue: Pick<Issue, "id" | "companyId" | "projectId">, enabled = true): ResolvedPluginSlot[] {
  const savedTask = enabled && !issue.id.startsWith("chat:");
  const { slots, errorMessage } = usePluginSlots({ slotTypes: ["taskSidePanelTab"], companyId: issue.companyId, enabled: savedTask });
  // `slots` is memoized by usePluginSlots, so `candidates` only changes with the declarations.
  const candidates = useMemo(() => savedTask && !errorMessage ? slots.filter((slot) => slot.sidePanelTab?.visibilityDataKey) : EMPTY_SLOTS,
    [savedTask, errorMessage, slots]);
  const results = useQueries({
    queries: candidates.map((slot) => ({
      queryKey: ["task-side-panel-plugin-tab", issue.companyId, issue.id, issue.projectId ?? null, slot.pluginId, slot.pluginVersion, slot.id, slot.sidePanelTab!.visibilityDataKey],
      queryFn: async () => {
        const result = await pluginsApi.bridgeGetData(slot.pluginId, slot.sidePanelTab!.visibilityDataKey, { issueId: issue.id, projectId: issue.projectId ?? null }, issue.companyId);
        const data = result?.data as { visible?: unknown } | null | undefined;
        return data !== null && typeof data === "object" && data.visible === true;
      },
      refetchInterval: TASK_SIDE_PANEL_PLUGIN_TAB_REFRESH_MS,
      // One quick retry absorbs a blip; a lasting error hides the tab.
      retry: 1,
      retryDelay: 500,
    })),
  });
  const visibleKey = results.map((result) => (!result.isError && result.data === true ? "1" : "0")).join("");
  // Re-derive only when the visible set changes, so callers can key effects on it.
  return useMemo(() => {
    const visible = candidates.filter((_, index) => visibleKey[index] === "1");
    return visible.length ? visible : EMPTY_SLOTS;
  }, [candidates, visibleKey]);
}
