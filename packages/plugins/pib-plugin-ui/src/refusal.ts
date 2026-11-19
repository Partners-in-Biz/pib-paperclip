/**
 * Refusals on the page, once (access stage A, spec PAR-12578 sections 4.4 and 4.6). A guarded action answers a
 * refusal as a normal 200 `{ ok: false, refused: true, code: "PERMISSION_DENIED", message }`, never a throw, so
 * without help a page reads it as success (a Save button that says "saved"). `withRefusal(usePluginAction)`
 * gives a hook whose action throws `AccessRefused` with the worker's message instead. Each plugin exports the
 * wrapped hook from one file. This package has no sdk dependency, so the plugin passes the sdk hook in.
 */
import { useMemo } from "react";

export interface RefusalAnswer {
  ok: false;
  refused: true;
  code: string;
  message: string;
}

/** The refusal form of 4.4 (also Studio's older refusals, which use their own codes). */
export function isRefusal(value: unknown): value is RefusalAnswer {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.ok === false && v.refused === true && typeof v.message === "string";
}

export class AccessRefused extends Error {
  readonly code: string;
  constructor(message: string, code: string = "PERMISSION_DENIED") {
    super(message);
    this.name = "AccessRefused";
    this.code = code;
  }
}

/** The answer as it is, or a thrown `AccessRefused` carrying the worker's message for a refusal. */
export function unwrapRefusal<T>(answer: T): T {
  if (isRefusal(answer)) throw new AccessRefused(answer.message, typeof answer.code === "string" ? answer.code : undefined);
  return answer;
}

type ActionFn = (params?: Record<string, unknown>) => Promise<unknown>;

/**
 * Wraps an action hook (the sdk's `usePluginAction`). The wrapped action keeps the same identity for as long
 * as the inner one does, so it is safe in effect and callback dependencies. Errors the inner action throws
 * (bridge errors, a 403) pass through unchanged.
 */
export function withRefusal<A extends unknown[], F extends ActionFn>(hook: (...args: A) => F): (...args: A) => F {
  return function useRefusalAction(...args: A): F {
    const inner = hook(...args);
    return useMemo(() => (async (params?: Record<string, unknown>) => unwrapRefusal(await inner(params))) as F, [inner]);
  };
}
