import { describe, it, expect } from "vitest";
import { createTwilioClient, classifyTwilioFailure, type HttpFetch } from "../src/twilio-client.js";

const VALID_ACCOUNT_SID = "AC" + "a".repeat(32);
const VALID_TOKEN = "test-token";

describe("Twilio Client", () => {
  it("(a) builds Authorization header correctly and uses right URL", async () => {
    let capturedAuth: string | undefined;
    let capturedUrl: string | undefined;

    const fetch: HttpFetch = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      capturedUrl = url;
      capturedAuth = init?.headers?.Authorization;
      return { status: 201, ok: true, headers: {}, text: async () => JSON.stringify({ sid: "SMaaaaa", status: "queued" }) };
    };

    const client = createTwilioClient({ accountSid: VALID_ACCOUNT_SID, authToken: VALID_TOKEN, fetch });
    const result = await client.sendMessage({ from: "whatsapp:+27123", to: "whatsapp:+27456", body: "Hello" });

    expect(result.ok).toBe(true);
    expect(capturedUrl).toContain(VALID_ACCOUNT_SID);
    expect(capturedAuth).toMatch(/^Basic /);
  });

  it("(b) sendMessage posts expected form body and returns SID", async () => {
    let capturedBody: string | undefined;

    const fetch: HttpFetch = async (url: string, init?: any) => {
      capturedBody = init?.body;
      return { status: 201, ok: true, headers: {}, text: async () => JSON.stringify({ sid: "SMtest123", status: "queued" }) };
    };

    const client = createTwilioClient({ accountSid: VALID_ACCOUNT_SID, authToken: VALID_TOKEN, fetch });
    const result = await client.sendMessage({ from: "whatsapp:+27123", to: "whatsapp:+27456", body: "Test message" });

    expect(result.ok).toBe(true);
    expect((result as any).value.sid).toBe("SMtest123");
    expect(capturedBody).toContain("From=whatsapp");
    expect(capturedBody).toContain("To=whatsapp");
    expect(capturedBody).toContain("Body=Test+message");
  });

  it("(c) sendMessage never retries on 5xx/timeout, timeout classified correctly", async () => {
    let callCount = 0;
    const fetch: HttpFetch = async () => {
      callCount++;
      throw new Error("Timeout");
    };

    const client = createTwilioClient({ accountSid: VALID_ACCOUNT_SID, authToken: VALID_TOKEN, fetch, timeoutMs: 10 });
    const result = await client.sendMessage({ from: "whatsapp:+27123", to: "whatsapp:+27456", body: "Test" });

    expect(callCount).toBe(1);
    expect(result.ok).toBe(false);
    expect((result as any).failure.kind).toBe("timeout");
  });

  it("(d) classifies 4xx errors correctly", () => {
    expect(classifyTwilioFailure(400, { message: "Bad", code: 63016 }).kind).toBe("rejected");
    expect(classifyTwilioFailure(401, { message: "Unauthorized" }).kind).toBe("auth");
    expect(classifyTwilioFailure(403, { message: "Forbidden" }).kind).toBe("rejected");
    expect(classifyTwilioFailure(429, { message: "Rate limited" }).kind).toBe("rate_limited");
  });

  it("(e) truncates error messages to 300 chars", () => {
    const longMsg = "x".repeat(400);
    const failure = classifyTwilioFailure(500, { message: longMsg });
    expect(failure.error.length).toBeLessThanOrEqual(300);
    expect(failure.error).toBe("x".repeat(300));
  });

  it("(f) lists content templates and parses approval status", async () => {
    const fetch: HttpFetch = async (url: string) => {
      if (url.includes("/Content?")) {
        return {
          status: 200,
          ok: true,
          headers: {},
          text: async () =>
            JSON.stringify({
              contents: [
                {
                  sid: "HT12345678901234567890123456789",
                  friendly_name: "Greeting",
                  language: "en",
                  types: { twilio_whatsapp: { body: "Hello {{1}}!" } },
                },
              ],
              meta: { next_page_url: null },
            }),
        };
      }
      if (url.includes("/ApprovalRequests")) {
        return {
          status: 200,
          ok: true,
          headers: {},
          text: async () => JSON.stringify({ requests: [{ whatsapp: { status: "approved" } }] }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const client = createTwilioClient({ accountSid: VALID_ACCOUNT_SID, authToken: VALID_TOKEN, fetch });
    const templates = await client.listContentTemplates();
    expect(templates.ok).toBe(true);
    expect((templates as any).value[0].friendlyName).toBe("Greeting");

    const status = await client.getApprovalStatus("HT12345678901234567890123456789");
    expect(status.ok).toBe(true);
    expect((status as any).value).toBe("approved");
  });

  it("(g) accountSid validation rejects bad shapes without echoing value", () => {
    const badSids = ["invalid", "AC" + "g".repeat(32), "AC12"];
    for (const badSid of badSids) {
      expect(() =>
        createTwilioClient({
          accountSid: badSid,
          authToken: VALID_TOKEN,
          fetch: async () => ({ status: 200, ok: true, headers: {}, text: async () => "{}" }),
        })
      ).toThrow("Invalid accountSid format");
      try {
        createTwilioClient({
          accountSid: badSid,
          authToken: VALID_TOKEN,
          fetch: async () => ({ status: 200, ok: true, headers: {}, text: async () => "{}" }),
        });
        expect.fail("Should have thrown");
      } catch (err) {
        expect((err as Error).message).not.toContain(badSid);
      }
    }
  });
});
