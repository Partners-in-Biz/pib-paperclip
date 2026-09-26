/**
 * The company's Google service account (settings `google.serviceAccountJson`,
 * a secret-ref), parsed once per company info.
 */
import { parseServiceAccountKey, serviceAccountToken, type ServiceAccountKey } from "../integrations/google-sa.js";
import { errorMessage, type CompanyInfo, type Env } from "./common.js";

export interface ServiceAccountState {
  key: ServiceAccountKey | null;
  /** Set when a key is configured but unusable. */
  error: string | null;
}

const parsed = new WeakMap<CompanyInfo, Promise<ServiceAccountState>>();

export function loadServiceAccount(info: CompanyInfo): Promise<ServiceAccountState> {
  const hit = parsed.get(info);
  if (hit) return hit;
  const run = (async (): Promise<ServiceAccountState> => {
    let raw: string | undefined;
    try {
      raw = await info.loaded.secrets.get("google.serviceAccountJson");
    } catch (error) {
      return { key: null, error: `The Google service account secret could not be read (${errorMessage(error)}).` };
    }
    if (!raw) return { key: null, error: null };
    try {
      return { key: parseServiceAccountKey(raw), error: null };
    } catch (error) {
      return { key: null, error: errorMessage(error) };
    }
  })();
  parsed.set(info, run);
  return run;
}

/** Service account access token, or null when no key is configured. Throws when the key is broken. */
export async function serviceAccountAccess(env: Env, info: CompanyInfo): Promise<{ token: string; email: string } | null> {
  const sa = await loadServiceAccount(info);
  if (sa.error) throw new Error(sa.error);
  if (!sa.key) return null;
  const token = await serviceAccountToken(env.fetch, sa.key, undefined, env.now().getTime());
  return { token, email: sa.key.clientEmail };
}
