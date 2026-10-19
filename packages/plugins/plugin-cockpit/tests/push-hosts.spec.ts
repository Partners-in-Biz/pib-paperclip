import { describe, expect, it } from "vitest";
import { ALLOWED_PUSH_HOSTS, isAllowedPushEndpoint } from "../src/push/hosts.js";

describe("Push endpoint host allowlist (S1)", () => {
  it("exports the four allowed host families", () => {
    expect(ALLOWED_PUSH_HOSTS).toContain("fcm.googleapis.com");
    expect(ALLOWED_PUSH_HOSTS).toContain("updates.push.services.mozilla.com");
    expect(ALLOWED_PUSH_HOSTS).toContain(".push.apple.com");
    expect(ALLOWED_PUSH_HOSTS).toContain(".notify.windows.com");
    expect(ALLOWED_PUSH_HOSTS.length).toBe(4);
  });

  describe("accepts allowed endpoints", () => {
    it("accepts Firebase Cloud Messaging (FCM)", () => {
      expect(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc123")).toBe(true);
      expect(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/xyz")).toBe(true);
    });

    it("accepts Mozilla Push Service", () => {
      expect(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/push/v1/abc")).toBe(true);
      expect(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/push/v1/gUh30z21")).toBe(
        true
      );
    });

    it("accepts Apple Push Service subdomains", () => {
      expect(isAllowedPushEndpoint("https://api.push.apple.com/3/device/abc123")).toBe(true);
      expect(isAllowedPushEndpoint("https://test.push.apple.com/3/device/xyz")).toBe(true);
      expect(isAllowedPushEndpoint("https://sub.domain.push.apple.com/path")).toBe(true);
    });

    it("accepts Windows Push Service subdomains", () => {
      expect(isAllowedPushEndpoint("https://db3.notify.windows.com/w/?token=abc")).toBe(true);
      expect(isAllowedPushEndpoint("https://sub.domain.notify.windows.com/path")).toBe(true);
    });
  });

  describe("rejects disallowed hosts", () => {
    it("rejects arbitrary domains", () => {
      expect(isAllowedPushEndpoint("https://evil.com/push")).toBe(false);
      expect(isAllowedPushEndpoint("https://attacker.com/x")).toBe(false);
    });

    it("rejects bare apex for wildcard families", () => {
      // Bare apex push.apple.com should be rejected (no subdomain)
      expect(isAllowedPushEndpoint("https://push.apple.com/3/device/abc")).toBe(false);
      // Bare apex notify.windows.com should be rejected (no subdomain)
      expect(isAllowedPushEndpoint("https://notify.windows.com/w/?token=abc")).toBe(false);
    });

    it("rejects leading-dot/empty-label for wildcard families", () => {
      // Leading dot with empty label should be rejected
      expect(isAllowedPushEndpoint("https://.push.apple.com/path")).toBe(false);
      expect(isAllowedPushEndpoint("https://.notify.windows.com/path")).toBe(false);
    });

    it("rejects subdomains of exact-match families", () => {
      // fcm.googleapis.com should only match exactly, not subdomains
      expect(isAllowedPushEndpoint("https://x.fcm.googleapis.com/path")).toBe(false);
      expect(isAllowedPushEndpoint("https://sub.fcm.googleapis.com/path")).toBe(false);
      // updates.push.services.mozilla.com should only match exactly, not subdomains
      expect(isAllowedPushEndpoint("https://foo.updates.push.services.mozilla.com/path")).toBe(
        false
      );
      expect(isAllowedPushEndpoint("https://x.updates.push.services.mozilla.com/path")).toBe(
        false
      );
    });

    it("rejects subdomain spoofing (fcm.googleapis.com.evil.com)", () => {
      expect(isAllowedPushEndpoint("https://fcm.googleapis.com.evil.com/x")).toBe(false);
    });

    it("rejects substring matches (evilfcm.googleapis.com)", () => {
      expect(isAllowedPushEndpoint("https://evilfcm.googleapis.com/x")).toBe(false);
    });

    it("rejects HTTP (requires HTTPS)", () => {
      expect(isAllowedPushEndpoint("http://fcm.googleapis.com/x")).toBe(false);
      expect(isAllowedPushEndpoint("http://api.push.apple.com/x")).toBe(false);
    });

    it("rejects explicit non-443 ports", () => {
      expect(isAllowedPushEndpoint("https://fcm.googleapis.com:8443/x")).toBe(false);
      expect(isAllowedPushEndpoint("https://notify.windows.com:80/x")).toBe(false);
    });

    it("rejects IPv4 literals", () => {
      expect(isAllowedPushEndpoint("https://127.0.0.1/x")).toBe(false);
      expect(isAllowedPushEndpoint("https://192.168.1.1/x")).toBe(false);
      expect(isAllowedPushEndpoint("https://8.8.8.8/x")).toBe(false);
      expect(isAllowedPushEndpoint("https://142.250.1.1/x")).toBe(false);
    });

    it("rejects IPv6 literals", () => {
      expect(isAllowedPushEndpoint("https://[::1]/x")).toBe(false);
      expect(isAllowedPushEndpoint("https://[2001:db8::1]/x")).toBe(false);
      expect(isAllowedPushEndpoint("https://[::ffff:192.0.2.1]/x")).toBe(false);
    });

    it("rejects localhost", () => {
      expect(isAllowedPushEndpoint("https://localhost/x")).toBe(false);
      expect(isAllowedPushEndpoint("https://localhost:443/x")).toBe(false);
    });

    it("rejects URLs with userinfo (username:password@host)", () => {
      expect(isAllowedPushEndpoint("https://fcm.googleapis.com@evil.com/x")).toBe(false);
      expect(isAllowedPushEndpoint("https://user:pw@fcm.googleapis.com/x")).toBe(false);
      expect(isAllowedPushEndpoint("https://user@api.push.apple.com/x")).toBe(false);
    });
  });

  describe("never throws", () => {
    it("handles empty string gracefully", () => {
      expect(isAllowedPushEndpoint("")).toBe(false);
    });

    it("handles invalid URLs gracefully", () => {
      expect(isAllowedPushEndpoint("not a url")).toBe(false);
      expect(isAllowedPushEndpoint("javascript:alert(1)")).toBe(false);
      expect(isAllowedPushEndpoint("ftp://example.com")).toBe(false);
      expect(() => isAllowedPushEndpoint("garbage")).not.toThrow();
    });

    it("handles malformed URLs gracefully", () => {
      expect(isAllowedPushEndpoint("https://[invalid ipv6]/x")).toBe(false);
      expect(isAllowedPushEndpoint("https:///path/only")).toBe(false);
    });

    it("handles null/undefined gracefully (via ts-ignore in actual code)", () => {
      // In TypeScript, these would be compile errors, but we test the runtime behavior
      expect(isAllowedPushEndpoint(undefined as unknown as string)).toBe(false);
      expect(isAllowedPushEndpoint(null as unknown as string)).toBe(false);
    });
  });

  describe("case insensitivity and normalization", () => {
    it("normalizes uppercase hostnames", () => {
      expect(isAllowedPushEndpoint("https://FCM.GOOGLEAPIS.COM/x")).toBe(true);
      expect(isAllowedPushEndpoint("https://API.PUSH.APPLE.COM/x")).toBe(true);
    });

    it("handles trailing dots", () => {
      expect(isAllowedPushEndpoint("https://fcm.googleapis.com./x")).toBe(true);
      expect(isAllowedPushEndpoint("https://api.push.apple.com./x")).toBe(true);
    });
  });

  describe("query strings and fragments", () => {
    it("allows query strings and fragments", () => {
      expect(isAllowedPushEndpoint("https://fcm.googleapis.com/path?token=abc&id=123")).toBe(true);
      expect(
        isAllowedPushEndpoint("https://api.push.apple.com/3/device/abc#section")
      ).toBe(true);
    });
  });
});
