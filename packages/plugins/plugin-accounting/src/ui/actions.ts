/**
 * The one file of the Accounting page that imports the sdk's `usePluginAction`
 * (access stage A, spec PAR-12578 section 4.6). Page files use `useAccountingAction`,
 * so a refused action throws `AccessRefused` with the worker's message instead of
 * reading as success; `tests/access.spec.ts` fails on any other direct import.
 */
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { withRefusal, type AccessLoader } from "@partnersinbiz/pib-plugin-ui";

export const useAccountingAction = withRefusal(usePluginAction);

/** The guard's `access.me` for the page gate (`useAccess`); a refusal answer there reads as closed. */
export const useAccessMe = (): AccessLoader => usePluginAction("access.me");
