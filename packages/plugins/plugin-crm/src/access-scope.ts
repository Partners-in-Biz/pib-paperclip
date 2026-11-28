/**
 * The guard's decision for the call in progress (access stage B, PAR-12581 B-D3). The worker's action, tool, canvas
 * and API route wrappers run each handler inside `withAccessCheck(check, ...)`; `viewerFor` reads it, so every
 * `Viewer` built during a guarded call carries a `linked` decision's companies without each of the many handlers
 * passing `check` along. Outside a guarded call (events, jobs, detached work) there is no check: scope `all`.
 *
 * Only `enforce` hands a `linked` decision to a handler (the kit guard), so with the switch off or on `report`
 * nothing here changes an answer.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { AccessCheck } from "@partnersinbiz/pib-plugin-kit";

const current = new AsyncLocalStorage<AccessCheck>();

export function withAccessCheck<T>(check: AccessCheck | undefined, run: () => T): T {
  return check ? current.run(check, run) : run();
}

/** The person the guard decided for (the host's acting person, else the signed-in person), or null. */
export function actingUserIdNow(): string | null {
  const caller = current.getStore()?.caller;
  if (!caller) return null;
  return caller.onBehalfOf?.userId ?? (caller.type === "user" ? caller.userId : null);
}

/** The CRM companies of the call's `linked` decision, or null (scope `all`, or no guarded call). */
export function linkedCompanyIdsNow(): readonly string[] | null {
  const decision = current.getStore()?.decision;
  return decision && decision.scope === "linked" ? decision.companyIds : null;
}
