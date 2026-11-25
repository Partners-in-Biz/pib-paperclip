/**
 * Run background work outside the host invocation that started it.
 *
 * The SDK stamps every worker-to-host call with the id of the invocation it
 * runs in (AsyncLocalStorage). Work a tool call, page load or event starts but
 * does not wait for (the managed-skill sync, `rememberCompany`) keeps that id
 * after the invocation ended, so the host refuses its calls: `not allowed to
 * perform "config.get" ... missing, expired, or unknown invocation scope`
 * (PAR-13342). Started here, the work carries no id, so the host answers it
 * like a timer: it acts for companies with saved settings only.
 *
 * The resource is created at module load (worker start, in no invocation), so
 * the scope it captures is empty.
 */
import { AsyncResource } from "node:async_hooks";

const outside = new AsyncResource("pib-kit.detached");

export function runDetached<T>(fn: () => T): T {
  return outside.runInAsyncScope(fn);
}
