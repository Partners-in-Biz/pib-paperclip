import type { ExecutionWorkspace } from "@paperclipai/shared";

export const WORKSPACE_GIT_DISPLAY_CACHE_TTL_MS = 5_000;
export const WORKSPACE_GIT_SWEEP_CACHE_TTL_MS = 30_000;

export type WorkspaceGitInspectionCacheOptions<T> = {
  /** How long a settled result is served. Defaults to the 5s display TTL. */
  ttlMs?: number;
  /** Upper bound on retained entries (oldest evicted first). */
  maxEntries?: number;
  /** Results this returns false for are shared while in flight but not retained. */
  shouldRetain?: (result: T) => boolean;
  now?: () => number;
};

/**
 * Short-lived read cache with single-flight. Destructive operations must inspect afresh.
 * Concurrent callers for the same workspace share one in-flight inspection; settled
 * results are served until `ttlMs` elapses. Failed inspections are never retained.
 */
export function createWorkspaceGitInspectionCache<T>(
  inspect: (workspace: ExecutionWorkspace) => Promise<T>,
  options: WorkspaceGitInspectionCacheOptions<T> = {},
) {
  const ttlMs = options.ttlMs ?? WORKSPACE_GIT_DISPLAY_CACHE_TTL_MS;
  const maxEntries = options.maxEntries ?? 256;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { expiresAt: number; promise: Promise<T> }>();
  return (workspace: ExecutionWorkspace): Promise<T> => {
    const key = JSON.stringify([
      workspace.companyId, workspace.id, workspace.updatedAt, workspace.providerType,
      workspace.providerRef, workspace.cwd, workspace.repoUrl, workspace.baseRef,
      workspace.branchName, workspace.metadata,
    ]);
    const current = now();
    const existing = entries.get(key);
    if (existing && existing.expiresAt > current) return existing.promise;
    for (const [candidate, entry] of entries) {
      if (entry.expiresAt <= current) entries.delete(candidate);
    }
    if (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
    const entry = { expiresAt: Number.POSITIVE_INFINITY, promise: Promise.resolve().then(() => inspect(workspace)) };
    entries.set(key, entry);
    entry.promise = entry.promise.then((result) => {
      if (options.shouldRetain && !options.shouldRetain(result)) {
        if (entries.get(key) === entry) entries.delete(key);
      } else {
        entry.expiresAt = now() + ttlMs;
      }
      return result;
    }, (error) => {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    });
    return entry.promise;
  };
}
