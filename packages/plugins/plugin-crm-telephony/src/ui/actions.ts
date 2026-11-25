/**
 * The one place the Telephony pages get their actions (access stage A, spec PAR-12578 section 4.6; PAR-12683).
 * `useTelephonyAction` throws `AccessRefused` with the worker's message when the guard refuses, so a refusal never
 * reads as success. `useAccessMe` is the page gate's loader: it must see the refusal answer as it is.
 * No other page file imports `usePluginAction` (tests/access.spec.ts checks it).
 */
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { withRefusal } from "@partnersinbiz/pib-plugin-ui";

export const useTelephonyAction = withRefusal(usePluginAction);

/** The guard's `access.me` action, for `useAccess`. */
export const useAccessMe = () => usePluginAction("access.me");
