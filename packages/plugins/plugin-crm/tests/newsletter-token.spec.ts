import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CONFIRM_TOKEN_TTL_MS,
  MAX_CONFIRM_LINK_LENGTH,
  MAX_CONFIRM_TOKEN_LENGTH,
  MAX_CONFIRM_URL_LENGTH,
  MAX_EMAIL_BYTES,
  MAX_PATH_BYTES,
  confirmLink,
  mintConfirmToken,
  verifyConfirmToken,
  wordingHash,
  type ConfirmTokenSource,
} from "../src/newsletter-token.js";

const NOW = Date.UTC(2026, 10, 13, 9, 0, 0);
const secret = () => `pibc_${randomBytes(30).toString("hex")}`;

function source(overrides: Partial<ConfirmTokenSource> = {}): ConfirmTokenSource {
  return { id: randomUUID(), confirmSecret: secret(), consentText: "Send me the RemoteSaffa newsletter. I can unsubscribe at any time.", ...overrides };
}

const signup = { email: "Visitor@Example.co.za", pagePath: "/blog/remote-work", issuedAt: NOW };

/** Flips one base64url character in a token part, keeping it valid base64url. */
function flip(text: string, index: number): string {
  const c = text[index]!;
  return `${text.slice(0, index)}${c === "A" ? "B" : "A"}${text.slice(index + 1)}`;
}

