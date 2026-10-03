/** The plugin's public endpoints, declared in the manifest (kept apart from the handlers so the manifest stays small). */
export const WEBHOOK_KEYS = { unsubscribe: "unsubscribe", messagingInbound: "messaging-inbound" } as const;

/** The webhooks the manifest declares. */
export const WEBHOOKS = [
  {
    endpointKey: WEBHOOK_KEYS.unsubscribe,
    displayName: "Unsubscribe",
    description: "A recipient unsubscribes from one sender's campaigns. Takes a signed token from the unsubscribe page or a one-click POST; no sign-in.",
  },
  {
    endpointKey: WEBHOOK_KEYS.messagingInbound,
    displayName: "SMS and WhatsApp replies",
    description: "A reply forwarded as JSON, with the company's shared secret in the x-pib-webhook-secret header. Optional: replies are also read by polling.",
  },
];
