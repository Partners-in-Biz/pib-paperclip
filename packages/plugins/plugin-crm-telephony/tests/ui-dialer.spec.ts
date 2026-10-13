import { describe, it, expect } from "vitest";
import {
  parseDialerParams,
  normalizeDialInput,
  isDialable,
  buildDialEvent,
  DIAL_EVENT,
} from "../src/ui/dialer.js";

describe("Dialer UI utilities", () => {
  describe("parseDialerParams", () => {
    it("parses empty search string", () => {
      expect(parseDialerParams("")).toEqual({});
    });

    it("parses valid E.164 to parameter", () => {
      expect(parseDialerParams("?to=%2B27123456789")).toEqual({ to: "+27123456789" });
    });

    it("accepts valid E.164 with URL encoding", () => {
      expect(parseDialerParams("?to=%2B1234567890")).toEqual({ to: "+1234567890" });
    });

    it("strips spaces from to parameter and validates", () => {
      expect(parseDialerParams("?to=%2B27%20123%20456%20789")).toEqual({ to: "+27123456789" });
    });

    it("accepts URL-encoded typed format like +27 82 123 4567", () => {
      expect(parseDialerParams("?to=%2B27%2082%20123%204567")).toEqual({ to: "+27821234567" });
    });

    it("strips dashes from to parameter and validates", () => {
      expect(parseDialerParams("?to=%2B27-123-456-789")).toEqual({ to: "+27123456789" });
    });

    it("strips parentheses from to parameter and validates", () => {
      expect(parseDialerParams("?to=%2B27(123)456789")).toEqual({ to: "+27123456789" });
    });

    it("rejects invalid E.164 format in to parameter", () => {
      expect(parseDialerParams("?to=invalid").to).toBeUndefined();
    });

    it("rejects to without + prefix", () => {
      expect(parseDialerParams("?to=27123456789").to).toBeUndefined();
    });

    it("rejects to with leading zero after +", () => {
      expect(parseDialerParams("?to=%2B027123456789").to).toBeUndefined();
    });

    it("rejects to with too few digits", () => {
      expect(parseDialerParams("?to=%2B123456").to).toBeUndefined();
    });

    it("rejects to with too many digits (16+)", () => {
      expect(parseDialerParams("?to=%2B1234567890123456").to).toBeUndefined();
    });

    it("parses valid contactId parameter", () => {
      expect(parseDialerParams("?contactId=contact-123")).toEqual({ contactId: "contact-123" });
    });

    it("accepts contactId with alphanumeric and dashes/underscores", () => {
      expect(parseDialerParams("?contactId=Contact_123-ABC")).toEqual({ contactId: "Contact_123-ABC" });
    });

    it("trims whitespace from contactId", () => {
      expect(parseDialerParams("?contactId=%20contact-123%20")).toEqual({ contactId: "contact-123" });
    });

    it("rejects contactId with invalid characters", () => {
      expect(parseDialerParams("?contactId=contact@123").contactId).toBeUndefined();
    });

    it("rejects contactId exceeding 64 characters", () => {
      const longId = "a".repeat(65);
      expect(parseDialerParams(`?contactId=${longId}`).contactId).toBeUndefined();
    });

    it("accepts contactId with exactly 64 characters", () => {
      const longId = "a".repeat(64);
      expect(parseDialerParams(`?contactId=${longId}`).contactId).toBe(longId);
    });

    it("parses both to and contactId parameters", () => {
      expect(parseDialerParams("?to=%2B27123456789&contactId=contact-123")).toEqual({
        to: "+27123456789",
        contactId: "contact-123",
      });
    });

    it("ignores unknown parameters", () => {
      expect(parseDialerParams("?to=%2B27123456789&unknown=value")).toEqual({
        to: "+27123456789",
      });
    });

    it("returns undefined for missing parameters", () => {
      expect(parseDialerParams("?to=%2B27123456789").contactId).toBeUndefined();
    });
  });

  describe("normalizeDialInput", () => {
    it("strips spaces from input", () => {
      expect(normalizeDialInput("+27 82 123 4567")).toBe("+27821234567");
    });

    it("strips dashes from input", () => {
      expect(normalizeDialInput("+27-82-123-4567")).toBe("+27821234567");
    });

    it("strips parentheses from input", () => {
      expect(normalizeDialInput("+1 (555) 123-4567")).toBe("+15551234567");
    });

    it("strips dots from input", () => {
      expect(normalizeDialInput("+27.82.123.4567")).toBe("+27821234567");
    });

    it("trims leading and trailing whitespace", () => {
      expect(normalizeDialInput("  +27821234567  ")).toBe("+27821234567");
    });

    it("handles already-clean input", () => {
      expect(normalizeDialInput("+27821234567")).toBe("+27821234567");
    });

    it("combines multiple formatting characters", () => {
      expect(normalizeDialInput("  +1 (555) 123-4567.x123  ")).toBe("+15551234567x123");
    });

    it("returns empty string for empty input", () => {
      expect(normalizeDialInput("")).toBe("");
    });

    it("returns empty string for whitespace-only input", () => {
      expect(normalizeDialInput("   ")).toBe("");
    });
  });

  describe("isDialable", () => {
    it("accepts valid E.164 format", () => {
      expect(isDialable("+27123456789")).toBe(true);
    });

    it("accepts minimum length E.164 (7 digits after +)", () => {
      expect(isDialable("+1234567")).toBe(true);
    });

    it("accepts maximum length E.164 (15 digits after +)", () => {
      expect(isDialable("+123456789012345")).toBe(true);
    });

    it("rejects E.164 without + prefix", () => {
      expect(isDialable("27123456789")).toBe(false);
    });

    it("rejects E.164 with leading zero", () => {
      expect(isDialable("+027123456789")).toBe(false);
    });

    it("rejects too short E.164", () => {
      expect(isDialable("+123456")).toBe(false);
    });

    it("rejects too long E.164 (16+ digits)", () => {
      expect(isDialable("+12345678901234567")).toBe(false);
    });

    it("rejects E.164 with spaces", () => {
      expect(isDialable("+27 123 456 789")).toBe(false);
    });

    it("rejects E.164 with dashes", () => {
      expect(isDialable("+27-123-456-789")).toBe(false);
    });

    it("rejects empty string", () => {
      expect(isDialable("")).toBe(false);
    });

    it("rejects non-numeric after +", () => {
      expect(isDialable("+27abc456789")).toBe(false);
    });
  });

  describe("buildDialEvent", () => {
    it("creates custom event with correct type", () => {
      const event = buildDialEvent("+27123456789");
      expect(event.type).toBe(DIAL_EVENT);
    });

    it("sets dial event constant correctly", () => {
      expect(DIAL_EVENT).toBe("pib-telephony:dial");
    });

    it("includes to in detail", () => {
      const event = buildDialEvent("+27123456789");
      expect(event.detail.to).toBe("+27123456789");
    });

    it("includes contactId in detail when provided", () => {
      const event = buildDialEvent("+27123456789", "contact-123");
      expect(event.detail.contactId).toBe("contact-123");
    });

    it("omits contactId in detail when not provided", () => {
      const event = buildDialEvent("+27123456789");
      expect(event.detail.contactId).toBeUndefined();
    });

    it("event bubbles", () => {
      const event = buildDialEvent("+27123456789");
      expect(event.bubbles).toBe(true);
    });

    it("event is cancelable", () => {
      const event = buildDialEvent("+27123456789");
      expect(event.cancelable).toBe(true);
    });
  });
});
