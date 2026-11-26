import { useCallback, useSyncExternalStore } from "react";
import { taskCollectionPreferencesStorageKey, TASK_COLLECTION_PREFERENCES_CHANGED, TASK_COLLECTION_PREFERENCES_VERSION } from "../lib/task-collection-preferences";

/** Subscribe the collection's fetching owner to its persisted filter control. */
export function useShowAgentCreatedTasks(
  companyId: string | null,
  collectionKey: string,
  defaultValue = false,
): boolean {
  const getSnapshot = useCallback(() => {
    try {
      const key = taskCollectionPreferencesStorageKey({ companyId: companyId ?? "__unscoped__", collectionKey });
      const current = localStorage.getItem(key);
      const legacy = localStorage.getItem(companyId ? `${collectionKey}:${companyId}` : collectionKey);
      const envelope = current ? JSON.parse(current) : null;
      const valid = envelope?.version === TASK_COLLECTION_PREFERENCES_VERSION
        && envelope.companyId === (companyId ?? "__unscoped__") && envelope.collectionKey === collectionKey;
      const view = valid ? envelope.viewState : legacy ? JSON.parse(legacy) : null;
      if (!view || typeof view !== "object") return defaultValue;
      if (defaultValue && view.showAgentCreatedTasksCustomized !== true) {
        return view.showAgentCreatedTasks === true ? true : defaultValue;
      }
      return typeof view.showAgentCreatedTasks === "boolean" ? view.showAgentCreatedTasks : defaultValue;
    } catch {
      return defaultValue;
    }
  }, [companyId, collectionKey, defaultValue]);
  return useSyncExternalStore(subscribe, getSnapshot, () => defaultValue);
}

function subscribe(onChange: () => void) {
  window.addEventListener(TASK_COLLECTION_PREFERENCES_CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(TASK_COLLECTION_PREFERENCES_CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}