describe("newsletter confirmation token", () => {
  it("round trips: the claims come back with the email lower-cased", () => {
    const src = source();
    const token = mintConfirmToken(src, signup);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    const check = verifyConfirmToken(src, token, NOW + 60_000);
    expect(check).toEqual({
      ok: true,
      claims: { version: 1, sourceId: src.id, email: "visitor@example.co.za", issuedAt: NOW, pagePath: "/blog/remote-work", wordingHash: wordingHash(src.consentText) },
    });
    expect(wordingHash(src.consentText)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is valid at exactly 7 days and refused at 7 days + 1 s", () => {
    const src = source();
    const token = mintConfirmToken(src, signup);
    expect(verifyConfirmToken(src, token, NOW + CONFIRM_TOKEN_TTL_MS).ok).toBe(true);
    expect(verifyConfirmToken(src, token, NOW + CONFIRM_TOKEN_TTL_MS + 1000)).toEqual({ ok: false, reason: "expired" });
    // Issued well in the future (a forged clock) is refused too.
    expect(verifyConfirmToken(src, mintConfirmToken(src, { ...signup, issuedAt: NOW + 3_600_000 }), NOW)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a tampered payload", () => {
    const src = source();
    const [payload, sig] = mintConfirmToken(src, signup).split(".") as [string, string];
    for (const i of [0, 5, 30, payload.length - 2]) {
      expect(verifyConfirmToken(src, `${flip(payload, i)}.${sig}`, NOW)).toEqual({ ok: false, reason: "bad_signature" });
    }
    // Another address swapped in under the original signature.
    const other = mintConfirmToken(src, { ...signup, email: "attacker@example.com" }).split(".")[0];
    expect(verifyConfirmToken(src, `${other}.${sig}`, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a tampered signature", () => {
    const src = source();
    const [payload, sig] = mintConfirmToken(src, signup).split(".") as [string, string];
    expect(verifyConfirmToken(src, `${payload}.${flip(sig, 10)}`, NOW)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyConfirmToken(src, `${payload}.${sig.slice(0, -1)}`, NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyConfirmToken(src, `${payload}.`, NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a token for another source", () => {
    const shared = secret();
    const a = source({ confirmSecret: shared });
    const b = source({ confirmSecret: shared, consentText: a.consentText });
    // Same key on both sources: the signature passes, the source id does not.
    expect(verifyConfirmToken(b, mintConfirmToken(a, signup), NOW)).toEqual({ ok: false, reason: "wrong_source" });
    // The normal case, each source with its own key.
    expect(verifyConfirmToken(source(), mintConfirmToken(a, signup), NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses the token once the consent wording changed", () => {
    const src = source();
    const token = mintConfirmToken(src, signup);
    expect(verifyConfirmToken({ ...src, consentText: `${src.consentText} We may share it with partners.` }, token, NOW)).toEqual({ ok: false, reason: "wording_changed" });
  });

  it("refuses a token signed with the source's signing_secret", () => {
    const src = source();
    const signingSecret = `pibs_${randomBytes(20).toString("hex")}`;
    const forged = mintConfirmToken({ ...src, confirmSecret: signingSecret }, signup);
    expect(verifyConfirmToken(src, forged, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses an oversize email and an oversize path, at mint and at verify", () => {
    const src = source();
    const longEmail = `${"a".repeat(MAX_EMAIL_BYTES - "@example.com".length + 1)}@example.com`;
    expect(() => mintConfirmToken(src, { ...signup, email: longEmail })).toThrow(/longer than 254/);
    expect(() => mintConfirmToken(src, { ...signup, pagePath: `/${"p".repeat(MAX_PATH_BYTES)}` })).toThrow(/longer than 200/);
    // Multi-byte characters count by their UTF-8 bytes.
    expect(() => mintConfirmToken(src, { ...signup, pagePath: `/${"é".repeat(100)}` })).toThrow(/longer than 200/);

    // A payload carrying an oversize field, correctly signed (someone holding the key): still refused.
    const email = Buffer.from(longEmail);
    const head = Buffer.alloc(21);
    head.writeUInt8(1, 0);
    Buffer.from(src.id.replace(/-/g, ""), "hex").copy(head, 1);
    head.writeUInt32BE(NOW / 1000, 17);
    const payload = Buffer.concat([head, Buffer.from(wordingHash(src.consentText), "hex"), Buffer.from([email.length]), email, Buffer.from([0])]);
    const token = `${payload.toString("base64url")}.${createHmac("sha256", src.confirmSecret).update(payload).digest("base64url")}`;
    expect(verifyConfirmToken(src, token, NOW)).toEqual({ ok: false, reason: "oversize" });
    expect(verifyConfirmToken(src, "A".repeat(MAX_CONFIRM_TOKEN_LENGTH + 1), NOW)).toEqual({ ok: false, reason: "oversize" });
  });

  it("refuses an unknown version and malformed input", () => {
    const src = source();
    const [payload] = mintConfirmToken(src, signup).split(".") as [string];
    const bytes = Buffer.from(payload, "base64url");
    bytes.writeUInt8(2, 0);
    const v2 = `${bytes.toString("base64url")}.${createHmac("sha256", src.confirmSecret).update(bytes).digest("base64url")}`;
    expect(verifyConfirmToken(src, v2, NOW)).toEqual({ ok: false, reason: "unknown_version" });

    const truncated = bytes.subarray(0, 25);
    truncated.writeUInt8(1, 0);
    const short = `${truncated.toString("base64url")}.${createHmac("sha256", src.confirmSecret).update(truncated).digest("base64url")}`;
    expect(verifyConfirmToken(src, short, NOW)).toEqual({ ok: false, reason: "malformed" });

    for (const bad of [undefined, null, 42, "", "abc", "a.b.c", "a b.c", "YQ==.YQ", `${payload}=.${payload}`]) {
      expect(verifyConfirmToken(src, bad, NOW).ok).toBe(false);
    }
    expect(() => mintConfirmToken({ ...src, id: "not-a-uuid" }, signup)).toThrow(/UUID/);
    expect(() => mintConfirmToken({ ...src, confirmSecret: "" }, signup)).toThrow(/confirm secret/);
    expect(() => mintConfirmToken(src, { ...signup, email: "  " })).toThrow(/empty/);
    expect(verifyConfirmToken({ ...src, confirmSecret: "" }, mintConfirmToken(src, signup), NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("keeps the longest link under 800 characters", () => {
    const src = source();
    const email = `${"a".repeat(MAX_EMAIL_BYTES - "@example.com".length)}@example.com`;
    const pagePath = `/${"p".repeat(MAX_PATH_BYTES - 1)}`;
    const token = mintConfirmToken(src, { email, pagePath, issuedAt: NOW });
    expect(token.length).toBe(MAX_CONFIRM_TOKEN_LENGTH);
    const url = `https://remotesaffa.co.za/${"c".repeat(MAX_CONFIRM_URL_LENGTH - "https://remotesaffa.co.za/".length)}`;
    expect(url.length).toBe(MAX_CONFIRM_URL_LENGTH);
    const link = confirmLink(url, token);
    expect(link.length).toBeLessThan(MAX_CONFIRM_LINK_LENGTH);
    expect(verifyConfirmToken(src, link.split("#t=")[1], NOW).ok).toBe(true);
    expect(() => confirmLink(`${url}${"x".repeat(MAX_CONFIRM_LINK_LENGTH)}`, token)).toThrow(/most is 799/);
  });
});
