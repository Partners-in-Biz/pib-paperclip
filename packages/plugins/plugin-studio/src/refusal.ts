/**
 * Page actions answer a plain refusal (a StudioError) as `{ ok: false, refused: true, code, message }` with a normal
 * 200, not a throw (PAR-8120). A thrown action error reaches the browser as a host 502, and Cloudflare swaps that body
 * for its own error page, so the person saw "Request failed: 502" instead of the reason. Genuine faults still throw.
 * The page side (ui/action.ts) turns the refusal back into an Error with the same message.
 */
import { StudioError } from "./errors.js";

export interface StudioRefusal {
  ok: false;
  refused: true;
  code: string;
  message: string;
}

export function refusalOf(error: StudioError): StudioRefusal {
  return { ok: false, refused: true, code: error.code, message: error.message };
}

export function isRefusal(value: unknown): value is StudioRefusal {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.ok === false && v.refused === true && typeof v.message === "string";
}

export class StudioRefusalError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "StudioRefusalError";
  }
}

/** Page side: the action's answer, or a thrown StudioRefusalError carrying the worker's reason. */
export function unwrapAction(result: unknown): unknown {
  if (isRefusal(result)) throw new StudioRefusalError(result.message, result.code);
  return result;
}

/** Wrap an action handler: a StudioError becomes a refusal answer; anything else is rethrown as before. */
export function guardAction<P, C, R>(handler: (params: P, context: C) => Promise<R>): (params: P, context: C) => Promise<R | StudioRefusal> {
  return async (params, context) => {
    try {
      return await handler(params, context);
    } catch (error) {
      if (error instanceof StudioError) return refusalOf(error);
      throw error;
    }
  };
}
