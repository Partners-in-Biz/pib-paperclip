/**
 * Runs work after an action has returned, outside that action's invocation.
 *
 * The SDK keeps the current host invocation in an AsyncLocalStorage, so a `void promise` started inside an action
 * carries the action's invocation id. The host forgets that id once the action returns, and then refuses every call
 * the background work makes ("missing, expired, or unknown invocation scope"). This snapshot is taken at import time,
 * outside any invocation, so work run through it uses the host's no-invocation (proactive company) scope instead,
 * the same scope the per-minute job uses.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const outsideAnyInvocation = AsyncLocalStorage.snapshot();

export function runDetached<T>(work: () => T): T {
  return outsideAnyInvocation(work);
}
