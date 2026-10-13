import { describe, it, expect } from "vitest";
import { dialerHref, TELEPHONY_PLUGIN_KEY } from "../src/phone-link.js";

describe("phone-link utilities", () => {
  describe("dialerHref", () => {
    describe("TELEPHONY_PLUGIN_KEY", () => {
      it("should export the correct plugin key", () => {
        expect(TELEPHONY_PLUGIN_KEY).toBe("partnersinbiz.crm-telephony");
      });
    });

    describe("E.164 pass", () => {
      it("should accept valid E.164 format", () => {
        const href = dialerHref("+27821234567", null, "PIB");
        expect(href).toBe("/PIB/dialer?to=%2B27821234567");
      });

      it("should accept E.164 with minimum digits (7 after country code)", () => {
        const href = dialerHref("+12345678", null, "PIB");
        expect(href).toBe("/PIB/dialer?to=%2B12345678");
      });

      it("should accept E.164 with maximum digits (14 after country code)", () => {
        const href = dialerHref("+12345678901234", null, "PIB");
        expect(href).toBe("/PIB/dialer?to=%2B12345678901234");
      });
    });

    describe("formatted number normalization", () => {
      it("should normalize spaces", () => {
        const href = dialerHref("+27 82 123 4567", null, "PIB");
        expect(href).toBe("/PIB/dialer?to=%2B27821234567");
      });

      it("should normalize dashes", () => {
        const href = dialerHref("+27-82-123-4567", null, "PIB");
        expect(href).toBe("/PIB/dialer?to=%2B27821234567");
      });

      it("should normalize parentheses", () => {
        const href = dialerHref("+27(82)123-4567", null, "PIB");
        expect(href).toBe("/PIB/dialer?to=%2B27821234567");
      });

      it("should normalize dots", () => {
        const href = dialerHref("+27.82.123.4567", null, "PIB");
        expect(href).toBe("/PIB/dialer?to=%2B27821234567");
      });

      it("should normalize mixed formatting", () => {
        const href = dialerHref("+27 (82) 123-4567", null, "PIB");
        expect(href).toBe("/PIB/dialer?to=%2B27821234567");
      });
    });

    describe("South African local conversion", () => {
      it("should convert 10-digit SA local number starting with 0", () => {
        const href = dialerHref("0821234567", null, "PIB");
        expect(href).toBe("/PIB/dialer?to=%2B27821234567");
      });

      it("should convert SA local with formatting", () => {
        const href = dialerHref("082 123 4567", null, "PIB");
        expect(href).toBe("/PIB/dialer?to=%2B27821234567");
      });

      it("should convert SA local with dashes", () => {
        const href = dialerHref("082-123-4567", null, "PIB");
        expect(href).toBe("/PIB/dialer?to=%2B27821234567");
      });

      it("should not convert numbers that don't match SA local pattern", () => {
        const href = dialerHref("1234567890", null, "PIB"); // 10 digits but doesn't start with 0 after normalization
        expect(href).toBeNull(); // Invalid E.164 (must start with + and +1 or higher)
      });
    });

    describe("invalid input returns null", () => {
      it("should return null for empty string", () => {
        expect(dialerHref("", null, "PIB")).toBeNull();
      });

      it("should return null for whitespace only", () => {
        expect(dialerHref("   ", null, "PIB")).toBeNull();
      });

      it("should return null for number without country code", () => {
        const href = dialerHref("821234567", null, "PIB");
        expect(href).toBeNull();
      });

      it("should return null for E.164 with country code 0", () => {
        const href = dialerHref("+0821234567", null, "PIB");
        expect(href).toBeNull();
      });

      it("should return null for number too short (less than 6 digits after country code digit)", () => {
        const href = dialerHref("+271234", null, "PIB");
        expect(href).toBeNull();
      });

      it("should return null for number too long (more than 14 digits after country code)", () => {
        const href = dialerHref("+271234567890123456", null, "PIB");
        expect(href).toBeNull();
      });
    });

    describe("contactId validation", () => {
      it("should include valid contactId in URL", () => {
        const href = dialerHref("+27821234567", "contact-123", "PIB");
        expect(href).toContain("contactId=contact-123");
      });

      it("should include contactId with valid characters", () => {
        const href = dialerHref("+27821234567", "contact_123-abc", "PIB");
        expect(href).toContain("contactId=contact_123-abc");
      });

      it("should return null for contactId that is too long (> 64 chars)", () => {
        const longId = "a".repeat(65);
        expect(dialerHref("+27821234567", longId, "PIB")).toBeNull();
      });

      it("should return null for contactId with invalid characters", () => {
        expect(dialerHref("+27821234567", "contact@123", "PIB")).toBeNull();
      });

      it("should return null for contactId with spaces", () => {
        expect(dialerHref("+27821234567", "contact 123", "PIB")).toBeNull();
      });

      it("should ignore null contactId", () => {
        const href = dialerHref("+27821234567", null, "PIB");
        expect(href).toBe("/PIB/dialer?to=%2B27821234567");
        expect(href).not.toContain("contactId");
      });

      it("should ignore undefined contactId", () => {
        const href = dialerHref("+27821234567", undefined, "PIB");
        expect(href).toBe("/PIB/dialer?to=%2B27821234567");
        expect(href).not.toContain("contactId");
      });

      it("should ignore empty string contactId", () => {
        const href = dialerHref("+27821234567", "", "PIB");
        expect(href).toBe("/PIB/dialer?to=%2B27821234567");
        expect(href).not.toContain("contactId");
      });

      it("should ignore whitespace-only contactId", () => {
        const href = dialerHref("+27821234567", "   ", "PIB");
        expect(href).toBe("/PIB/dialer?to=%2B27821234567");
        expect(href).not.toContain("contactId");
      });

      it("should trim contactId before validation", () => {
        const href = dialerHref("+27821234567", "  contact-123  ", "PIB");
        expect(href).toContain("contactId=contact-123");
      });
    });

    describe("plus sign encoding", () => {
      it("should encode plus sign as %2B in query string", () => {
        const href = dialerHref("+27821234567", null, "PIB");
        expect(href).toContain("%2B");
        expect(href).not.toContain("to=+"); // Should not have raw +
      });
    });

    describe("prefix handling", () => {
      it("should use provided prefix", () => {
        const href = dialerHref("+27821234567", null, "PIB");
        expect(href).toBe("/PIB/dialer?to=%2B27821234567");
      });

      it("should return null if prefix is missing", () => {
        const href = dialerHref("+27821234567", null, undefined);
        expect(href).toBeNull();
      });

      it("should return null if prefix is empty string", () => {
        const href = dialerHref("+27821234567", null, "");
        expect(href).toBeNull();
      });

      it("should return null if prefix is whitespace only", () => {
        const href = dialerHref("+27821234567", null, "   ");
        expect(href).toBeNull();
      });

      it("should include contactId with prefix", () => {
        const href = dialerHref("+27821234567", "contact-123", "PIB");
        expect(href).toBe("/PIB/dialer?to=%2B27821234567&contactId=contact-123");
      });
    });
  });
});
