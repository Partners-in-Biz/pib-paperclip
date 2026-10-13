import { describe, expect, it } from "vitest";
import {
  buildPublicWebhookUrl,
  computeTwilioSignature,
  parseFormParams,
  verifyTwilioWebhook,
} from "../src/twilio-signature.js";

// Helper to build and verify a signed request
const buildSignedRequest = (
  authToken: string,
  url: string,
  rawBody: string,
  headerName: string = "x-twilio-signature",
) => {
  const params = parseFormParams(rawBody);
  const signature = computeTwilioSignature(authToken, url, params);
  return { headers: { [headerName]: signature }, rawBody, url, authToken };
};

describe("Twilio Signature", () => {
  describe("buildPublicWebhookUrl", () => {
    it.each<[string, string, string, string | undefined, string]>([
      ["basic", "https://example.com", "my.plugin", undefined, "https://example.com/api/plugins/my.plugin/webhooks/sms"],
      ["trailing slash", "https://example.com/", "my.plugin", undefined, "https://example.com/api/plugins/my.plugin/webhooks/sms"],
      ["with query", "https://example.com", "my.plugin", "b=2&a=1", "https://example.com/api/plugins/my.plugin/webhooks/sms?b=2&a=1"],
      ["query with ?", "https://example.com", "my.plugin", "?b=2&a=1", "https://example.com/api/plugins/my.plugin/webhooks/sms?b=2&a=1"],
      ["percent-encoding", "https://example.com", "my.plugin", "b=%20&a=1", "https://example.com/api/plugins/my.plugin/webhooks/sms?b=%20&a=1"],
    ])("%s", (_, baseUrl, pluginId, rawQuery, expected) => {
      const url = buildPublicWebhookUrl({
        baseUrl,
        pluginId,
        endpointKey: "sms",
        ...(rawQuery && { rawQuery }),
      });
      expect(url).toBe(expected);
    });

    it.each<[string, string]>([
      ["query in base", "https://example.com?foo=bar"],
      ["hash in base", "https://example.com#section"],
      ["credentials in base", "https://user:pass@example.com"],
      ["non-http protocol", "ftp://example.com"],
      ["invalid URL", "not a url"],
    ])("throws on %s", (_, baseUrl) => {
      expect(() =>
        buildPublicWebhookUrl({
          baseUrl,
          pluginId: "my.plugin",
          endpointKey: "sms",
        }),
      ).toThrow();
    });
  });

  describe("parseFormParams", () => {
    it.each([
      ["key=value&foo=bar", { key: ["value"], foo: ["bar"] }],
      ["item=apple&item=banana&item=cherry", { item: ["apple", "banana", "cherry"] }],
      ["name=John+Doe&email=test%40example.com", { name: ["John Doe"], email: ["test@example.com"] }],
      ["", {}],
    ])("parses %s", (input, expected) => {
      expect(parseFormParams(input)).toEqual(expected);
    });
  });

  describe("computeTwilioSignature", () => {
    it("matches official twilio-node algorithm", () => {
      const sig = computeTwilioSignature("12345", "https://mycompany.com/myapp.php?foo=1&bar=2", {
        CallSid: "CA1234567890ABCDE",
        Caller: "+12349013030",
        Digits: "1234",
        From: "+12349013030",
        To: "+18005551212",
      });
      expect(sig).toBe("0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
    });

    it("handles repeated keys in params", () => {
      const sig = computeTwilioSignature("secret", "https://example.com/webhook", {
        item: ["a", "b", "c"],
        name: "test",
      });
      expect(typeof sig).toBe("string");
      expect(sig.length).toBeGreaterThan(0);
    });

    it("sorts keys before computing", () => {
      const url = "https://example.com/webhook";
      const sig1 = computeTwilioSignature("secret", url, { z: "value", a: "value", m: "value" });
      const sig2 = computeTwilioSignature("secret", url, { a: "value", m: "value", z: "value" });
      expect(sig1).toBe(sig2);
    });
  });

  describe("verifyTwilioWebhook", () => {
    const officialUrl = "https://mycompany.com/myapp.php?foo=1&bar=2";
    const officialBody = "CallSid=CA1234567890ABCDE&Caller=%2B12349013030&Digits=1234&From=%2B12349013030&To=%2B18005551212";
    const officialSig = "GvWf1cFY/Q7PnoempGyD5oXAezc=";

    it.each<[string, Record<string, unknown>, boolean | { ok: boolean; reason?: string; variant?: string }]>([
      ["missing auth token", { authToken: "", headers: { "x-twilio-signature": "sig" }, rawBody: "", url: "https://example.com/webhook" }, { ok: false, reason: "missing_auth_token" }],
      ["missing signature", { authToken: "secret", headers: {}, rawBody: "", url: "https://example.com/webhook" }, { ok: false, reason: "missing_signature" }],
      ["empty signature", { authToken: "secret", headers: { "x-twilio-signature": "" }, rawBody: "", url: "https://example.com/webhook" }, { ok: false, reason: "missing_signature" }],
      ["form/tampered param", { authToken: "12345", headers: { "x-twilio-signature": officialSig }, rawBody: officialBody.replace("1234", "HACKED"), url: officialUrl }, { ok: false, reason: "bad_signature" }],
      ["form/tampered host", { authToken: "12345", headers: { "x-twilio-signature": officialSig }, rawBody: officialBody, url: "https://evil.com/myapp.php?foo=1&bar=2" }, { ok: false, reason: "bad_signature" }],
      ["form/tampered query", { authToken: "12345", headers: { "x-twilio-signature": officialSig }, rawBody: officialBody, url: "https://mycompany.com/myapp.php?foo=1&bar=99" }, { ok: false, reason: "bad_signature" }],
      ["form/wrong token", { authToken: "wrongtoken", headers: { "x-twilio-signature": officialSig }, rawBody: officialBody, url: officialUrl }, { ok: false, reason: "bad_signature" }],
    ])("%s", (_, input, expected) => {
      const result = verifyTwilioWebhook(input as Parameters<typeof verifyTwilioWebhook>[0]);
      expect(result).toEqual(expected);
    });

    it("verifies form variant with correct signature", () => {
      const { headers, rawBody, url, authToken } = buildSignedRequest("12345", officialUrl, officialBody);
      expect(verifyTwilioWebhook({ authToken, headers, rawBody, url })).toEqual({ ok: true, variant: "form" });
    });

    it("accepts header name in different case", () => {
      const { headers: _, rawBody, url, authToken } = buildSignedRequest("12345", officialUrl, officialBody);
      const params = parseFormParams(rawBody);
      const sig = computeTwilioSignature(authToken, url, params);
      expect(verifyTwilioWebhook({ authToken, headers: { "X-TWILIO-SIGNATURE": sig }, rawBody, url })).toEqual({ ok: true, variant: "form" });
    });

    it("handles JSON variant with valid body hash and signature", () => {
      const hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
      const url = `https://example.com/webhook?bodySHA256=${hash}`;
      const sig = computeTwilioSignature("secret", url);
      expect(verifyTwilioWebhook({ authToken: "secret", headers: { "x-twilio-signature": sig }, rawBody: "", url })).toEqual({ ok: true, variant: "json" });
    });

    it.each([
      ["bad_body_hash", "tampered"],
      ["bad_signature", ""],
    ])("returns %s for JSON variant", (reason, body) => {
      const hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
      const url = `https://example.com/webhook?bodySHA256=${hash}`;
      const sig = reason === "bad_body_hash" ? computeTwilioSignature("secret", url) : "badsignature";
      expect(verifyTwilioWebhook({ authToken: "secret", headers: { "x-twilio-signature": sig }, rawBody: body, url })).toEqual({ ok: false, reason });
    });

    it("rejects JSON variant when signature is computed over stripped URL", () => {
      const hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
      const url = `https://example.com/webhook?bodySHA256=${hash}`;
      // Compute signature incorrectly over the stripped URL
      const sig = computeTwilioSignature("secret", url.split("?")[0]);
      expect(verifyTwilioWebhook({ authToken: "secret", headers: { "x-twilio-signature": sig }, rawBody: "", url })).toEqual({ ok: false, reason: "bad_signature" });
    });

    it("includes other query params in JSON variant signature", () => {
      const hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
      const url = `https://example.com/webhook?bodySHA256=${hash}&token=abc123`;
      // Compute valid signature over full URL with both query params
      const sig = computeTwilioSignature("secret", url);
      expect(verifyTwilioWebhook({ authToken: "secret", headers: { "x-twilio-signature": sig }, rawBody: "", url })).toEqual({ ok: true, variant: "json" });

      // Change the token param and signature should fail
      const tamperedUrl = `https://example.com/webhook?bodySHA256=${hash}&token=xyz789`;
      expect(verifyTwilioWebhook({ authToken: "secret", headers: { "x-twilio-signature": sig }, rawBody: "", url: tamperedUrl })).toEqual({ ok: false, reason: "bad_signature" });
    });
  });
});
