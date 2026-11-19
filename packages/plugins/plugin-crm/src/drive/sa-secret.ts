/**
 * The Drive service account key, resolved once per company and kept in memory (PAR-9358).
 *
 * The host lets a plugin resolve 30 secrets a minute per company, shared by every CRM call from every agent. Each
 * Drive tool used to resolve the key on every call, so a few Drive calls in a minute ran out of that budget. The
 * key is now kept for five minutes. The cache key is the secret ref (id and version), never the value, so a new
 * ref in the settings is read at once. A bad-credential answer from Google drops the entry and re-reads the
 * secret once (see `driveKeyAfterAuthFailure`), so a rotated key is picked up without waiting for the TTL.
 *
 * The value lives only in this map: it is never logged, persisted or returned to a caller outside the CRM.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isSecretRef, SecretResolver } from "@partnersinbiz/pib-plugin-kit";

export const DRIVE_KEY_PATH = "driveServiceAccountJson";
export const DRIVE_KEY_TTL_MS = 5 * 60_000;

/** `rechecked`: this value was read again after Google refused the previous one, so a further refusal does not re-read it. */
type Entry = { at: number; refKey: string; value: Promise<string | undefined>; rechecked: boolean };
const cache = new Map<string, Entry>();

/** Tests and settings changes. */
export function clearDriveKeyCache(): void {
  cache.clear();
}

/** The ref's identity: which secret and which version. A raw string in the settings is not a secret and is not cached. */
function refKeyOf(raw: unknown): string | null {
  if (!isSecretRef(raw)) return null;
  return `${raw.secretId}@${raw.version ?? "latest"}`;
}

function resolveFresh(ctx: PluginContext, companyId: string, cfg: Record<string, unknown>, refKey: string, rechecked = false): Promise<string | undefined> {
  const value = new SecretResolver(ctx, companyId, cfg).get(DRIVE_KEY_PATH);
  const entry: Entry = { at: Date.now(), refKey, value, rechecked };
  cache.set(companyId, entry);
  // A failed or empty lookup is never kept: the next call asks again.
  value.then(
    (v) => {
      if (!v && cache.get(companyId) === entry) cache.delete(companyId);
    },
    () => {
      if (cache.get(companyId) === entry) cache.delete(companyId);
    },
  );
  return value;
}

/** The company's Drive service account key JSON, or undefined when none is set. Concurrent calls share one lookup. */
export async function driveServiceAccountKey(ctx: PluginContext, companyId: string, cfg: Record<string, unknown>): Promise<string | undefined> {
  const raw = cfg[DRIVE_KEY_PATH];
  const refKey = refKeyOf(raw);
  if (!refKey) return new SecretResolver(ctx, companyId, cfg).get(DRIVE_KEY_PATH);
  const hit = cache.get(companyId);
  if (hit && hit.refKey === refKey && Date.now() - hit.at < DRIVE_KEY_TTL_MS) return hit.value;
  return resolveFresh(ctx, companyId, cfg, refKey);
}

/**
 * Google refused the key: drop the cached one and read the secret once more. Returns the new key when it differs
 * from the one that failed (the caller retries once with it), else null (no retry; the re-read value stays cached so
 * a bad key costs one lookup per TTL, not one per call).
 */
export async function driveKeyAfterAuthFailure(
  ctx: PluginContext,
  companyId: string,
  cfg: Record<string, unknown>,
  failed: string,
): Promise<string | null> {
  const refKey = refKeyOf(cfg[DRIVE_KEY_PATH]);
  if (!refKey) return null;
  const hit = cache.get(companyId);
  if (hit && hit.refKey === refKey && Date.now() - hit.at < DRIVE_KEY_TTL_MS) {
    const current = await hit.value.catch(() => undefined);
    // Another call already read a newer key: use it instead of a second lookup.
    if (current && current !== failed) return current;
    // This key was already read again after a refusal and is still the one Google refuses: no new lookup until the TTL ends.
    if (hit.rechecked) return null;
  }
  const fresh = await resolveFresh(ctx, companyId, cfg, refKey, true);
  return fresh && fresh !== failed ? fresh : null;
}
