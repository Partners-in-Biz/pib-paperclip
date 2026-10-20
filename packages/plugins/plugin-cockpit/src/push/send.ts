/**
 * Push notification sender: encrypts, signs, and delivers push notifications to subscribed devices.
 * Handles rate limiting, VAPID signing, encryption per RFC 8291, and delivery result logging.
 * Never logs endpoints, keys, or auth values.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { MAX_PLAINTEXT_BYTES, encryptPayload } from "./encrypt.js";
import { signVapidJwt } from "./vapid.js";
import { isAllowedPushEndpoint } from "./hosts.js";
import { VAPID_SUBJECT, getOrCreateVapidKey, createPushKeyStore, PushKeyError } from "./keys.js";
import { getKey, createKeyIfAbsent, listSubscriptionsForUser, setSubscriptionState, deleteSubscription, markSubscriptionOk, appendPushLog, takeRateSlot } from "./store.js";
import { postPush, type PushTransportError } from "./transport.js";
import type { PolicyClass } from "./policy.js";

/**
 * The payload sent to devices.
 */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  class: PolicyClass;
}

/**
 * Outcome of sending a push to a single device.
 */
export type DeviceOutcome = "sent" | "deleted" | "needs_resubscribe" | "error" | "skipped_muted" | "refused";

/**
 * Result for a single device.
 */
export interface DeviceResult {
  endpoint: string;
  label: string | null;
  outcome: DeviceOutcome;
  status?: number;
  error?: string;
}

/**
 * Result of sendPush operation.
 */
export interface SendResult {
  disabled: boolean;
  capped: boolean;
  devices: DeviceResult[];
}

/**
 * Dependencies for sendPush (testable).
 */
export interface SendDeps {
  postPush?: typeof postPush;
  now?: () => Date;
}

/**
 * TTL in seconds per policy class.
 */
function getTtlSeconds(classValue: PolicyClass): number {
  switch (classValue) {
    case "critical":
      return 86400; // 24 hours
    case "needs_you":
      return 14400; // 4 hours
    default:
      return 14400; // 4 hours
  }
}

/**
 * Urgency header per policy class.
 */
function getUrgency(classValue: PolicyClass): string {
  return classValue === "critical" ? "high" : "normal";
}

/**
 * Get the rate limit key for this class (non-critical uses "normal", critical uses "all").
 */
function getRateLimitKey(classValue: PolicyClass): string {
  return classValue === "critical" ? "all" : "normal";
}

/**
 * Check if a class is "critical" for rate limiting (critical can exceed normal cap).
 */
function isCritical(classValue: PolicyClass): boolean {
  return classValue === "critical";
}

/**
 * Send push notifications to subscribed devices.
 *
 * Behavior:
 * 1. Check pushEnabled setting; if false, return disabled without network
 * 2. Validate payload JSON < 2048 bytes
 * 3. Skip muted devices (no rate slot)
 * 4. Reject endpoints not in allow-list (no rate slot)
 * 5. Rate limit check before any network call
 * 6. Load VAPID key
 * 7. Per-device encryption and POST
 * 8. Handle responses and update subscription state
 * 9. Log capped status or sent status
 *
 * @param ctx Plugin context with config and db
 * @param companyId Company identifier
 * @param subs List of subscriptions to send to
 * @param payload The notification payload
 * @param opts Options including policy class and optional dependencies
 * @returns Send result with outcomes per device
 */
