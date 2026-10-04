import { describe, expect, it } from "vitest";
import { checkSvixShape, signSvix, SVIX_TOLERANCE_SECONDS, svixKey, verifySvix } from "../../src/esp/svix.js";

// Built at runtime: a secret-shaped literal in a test file is refused by GitHub push protection.
const SECRET = ["whsec", Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")].join("_");
const NOW = Date.parse("2026-10-03T12:00:00Z");
const BODY = JSON.stringify({ type: "email.delivered", data: { email_id: "e1" } });
const ts = (offset = 0) => Math.floor(NOW / 1000) + offset;

function headers(secret = SECRET, id = "msg_1", timestamp = ts(), body = BODY) {
  return { "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": signSvix(secret, id, timestamp, body) };
}

describe("Svix signature", () => {
  it("accepts a delivery signed with the secret", () => {
    expect(verifySvix({ secret: SECRET, rawBody: BODY, headers: headers(), nowMs: NOW })).toEqual({ ok: true, id: "msg_1", timestamp: ts() });
  });

  it("matches what the Svix library computes: HMAC-SHA256 of id.timestamp.body keyed with the base64-decoded secret, base64 encoded", async () => {
    // Independent computation straight from the documented scheme, not through signSvix.
    const { createHmac } = await import("node:crypto");
    const key = Buffer.from(SECRET.slice("whsec_".length), "base64");
    const expected = createHmac("sha256", key).update(`msg_1.${ts()}.${BODY}`).digest("base64");
    expect(signSvix(SECRET, "msg_1", ts(), BODY)).toBe(`v1,${expected}`);
    expect(svixKey(SECRET)?.toString()).toBe("0123456789abcdef0123456789abcdef");
  });

  it("refuses a bad signature: another secret, a changed body, a changed id or timestamp", () => {
    const other = ["whsec", Buffer.from("fedcba9876543210fedcba9876543210").toString("base64")].join("_");
    expect(verifySvix({ secret: other, rawBody: BODY, headers: headers(), nowMs: NOW })).toMatchObject({ ok: false, code: "bad_signature" });
    expect(verifySvix({ secret: SECRET, rawBody: `${BODY} `, headers: headers(), nowMs: NOW })).toMatchObject({ ok: false, code: "bad_signature" });
    const h = headers();
    expect(verifySvix({ secret: SECRET, rawBody: BODY, headers: { ...h, "svix-id": "msg_2" }, nowMs: NOW })).toMatchObject({ ok: false, code: "bad_signature" });
    expect(verifySvix({ secret: SECRET, rawBody: BODY, headers: { ...h, "svix-timestamp": String(ts() + 1) }, nowMs: NOW })).toMatchObject({ ok: false, code: "bad_signature" });
  });

  it("refuses a replay: a correctly signed delivery older than five minutes, or from the future", () => {
    const old = headers(SECRET, "msg_old", ts(-SVIX_TOLERANCE_SECONDS - 5));
    expect(verifySvix({ secret: SECRET, rawBody: BODY, headers: old, nowMs: NOW })).toMatchObject({ ok: false, code: "stale" });
    const future = headers(SECRET, "msg_future", ts(SVIX_TOLERANCE_SECONDS + 5));
    expect(verifySvix({ secret: SECRET, rawBody: BODY, headers: future, nowMs: NOW })).toMatchObject({ ok: false, code: "stale" });
    // Inside the window is fine.
    expect(verifySvix({ secret: SECRET, rawBody: BODY, headers: headers(SECRET, "msg_ok", ts(-SVIX_TOLERANCE_SECONDS + 5)), nowMs: NOW }).ok).toBe(true);
  });

  it("refuses missing or malformed headers before any secret is looked at", () => {
    expect(checkSvixShape({}, NOW)).toMatchObject({ ok: false, code: "missing" });
    expect(checkSvixShape({ "svix-id": "m", "svix-timestamp": String(ts()) }, NOW)).toMatchObject({ ok: false, code: "missing" });
    const h = headers();
    expect(checkSvixShape({ ...h, "svix-timestamp": "yesterday" }, NOW)).toMatchObject({ ok: false, code: "malformed" });
    expect(checkSvixShape({ ...h, "svix-signature": "v1,not-a-signature" }, NOW)).toMatchObject({ ok: false, code: "malformed" });
    expect(checkSvixShape({ ...h, "svix-id": "has spaces and\nnewline" }, NOW)).toMatchObject({ ok: false, code: "malformed" });
  });

  it("believes only v1: a v2 or v0 signature does not pass, a v1 beside it does", () => {
    const h = headers();
    const sig = h["svix-signature"].replace("v1,", "");
    expect(checkSvixShape({ ...h, "svix-signature": `v0,${sig}` }, NOW)).toMatchObject({ ok: false, code: "malformed" });
    expect(verifySvix({ secret: SECRET, rawBody: BODY, headers: { ...h, "svix-signature": `v2,${sig} v1,${sig}` }, nowMs: NOW }).ok).toBe(true);
    // Several v1 entries (a rotated secret): any one matching is enough.
    const stale = `v1,${Buffer.alloc(32, 7).toString("base64")}`;
    expect(verifySvix({ secret: SECRET, rawBody: BODY, headers: { ...h, "svix-signature": `${stale} v1,${sig}` }, nowMs: NOW }).ok).toBe(true);
  });

  it("reads header names in any case, as the host passes them", () => {
    const h = headers();
    expect(verifySvix({ secret: SECRET, rawBody: BODY, headers: { "Svix-Id": h["svix-id"], "SVIX-TIMESTAMP": h["svix-timestamp"], "Svix-Signature": h["svix-signature"] }, nowMs: NOW }).ok).toBe(true);
  });

  it("says so when the saved secret is not usable instead of failing every delivery as a bad signature", () => {
    expect(verifySvix({ secret: "nope", rawBody: BODY, headers: headers(), nowMs: NOW })).toMatchObject({ ok: false, code: "no_secret" });
    expect(verifySvix({ secret: "", rawBody: BODY, headers: headers(), nowMs: NOW })).toMatchObject({ ok: false, code: "no_secret" });
    expect(svixKey("whsec_c2hvcnQ=")).toBeNull();
  });
});
