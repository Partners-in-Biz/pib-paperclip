/**
 * SNS webhook for Amazon SES. The public webhook `ses` (`POST /api/plugins/partnersinbiz.mailbox/webhooks/ses`): the SES configuration set's
 * bounce, complaint, delivery and other events via SNS.
 *
 * The host route is public and hands the plugin the raw body and headers, and nothing else. A message is handled in this order,
 * and nothing is believed before step 3:
 *
 * 1. Shape checks (JSON, field presence, format): refused before any network call, because the address is public and the host lets
 *    a plugin fetch 10 certificates a minute per topic ARN.
 * 2. The company(ies) that have SES on with the topic ARN saved: candidates are cached 60 seconds. A new ARN saved less than 10 seconds
 *    ago is found on a cache miss re-read.
 * 3. AWS signature verification: certificate fetch (cached 24 hours, at most 8 URLs; budget 10 fetches per minute per topic ARN),
 *    RSA-SHA1 or RSA-SHA256 depending on SignatureVersion.
 * 4. Message handling: confirmation fetches the subscribe URL and marks the topic confirmed; unsubscribe is logged and ignored;
 *    notification parses the inner SES event and applies it.
 * 5. Topic confirmation is per ARN in company state; changing the saved ARN resets it.
 */
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import type { PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { isModuleEnabled } from "@partnersinbiz/pib-plugin-kit";
import { loadMailboxConfig, type LoadedConfig } from "../config.js";
import { errorMessage, type Env } from "../gmail/env.js";
import { PLUGIN_ID } from "../namespace.js";
import { knownCompanies } from "../setup-status.js";
import { applyEspEvent, type EspEventOutcome } from "./events.js";
import { parseSesEvent } from "./ses.js";
import { markSesTopicConfirmed, readSesTopicConfirmed } from "./topic-state.js";
import { WebhookRejected, MAX_WEBHOOK_BYTES, REFUSED, type WebhookResult } from "./webhook.js";

export { SES_ENDPOINT } from "../constants.js";

const CANDIDATES_TTL_MS = 60_000;
let candidates: { at: number; companies: LoadedConfig[] } | null = null;
const MISS_REREAD_THROTTLE_MS = 10_000;
let lastMissRereadAt = -Infinity;

const CERT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const certs = new Map<string, { pem: string; expires: number }>();

const CERT_BUDGET_WINDOW_MS = 60_000;
const certBudgets = new Map<string, { at: number; fetches: number }>();

const REFUSAL_LOG_EVERY_MS = 60_000;
const refusalLog = new Map<string, { at: number; held: number }>();

export function forgetSnsCandidates(): void {
  candidates = null;
  lastMissRereadAt = -Infinity;
}

export function forgetSnsCerts(): void {
  certs.clear();
  certBudgets.clear();
}

export function forgetSnsRefusals(): void {
  refusalLog.clear();
}

/**
 * The companies that have SES provider on with a topic ARN saved, with their settings. Cached for 60 seconds.
 */
async function candidateCompanies(env: Env): Promise<LoadedConfig[]> {
  const now = env.now();
  if (candidates && now - candidates.at < CANDIDATES_TTL_MS) return candidates.companies;
  const companies: LoadedConfig[] = [];
  for (const companyId of await knownCompanies(env.ctx)) {
    try {
      const loaded = await loadMailboxConfig(env.ctx, companyId);
      if (loaded.config.esp.enabled && loaded.config.esp.provider === "ses" && loaded.config.esp.ses.snsTopicArn) companies.push(loaded);
    } catch {
      // a company whose settings cannot be read is not a candidate
    }
  }
  candidates = { at: now, companies };
  return companies;
}

/**
 * Force a fresh read of candidates bypassing the cache, for use on a cache miss re-read.
 */
async function forceRefreshCandidates(env: Env, topicArn: string, region: string): Promise<LoadedConfig[]> {
  const now = env.now();
  const companies: LoadedConfig[] = [];
  for (const companyId of await knownCompanies(env.ctx)) {
    try {
      const loaded = await loadMailboxConfig(env.ctx, companyId);
      if (loaded.config.esp.enabled && loaded.config.esp.provider === "ses" && loaded.config.esp.ses.snsTopicArn === topicArn && loaded.config.esp.ses.region === region) companies.push(loaded);
    } catch {
      // a company whose settings cannot be read is not a candidate
    }
  }
  // Update the cache even on a refresh (so we don't immediately re-read again within the 60s window)
  candidates = { at: now, companies };
  return companies;
}

/** Logs why for the owner (the worker log, no body, no secret; once a minute per reason) and returns the error the host will answer with. */
function refuse(env: Pick<Env, "ctx" | "now">, code: string, detail: string): WebhookRejected {
  const now = env.now();
  const last = refusalLog.get(code);
  if (!last || now - last.at >= REFUSAL_LOG_EVERY_MS) {
    env.ctx.logger.warn("Provider webhook refused", { code, detail, ...(last && last.held > 0 ? { alsoRefused: last.held } : {}), ...(code === "empty_raw_body" ? { reason: "PAR-1853/T0" } : {}) });
    refusalLog.set(code, { at: now, held: 0 });
  } else {
    last.held += 1;
  }
  return new WebhookRejected(code as any, detail);
}

type SnsMessageType = "Notification" | "SubscriptionConfirmation" | "UnsubscribeConfirmation";

interface SnsMessage {
  Type: SnsMessageType;
  MessageId: string;
  Message: string;
  Timestamp: string;
  TopicArn: string;
  Signature: string;
  SignatureVersion: "1" | "2";
  SigningCertURL: string;
  SubscribeURL?: string;
  Token?: string;
  Subject?: string;
}

/**
 * Parse an ARN: `arn:aws:sns:<region>:<account>:<name>`. Returns region and account, or null if invalid.
 */
function parseArn(arn: string): { region: string; account: string } | null {
  const match = /^arn:aws:sns:([a-z]{2}-[a-z]+-\d):(\d{12}):/.exec(arn);
  if (!match) return null;
  return { region: match[1]!, account: match[2]! };
}

/**
 * Verify that SigningCertURL matches the expected pattern for the region.
 */
function isValidCertUrl(url: string, region: string): boolean {
  const pattern = new RegExp(`^https://sns\\.${region.replace(/\./g, "\\.")}\\.amazonaws\\.com/[^?#]+\\.pem$`);
  return pattern.test(url);
}

/**
 * Verify that SubscribeURL matches the expected pattern for the region.
 * Allows path and query string, but no userinfo or port tricks.
 */
function isValidSubscribeUrl(url: string, region: string): boolean {
  // Check for @ (userinfo trick) anywhere in URL
  if (url.includes("@")) return false;
  // Check for : after https:// (port trick)
  const hostEnd = url.indexOf("/", 10); // Skip "https://" (8 chars) and find first /
  const host = hostEnd >= 0 ? url.substring(0, hostEnd) : url;
  if (host.substring(8).includes(":")) return false; // After "https://"
  // Check pattern
  const pattern = new RegExp(`^https://sns\\.${region.replace(/\./g, "\\.")}\\.amazonaws\\.com([/?].*)?$`);
  return pattern.test(url);
}

/**
 * Fetch the certificate PEM from the URL. Cached for 24 hours, at most 8 URLs. Budget: 10 fetches per minute per topic ARN.
 */
async function fetchCertificate(env: Env, topicArn: string, url: string): Promise<string | null> {
  const now = env.now();

  // Check cache
  const cached = certs.get(url);
  if (cached && cached.expires > now) return cached.pem;

  // Check budget (accepted in the plan: budget is per known topic)
  const budgetKey = topicArn;
  const budget = certBudgets.get(budgetKey);
  const budgetExpires = budget ? budget.at + CERT_BUDGET_WINDOW_MS : 0;

  if (budget && now < budgetExpires) {
    if (budget.fetches >= 10) {
      throw refuse(env, "cert_budget", "Certificate fetch budget exceeded for this topic");
    }
    budget.fetches += 1;
  } else {
    certBudgets.set(budgetKey, { at: now, fetches: 1 });
  }

  // Evict old entries if we have too many cached
  if (certs.size >= 8) {
    const oldest = Array.from(certs.entries()).sort((a, b) => a[1].expires - b[1].expires)[0];
    if (oldest) certs.delete(oldest[0]);
  }

  // Fetch (redirects follow host policy)
  let pem: string;
  try {
    const http = env.esp?.fetch ?? ((u: string, init?: RequestInit) => env.ctx.http.fetch(u, init));
    const response = await http(url);
    if (!response.ok) throw refuse(env, "bad_certificate", "Failed to fetch the AWS signing certificate");
    const text = await response.text();
    if (text.length > 16 * 1024) throw refuse(env, "bad_certificate", "The AWS signing certificate is too large");
    pem = text;
  } catch (error) {
    if (error instanceof WebhookRejected) throw error;
    throw refuse(env, "bad_certificate", "Failed to fetch the AWS signing certificate");
  }

  // Cache
  certs.set(url, { pem, expires: now + CERT_CACHE_TTL_MS });
  return pem;
}

/**
 * Build the canonical string for signature verification.
 * AWS SNS format: each field is `Name\nValue\n` including trailing newline.
 */
export function canonicalString(message: SnsMessage): string {
  let canonical = "";
  const fields: (keyof SnsMessage)[] =
    message.Type === "Notification"
      ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
      : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];

  for (const field of fields) {
    const value = message[field];
    if (value !== undefined) {
      canonical += `${field}\n${value}\n`;
    }
  }
  return canonical;
}

