/**
 * AES-256-GCM sealing for tokens a plugin must store (OAuth access/refresh
 * tokens, app passwords). The key comes from an operator-supplied secret
 * (a secret-ref in plugin config) and is never derived from ids alone.
 *
 * Sealed format: `v<keyVersion>.<iv b64>.<tag b64>.<data b64>`. The key version
 * lets an operator rotate the secret: keep the old one under `previousKeys`
 * until every row has been re-sealed.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface TokenKeyring {
  /** Version written into new ciphertexts. */
  currentVersion: number;
  /** Key material by version. */
  keys: Map<number, Buffer>;
}

export class TokenKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenKeyError";
  }
}

export function deriveKey(purpose: string, companyId: string, secret: string): Buffer {
  if (!secret || secret.length < 16) {
    throw new TokenKeyError("The token encryption key must be at least 16 characters. Set it in the plugin settings.");
  }
  return createHash("sha256").update(`pib:${purpose}:${companyId}:${secret}`).digest();
}

export function buildKeyring(input: {
  purpose: string;
  companyId: string;
  secret: string;
  version?: number;
  previous?: Array<{ version: number; secret: string }>;
}): TokenKeyring {
  const currentVersion = input.version ?? 1;
  const keys = new Map<number, Buffer>();
  for (const prev of input.previous ?? []) keys.set(prev.version, deriveKey(input.purpose, input.companyId, prev.secret));
  keys.set(currentVersion, deriveKey(input.purpose, input.companyId, input.secret));
  return { currentVersion, keys };
}

export function seal(plain: string, keyring: TokenKeyring): string {
  const key = keyring.keys.get(keyring.currentVersion);
  if (!key) throw new TokenKeyError(`No key for version ${keyring.currentVersion}`);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [`v${keyring.currentVersion}`, iv.toString("base64"), tag.toString("base64"), data.toString("base64")].join(".");
}

export function open(sealed: string, keyring: TokenKeyring): string {
  const parts = sealed.split(".");
  if (parts.length !== 4 || !parts[0]!.startsWith("v")) throw new TokenKeyError("Stored token is in an unknown format; reconnect the account");
  const version = Number(parts[0]!.slice(1));
  const key = keyring.keys.get(version);
  if (!key) throw new TokenKeyError(`Stored token uses key version ${version}, which is not configured`);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1]!, "base64"));
  decipher.setAuthTag(Buffer.from(parts[2]!, "base64"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(parts[3]!, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new TokenKeyError("Stored token could not be decrypted; the encryption key changed. Reconnect the account");
  }
}

export function sealedVersion(sealed: string): number | null {
  const head = sealed.split(".")[0] ?? "";
  if (!head.startsWith("v")) return null;
  const version = Number(head.slice(1));
  return Number.isInteger(version) ? version : null;
}

export function sealJson(value: unknown, keyring: TokenKeyring): string {
  return seal(JSON.stringify(value), keyring);
}

export function openJson<T>(sealed: string, keyring: TokenKeyring): T {
  return JSON.parse(open(sealed, keyring)) as T;
}
