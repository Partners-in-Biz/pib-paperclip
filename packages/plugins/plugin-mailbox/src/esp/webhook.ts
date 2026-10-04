/**
 * The public webhook `resend` (`POST /api/plugins/partnersinbiz.mailbox/webhooks/resend`): the provider's delivery events.
 *
 * The host route is public and hands the plugin the raw body and the headers, and nothing else: no company, no caller.
 * So a delivery is handled in this order, and nothing is believed before step 3:
 *
 * 1. The Svix headers must be there, well formed and fresh (`checkSvixShape`): refused before any secret is asked for,
 *    because the host lets a plugin resolve 30 secrets a minute per company and the address is public.
 * 2. Which company it is for. The webhook is signed with that company's signing secret and nothing in the request can be
 *    trusted to name it, so the delivery's own `pib_company` tag (set on every message the Mailbox sends) only says which
 *    company to try FIRST; every company that has the provider on and a webhook secret saved is a candidate.
 * 3. The signature is checked against each candidate's secret (constant time). The company whose secret verifies is the
 *    company; a delivery that verifies for none is refused (HTTP 502 from the host: the provider retries, and the host
 *    records the failure). A replayed old delivery fails the five minute window; a second copy of a fresh one is recognised
 *    by its delivery id and changes nothing.
 * 4. Only then is the body read and applied (`events.ts`), scoped to that company.
 *
 * A refusal throws `WebhookRejected`. The host answers a public caller with the error's message, so the message is the same short
 * sentence for every kind of refusal (it must not say whether a company has the provider set up, or which check failed); the code
 * is on the error and in the worker log, never in the answer, and never the secret or the body.
 */
import type { PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { isModuleEnabled } from "@partnersinbiz/pib-plugin-kit";
import { loadMailboxConfig, type LoadedConfig } from "../config.js";
import { ESP_ENDPOINT } from "../constants.js";
import { errorMessage, type Env } from "../gmail/env.js";
import { PLUGIN_ID } from "../namespace.js";
import { knownCompanies } from "../setup-status.js";
import { applyEspEvent, type EspEventOutcome } from "./events.js";
import { parseResendEvent } from "./resend.js";
import { espSecret } from "./runtime.js";
import { checkSvixShape, verifySvix, type SvixRejection } from "./svix.js";

export { ESP_ENDPOINT };
/** A delivery is small; refuse anything bigger before it is parsed. */
export const MAX_WEBHOOK_BYTES = 256 * 1024;

/** What the public caller is told about any refusal. */
export const REFUSED = "The delivery could not be verified";

export class WebhookRejected extends Error {
  constructor(readonly code: SvixRejection | "too_large" | "unconfigured", readonly detail: string) {
    super(REFUSED);
    this.name = "WebhookRejected";
  }
}

const CANDIDATES_TTL_MS = 60_000;
let candidates: { at: number; companies: LoadedConfig[] } | null = null;

/** The address is public, so a refusal is logged at most once a minute per reason (with how many more there were), at info level: a flood must not fill the log. */
const REFUSAL_LOG_EVERY_MS = 60_000;
const refusalLog = new Map<string, { at: number; held: number }>();

export function forgetWebhookCandidates(): void {
  candidates = null;
  refusalLog.clear();
}

/**
 * The companies that have the provider on with a webhook secret saved, with their settings. Cached for a minute (the same time the
 * signing secret itself is kept): a flood of deliveries must not read every company's settings each time, and a settings change is
 * seen within the minute.
 */
async function candidateCompanies(env: Env): Promise<LoadedConfig[]> {
  const now = env.now();
  if (candidates && now - candidates.at < CANDIDATES_TTL_MS) return candidates.companies;
  const companies: LoadedConfig[] = [];
  for (const companyId of await knownCompanies(env.ctx)) {
    try {
      const loaded = await loadMailboxConfig(env.ctx, companyId);
      if (loaded.config.esp.enabled && loaded.config.esp.hasWebhookSecret) companies.push(loaded);
    } catch {
      // a company whose settings cannot be read is not a candidate
    }
  }
  candidates = { at: now, companies };
  return companies;
}

/** The company a body claims through its `pib_company` tag, without believing it. */
function claimedCompany(rawBody: string): string | null {
  try {
    const tags = parseResendEvent(rawBody)?.tags;
    return tags?.pib_company ?? null;
  } catch {
    return null;
  }
}

/** Logs why for the owner (the worker log, no body, no secret; once a minute per reason) and returns the error the host will answer with. */
function refuse(env: Pick<Env, "ctx" | "now">, code: WebhookRejected["code"], detail: string): WebhookRejected {
  const now = env.now();
  const last = refusalLog.get(code);
  if (!last || now - last.at >= REFUSAL_LOG_EVERY_MS) {
    env.ctx.logger.info("Provider webhook refused", { code, detail, ...(last && last.held > 0 ? { alsoRefused: last.held } : {}) });
    refusalLog.set(code, { at: now, held: 0 });
  } else {
    last.held += 1;
  }
  return new WebhookRejected(code, detail);
}

export interface WebhookResult {
  outcome: EspEventOutcome;
  companyId: string;
}

/** Handles one delivery. Throws `WebhookRejected` for what is not a verified delivery; any other error means it could not be applied (the provider retries). */
export async function handleEspWebhook(env: Env, input: Pick<PluginWebhookInput, "headers" | "rawBody">): Promise<WebhookResult> {
  const now = env.now();
  const rawBody = input.rawBody ?? "";
  if (rawBody.length > MAX_WEBHOOK_BYTES) throw refuse(env, "too_large", "The delivery is larger than a provider event can be");
  const shape = checkSvixShape(input.headers, now);
  if (!shape.ok) throw refuse(env, shape.code, shape.message);

  const all = await candidateCompanies(env);
  const claimed = claimedCompany(rawBody);
  // Every candidate is tried: the claim only picks who goes first, it never excludes anyone.
  const order = claimed && all.some((entry) => entry.companyId === claimed) ? [...all.filter((entry) => entry.companyId === claimed), ...all.filter((entry) => entry.companyId !== claimed)] : all;
  if (order.length === 0) throw refuse(env, "unconfigured", "No company has the email provider switched on with a webhook signing secret");

  let verified: { loaded: LoadedConfig; id: string } | null = null;
  let last: SvixRejection = "bad_signature";
  for (const loaded of order) {
    const secret = await espSecret(loaded, "esp.webhookSecret", now).catch(() => undefined);
    if (!secret) continue;
    const result = verifySvix({ secret, rawBody, headers: input.headers, nowMs: now });
    if (result.ok) {
      verified = { loaded, id: result.id };
      break;
    }
    last = result.code;
  }
  if (!verified) throw refuse(env, last, last === "bad_signature" ? "The signature matches no company's webhook signing secret" : "The delivery could not be verified");

  const companyId = verified.loaded.companyId;
  // Switched off in Setup: acknowledge, so the provider stops retrying, and change nothing.
  if (!(await isModuleEnabled(env.ctx, companyId, PLUGIN_ID))) return { outcome: "ignored", companyId };
  const event = parseResendEvent(rawBody);
  if (!event) return { outcome: "ignored", companyId };
  try {
    return { outcome: await applyEspEvent(env, verified.loaded, event, { id: verified.id }), companyId };
  } catch (error) {
    env.ctx.logger.warn("Provider event not applied; the provider will deliver it again", { type: event.type, error: errorMessage(error) });
    throw error;
  }
}
