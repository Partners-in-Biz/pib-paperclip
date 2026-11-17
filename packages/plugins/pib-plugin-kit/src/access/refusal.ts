/**
 * The refusal form of a page action (moved from Studio, PAR-12578 plan 4.4 and 7).
 *
 * A refused action answers `{ ok: false, refused: true, code, message }` with a
 * normal 200, never a throw (PAR-8120). A thrown action error reaches the browser
 * as a host 502, and Cloudflare swaps that body for its own error page, so the
 * person saw "Request failed: 502" instead of the reason. Genuine faults still throw.
 * The page side (`unwrapAction`) turns the refusal back into an Error with the same message.
 *
 * Pure: no sdk or Node import, so a plugin's page bundle can import it too.
 */

export const PERMISSION_DENIED = "PERMISSION_DENIED";

export interface ActionRefusal {
  ok: false;
  refused: true;
  code: string;
  message: string;
}

export function refusalOf(error: { code: string; message: string }): ActionRefusal {
  return { ok: false, refused: true, code: error.code, message: error.message };
}

/** The access guard's refusal: code `PERMISSION_DENIED`. */
export function permissionRefusal(message: string): ActionRefusal {
  return refusalOf({ code: PERMISSION_DENIED, message });
}

export function isRefusal(value: unknown): value is ActionRefusal {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.ok === false && v.refused === true && typeof v.message === "string";
}

export class RefusalError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "RefusalError";
  }
}

/** Page side: the action's answer, or a thrown RefusalError carrying the worker's reason. */
export function unwrapAction(result: unknown): unknown {
  if (isRefusal(result)) throw new RefusalError(result.message, result.code);
  return result;
}

/**
 * Wraps an action handler: an error that `isRefusalError` accepts becomes a
 * refusal answer; anything else is rethrown as before.
 */
export function guardAction<P, C, R>(
  handler: (params: P, context: C) => Promise<R>,
  isRefusalError: (error: unknown) => error is { code: string; message: string },
): (params: P, context: C) => Promise<R | ActionRefusal> {
  return async (params, context) => {
    try {
      return await handler(params, context);
    } catch (error) {
      if (isRefusalError(error)) return refusalOf(error);
      throw error;
    }
  };
}
