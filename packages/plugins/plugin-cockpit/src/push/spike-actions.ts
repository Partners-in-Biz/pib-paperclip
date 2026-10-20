import type { ScopeKey } from "@paperclipai/plugin-sdk";
import { isAllowedPushEndpoint } from "./hosts.js";
import {
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
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function throwError(code: string, message: string): never {
  const err: CockpitError = new Error(message);
  err.code = code;
  throw err;
}

async function ensureKeyExists(deps: SpikeActionDeps, anySubsExist: boolean): Promise<{ publicKey: string; privateKey: string }> {
  return getOrCreateVapidKey(deps.keyStore, { hasSubscriptions: () => anySubsExist });
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
