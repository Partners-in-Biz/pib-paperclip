import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";

export type VoiceAccess = { ok: true; userId: string } | { ok: false; status: 403; error: string };

export function checkVoiceAccess(actor: PluginApiRequestInput["actor"], allowedUserIds: readonly string[]): VoiceAccess {
  if (actor.actorType !== "user") {
    return { ok: false, status: 403, error: "Only a signed-in person can use the dialer" };
  }

  const userId = actor.userId ?? actor.actorId;

  if (allowedUserIds.length === 0) {
    return { ok: false, status: 403, error: "Calling is not enabled for any user" };
  }

  if (!allowedUserIds.includes(userId)) {
    return { ok: false, status: 403, error: "Calling is not enabled for this user" };
  }

  return { ok: true, userId };
}
