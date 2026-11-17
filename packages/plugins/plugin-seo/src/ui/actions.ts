/**
 * The one place the SEO pages get their actions (access stage A, spec PAR-12578 section 4.6; PAR-12676).
 * `useSeoAction` throws `AccessRefused` with the worker's message when the guard refuses, so a refusal never
 * reads as success. `useAccessMe` is the page gate's loader: it must see the refusal answer as it is.
 * No other page file imports `usePluginAction` (tests/access.spec.ts checks it).
 */
import { useMemo } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { withRefusal } from "@partnersinbiz/pib-plugin-ui";
import { SEO_CALL_ACTIONS, seoCallAction } from "../access-table.js";

export const useSeoAction = withRefusal(usePluginAction);

/** The guard's `access.me` action, for `useAccess`. */
export const useAccessMe = () => usePluginAction("access.me");

const CALL_KEYS = Object.keys(SEO_CALL_ACTIONS);

/**
 * The page's `call({ tool, params })` to a dispatch handler, as `seo.call` was: each handler goes through the call
 * action of its own permission (access-table.ts), so the guard checks that permission.
 */
export function useSeoCall(): (input: { tool: string; params?: Record<string, unknown> }) => Promise<unknown> {
  const fns: Record<string, (params?: Record<string, unknown>) => Promise<unknown>> = {};
  // Fixed list, fixed order: the hooks run in the same order on every render.
  for (const key of CALL_KEYS) fns[key] = useSeoAction(key);
  const deps = CALL_KEYS.map((key) => fns[key]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (input) => fns[seoCallAction(input.tool) ?? "seo.call"]!(input), deps);
}
