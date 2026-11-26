/**
 * The one place the Voice UI gets its actions (access stage A, spec PAR-12578 section 4.6; PAR-12678).
 * `useVoiceAction` throws `AccessRefused` with the worker's message when the guard refuses, so a refusal never
 * reads as success (a voice note that inserts nothing, a picker that says "saved"). `useAccessMe` is the gate's
 * loader: it must see the refusal answer as it is.
 * No other UI file imports `usePluginAction` (tests/access.spec.ts checks it).
 */
import { useMemo } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { withRefusal } from "@partnersinbiz/pib-plugin-ui";

export const useVoiceAction = withRefusal(usePluginAction);

/** The permission behind the mic and the live call. */
export const VOICE_USE = "voice.use:create";

/**
 * An `access.me` answer as the overlay reads it. The mic is all Voice shows, so an open answer whose permissions
 * lack `voice.use:create` (a person with `voice.settings` only) is closed. An open answer with no permissions
 * listed (access could not be read) stays open, as the kit's gate fails open; the guard still refuses behind it.
 */
export function voiceAccess(answer: unknown): unknown {
  if (!answer || typeof answer !== "object") return answer;
  const a = answer as { open?: unknown; permissions?: unknown };
  if (a.open !== true || !Array.isArray(a.permissions) || a.permissions.length === 0) return answer;
  return a.permissions.includes(VOICE_USE) ? answer : { ...a, open: false };
}

/** The permission behind the voices an agent speaks with (the Voice tab on the agent page). */
export const VOICE_SETTINGS = "voice.settings:edit";

/** Like `voiceAccess`, but the agent's Voice tab is open to a person with either `voice.use` or `voice.settings`. */
export function voiceTabAccess(answer: unknown): unknown {
  if (!answer || typeof answer !== "object") return answer;
  const a = answer as { open?: unknown; permissions?: unknown };
  if (a.open !== true || !Array.isArray(a.permissions) || a.permissions.length === 0) return answer;
  return a.permissions.includes(VOICE_USE) || a.permissions.includes(VOICE_SETTINGS) ? answer : { ...a, open: false };
}

/** The guard's `access.me` action for the Voice tab, read by `voiceTabAccess`. */
export function useTabAccessMe() {
  const me = usePluginAction("access.me");
  return useMemo(() => async (params?: Record<string, unknown>) => voiceTabAccess(await me(params)), [me]);
}

/** The guard's `access.me` action, read by `voiceAccess`, for `useAccess`. Stable while the inner action is. */
export function useAccessMe() {
  const me = usePluginAction("access.me");
  return useMemo(() => async (params?: Record<string, unknown>) => voiceAccess(await me(params)), [me]);
}
