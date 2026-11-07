/**
 * Studio's page actions (PAR-8120). The worker answers a refusal as `{ ok: false, refused: true, message }` with a 200
 * (see ../refusal.ts), so the reason survives the host and Cloudflare. This hook throws it again as a normal Error, so
 * every caller's existing `catch` shows the real message.
 */
import { useCallback } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { unwrapAction } from "../refusal.js";

export function useStudioAction(key: string): (params?: Record<string, unknown>) => Promise<unknown> {
  const run = usePluginAction(key);
  return useCallback(async (params?: Record<string, unknown>) => unwrapAction(await run(params)), [run]);
}
