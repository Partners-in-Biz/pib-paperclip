import type { ProviderEffectPayload } from "../provider-effects.js";

/** PAR-12608 4.6a row 11: the delivery's recorded reason and the sender's reply. */
export const RESTRICTED_SENDER_REASON = "Linked Paperclip account is restricted in this company";
/** PAR-14560: the delivery's recorded reason when GitHub automatic work's responsible user is restricted. */
export const RESTRICTED_RESPONSIBLE_USER_REASON = "Responsible Paperclip account is restricted in this company";
export const RESTRICTED_SENDER_NOTICE =
  "Your Paperclip account is restricted in this company, so this message was not accepted.";

/**
 * The reply to a message from a restricted member's linked identity, staged
 * with the filtered delivery. Private to him where the provider can post
 * ephemeral messages, else in the thread. `safe_notice`: it names no task and
 * is sent although his identity is no longer authorized.
 */
export function restrictedSenderNotice(input: {
  deliveryId: string;
  threadId: string;
  authorUserId: string;
  ephemeral: boolean;
  resourceId?: string;
}): { providerActionId: string; payload: Omit<ProviderEffectPayload, "runtimeGeneration" | "credentialFingerprint"> } {
  const common = {
    version: 1 as const,
    authorizationMode: "safe_notice" as const,
    threadId: input.threadId,
    text: RESTRICTED_SENDER_NOTICE,
    settleDelivery: false,
  };
  return {
    providerActionId: `provider_effect:restricted-sender:${input.deliveryId}`,
    payload: input.ephemeral
      ? { ...common, effect: "ephemeral_message", userId: input.authorUserId, fallbackText: RESTRICTED_SENDER_NOTICE }
      : { ...common, effect: "thread_message", ...(input.resourceId ? { resourceId: input.resourceId } : {}) },
  };
}
