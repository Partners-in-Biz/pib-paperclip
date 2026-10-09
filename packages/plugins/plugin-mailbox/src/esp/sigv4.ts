/**
 * AWS Signature Version 4, written against the published algorithm
 * (https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html) and nothing else: Node `crypto`, no
 * dependency, no AWS SDK. It stores nothing and logs nothing; the secret access key exists only as an argument.
 *
 * `signSesRequest` signs exactly four headers: `host`, `content-type`, `x-amz-date` and `x-amz-content-sha256`. The host's guarded
 * fetch sets `Host` itself (from the URL, so it equals what is signed) and adds `Content-Length`, which is NOT signed; it rewrites
 * nothing else. Signing more headers would make the signature depend on what a proxy or the host may add.
 */
import { createHash, createHmac } from "node:crypto";

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Uint8Array, data: string): Buffer => createHmac("sha256", key).update(data, "utf8").digest();

/** RFC 3986 percent-encoding as SigV4 wants it (everything but unreserved characters). */
const encode = (value: string): string => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** `20150830T123600Z`. */
export function amzDate(at: Date): string {
  return at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export interface SignInput {
  method: string;
  /** Absolute path, already in the form sent (SES paths hold only unreserved characters). */
  path: string;
  query?: Record<string, string>;
  /** Every header here is signed (names are lower-cased, values trimmed and inner whitespace collapsed). */
  headers: Record<string, string>;
  /** The payload as sent: a string is hashed as its UTF-8 bytes. */
  body: string | Uint8Array;
  region: string;
  service: string;
  at: Date;
  credentials: SigV4Credentials;
}

export interface Signed {
  authorization: string;
  signedHeaders: string;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

/** The general algorithm: signs every header given. */
export function signV4(input: SignInput): Signed {
  const date = amzDate(input.at);
  const day = date.slice(0, 8);
  const headers = Object.entries(input.headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = headers.map(([name]) => name).join(";");
  const query = Object.entries(input.query ?? {})
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const path = input.path.split("/").map((segment) => encode(decodeURIComponent(segment))).join("/") || "/";
  const canonicalRequest = [input.method.toUpperCase(), path, query, ...headers.map(([name, value]) => `${name}:${value}`), "", signedHeaders, sha256Hex(typeof input.body === "string" ? Buffer.from(input.body, "utf8") : input.body)].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, sha256Hex(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, day), input.region), input.service), "aws4_request");
  const signature = createHmac("sha256", key).update(stringToSign, "utf8").digest("hex");
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    signedHeaders,
    canonicalRequest,
    stringToSign,
    signature,
  };
}

export const SES_SERVICE = "ses";

/** The host of the SESv2 endpoint of a region. */
export const sesHost = (region: string): string => `email.${region}.amazonaws.com`;

/**
 * The headers to send with a SESv2 request: `content-type`, `x-amz-date`, `x-amz-content-sha256` and `authorization`. `host` is signed but
 * not returned: the fetch sets it from the URL, to the same value.
 */
export function signSesRequest(input: { method: string; path: string; query?: Record<string, string>; body: string; region: string; credentials: SigV4Credentials; at: Date }): Record<string, string> {
  const host = sesHost(input.region);
  const payloadHash = sha256Hex(Buffer.from(input.body, "utf8"));
  const headers = { host, "content-type": "application/json", "x-amz-date": amzDate(input.at), "x-amz-content-sha256": payloadHash };
  const signed = signV4({ method: input.method, path: input.path, ...(input.query ? { query: input.query } : {}), headers, body: input.body, region: input.region, service: SES_SERVICE, at: input.at, credentials: input.credentials });
  return { "content-type": headers["content-type"], "x-amz-date": headers["x-amz-date"], "x-amz-content-sha256": payloadHash, authorization: signed.authorization };
}
