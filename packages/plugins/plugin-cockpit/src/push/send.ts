/**
 * Push sender: allowlist, encrypt (RFC 8291), VAPID-sign and deliver one notification to a
 * user's devices. The kill switch and the hourly cap are checked before any network call.
 * Never logs or returns keys, auth secrets or token values.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { MAX_PLAINTEXT_BYTES, encryptPayload } from "./encrypt.js";
import { isAllowedPushEndpoint } from "./hosts.js";
import { VAPID_SUBJECT } from "./keys.js";
import type { PolicyClass } from "./policy.js";
import {
  appendPushLog,
  createKeyIfAbsent,
  deleteSubscription,
  getKey,
  markSubscriptionOk,
  setSubscriptionState,
  takeRateSlot,
  type PushSubscription,
} from "./store.js";
import { PushTransportError, postPush } from "./transport.js";
import { buildVapidAuthorization, generateVapidKeyPair } from "./vapid.js";

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  class: PolicyClass;
}

export type DeviceOutcome = "sent" | "deleted" | "needs_resubscribe" | "error" | "skipped_muted" | "refused";

export interface DeviceResult {
  endpoint: string;
  label: string | null;
  outcome: DeviceOutcome;
  status?: number;
  error?: string;
}

export interface SendResult {
  disabled: boolean;
  capped: boolean;
  devices: DeviceResult[];
}

export interface SendDeps {
  postPush?: typeof postPush;
  now?: () => Date;
}

/** Global hourly budget. Non-critical sends may use at most `HOURLY_CAP - CRITICAL_RESERVE`. */
export const HOURLY_CAP = 60;
export const CRITICAL_RESERVE = 30;
const RATE_KEY_ALL = "all";
const RATE_KEY_NON_CRITICAL = "non_critical";
const HOUR_MS = 3_600_000;

const TTL_CRITICAL_SECONDS = 24 * 3600;
const TTL_DEFAULT_SECONDS = 4 * 3600;

const ttlFor = (cls: PolicyClass): number => (cls === "critical" ? TTL_CRITICAL_SECONDS : TTL_DEFAULT_SECONDS);
const urgencyFor = (cls: PolicyClass): string => (cls === "critical" ? "high" : "normal");

/** One slot from the budgets that apply to this class; false when any budget is spent. */
async function takeSlot(ctx: PluginContext, cls: PolicyClass, windowStart: Date): Promise<boolean> {
  if (cls !== "critical" && !(await takeRateSlot(ctx, RATE_KEY_NON_CRITICAL, windowStart, HOURLY_CAP - CRITICAL_RESERVE))) {
    return false;
  }
  return takeRateSlot(ctx, RATE_KEY_ALL, windowStart, HOURLY_CAP);
}

export async function sendPush(
  ctx: PluginContext,
  companyId: string,
  subs: PushSubscription[],
  payload: PushPayload,
  opts: { class: PolicyClass; deps?: SendDeps },
): Promise<SendResult> {
  const post = opts.deps?.postPush ?? postPush;
  const now = (opts.deps?.now ?? (() => new Date()))();
  const cls = opts.class;

  const config = (await ctx.config.get(companyId)) as Record<string, unknown> | undefined;
  if (config?.pushEnabled !== true) return { disabled: true, capped: false, devices: [] };

  const plaintext = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url,
    tag: payload.tag,
    class: payload.class,
  });
  if (Buffer.byteLength(plaintext, "utf-8") >= MAX_PLAINTEXT_BYTES) {
    throw new Error(`Payload must be under ${MAX_PLAINTEXT_BYTES} bytes`);
  }

  const devices: DeviceResult[] = [];
  const targets: PushSubscription[] = [];
  for (const sub of subs) {
    const base = { endpoint: sub.endpoint, label: sub.deviceLabel };
    if (sub.state === "muted") {
      devices.push({ ...base, outcome: "skipped_muted" });
    } else if (!isAllowedPushEndpoint(sub.endpoint)) {
      await setSubscriptionState(ctx, sub.endpoint, "needs_resubscribe", "endpoint_not_allowed");
      devices.push({ ...base, outcome: "refused", error: "endpoint_not_allowed" });
    } else {
      targets.push(sub);
    }
  }
  if (targets.length === 0) return { disabled: false, capped: false, devices };

  const windowStart = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  for (let i = 0; i < targets.length; i += 1) {
    if (!(await takeSlot(ctx, cls, windowStart))) {
      await appendPushLog(ctx, { companyId, class: cls, issueRef: payload.tag || null, title: payload.title, status: "capped" });
      return { disabled: false, capped: true, devices };
    }
  }

  let key = await getKey(ctx);
  if (!key) key = await createKeyIfAbsent(ctx, generateVapidKeyPair());
  const subject = typeof config?.vapidSubject === "string" && config.vapidSubject ? config.vapidSubject : VAPID_SUBJECT;
  const ttl = ttlFor(cls);

  let sent = 0;
  for (const sub of targets) {
    const base = { endpoint: sub.endpoint, label: sub.deviceLabel };
    try {
      const headers: Record<string, string> = {
        Authorization: buildVapidAuthorization({
          endpoint: sub.endpoint,
          subject,
          publicKey: key.publicKey,
          privateKey: key.privateKey,
          now,
        }),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(ttl),
        Urgency: urgencyFor(cls),
      };
      if (/^[A-Za-z0-9_-]{1,32}$/.test(payload.tag)) headers.Topic = payload.tag;

      const res = await post(sub.endpoint, headers, encryptPayload(plaintext, sub.p256dh, sub.auth));
      if (res.status >= 200 && res.status < 300) {
        await markSubscriptionOk(ctx, sub.endpoint);
        sent += 1;
        devices.push({ ...base, outcome: "sent", status: res.status });
      } else if (res.status === 404 || res.status === 410) {
        await deleteSubscription(ctx, companyId, sub.userId, sub.endpoint);
        devices.push({ ...base, outcome: "deleted", status: res.status });
      } else if (res.status === 401 || res.status === 403) {
        await setSubscriptionState(ctx, sub.endpoint, "needs_resubscribe", `http_${res.status}`);
        devices.push({ ...base, outcome: "needs_resubscribe", status: res.status });
      } else {
        await setSubscriptionState(ctx, sub.endpoint, sub.state, `http_${res.status}`);
        devices.push({ ...base, outcome: "error", status: res.status, error: `http_${res.status}` });
      }
    } catch (err) {
      const code = err instanceof PushTransportError ? err.code : "send_failed";
      await setSubscriptionState(ctx, sub.endpoint, sub.state, code);
      devices.push({ ...base, outcome: "error", error: code });
    }
  }

  if (sent > 0) {
    await appendPushLog(ctx, { companyId, class: cls, issueRef: payload.tag || null, title: payload.title, status: "sent" });
  }
  return { disabled: false, capped: false, devices };
}
