/**
 * Tests for the Twilio SMS transport.
 *
 * Validates:
 * - Success with SID extraction
 * - Rate limit (429) and server error (5xx) handling
 * - Client error (4xx) handling with Twilio error codes
 * - Network error handling
 * - Invalid Messaging Service SID format (MG + 20+ alphanumeric chars)
 * - Auth header and form body construction
 * - Auth token is never leaked in error messages
 */

import { describe, it, expect, vi } from "vitest";
import { twilioSmsTransport, type HttpFetch } from "../../src/sms/twilio-sms.js";

describe("twilioSmsTransport", () => {
  const accountSid = "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  const authToken = "your_auth_token_secret_do_not_leak";
  const messagingServiceSid = "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

  function createMockFetch(
    responseStatus: number,
    responseBody: string
  ): { fetch: HttpFetch; calls: Array<{ url: string; init: any }> } {
    const calls: Array<{ url: string; init: any }> = [];

    const fetch: HttpFetch = async (url, init) => {
      calls.push({ url, init });

      return {
        status: responseStatus,
        headers: {
          get: (name: string) => {
            if (name.toLowerCase() === "retry-after") return "60";
            return null;
          },
        },
        text: async () => responseBody,
      };
    };

    return { fetch, calls };
  }

  describe("success cases", () => {
    it("returns ok with providerMsgId when status is 2xx and sid is present", async () => {
      const { fetch } = createMockFetch(
        200,
        JSON.stringify({
          sid: "SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          status: "sent",
        })
      );

      const transport = twilioSmsTransport({
        fetch,
        accountSid,
        authToken,
        messagingServiceSid,
      });

      const result = await transport.send({
        to: "+27821234567",
        body: "Hello, world!",
      });

      expect(result).toEqual({
        ok: true,
        providerMsgId: "SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        status: "sent",
      });
    });

    it("handles 201 Created response with sid", async () => {
      const { fetch } = createMockFetch(
        201,
        JSON.stringify({
          sid: "SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        })
      );

      const transport = twilioSmsTransport({
        fetch,
        accountSid,
        authToken,
        messagingServiceSid,
      });

      const result = await transport.send({
        to: "+1234567890",
        body: "Test message",
      });

      expect(result.ok).toBe(true);
      expect((result as any).providerMsgId).toBe("SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    });
  });

  describe("rate limit and server errors", () => {
    it("returns retry kind for 429 rate limit", async () => {
      const { fetch } = createMockFetch(
        429,
        JSON.stringify({
          code: 20429,
          message: "Too Many Requests",
        })
      );

      const transport = twilioSmsTransport({
        fetch,
        accountSid,
        authToken,
        messagingServiceSid,
      });

      const result = await transport.send({
        to: "+27821234567",
        body: "Test message",
      });

      expect(result).toEqual({
        ok: false,
        kind: "retry",
        error: "Twilio rate limit exceeded",
      });
    });

    it("returns retry kind for 500 server error", async () => {
      const { fetch } = createMockFetch(
        500,
        JSON.stringify({
          code: 20000,
          message: "Internal Server Error",
        })
      );

      const transport = twilioSmsTransport({
        fetch,
        accountSid,
        authToken,
        messagingServiceSid,
      });

      const result = await transport.send({
        to: "+27821234567",
        body: "Test message",
      });

      expect(result).toEqual({
        ok: false,
        kind: "retry",
        error: "Twilio server error (HTTP 500)",
      });
    });

    it("returns retry kind for 503 service unavailable", async () => {
      const { fetch } = createMockFetch(
        503,
        JSON.stringify({
          message: "Service Unavailable",
        })
      );

      const transport = twilioSmsTransport({
        fetch,
        accountSid,
        authToken,
        messagingServiceSid,
      });

      const result = await transport.send({
        to: "+27821234567",
        body: "Test",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe("retry");
      }
    });
  });

  describe("client errors (4xx)", () => {
    it("returns rejected kind for 400 bad request with error code", async () => {
      const { fetch } = createMockFetch(
        400,
        JSON.stringify({
          code: 21211,
          message: "The 'To' number +27821234567 is not a valid phone number.",
        })
      );

      const transport = twilioSmsTransport({
        fetch,
        accountSid,
        authToken,
        messagingServiceSid,
      });

      const result = await transport.send({
        to: "+27821234567",
        body: "Test",
      });

      expect(result).toEqual({
        ok: false,
        kind: "rejected",
        error: "Twilio error 21211: The 'To' number +27821234567 is not a valid phone number.",
      });
    });

    it("handles 401 unauthorized", async () => {
      const { fetch } = createMockFetch(
        401,
        JSON.stringify({
          code: 20003,
          message: "Authentication Error",
        })
      );

      const transport = twilioSmsTransport({
        fetch,
        accountSid,
        authToken,
        messagingServiceSid,
      });

      const result = await transport.send({
        to: "+27821234567",
        body: "Test",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe("rejected");
        expect(result.error).toContain("20003");
      }
    });

    it("handles 4xx error without detailed JSON response", async () => {
      const { fetch } = createMockFetch(404, "Not Found");

      const transport = twilioSmsTransport({
        fetch,
        accountSid,
        authToken,
        messagingServiceSid,
      });

      const result = await transport.send({
        to: "+27821234567",
        body: "Test",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe("rejected");
        expect(result.error).toContain("HTTP 404");
      }
    });
  });

  describe("network errors", () => {
    it("returns retry kind when fetch throws error", async () => {
      const fetch: HttpFetch = async () => {
        throw new Error("Network timeout");
      };

      const transport = twilioSmsTransport({
        fetch,
        accountSid,
        authToken,
        messagingServiceSid,
      });

      const result = await transport.send({
        to: "+27821234567",
        body: "Test",
      });

      expect(result).toEqual({
        ok: false,
        kind: "retry",
        error: "Network error contacting Twilio: Network timeout",
      });
    });

    it("handles fetch rejection gracefully", async () => {
      const fetch: HttpFetch = async () => {
        throw new Error("ECONNREFUSED");
      };

      const transport = twilioSmsTransport({
        fetch,
        accountSid,
        authToken,
        messagingServiceSid,
      });

      const result = await transport.send({
        to: "+27821234567",
        body: "Test",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe("retry");
        expect(result.error).toContain("ECONNREFUSED");
      }
    });
  });

  describe("invalid Messaging Service SID", () => {
    it("returns config error for invalid SID format", async () => {
      const fetch: HttpFetch = vi.fn();

      const transport = twilioSmsTransport({
        fetch,
        accountSid,
        authToken,
        messagingServiceSid: "INVALID_SID",
      });

      const result = await transport.send({
        to: "+27821234567",
        body: "Test",
      });

      expect(result).toEqual({
        ok: false,
        kind: "config",
        error: expect.stringContaining("Invalid Twilio Messaging Service SID"),
      });

      // Fetch should not have been called since validation happens first
      expect(fetch).not.toHaveBeenCalled();
    });

    it("returns config error for SID that doesn't start with MG", async () => {
      const fetch: HttpFetch = vi.fn();

      const transport = twilioSmsTransport({
        fetch,
        accountSid,
        authToken,
        messagingServiceSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", // Starts with AC, not MG
      });

      const result = await transport.send({
        to: "+27821234567",
        body: "Test",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe("config");
      }
      expect(fetch).not.toHaveBeenCalled();
    });

    it("rejects SID shorter than MG + 32 chars", async () => {
      const fetch: HttpFetch = vi.fn();

      const transport = twilioSmsTransport({
        fetch,
        accountSid,
        authToken,
        messagingServiceSid: "MGtooShort",
      });

      const result = await transport.send({
        to: "+27821234567",
        body: "Test",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe("config");
      }
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe("request format validation", () => {
    it("sends correct POST request to Twilio API endpoint", async () => {
      const { fetch, calls } = createMockFetch(200, JSON.stringify({ sid: "SM123" }));

      const transport = twilioSmsTransport({
        fetch,
        accountSid,
        authToken,
        messagingServiceSid,
      });

      await transport.send({
        to: "+27821234567",
        body: "Hello",
      });

      expect(calls).toHaveLength(1);
      const call = calls[0];

      expect(call.url).toContain("https://api.twilio.com/2010-04-01/Accounts");
      expect(call.url).toContain(accountSid);
      expect(call.init.method).toBe("POST");
    });

    it("includes correct Authorization header with Basic auth", async () => {
      const { fetch, calls } = createMockFetch(200, JSON.stringify({ sid: "SM123" }));

      const transport = twilioSmsTransport({
        fetch,
        accountSid,
        authToken,
        messagingServiceSid,
      });

      await transport.send({
        to: "+27821234567",
        body: "Hello",
      });

      const authHeader = calls[0].init.headers.Authorization;
      expect(authHeader).toMatch(/^Basic /);

      // Decode and verify the auth header contains accountSid:authToken
      const decoded = Buffer.from(authHeader.replace(/^Basic /, ""), "base64").toString("utf-8");
      expect(decoded).toBe(`${accountSid}:${authToken}`);
    });

    it("sends form-encoded body with To, Body, and MessagingServiceSid", async () => {
      const { fetch, calls } = createMockFetch(200, JSON.stringify({ sid: "SM123" }));

      const transport = twilioSmsTransport({
        fetch,
        accountSid,
        authToken,
        messagingServiceSid,
      });

      const phoneNumber = "+27821234567";
      const messageBody = "Test message with special chars: & = %";

      await transport.send({
        to: phoneNumber,
        body: messageBody,
      });

      const body = calls[0].init.body;
      expect(body).toContain("To=");
      expect(body).toContain("Body=");
      expect(body).toContain("MessagingServiceSid=");

      // Verify form encoding (special characters should be escaped)
      expect(body).toContain(encodeURIComponent(phoneNumber));
      expect(body).toContain(encodeURIComponent(messagingServiceSid));
    });

    it("sets Content-Type header to application/x-www-form-urlencoded", async () => {
      const { fetch, calls } = createMockFetch(200, JSON.stringify({ sid: "SM123" }));

      const transport = twilioSmsTransport({
        fetch,
        accountSid,
        authToken,
        messagingServiceSid,
      });

      await transport.send({
        to: "+27821234567",
        body: "Test",
      });

      expect(calls[0].init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    });
  });

  describe("security and error handling", () => {
    it("never leaks auth token in error messages on network failure", async () => {
      const fetch: HttpFetch = async () => {
        throw new Error("Connection refused");
      };

      const transport = twilioSmsTransport({
        fetch,
        accountSid,
        authToken: "super_secret_token_12345",
        messagingServiceSid,
      });

      const result = await transport.send({
        to: "+27821234567",
        body: "Test",
      });

      expect((result as any).error).not.toContain("super_secret_token");
      expect((result as any).error).not.toContain(authToken);
    });

    it("never leaks auth token in error messages on API failure", async () => {
      const { fetch } = createMockFetch(
        400,
        JSON.stringify({
          code: 21211,
          message: "Invalid number",
        })
      );

      const transport = twilioSmsTransport({
        fetch,
        accountSid,
        authToken: "secret_key_xyz",
        messagingServiceSid,
      });

      const result = await transport.send({
        to: "+27821234567",
        body: "Test",
      });

      expect((result as any).error).not.toContain("secret_key_xyz");
      expect((result as any).error).not.toContain(authToken);
    });

    it("handles 2xx response without sid as config error", async () => {
      const { fetch } = createMockFetch(
        200,
        JSON.stringify({
          status: "queued",
          // Missing 'sid' field
        })
      );

      const transport = twilioSmsTransport({
        fetch,
        accountSid,
        authToken,
        messagingServiceSid,
      });

      const result = await transport.send({
        to: "+27821234567",
        body: "Test",
      });

      expect(result).toEqual({
        ok: false,
        kind: "config",
        error: "Twilio accepted the request but returned no message SID",
      });
    });

    it("handles non-JSON response gracefully", async () => {
      const { fetch } = createMockFetch(200, "Invalid JSON {{{");

      const transport = twilioSmsTransport({
        fetch,
        accountSid,
        authToken,
        messagingServiceSid,
      });

      const result = await transport.send({
        to: "+27821234567",
        body: "Test",
      });

      // Since there's no sid in the JSON, should fail
      expect(result.ok).toBe(false);
    });
  });
});
