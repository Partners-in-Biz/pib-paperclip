// PAR-13561: POST /agents/:id/pause may declare a planned deploy window with
// body.reason = "maintenance". Anything else (unknown value, missing body) keeps
// the default "manual" reason, so callers cannot set budget/setup/etc. holds here.
export function requestedPauseReason(body: unknown): "maintenance" | undefined {
  const reason = (body as { reason?: unknown } | null | undefined)?.reason;
  return reason === "maintenance" ? "maintenance" : undefined;
}