/**
 * Verify the AWS signature on the message.
 */
function verifySnsSignature(message: SnsMessage, publicKey: KeyObject | string): boolean {
  const algo = message.SignatureVersion === "1" ? "rsa-sha1" : "rsa-sha256";
  const canonical = canonicalString(message);
  const signature = Buffer.from(message.Signature, "base64");

  try {
    return verify(algo, Buffer.from(canonical, "utf8"), publicKey, signature);
  } catch {
    return false;
  }
}

/**
 * Extract pib_company from the parsed Message if present (for resolving ambiguous ARNs).
 */
function extractCompanyId(message: string): string | null {
  try {
    const parsed = JSON.parse(message);
    if (parsed && typeof parsed === "object" && parsed.mail && Array.isArray(parsed.mail.tags?.pib_company)) {
      return parsed.mail.tags.pib_company[0] ?? null;
    }
  } catch {
    // Not JSON, not SES format, etc.
  }
  return null;
}

export async function handleSnsWebhook(env: Env, input: Pick<PluginWebhookInput, "rawBody">): Promise<WebhookResult> {
  const now = env.now();
  const rawBody = input.rawBody ?? "";

  // Step 0: Check rawBody is not empty
  if (!rawBody) throw refuse(env, "empty_raw_body", "SNS message arrived with an empty raw body: the host must capture text/plain webhook bodies (PAR-1853/T0)");

  // Step 1: Shape and format checks
  if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BYTES) throw refuse(env, "too_large", "The SNS message is larger than allowed");

  let message: SnsMessage;
  try {
    message = JSON.parse(rawBody) as SnsMessage;
  } catch {
    throw refuse(env, "not_json", "The SNS message is not valid JSON");
  }

  // Check Type
  if (!["Notification", "SubscriptionConfirmation", "UnsubscribeConfirmation"].includes(message.Type ?? "")) {
    throw refuse(env, "invalid_type", "The SNS message Type is not recognized");
  }

  // Check required fields
  const required = ["Message", "MessageId", "Timestamp", "TopicArn", "Type", "Signature", "SignatureVersion", "SigningCertURL"];
  if (message.Type === "SubscriptionConfirmation" || message.Type === "UnsubscribeConfirmation") {
    required.push("SubscribeURL", "Token");
  }
  for (const field of required) {
    if (typeof message[field as keyof SnsMessage] !== "string" || !message[field as keyof SnsMessage]) {
      throw refuse(env, "missing_field", `Required field ${field} is missing`);
    }
  }

  // Validate Signature is valid base64 format and length
  const sig = message.Signature;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(sig) || sig.length % 4 !== 0) {
    throw refuse(env, "invalid_signature_format", "Signature is not valid base64");
  }
  const decodedSig = Buffer.from(sig, "base64");
  if (decodedSig.length < 128 || decodedSig.length > 1024) {
    throw refuse(env, "invalid_signature_format", "Signature has invalid length");
  }

  // Validate SignatureVersion
  if (!["1", "2"].includes(message.SignatureVersion)) {
    throw refuse(env, "invalid_signature_version", "SignatureVersion must be 1 or 2");
  }

  // Parse TopicArn
  const arnParts = parseArn(message.TopicArn);
  if (!arnParts) throw refuse(env, "invalid_arn", "TopicArn is not a valid AWS ARN");

  // Validate SigningCertURL matches region
  if (!isValidCertUrl(message.SigningCertURL, arnParts.region)) {
    throw refuse(env, "invalid_cert_url", "SigningCertURL does not match the expected SNS endpoint");
  }

  // Validate SubscribeURL for SubscriptionConfirmation and UnsubscribeConfirmation
  if (message.Type === "SubscriptionConfirmation" || message.Type === "UnsubscribeConfirmation") {
    if (!isValidSubscribeUrl(message.SubscribeURL!, arnParts.region)) {
      throw refuse(env, "invalid_subscribe_url", "SubscribeURL does not match the expected SNS endpoint");
    }
  }

  // Step 2: Company candidate matching
  let all = await candidateCompanies(env);
  const candidates = all.filter((c) => c.config.esp.ses.snsTopicArn === message.TopicArn && c.config.esp.ses.region === arnParts.region);

  if (candidates.length === 0) {
    // Re-read once, at most every 10s (on a cache miss, check if the ARN was saved recently by forcing a fresh read)
    const now = env.now();
    if (now - lastMissRereadAt >= MISS_REREAD_THROTTLE_MS) {
      lastMissRereadAt = now;
      // Force a fresh read by invalidating the cache
      candidates.splice(0, candidates.length, ...(await forceRefreshCandidates(env, message.TopicArn, arnParts.region)));
      if (candidates.length === 0) {
        throw refuse(env, "unknown_topic", "The SNS topic is not configured in any company");
      }
    } else {
      throw refuse(env, "unknown_topic", "The SNS topic is not configured in any company");
    }
  }

  // Handle ambiguity for Notification
  let matched: LoadedConfig | null = null;
  if (message.Type === "Notification") {
    if (candidates.length > 1) {
      const companyId = extractCompanyId(message.Message);
      if (companyId) {
        const found = candidates.find((c) => c.companyId === companyId);
        if (!found) throw refuse(env, "ambiguous_topic", "Multiple companies match this topic but the pib_company tag does not resolve to any");
        matched = found;
      } else {
        throw refuse(env, "ambiguous_topic", "Multiple companies have this SNS topic configured but the message has no pib_company tag");
      }
    } else {
      matched = candidates[0]!;
    }
  }

  // Step 3: Signature verification
  let pem: string;
  try {
    const certPem = await fetchCertificate(env, message.TopicArn, message.SigningCertURL);
    if (!certPem) throw refuse(env, "bad_certificate", "Failed to fetch the AWS signing certificate");
    pem = certPem;
  } catch (error) {
    if (error instanceof WebhookRejected) throw error;
    throw refuse(env, "bad_certificate", "Failed to fetch the AWS signing certificate");
  }

  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: pem, format: "pem" });
  } catch {
    throw refuse(env, "bad_certificate", "The AWS signing certificate is not valid");
  }

  if (!verifySnsSignature(message, publicKey)) {
    throw refuse(env, "bad_signature", "The SNS message signature does not verify");
  }

  // Mark Notification topic confirmed after signature verifies (before parsing the body)
  if (message.Type === "Notification" && matched && (await isModuleEnabled(env.ctx, matched.companyId, PLUGIN_ID))) {
    const isConfirmed = await readSesTopicConfirmed(env.ctx, matched.companyId);
    if (!isConfirmed) {
      await markSesTopicConfirmed(env.ctx, matched.companyId, message.TopicArn, now);
    }
  }

  // Step 4: Handle message by type
  if (message.Type === "SubscriptionConfirmation") {
    // Check if module is enabled (consistent with Notification path)
    const firstCandidate = candidates[0];
    if (firstCandidate && !(await isModuleEnabled(env.ctx, firstCandidate.companyId, PLUGIN_ID))) {
      return { outcome: "ignored", companyId: firstCandidate.companyId };
    }

    // Defensive re-check before fetch (SubscribeURL was validated in step 1)
    if (!isValidSubscribeUrl(message.SubscribeURL!, arnParts.region)) {
      throw refuse(env, "invalid_subscribe_url", "SubscribeURL does not match the expected SNS endpoint");
    }
    // Fetch the subscribe URL (redirects follow host policy)
    let subscribeOk = false;
    try {
      const http = env.esp?.fetch ?? ((u: string, init?: RequestInit) => env.ctx.http.fetch(u, init));
      const response = await http(message.SubscribeURL!);
      if (response.ok) {
        subscribeOk = true;
      } else {
        env.ctx.logger.info("SNS SubscribeURL fetch failed", { status: response.status, topicArn: message.TopicArn });
      }
    } catch (error) {
      env.ctx.logger.info("SNS SubscribeURL fetch error", { error: errorMessage(error), topicArn: message.TopicArn });
    }

    // Mark confirmed only when the SubscribeURL fetch succeeded (response ok)
    if (subscribeOk) {
      for (const candidate of candidates) {
        await markSesTopicConfirmed(env.ctx, candidate.companyId, message.TopicArn, now);
      }
    }

    return { outcome: "ignored", companyId: firstCandidate?.companyId ?? "" };
  }

  if (message.Type === "UnsubscribeConfirmation") {
    env.ctx.logger.info("SNS unsubscribe confirmation received", { topicArn: message.TopicArn });
    return { outcome: "ignored", companyId: candidates[0]?.companyId ?? "" };
  }

  // Notification
  if (!matched) {
    // This shouldn't happen based on step 2, but defensive check
    throw refuse(env, "no_match", "No company matched for this notification");
  }

  const companyId = matched.companyId;

  // Switched off in Setup: acknowledge, so SNS stops retrying, and change nothing
  if (!(await isModuleEnabled(env.ctx, companyId, PLUGIN_ID))) return { outcome: "ignored", companyId };

  // Parse the inner SES event
  const parsed = parseSesEvent(message.Message);
  if (!parsed || "ignored" in parsed) {
    env.ctx.logger.info("SNS message ignored", { reason: "ignored" in parsed ? parsed.ignored : "unparseable" });
    return { outcome: "ignored", companyId };
  }

  // Apply the event
  const event = parsed.event;
  try {
    return { outcome: await applyEspEvent(env, matched, event, { id: message.MessageId }), companyId };
  } catch (error) {
    env.ctx.logger.warn("SNS event not applied; SNS will deliver it again", { eventType: message.Type, error: errorMessage(error) });
    throw error;
  }
}