export async function sendPush(
  ctx: PluginContext,
  companyId: string,
  subs: Array<{
    id: string;
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    deviceLabel: string | null;
    state: "ok" | "muted" | "needs_resubscribe";
  }>,
  payload: PushPayload,
  opts: { class: PolicyClass; deps?: SendDeps }
): Promise<SendResult> {
  const postPushFn = opts.deps?.postPush ?? postPush;
  const now = opts.deps?.now ?? (() => new Date());
  const classValue = opts.class;

  // Step 1: Check pushEnabled setting
  const config = (await ctx.config.get(companyId)) as Record<string, unknown> | undefined;
  const pushEnabled = config?.pushEnabled === true;
  if (!pushEnabled) {
    return { disabled: true, capped: false, devices: [] };
  }

  // Step 2: Validate payload size
  const payloadJson = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url,
    tag: payload.tag,
  });
  if (Buffer.byteLength(payloadJson, "utf-8") > MAX_PLAINTEXT_BYTES) {
    throw new Error(`Payload exceeds ${MAX_PLAINTEXT_BYTES} bytes`);
  }

  // Step 3 & 4: Filter devices (muted and invalid endpoints)
  const devicesToSend = subs.filter((sub) => {
    if (sub.state === "muted") return false;
    if (!isAllowedPushEndpoint(sub.endpoint)) return false;
    return true;
  });

  const skippedMuted = subs.filter((sub) => sub.state === "muted");
  const refused = subs.filter((sub) => !isAllowedPushEndpoint(sub.endpoint) && sub.state !== "muted");

  // Step 5: Rate limit check before any network call (one slot per remaining device)
  const currentNow = now();
  const hourStart = new Date(Math.floor(currentNow.getTime() / 3600000) * 3600000);

  // Check if we can take all slots
  let slotsAvailable = true;
  if (!isCritical(classValue)) {
    // Non-critical: try to take from "normal" first (30 slots)
    for (let i = 0; i < devicesToSend.length; i++) {
      const slotTaken = await takeRateSlot(ctx, "normal", hourStart, 30);
      if (!slotTaken) {
        // Ran out of normal slots; cap this attempt
        slotsAvailable = false;
        break;
      }
    }
  } else {
    // Critical: try to take from "all" (60 slots)
    for (let i = 0; i < devicesToSend.length; i++) {
      const slotTaken = await takeRateSlot(ctx, "all", hourStart, 60);
      if (!slotTaken) {
        slotsAvailable = false;
        break;
      }
    }
  }

  if (!slotsAvailable) {
    // Cap hit: log and return
    await appendPushLog(ctx, {
      companyId,
      class: classValue,
      issueRef: payload.tag || null,
      title: payload.title,
      status: "capped",
    });
    return { disabled: false, capped: true, devices: [] };
  }

  // Step 6: Load VAPID key
  let vapidKey = await getKey(ctx);
  if (!vapidKey) {
    vapidKey = await createKeyIfAbsent(ctx, {
      publicKey: "temp", // Will be replaced
      privateKey: "temp",
    });
  }

  const vapidSubject = (config?.vapidSubject as string | undefined) ?? VAPID_SUBJECT;

  // Step 7 & 8: Per-device encryption and POST
  const results: DeviceResult[] = [];
  let sentCount = 0;

  for (const sub of devicesToSend) {
    try {
      // Encrypt payload
      const encryptedBody = encryptPayload(payloadJson, sub.p256dh, sub.auth);

      // Build VAPID authorization
      const ttl = getTtlSeconds(classValue);
      const jwt = signVapidJwt({
        endpoint: sub.endpoint,
        subject: vapidSubject,
        publicKey: vapidKey.publicKey,
        privateKey: vapidKey.privateKey,
        now: currentNow,
        ttlSeconds: ttl,
      });

      const headers: Record<string, string> = {
        Authorization: `vapid t=${jwt}, k=${vapidKey.publicKey}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(ttl),
        Urgency: getUrgency(classValue),
      };

      // Topic header: only if tag is safe (base64url-safe, <= 32 chars)
      if (payload.tag && /^[A-Za-z0-9_-]{1,32}$/.test(payload.tag)) {
        headers.Topic = payload.tag;
      }

      // Send POST
      const response = await postPushFn(sub.endpoint, headers, encryptedBody);

      // Handle response
      if (response.status >= 200 && response.status < 300) {
        // 2xx: success
        await markSubscriptionOk(ctx, sub.endpoint);
        results.push({ endpoint: sub.endpoint, label: sub.deviceLabel, outcome: "sent", status: response.status });
        sentCount += 1;
      } else if (response.status === 404 || response.status === 410) {
        // 404 or 410: delete subscription
        await deleteSubscription(ctx, companyId, sub.userId, sub.endpoint);
        const reason = response.status === 410 ? "gone" : "not_found";
        results.push({ endpoint: sub.endpoint, label: sub.deviceLabel, outcome: "deleted", status: response.status, error: reason });
      } else if (response.status === 401 || response.status === 403) {
        // 401 or 403: needs resubscribe
        await setSubscriptionState(ctx, sub.endpoint, "needs_resubscribe", "key_mismatch");
        results.push({ endpoint: sub.endpoint, label: sub.deviceLabel, outcome: "needs_resubscribe", status: response.status });
      } else {
        // Any other status: error
        const errorMsg = `http_${response.status}`;
        await setSubscriptionState(ctx, sub.endpoint, sub.state, errorMsg);
        results.push({ endpoint: sub.endpoint, label: sub.deviceLabel, outcome: "error", status: response.status, error: errorMsg });
      }
    } catch (error) {
      // Transport or encryption error
      const transportErr = error as PushTransportError & { code?: string; message?: string };
      const errorCode = transportErr.code ?? "unknown";
      results.push({ endpoint: sub.endpoint, label: sub.deviceLabel, outcome: "error", error: errorCode });
    }
  }

  // Add skipped muted devices to results
  for (const sub of skippedMuted) {
    results.push({ endpoint: sub.endpoint, label: sub.deviceLabel, outcome: "skipped_muted" });
  }

  // Add refused endpoints to results
  for (const sub of refused) {
    await setSubscriptionState(ctx, sub.endpoint, "needs_resubscribe", "endpoint_not_allowed");
    results.push({ endpoint: sub.endpoint, label: sub.deviceLabel, outcome: "refused" });
  }

  // Step 9: Log if any sent
  if (sentCount > 0) {
    await appendPushLog(ctx, {
      companyId,
      class: classValue,
      issueRef: payload.tag || null,
      title: payload.title,
      status: "sent",
    });
  }

  return { disabled: false, capped: false, devices: results };
}
