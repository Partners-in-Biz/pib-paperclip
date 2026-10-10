/**
 * List cost of one run in USD: the explicit cache-adjusted value, else the
 * reported `costUsd`. Lives outside heartbeat.ts so the spend alarm can use it
 * without importing the heartbeat service (PAR-1996).
 */
export function resolveCacheAdjustedCostUsd(input: {
  costUsd?: unknown;
  cacheAdjustedCostUsd?: unknown;
}) {
  const explicit = input.cacheAdjustedCostUsd;
  if (
    typeof explicit === "number" &&
    Number.isFinite(explicit) &&
    explicit >= 0
  ) {
    return explicit;
  }
  const reported = input.costUsd;
  if (
    typeof reported === "number" &&
    Number.isFinite(reported) &&
    reported >= 0
  ) {
    return reported;
  }
  return null;
}
