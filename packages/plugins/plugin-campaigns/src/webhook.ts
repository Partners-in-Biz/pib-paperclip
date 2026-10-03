/**
 * The plugin's public endpoints (`POST /api/plugins/<plugin>/webhooks/<key>`).
 *
 * The host's webhook route is public (no sign-in), takes JSON only, passes the
 * worker the headers and the body but not the address or its query string, and
 * answers `{ deliveryId, status }`. So:
 *
 * - `unsubscribe` takes the signed token in the JSON body (`{ "token": "..." }`,
 *   what the landing page posts) or in the `x-unsubscribe-token` header (what a
 *   front-door rule sets for an RFC 8058 one-click POST, which carries the token in
 *   the address, not the body). The token is checked against the company's secret.
 *   A bad token is refused with one plain message and nothing is learnt from it.
 *   Unsubscribing twice is harmless.
 * - `messaging-inbound` takes a reply forwarded as JSON with the company's shared
 *   secret (see `inbound.ts`).
 *
 * The host keeps each delivery's headers and payload in its own log table, which
 * a plugin cannot prune: the unsubscribe token (and so the address in it) lands
 * there. The README says so and asks for that table to be pruned.
 */
import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import type { UnsubscribePayload } from "@partnersinbiz/pib-plugin-kit";
import { handleInboundWebhook } from "./inbound.js";
import { checkUnsubscribeToken } from "./links.js";
import { PLUGIN_ID } from "./namespace.js";
import { announceSuppression, suppressAddress, suppressionPayload } from "./suppress.js";
import { WEBHOOK_KEYS, WEBHOOKS } from "./webhook-keys.js";

export { WEBHOOKS, WEBHOOK_KEYS };

const REFUSED = "This unsubscribe link is not valid.";

function header(headers: PluginWebhookInput["headers"], name: string): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

/** The token from the header or the JSON body; empty when there is none. */
export function tokenFrom(input: Pick<PluginWebhookInput, "headers" | "parsedBody">): string {
  const fromHeader = header(input.headers, "x-unsubscribe-token");
  if (fromHeader) return fromHeader;
  const body = input.parsedBody && typeof input.parsedBody === "object" ? (input.parsedBody as Record<string, unknown>) : {};
  return typeof body.token === "string" ? body.token.trim() : "";
}

/** A sender key as the client it names, for the announcement. */
function clientOf(senderKey: string): { clientKind: "company" | "contact" | null; clientRef: string | null } {
  const match = /^(company|contact):(.+)$/.exec(senderKey);
  return match ? { clientKind: match[1] as "company" | "contact", clientRef: match[2]! } : { clientKind: null, clientRef: null };
}

/** Records an opt-out from a link: the address goes on that sender's list, their running campaigns stop, the CRM and Mailbox are told. */
export async function unsubscribeByLink(ctx: PluginContext, payload: UnsubscribePayload): Promise<void> {
  const outcome = await suppressAddress(ctx, { companyId: payload.companyId, email: payload.email, reason: "unsubscribe", scope: "marketing", source: PLUGIN_ID, senderKey: payload.senderKey });
  await announceSuppression(ctx, payload.companyId, suppressionPayload({ email: payload.email, reason: "unsubscribe", scope: "marketing", senderKey: payload.senderKey, ...clientOf(payload.senderKey) }));
  // The address is never logged.
  ctx.logger.info("Unsubscribed through a link", { companyId: payload.companyId, senderKey: payload.senderKey, added: outcome.created, stopped: outcome.stoppedContacts });
}

export async function handleUnsubscribeWebhook(ctx: PluginContext, input: Pick<PluginWebhookInput, "headers" | "parsedBody">): Promise<void> {
  const token = tokenFrom(input);
  const payload = token ? await checkUnsubscribeToken(ctx, token) : null;
  if (!payload) throw new Error(REFUSED);
  await unsubscribeByLink(ctx, payload);
}

export async function handleWebhook(ctx: PluginContext, input: PluginWebhookInput): Promise<void> {
  if (input.endpointKey === WEBHOOK_KEYS.unsubscribe) return handleUnsubscribeWebhook(ctx, input);
  if (input.endpointKey === WEBHOOK_KEYS.messagingInbound) return handleInboundWebhook(ctx, input);
  throw new Error("Unknown endpoint.");
}
