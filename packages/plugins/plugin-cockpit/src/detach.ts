/**
 * Runs work outside the current host invocation (same as Studio's `src/detach.ts`).
 *
 * The SDK keeps the current host invocation in an AsyncLocalStorage, so work started inside an action carries the
 * action's invocation id. The host forgets that id once the action returns or times out (30 s), and then refuses every
 * call the work still makes (`unknown_invocation`, PAR-14009). This snapshot is taken at import time, outside any
 * invocation, so work run through it uses the host's no-invocation scope instead: the same scope the hourly job uses,
 * which admits a company only when the Cockpit's settings are saved for it.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const outsideAnyInvocation = AsyncLocalStorage.snapshot();

export function runDetached<T>(work: () => T): T {
  return outsideAnyInvocation(work);
}
