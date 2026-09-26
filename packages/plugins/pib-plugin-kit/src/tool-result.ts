/**
 * Agent tool results that MCP clients accept.
 *
 * The host sends a plugin tool's `data` to MCP clients as `structuredContent`,
 * which must be a JSON object. Arrays, primitives or a missing `data` (for
 * example on errors) arrive as null and strict clients reject the call
 * ("structuredContent expected record, received null"). Always return an
 * object: lists as `{ items }`, scalars as `{ value }`, errors as
 * `{ ok: false, error }`.
 */
export function toToolData(data: unknown): Record<string, unknown> {
  if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  if (Array.isArray(data)) return { items: data, count: data.length };
  if (data === undefined || data === null) return { ok: true };
  return { value: data };
}

export function toolOk(content: string, data: unknown): { content: string; data: Record<string, unknown> } {
  return { content, data: toToolData(data) };
}

export function toolFail(message: string): { content: string; data: Record<string, unknown>; error: string } {
  return { content: message, data: { ok: false, error: message }, error: message };
}

/** Wrap any tool result so `data` is always an object (use at `ctx.tools.register`). */
export function normalizeToolResult<T extends { content?: string; data?: unknown; error?: string }>(result: T): T & { data: Record<string, unknown> } {
  if (result.error) return { ...result, content: result.content ?? result.error, data: result.data && typeof result.data === "object" && !Array.isArray(result.data) ? (result.data as Record<string, unknown>) : { ok: false, error: result.error } };
  return { ...result, data: toToolData(result.data) };
}
