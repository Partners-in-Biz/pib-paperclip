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

export async function r2Delete(cfg: R2Config, key: string, f: typeof fetch = fetch, now?: Date): Promise<void> {
  const url = `https://${cfg.bucket}.${cfg.accountId}.r2.cloudflarestorage.com/${key}`;

  const headers = signR2Headers({
    method: "DELETE",
    host: `${cfg.bucket}.${cfg.accountId}.r2.cloudflarestorage.com`,
    path: `/${key}`,
    headers: {},
    payloadSha256: sha256Hex(""),
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    now,
  });

  const response = await f(url, {
    method: "DELETE",
    headers,
  });

  if ([204, 200, 404].includes(response.status)) {
    return;
  }

  throw new Error(`R2 DELETE failed: HTTP ${response.status}`);
}

function decodeXmlEntity(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

export async function r2List(cfg: R2Config, prefix: string, f: typeof fetch = fetch, now?: Date): Promise<string[]> {
  if (!prefix || !prefix.endsWith("/") || prefix === "/") {
    throw new Error("r2List prefix must be a non-empty path ending with /");
  }

  const keys: string[] = [];
  let continuationToken: string | null = null;

  for (let pageCount = 0; pageCount < 20; pageCount++) {
    const query: Record<string, string> = {
      "list-type": "2",
      prefix,
    };
    if (continuationToken) {
      query["continuation-token"] = continuationToken;
    }

    const url = new URL(`https://${cfg.bucket}.${cfg.accountId}.r2.cloudflarestorage.com/`);
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }

    const headers = signR2Headers({
      method: "GET",
      host: `${cfg.bucket}.${cfg.accountId}.r2.cloudflarestorage.com`,
      path: "/",
      query,
      headers: {},
      payloadSha256: sha256Hex(""),
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      now,
    });

    const response = await f(url.toString(), {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      throw new Error(`R2 LIST failed: HTTP ${response.status}`);
    }

    const body = await response.text();

    // Parse <Key>...</Key> tags
    const keyMatches = body.match(/<Key>([^<]*)<\/Key>/g);
    if (keyMatches) {
      for (const match of keyMatches) {
        const key = match.replace(/<Key>|<\/Key>/g, "");
        keys.push(decodeXmlEntity(key));
      }
    }

    // Check if truncated
    const isTruncated = /<IsTruncated>true<\/IsTruncated>/.test(body);
    if (!isTruncated) {
      break;
    }

    // Check page limit
    if (pageCount === 19) {
      throw new Error("R2 LIST exceeded 20 pages");
    }

    // Extract next continuation token
    const tokenMatch = body.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/);
    if (tokenMatch && tokenMatch[1]) {
      continuationToken = decodeXmlEntity(tokenMatch[1]);
    } else {
      break;
    }
  }

  return keys;
}
