import { describe, expect, it } from "vitest";
import {
  OWN_SENDER,
  mailSenderFields,
  resolveSender,
  senderKeyOf,
  signUnsubscribeToken,
  suppressionBlocks,
  suppressionKey,
  verifyUnsubscribeToken,
  type SenderIdentity,
} from "../src/index.js";

const acme: SenderIdentity = { senderKey: "company:acme", fromAddress: "hello@acme.co", fromName: "Acme Team", replyTo: "support@acme.co" };

describe("whose list an opt-out belongs to", () => {
  it("names the sender", () => {
    expect(senderKeyOf(null)).toBe(OWN_SENDER);
    expect(senderKeyOf({ clientRef: "" })).toBe("own");
    expect(senderKeyOf({ clientKind: "company", clientRef: "acme" })).toBe("company:acme");
    expect(senderKeyOf({ clientKind: "contact", clientRef: "jane" })).toBe("contact:jane");
    expect(senderKeyOf({ clientRef: "acme" })).toBe("company:acme");
  });

  it("keeps the old announcement key for own marketing and adds the sender for a client's", () => {
    expect(suppressionKey(" Jane@Example.com ", "unsubscribed")).toBe("suppress:jane@example.com:unsubscribed");
    expect(suppressionKey("jane@example.com", "unsubscribed", "company:acme")).toBe("suppress:jane@example.com:unsubscribed:company:acme");
  });

  it("a client's unsubscribe does not silence PiB's own marketing or another client's", () => {
    const row = { scope: "marketing" as const, senderKey: "company:acme" };
    expect(suppressionBlocks(row, { marketing: true, senderKey: "company:acme" })).toBe(true);
    expect(suppressionBlocks(row, { marketing: true, senderKey: OWN_SENDER })).toBe(false);
    expect(suppressionBlocks(row, { marketing: true, senderKey: "company:globex" })).toBe(false);
    expect(suppressionBlocks(row, { marketing: false, senderKey: "company:acme" })).toBe(false);
  });

  it("a hard bounce blocks every sender and every kind of mail", () => {
    const row = { scope: "all" as const, senderKey: "company:acme" };
    expect(suppressionBlocks(row, { marketing: false, senderKey: OWN_SENDER })).toBe(true);
    expect(suppressionBlocks(row, { marketing: true, senderKey: "company:globex" })).toBe(true);
  });

  it("a row from before the sender existed still blocks everyone's marketing", () => {
    expect(suppressionBlocks({ scope: "marketing" }, { marketing: true, senderKey: "company:acme" })).toBe(true);
    expect(suppressionBlocks({ scope: "marketing", senderKey: null }, { marketing: true })).toBe(true);
    expect(suppressionBlocks({ scope: "marketing" }, { marketing: false })).toBe(false);
  });
});

describe("the sender a send uses", () => {
  it("uses the client's identity and carries From, name and Reply-To on the request", () => {
    const resolved = resolveSender([acme], { clientKind: "company", clientRef: "acme" });
    expect(resolved).toEqual({ ok: true, identity: acme, senderKey: "company:acme" });
    expect(mailSenderFields(acme, { unsubscribeUrl: "https://p.example/unsub/abc" })).toEqual({ from: "hello@acme.co", fromName: "Acme Team", replyTo: { email: "support@acme.co" }, unsubscribeUrl: "https://p.example/unsub/abc" });
  });

  it("refuses to send a client's mail from the default account", () => {
    const resolved = resolveSender([], { clientKind: "company", clientRef: "globex" });
    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.error).toContain("will not go out from the default account");
  });

  it("lets own marketing use the default account", () => {
    expect(resolveSender([], null)).toEqual({ ok: true, identity: null, senderKey: "own" });
    expect(mailSenderFields(null)).toEqual({});
  });
});

describe("one-click unsubscribe tokens", () => {
  const secret = "a-long-enough-secret-value";
  const payload = { companyId: "co-1", email: "Jane@Example.com", senderKey: "company:acme" };

  it("round-trips, normalising the address", () => {
    const token = signUnsubscribeToken(payload, secret);
    expect(verifyUnsubscribeToken(token, secret)).toEqual({ companyId: "co-1", email: "jane@example.com", senderKey: "company:acme" });
  });

  it("refuses a tampered token, a wrong secret, junk and a short secret", () => {
    const token = signUnsubscribeToken(payload, secret);
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ c: "co-2", e: "jane@example.com", s: "own" })).toString("base64url");
    expect(verifyUnsubscribeToken(`${forged}.${sig}`, secret)).toBeNull();
    expect(verifyUnsubscribeToken(`${body}.${sig!.slice(0, -2)}AA`, secret)).toBeNull();
    expect(verifyUnsubscribeToken(token, "another-long-enough-secret")).toBeNull();
    expect(verifyUnsubscribeToken("nonsense", secret)).toBeNull();
    expect(verifyUnsubscribeToken(token, "short")).toBeNull();
    expect(() => signUnsubscribeToken(payload, "short")).toThrow("too short");
  });
});
