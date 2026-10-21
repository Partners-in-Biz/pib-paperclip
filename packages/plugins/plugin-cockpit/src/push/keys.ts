/**
 * VAPID key lifecycle for the web push spike.
 * Keys are stored per-instance in plugin state.
 * Instance-scoped state is preferred to company-scoped for security:
 * the same public key is shared across all companies, simplifying browser-side management.
 */

import type { ScopeKey } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { generateVapidKeyPair } from "./vapid.js";

/** Canonical mailto subject for VAPID JWT signing. The Delivery Lead may change this. */
export const VAPID_SUBJECT = "mailto:cockpit@partnersinbiz.online";

/** A stored VAPID key record (never logged or leaked). */
export interface VapidKeyRecord {
  publicKey: string;
  privateKey: string;
  createdAt: string;
}

/** Store interface for key persistence. Tests can fake it. */
export interface PushKeyStore {
  read(): Promise<VapidKeyRecord | null>;
  write(record: VapidKeyRecord): Promise<void>;
}

/** Module-level promise chain for serialized execution. A rejected call must not poison later calls. */
let chain: Promise<unknown> = Promise.resolve();

/** Execute a function inside the serialization chain. Errors don't poison the chain. */
function serialise<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn);
  chain = run.catch(() => undefined);
  return run;
}

/** Get or create the VAPID key, with serialized first-call semantics. */
export async function getOrCreateVapidKey(
  store: PushKeyStore,
  opts: { hasSubscriptions(): boolean | Promise<boolean> }
): Promise<{ publicKey: string; privateKey: string }> {
  return serialise(async () => {
    const existing = await store.read();
    if (existing) return { publicKey: existing.publicKey, privateKey: existing.privateKey };

    const hasSubs = await Promise.resolve(opts.hasSubscriptions());
    if (hasSubs) {
      throw new PushKeyError("key_lost", "key lost, devices must re-subscribe");
    }

    const generated = generateVapidKeyPair();
    const record: VapidKeyRecord = {
      publicKey: generated.publicKey,
      privateKey: generated.privateKey,
      createdAt: new Date().toISOString(),
    };
    await store.write(record);

    // Read-after-write: verify what was stored and return it
    const stored = await store.read();
    if (!stored) {
      throw new Error("Failed to read stored VAPID key after write");
    }
    return { publicKey: stored.publicKey, privateKey: stored.privateKey };
  });
}

/** Get the public key only (never returns the private key). */
export async function getVapidPublicKey(store: PushKeyStore): Promise<string> {
  const record = await store.read();
  if (!record) {
    throw new PushKeyError("key_missing", "VAPID key not found");
  }
  return record.publicKey;
}

/** Return only the public key part of a stored record (private key redacted). */
export function publicOnly(record: VapidKeyRecord): { publicKey: string; createdAt: string } {
  return { publicKey: record.publicKey, createdAt: record.createdAt };
}

/** Error for VAPID key operations. */
export class PushKeyError extends Error {
  readonly code: "key_lost" | "key_missing";
  constructor(code: "key_lost" | "key_missing", message: string) {
    super(message);
    this.code = code;
    this.name = "PushKeyError";
  }
}

/** Storage keys for push spike features. Exported so PR B can reuse them. */
export const PUSH_SPIKE_NAMESPACE = "pib-push-spike";
export const VAPID_KEY_STATE_KEY = "vapid-key";
export const SUBSCRIPTIONS_STATE_KEY = "subs";

/** Create a PushKeyStore backed by plugin state. */
export function createPushKeyStore(state: PluginContext["state"]): PushKeyStore {
  const scopeKey: ScopeKey = {
    scopeKind: "instance",
    namespace: PUSH_SPIKE_NAMESPACE,
    stateKey: VAPID_KEY_STATE_KEY,
  };

  return {
    read: async () => {
      const raw = await state.get(scopeKey);
      // Type guard: ensure it has the expected shape
      if (
        raw &&
        typeof raw === "object" &&
        "publicKey" in raw &&
        "privateKey" in raw &&
        "createdAt" in raw &&
        typeof (raw as Record<string, unknown>).publicKey === "string" &&
        typeof (raw as Record<string, unknown>).privateKey === "string" &&
        typeof (raw as Record<string, unknown>).createdAt === "string"
      ) {
        return raw as VapidKeyRecord;
      }
      return null;
    },
    write: async (record: VapidKeyRecord) => {
      await state.set(scopeKey, record);
    },
  };
}

/** Check if any push spike subscriptions exist for the instance. */
export async function hasSpikeSubscriptions(state: PluginContext["state"]): Promise<boolean> {
  const scopeKey: ScopeKey = {
    scopeKind: "instance",
    namespace: PUSH_SPIKE_NAMESPACE,
    stateKey: SUBSCRIPTIONS_STATE_KEY,
  };

  const raw = await state.get(scopeKey);
  if (!raw || typeof raw !== "object") return false;

  // Check if any user has any subscription
  const allSubs = raw as Record<string, unknown>;
  for (const userSubs of Object.values(allSubs)) {
    if (Array.isArray(userSubs) && userSubs.length > 0) {
      return true;
    }
  }
  return false;
}
