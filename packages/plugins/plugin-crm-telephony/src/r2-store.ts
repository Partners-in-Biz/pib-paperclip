import { signR2Headers, sha256Hex } from "./sigv4.js";

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
}

export function recordingKey(cfg: { prefix: string }, callSid: string, recordingSid: string): string {
  const prefix = cfg.prefix || "crm-telephony";
  return `${prefix}/recordings/${callSid}/${recordingSid}.wav`;
}

export async function r2Put(
  cfg: R2Config,
  key: string,
  body: Uint8Array,
  sha256: string,
  f: typeof fetch = fetch,
  now?: Date
): Promise<void> {
  const url = `https://${cfg.bucket}.${cfg.accountId}.r2.cloudflarestorage.com/${key}`;

  const headers = signR2Headers({
    method: "PUT",
    host: `${cfg.bucket}.${cfg.accountId}.r2.cloudflarestorage.com`,
    path: `/${key}`,
    headers: {
      "content-type": "audio/wav",
      "x-amz-meta-sha256": sha256,
    },
    payloadSha256: sha256,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    now,
  });

  const response = await f(url, {
    method: "PUT",
    headers,
    body: Buffer.from(body),
  });

  if (!response.ok) {
    throw new Error(`R2 PUT failed: HTTP ${response.status}`);
  }
}

export async function r2Head(
  cfg: R2Config,
  key: string,
  f: typeof fetch = fetch,
  now?: Date
): Promise<{ bytes: number; sha256: string | null } | null> {
  const url = `https://${cfg.bucket}.${cfg.accountId}.r2.cloudflarestorage.com/${key}`;

  const headers = signR2Headers({
    method: "HEAD",
    host: `${cfg.bucket}.${cfg.accountId}.r2.cloudflarestorage.com`,
    path: `/${key}`,
    headers: {},
    payloadSha256: sha256Hex(""),
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    now,
  });

  const response = await f(url, {
    method: "HEAD",
    headers,
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`R2 HEAD failed: HTTP ${response.status}`);
  }

  const contentLength = response.headers.get("content-length");
  const bytes = contentLength ? parseInt(contentLength, 10) : 0;

  const metaSha256 = response.headers.get("x-amz-meta-sha256");
  const sha256 = metaSha256 ? metaSha256.toLowerCase() : null;

  return { bytes, sha256 };
}
