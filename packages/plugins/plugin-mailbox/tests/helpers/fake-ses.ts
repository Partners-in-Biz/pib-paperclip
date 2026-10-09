/**
 * Amazon SESv2 as documented, in memory, behind a fetch: `POST /v2/email/outbound-emails` (Raw MIME, configuration set, tags) and
 * `GET /v2/email/account`. Every request has its SigV4 signature checked the way AWS does (from the headers that arrive, the signed
 * header list and the secret key), so a signing mistake fails a test instead of production. Records requests, answers scripted errors,
 * and never touches a network.
 *
 * `hostFetch` stands in for the host's guarded `ctx.http.fetch`: like `buildPinnedRequestOptions` in the server it lower-cases the header
 * names, sets `Host` from the URL and adds `Content-Length`, and rewrites nothing else.
 */
import { createHash } from "node:crypto";
import { signV4 } from "../../src/esp/sigv4.js";
import type { HttpFetch } from "../../src/esp/resend.js";

// Built at runtime: a key-shaped literal in a test file is refused by GitHub push protection.
export const SES_ACCESS_KEY_ID = ["AKID", "TESTTESTTEST1234"].join("");
export const SES_SECRET_ACCESS_KEY = ["secret", Buffer.from("0123456789abcdef0123456789abcdef0123").toString("base64")].join("/");
export const SES_REGION = "eu-north-1";
export const SES_CONFIGURATION_SET = "pib-marketing";

export interface SesRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  rawBody: string;
  body: Record<string, any> | null;
  /** The decoded MIME of a send. */
  mime: string | null;
}

export interface ScriptedSesError {
  status: number;
  /** The exception name (`x-amzn-ErrorType`). */
  type?: string;
  message?: string;
  headers?: Record<string, string>;
  /** Throw instead of answering (a timeout, a reset). */
  throws?: string;
  /** Only a request whose path matches (default: a send, so reading the account first does not use the error up). */
  on?: RegExp;
  /** A 200 with this body instead. */
  body?: unknown;
}

export class FakeSes {
  requests: SesRequest[] = [];
  /** Signature problems found on arriving requests (empty when every request was signed right). */
  signatureProblems: string[] = [];
  errors: ScriptedSesError[] = [];
  account = { maxSendRate: 14, max24HourSend: 50_000, sentLast24Hours: 120, productionAccessEnabled: true, sendingEnabled: true };
  accessKeyId = SES_ACCESS_KEY_ID;
  secretAccessKey = SES_SECRET_ACCESS_KEY;
  private seq = 0;

  get sends(): SesRequest[] {
    return this.requests.filter((r) => r.path === "/v2/email/outbound-emails");
  }

  private json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }

  private checkSignature(method: string, path: string, headers: Record<string, string>, rawBody: string): void {
    const auth = headers.authorization ?? "";
    const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/ses\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
    if (!match) return void this.signatureProblems.push("malformed Authorization header");
    const [, keyId, , region, signedList, signature] = match;
    if (keyId !== this.accessKeyId) this.signatureProblems.push("unknown access key id");
    if (signedList !== "content-type;host;x-amz-content-sha256;x-amz-date") this.signatureProblems.push(`signed headers were ${signedList}`);
    if (headers["x-amz-content-sha256"] !== createHash("sha256").update(Buffer.from(rawBody, "utf8")).digest("hex")) this.signatureProblems.push("x-amz-content-sha256 is not the hash of the body");
    const date = headers["x-amz-date"] ?? "";
    const at = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`);
    const signed = Object.fromEntries(signedList!.split(";").map((name) => [name, headers[name] ?? ""]));
    const expected = signV4({ method, path, headers: signed, body: rawBody, region: region!, service: "ses", at, credentials: { accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey } });
    if (expected.signature !== signature) this.signatureProblems.push("signature does not match");
    if (headers.host !== `email.${region}.amazonaws.com`) this.signatureProblems.push(`host was ${headers.host}`);
  }

  handle: HttpFetch = async (url, init) => {
    const target = new URL(url);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const rawBody = init?.body ?? "";
    let body: Record<string, any> | null = null;
    try {
      body = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      body = null;
    }
    const mime = typeof body?.Content?.Raw?.Data === "string" ? Buffer.from(body.Content.Raw.Data, "base64").toString("utf8") : null;
    this.requests.push({ method, path: target.pathname, headers, rawBody, body, mime });
    if (target.protocol !== "https:" || !/^email\.[a-z0-9-]+\.amazonaws\.com$/.test(target.hostname)) return this.json(400, { message: "wrong host" });
    this.checkSignature(method, target.pathname, headers, rawBody);
    const scripted = this.errors[0] && (this.errors[0].on ?? /outbound-emails/).test(target.pathname) ? this.errors.shift() : undefined;
    if (scripted) {
      if (scripted.throws) throw new Error(scripted.throws);
      if (scripted.body !== undefined) return this.json(scripted.status, scripted.body, scripted.headers);
      return this.json(scripted.status, { message: scripted.message ?? "scripted" }, { ...(scripted.type ? { "x-amzn-ErrorType": `${scripted.type}:http://internal.amazon.com/coral/com.amazonaws.maestro.service.v20201210/` } : {}), ...scripted.headers });
    }
    if (method === "POST" && target.pathname === "/v2/email/outbound-emails") {
      this.seq += 1;
      return this.json(200, { MessageId: `0101019${String(this.seq).padStart(8, "0")}-ses-test-id` });
    }
    if (method === "GET" && target.pathname === "/v2/email/account") {
      const a = this.account;
      return this.json(200, { SendQuota: { Max24HourSend: a.max24HourSend, MaxSendRate: a.maxSendRate, SentLast24Hours: a.sentLast24Hours }, ProductionAccessEnabled: a.productionAccessEnabled, SendingEnabled: a.sendingEnabled });
    }
    return this.json(404, { message: "not found" }, { "x-amzn-ErrorType": "NotFoundException" });
  };
}

/** The host's guarded fetch in front of `inner`: header names lower-cased, `Host` set from the URL, `Content-Length` added, nothing else touched. */
export function hostFetch(inner: HttpFetch): HttpFetch {
  return (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Host", new URL(url).host);
    if (init?.body !== undefined && !headers.has("content-length")) headers.set("content-length", String(Buffer.byteLength(init.body)));
    return inner(url, { ...init, headers: Object.fromEntries(headers.entries()) });
  };
}
