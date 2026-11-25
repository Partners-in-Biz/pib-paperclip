/**
 * The one place the Studio pages get their actions (PAR-8120; access stage A, spec PAR-12578 section 4.6, PAR-12688).
 * The worker answers a refusal as `{ ok: false, refused: true, message }` with a 200 (the kit's refusal form), so the
 * reason survives the host and Cloudflare. `useStudioAction` (the UI kit's `withRefusal`) throws it again as an
 * `AccessRefused` error with the worker's message, so every caller's existing `catch` shows the real reason and a
 * refusal never reads as success. `useAccessMe` is the page gate's loader: it must see the refusal answer as it is.
 * No other page file imports `usePluginAction` (tests/access.spec.ts checks it).
 */
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { withRefusal } from "@partnersinbiz/pib-plugin-ui";

export const useStudioAction: (key: string) => (params?: Record<string, unknown>) => Promise<unknown> = withRefusal(usePluginAction);

/** The guard's `access.me` action, for `useAccess`. */
export const useAccessMe = () => usePluginAction("access.me");
