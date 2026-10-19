import type { ScopeKey } from "@paperclipai/plugin-sdk";
import type { PushTransportError } from "./transport.js";
import { encryptPayload } from "./encrypt.js";
import { signVapidJwt } from "./vapid.js";
import { isAllowedPushEndpoint } from "./hosts.js";
import {
  VAPID_SUBJECT,
  PUSH_SPIKE_NAMESPACE,
  SUBSCRIPTIONS_STATE_KEY,
  type PushKeyStore,
  getOrCreateVapidKey,
  type PushKeyError,
} from "./keys.js";

export interface StoredSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  createdAt: string;
  needsResubscribe?: boolean;
}

export interface AllSubscriptions {
  [userId: string]: StoredSubscription[];
}

export interface SpikeActionDeps {
  keyStore: PushKeyStore;
  stateReader: (key: ScopeKey) => Promise<unknown>;
  stateWriter: (key: ScopeKey, value: unknown) => Promise<void>;
  postPush: (endpoint: string, headers: Record<string, string>, body: Buffer) => Promise<{ status: number }>;
  now?: () => Date;
}

interface SubscribeParams {
  endpoint?: string;
  p256dh?: string;
  auth?: string;
  label?: string;
}

interface SendParams {
  url?: string;
}

interface CockpitError extends Error {
  code?: string;
}

let subsLockTail: Promise<void> = Promise.resolve();

const SUBS_STATE_KEY: ScopeKey = {
  scopeKind: "instance",
  namespace: PUSH_SPIKE_NAMESPACE,
  stateKey: SUBSCRIPTIONS_STATE_KEY,
};

async function withSubsLock<T>(op: () => Promise<T>): Promise<T> {
  let result: T;
  subsLockTail = subsLockTail.then(
    async () => {
      result = await op();
    },
    async () => {
      result = await op();
    }
  );
  await subsLockTail;
  return result!;
}

function decodeBase64Url(str: string): Buffer {
  try {
    const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
    return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  } catch {
    throw { code: "bad_subscription", message: "Invalid base64 encoding" } as CockpitError;
  }
}

function throwError(code: string, message: string): never {
  const err: CockpitError = new Error(message);
  err.code = code;
  throw err;
}

async function ensureKeyExists(deps: SpikeActionDeps, anySubsExist: boolean): Promise<{ publicKey: string; privateKey: string }> {
  try {
    return await getOrCreateVapidKey(deps.keyStore, { hasSubscriptions: () => anySubsExist });
  } catch (e) {
    if ((e as PushKeyError).code === "key_lost") {
      const err: CockpitError = new Error((e as Error).message);
      err.code = "key_lost";
      throw err;
    }
    throw e;
  }
}

export async function subscribe(
  deps: SpikeActionDeps,
  params: SubscribeParams,
  actor: { type: string; userId?: string }
): Promise<{ ok: boolean; publicKey?: string; subscriptions?: number; error?: string }> {
  if (actor.type !== "user" || !actor.userId) throwError("not_user", "Only users can subscribe to push notifications");

  const userId = actor.userId;
  const now = deps.now?.() ?? new Date();

  if (!params.endpoint) {
    const allSubs = (await deps.stateReader(SUBS_STATE_KEY)) as AllSubscriptions | null;
    const anySubsExist = allSubs && Object.values(allSubs).some((arr) => arr.length > 0);
    const key = await ensureKeyExists(deps, !!anySubsExist);
    return { ok: true, publicKey: key.publicKey };
  }

  const endpoint = params.endpoint.trim();
  const p256dh = params.p256dh?.trim() ?? "";
  const auth = params.auth?.trim() ?? "";
  const label = (params.label?.trim() ?? "").slice(0, 60);

  if (!isAllowedPushEndpoint(endpoint)) throwError("endpoint_not_allowed", "Endpoint not allowed");

  const p256dhBuf = decodeBase64Url(p256dh);
  if (p256dhBuf.length !== 65 || p256dhBuf[0] !== 0x04) throwError("bad_subscription", "p256dh must be 65 bytes starting with 0x04");

  const authBuf = decodeBase64Url(auth);
  if (authBuf.length !== 16) throwError("bad_subscription", "auth must be exactly 16 bytes");

  let allSubs = (await deps.stateReader(SUBS_STATE_KEY)) as AllSubscriptions | null;
  const anySubsExist = allSubs && Object.values(allSubs).some((arr) => arr.length > 0);
  await ensureKeyExists(deps, !!anySubsExist);

  let subsCount = 0;
  await withSubsLock(async () => {
    allSubs = (await deps.stateReader(SUBS_STATE_KEY)) as AllSubscriptions | null;
    allSubs = allSubs ?? {};

    const userSubs = allSubs[userId] ?? [];
    const newSubs = userSubs.filter((s) => s.endpoint !== endpoint);

    if (newSubs.length >= 10 && !userSubs.some((s) => s.endpoint === endpoint)) {
      newSubs.splice(0, newSubs.length - 9);
    }

    const subscription: StoredSubscription = {
      endpoint,
      p256dh,
      auth,
      label,
      createdAt: now.toISOString(),
    };
    newSubs.push(subscription);
    allSubs[userId] = newSubs;
    subsCount = newSubs.length;

    await deps.stateWriter(SUBS_STATE_KEY, allSubs);
  });

  return { ok: true, subscriptions: subsCount };
}

