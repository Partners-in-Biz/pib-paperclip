/**
 * Paging bounds for the plugin host's `ctx.issues.list`.
 *
 * A plugin that omits `limit` used to make the host read every matching issue
 * (and map labels, active runs and description previews for each) before
 * slicing in memory. Every plugin read is now bounded in SQL.
 */
export const PLUGIN_ISSUE_LIST_DEFAULT_LIMIT = 200;
export const PLUGIN_ISSUE_LIST_MAX_LIMIT = 1000;

function parseWindowNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
  }
  return null;
}

/** Numeric limit (1..max, default when missing) and offset (>= 0) to push into the SQL query. */
export function resolvePluginIssueWindow(params?: { limit?: unknown; offset?: unknown }): { limit: number; offset: number } {
  const requested = parseWindowNumber(params?.limit);
  const limit =
    requested == null
      ? PLUGIN_ISSUE_LIST_DEFAULT_LIMIT
      : Math.min(PLUGIN_ISSUE_LIST_MAX_LIMIT, Math.max(1, requested));
  return { limit, offset: parseWindowNumber(params?.offset) ?? 0 };
}
