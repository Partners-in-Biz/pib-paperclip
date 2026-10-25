/**
 * Push notification page actions: subscribe, devices, mute, unsubscribe, test.
 * All actions are scoped by company and user from the context actor.
 * Never returns p256dh, auth, or other key material in responses.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isAllowedPushEndpoint } from "./hosts.js";
import { listSubscriptionsForUser, deleteSubscription, setSubscriptionState, upsertSubscription, hasAnySubscription, createKeyIfAbsent, getKey, importSpikeKey, type PushSubscription } from "./store.js";
import { sendPush, type DeviceOutcome, type SendDeps } from "./send.js";
import { PushKeyError } from "./keys.js";
import { generateVapidKeyPair } from "./vapid.js";

interface CockpitError extends Error {
  code?: string;
}

function throwError(code: string, message: string): never {
  const err: CockpitError = new Error(message);
  err.code = code;
  throw err;
}

function decodeBase64Url(str: string): Buffer {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export interface SubscribeParams {
  endpoint?: string;
  p256dh?: string;
  auth?: string;
  label?: string;
}

export interface SubscribeResult {
  id: string;
  deviceLabel: string | null;
  state: "ok" | "muted" | "needs_resubscribe";
  createdAt: string;
}

export async function subscribe(
  ctx: PluginContext,
  companyId: string,
  userId: string,
  params: SubscribeParams,
): Promise<SubscribeResult> {
  const endpoint = params.endpoint?.trim() ?? "";
  const p256dh = params.p256dh?.trim() ?? "";
  const auth = params.auth?.trim() ?? "";
  const label = (params.label?.trim() ?? "").slice(0, 60) || null;

  if (!endpoint) throwError("missing_endpoint", "endpoint is required");
  if (!isAllowedPushEndpoint(endpoint)) throwError("endpoint_not_allowed", "Endpoint not allowed");

  const p256dhBuf = decodeBase64Url(p256dh);
  if (p256dhBuf.length !== 65 || p256dhBuf[0] !== 0x04) throwError("bad_subscription", "p256dh must be 65 bytes starting with 0x04");

  const authBuf = decodeBase64Url(auth);
  if (authBuf.length !== 16) throwError("bad_subscription", "auth must be exactly 16 bytes");

  const sub = await upsertSubscription(ctx, {
    companyId,
    userId,
    endpoint,
    p256dh,
    auth,
    deviceLabel: label,
  });

  return {
    id: sub.id,
    deviceLabel: sub.deviceLabel,
    state: sub.state,
    createdAt: sub.createdAt,
  };
}

export interface DeviceInfo {
  id: string;
  label: string | null;
  state: "ok" | "muted" | "needs_resubscribe";
  createdAt: string;
  lastOkAt: string | null;
  lastError: string | null;
}

export async function devices(ctx: PluginContext, companyId: string, userId: string): Promise<DeviceInfo[]> {
  const subs = await listSubscriptionsForUser(ctx, companyId, userId);
  return subs.map((sub) => ({
    id: sub.id,
    label: sub.deviceLabel,
    state: sub.state,
    createdAt: sub.createdAt,
    lastOkAt: sub.lastOkAt,
    lastError: sub.lastError,
  }));
}

export interface MuteParams {
  id: string;
  muted?: boolean;
}

export async function mute(ctx: PluginContext, companyId: string, userId: string, params: MuteParams): Promise<{ ok: boolean }> {
  const subscriptionId = params.id;
  const shouldMute = params.muted !== false;

  // Verify ownership: fetch the subscription by id and check company/user match
  const subs = await listSubscriptionsForUser(ctx, companyId, userId);
  const sub = subs.find((s) => s.id === subscriptionId);
  if (!sub) throwError("not_found", "Device not found");

  const newState = shouldMute ? "muted" : "ok";
  await setSubscriptionState(ctx, sub.endpoint, newState, null);

  return { ok: true };
}

export async function unsubscribe(ctx: PluginContext, companyId: string, userId: string, params: { id: string }): Promise<{ ok: boolean }> {
  const subscriptionId = params.id;

  // Verify ownership: fetch the subscription by id and check company/user match
  const subs = await listSubscriptionsForUser(ctx, companyId, userId);
  const sub = subs.find((s) => s.id === subscriptionId);
  if (!sub) throwError("not_found", "Device not found");

  const deleted = await deleteSubscription(ctx, companyId, userId, sub.endpoint);
  if (!deleted) throwError("not_found", "Device not found");

  return { ok: true };
}

/**
 * Get or create the VAPID public key for the push notification page.
 * Honors the key_lost guard: if the stored key is lost and subscriptions exist, throws PushKeyError.
 * Fetches from the database, with fallback import from spike state, to ensure consistency with the sender.
 */
export async function publicKey(ctx: PluginContext): Promise<{ publicKey: string }> {
  // Try to get existing key from database
  let key = await getKey(ctx);

  // If not found, try to import from spike state
  if (!key) {
    await importSpikeKey(ctx);
    key = await getKey(ctx);
  }

  // If still not found, check if subscriptions exist
  if (!key) {
    const hasSubs = await hasAnySubscription(ctx);
    if (hasSubs) {
      throw new PushKeyError("key_lost", "key lost, devices must re-subscribe");
    }

    // No subscriptions and no key: create a new key
    const generated = generateVapidKeyPair();
    const result = await createKeyIfAbsent(ctx, {
      publicKey: generated.publicKey,
      privateKey: generated.privateKey,
    });
    key = result;
  }

  return { publicKey: key.publicKey };
}

export interface TestParams {
  id?: string;
}

export interface DeviceTestResult {
  label: string | null;
  outcome: DeviceOutcome;
  status?: string;
  error?: string;
}

export interface TestActionResult {
  results: DeviceTestResult[];
  /** True when the company kill switch skipped the send. Devices may still be registered. */
  disabled: boolean;
  /** True when the hourly cap stopped the send before every active device was attempted. */
  capped: boolean;
  /** Subscriptions this call targeted, including ones the sender did not attempt. */
  deviceCount: number;
}

export async function test(
  ctx: PluginContext,
  companyId: string,
  userId: string,
  params: TestParams,
  opts?: { deps?: SendDeps },
): Promise<TestActionResult> {
  const allSubs = await listSubscriptionsForUser(ctx, companyId, userId);

  // Filter by id if provided. With no id, every subscription for this user is a target.
  let targetSubs = allSubs;
  if (params.id) {
    targetSubs = allSubs.filter((sub) => sub.id === params.id);
    if (!targetSubs.length) throwError("not_found", "Device not found");
  }

  const payload = {
    title: "Test Push",
    body: "This is a test notification from your Cockpit",
    url: "https://paperclip.partnersinbiz.online",
    tag: "cockpit_test",
    class: "test" as const,
  };

  const result = await sendPush(ctx, companyId, targetSubs, payload, {
    class: "test",
    deps: opts?.deps,
  });

  return {
    results: result.devices.map((device) => ({
      label: device.label,
      outcome: device.outcome,
      ...(device.status ? { status: String(device.status) } : {}),
      ...(device.error ? { error: device.error } : {}),
    })),
    disabled: result.disabled,
    capped: result.capped,
    deviceCount: targetSubs.length,
  };
}