export async function send(
  deps: SpikeActionDeps,
  params: SendParams,
  actor: { type: string; userId?: string }
): Promise<{ devices: Array<{ label: string; ok: boolean; status?: number; error?: string }> }> {
  if (actor.type !== "user" || !actor.userId) throwError("not_user", "Only users can send push notifications");

  const userId = actor.userId;
  let url = params.url?.trim() ?? "/";
  if (url.startsWith("//") || url.startsWith("http://") || url.startsWith("https://")) url = "/";
  if (!url.startsWith("/")) url = "/" + url;

  let allSubs = (await deps.stateReader(SUBS_STATE_KEY)) as AllSubscriptions | null;
  const subs = allSubs?.[userId] ?? [];

  if (subs.length === 0) throwError("no_subscription", "No subscriptions found");

  const anySubsExist = allSubs && Object.values(allSubs).some((arr) => arr.length > 0);
  const key = await ensureKeyExists(deps, !!anySubsExist);

  const now = deps.now?.() ?? new Date();
  const devices: Array<{ label: string; ok: boolean; status?: number; error?: string }> = [];
  const updates: Array<{ endpoint: string; needsResubscribe?: boolean; delete?: boolean }> = [];

  for (const sub of subs) {
    try {
      const payload = JSON.stringify({ title: "Push test", url });
      const body = encryptPayload(payload, sub.p256dh, sub.auth);
      const jwt = signVapidJwt({
        endpoint: sub.endpoint,
        subject: VAPID_SUBJECT,
        publicKey: key.publicKey,
        privateKey: key.privateKey,
        now,
        ttlSeconds: 60,
      });

      const headers = {
        Authorization: `vapid t=${jwt}, k=${key.publicKey}`,
        TTL: "60",
        Urgency: "normal",
      };

      const response = await deps.postPush(sub.endpoint, headers, body);

      if (response.status >= 200 && response.status < 300) {
        devices.push({ label: sub.label, ok: true, status: response.status });
      } else if (response.status === 401 || response.status === 403) {
        updates.push({ endpoint: sub.endpoint, needsResubscribe: true });
        devices.push({ label: sub.label, ok: false, status: response.status, error: "key_mismatch" });
      } else if (response.status === 404 || response.status === 410) {
        updates.push({ endpoint: sub.endpoint, delete: true });
        devices.push({ label: sub.label, ok: false, status: response.status, error: response.status === 410 ? "gone" : "not_found" });
      } else {
        devices.push({ label: sub.label, ok: false, status: response.status, error: `http_${response.status}` });
      }
    } catch (e) {
      const transportErr = e as PushTransportError;
      devices.push({ label: sub.label, ok: false, error: transportErr.code ?? "unknown" });
    }
  }

  if (updates.length > 0) {
    await withSubsLock(async () => {
      allSubs = (await deps.stateReader(SUBS_STATE_KEY)) as AllSubscriptions | null;
      allSubs = allSubs ?? {};

      const userSubs = allSubs[userId] ?? [];
      for (const update of updates) {
        const idx = userSubs.findIndex((s) => s.endpoint === update.endpoint);
        if (idx >= 0) {
          if (update.delete) userSubs.splice(idx, 1);
          else if (update.needsResubscribe) userSubs[idx].needsResubscribe = true;
        }
      }
      allSubs[userId] = userSubs;
      await deps.stateWriter(SUBS_STATE_KEY, allSubs);
    });
  }

  return { devices };
}
