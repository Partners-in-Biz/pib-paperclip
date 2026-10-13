import { describe, expect, it } from "vitest";
import {
  createTwilioClient,
  classifyTwilioFailure,
  type HttpFetch,
  type SendMessageInput,
} from "../src/twilio-client.js";

const ACCOUNT_SID = "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const AUTH_TOKEN = "your_auth_token_here_secret123456";
const BASIC_AUTH = "Basic " + Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64");

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function fakeFetch(
  answers: Array<{ status: number; body?: unknown; headers?: Record<string, string> } | Error>
) {
  const calls: Call[] = [];
  const queue = [...answers];

  const fetch: HttpFetch = async (url, init) => {
    const body = init?.body ?? null;
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body,
    });

    const next = queue.shift() ?? { status: 200, body: {} };
    if (next instanceof Error) throw next;

    return {
      ok: next.status < 400,
      status: next.status,
      headers: {
        get: (name: string) => next.headers?.[name.toLowerCase()] ?? null,
      },
      text: async () => (next.body === undefined ? "" : JSON.stringify(next.body)),
      json: async () => next.body,
    };
  };

  return { fetch, calls };
}

describe("Twilio Client: sendMessage", () => {
  it("POSTs to the messages endpoint with form-encoded body and Basic auth", async () => {
    const { fetch, calls } = fakeFetch([
      {
        status: 201,
        body: { sid: "SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", status: "queued" },
      },
    ]);

    const client = createTwilioClient({
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      fetch,
    });

    const input: SendMessageInput = {
      from: "whatsapp:+27821234567",
      to: "whatsapp:+27819876543",
      body: "Hello World",
    };

    const result = await client.sendMessage(input);

    expect(result).toEqual({
      ok: true,
      value: { sid: "SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", status: "queued" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      headers: {
        Authorization: BASIC_AUTH,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    // Verify form-encoded body
    const bodyStr = calls[0]!.body;
    expect(bodyStr).toBeTruthy();
    expect(bodyStr!).toContain("From=whatsapp%3A%2B27821234567");
    expect(bodyStr!).toContain("To=whatsapp%3A%2B27819876543");
    expect(bodyStr!).toContain("Body=Hello+World");
  });

  it("serializes ContentVariables as JSON in the form body when ContentSid is used", async () => {
    const { fetch, calls } = fakeFetch([
      {
        status: 201,
        body: { sid: "SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", status: "queued" },
      },
    ]);

    const client = createTwilioClient({
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      fetch,
    });

    const input: SendMessageInput = {
      from: "whatsapp:+27821234567",
      to: "whatsapp:+27819876543",
      contentSid: "HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      contentVariables: { name: "Alice", greeting: "Hello" },
    };

    const result = await client.sendMessage(input);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);

    const bodyStr = calls[0]!.body;
    expect(bodyStr).toBeTruthy();
    expect(bodyStr!).toContain("ContentSid=HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(bodyStr!).toContain("ContentVariables=");
    // Extract and parse the ContentVariables value
    const match = bodyStr!.match(/ContentVariables=([^&]+)/);
    expect(match).toBeTruthy();
    const encodedJson = match![1];
    const decodedJson = decodeURIComponent(encodedJson);
    const parsed = JSON.parse(decodedJson);
    expect(parsed).toEqual({ name: "Alice", greeting: "Hello" });
  });

  it("includes statusCallback when provided", async () => {
    const { fetch, calls } = fakeFetch([
      {
        status: 201,
        body: { sid: "SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", status: "queued" },
      },
    ]);

    const client = createTwilioClient({
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      fetch,
    });

    const input: SendMessageInput = {
      from: "whatsapp:+27821234567",
      to: "whatsapp:+27819876543",
      body: "Hello",
      statusCallback: "https://example.com/callback",
    };

    await client.sendMessage(input);

    const bodyStr = calls[0]!.body;
    expect(bodyStr).toBeTruthy();
    expect(bodyStr!).toContain("StatusCallback=https%3A%2F%2Fexample.com%2Fcallback");
  });

  it("handles 429 rate limiting with Retry-After", async () => {
    const { fetch } = fakeFetch([
      {
        status: 429,
        body: { message: "Too many requests" },
        headers: { "retry-after": "60" },
      },
    ]);

    const client = createTwilioClient({
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      fetch,
    });

    const result = await client.sendMessage({
      from: "whatsapp:+27821234567",
      to: "whatsapp:+27819876543",
      body: "Hello",
    });

    expect(result).toEqual({
      ok: false,
      failure: {
        kind: "rate_limited",
        status: 429,
        code: null,
        error: "Too many requests",
        retryAfterSeconds: 60,
      },
    });
  });

  it("handles 401 auth failure", async () => {
    const { fetch } = fakeFetch([
      {
        status: 401,
        body: { message: "Unauthorized" },
      },
    ]);

    const client = createTwilioClient({
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      fetch,
    });

    const result = await client.sendMessage({
      from: "whatsapp:+27821234567",
      to: "whatsapp:+27819876543",
      body: "Hello",
    });

    expect(result).toEqual({
      ok: false,
      failure: {
        kind: "auth",
        status: 401,
        code: null,
        error: "Unauthorized",
      },
    });
  });

  it("handles 400 with code 63016 as rejected", async () => {
    const { fetch } = fakeFetch([
      {
        status: 400,
        body: { code: 63016, message: "ContentSid not approved" },
      },
    ]);

    const client = createTwilioClient({
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      fetch,
    });

    const result = await client.sendMessage({
      from: "whatsapp:+27821234567",
      to: "whatsapp:+27819876543",
      contentSid: "HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    });

    expect(result).toEqual({
      ok: false,
      failure: {
        kind: "rejected",
        status: 400,
        code: 63016,
        error: "ContentSid not approved",
      },
    });
  });

  it("times out after the configured timeoutMs", async () => {
    const neverResponds: HttpFetch = () =>
      new Promise(() => {
        // Never resolves
      });

    const client = createTwilioClient({
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      fetch: neverResponds,
      timeoutMs: 10,
    });

    const result = await client.sendMessage({
      from: "whatsapp:+27821234567",
      to: "whatsapp:+27819876543",
      body: "Hello",
    });

    expect(result).toEqual({
      ok: false,
      failure: {
        kind: "timeout",
        status: null,
        code: null,
        error: "Request timeout",
      },
    });
  });

  it("does not log credentials in error handling", async () => {
    const { fetch, calls } = fakeFetch([
      {
        status: 401,
        body: { message: "Unauthorized" },
      },
    ]);

    const client = createTwilioClient({
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      fetch,
    });

    const result = await client.sendMessage({
      from: "whatsapp:+27821234567",
      to: "whatsapp:+27819876543",
      body: "Hello",
    });

    expect(result.ok).toBe(false);
    // Verify we sent the auth header correctly
    expect(calls[0]!.headers.Authorization).toBe(BASIC_AUTH);
    // But the error message doesn't contain the auth token or header value
    if (!result.ok) {
      const errorStr = JSON.stringify(result.failure);
      expect(errorStr).not.toContain(AUTH_TOKEN);
      // The error message should be the Twilio response message, not our auth header
      expect(result.failure.error).toBe("Unauthorized");
    }
  });
});

describe("Twilio Client: listContentTemplates", () => {
  it("GETs from the content endpoint and maps results", async () => {
    const { fetch, calls } = fakeFetch([
      {
        status: 200,
        body: {
          contents: [
            {
              sid: "HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
              friendly_name: "Welcome",
              language: "en",
              types: {
                twilio_whatsapp: {
                  body: "Welcome to {{company}}!",
                },
              },
            },
          ],
          meta: { next_page_url: null },
        },
      },
    ]);

    const client = createTwilioClient({
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      fetch,
    });

    const result = await client.listContentTemplates();

    expect(result).toEqual({
      ok: true,
      value: [
        {
          sid: "HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          friendlyName: "Welcome",
          language: "en",
          bodyPreview: "Welcome to {{company}}!",
        },
      ],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://content.twilio.com/v1/Content?PageSize=100",
      method: "GET",
      headers: {
        Authorization: BASIC_AUTH,
      },
    });
  });

  it("paginates up to 5 pages following meta.next_page_url", async () => {
    const { fetch, calls } = fakeFetch([
      {
        status: 200,
        body: {
          contents: [
            {
              sid: "HXaaa",
              friendly_name: "Template1",
              language: "en",
              types: { twilio_whatsapp: { body: "Body 1" } },
            },
          ],
          meta: { next_page_url: "https://content.twilio.com/v1/Content?PageSize=100&PageToken=page2" },
        },
      },
      {
        status: 200,
        body: {
          contents: [
            {
              sid: "HXbbb",
              friendly_name: "Template2",
              language: "en",
              types: { twilio_whatsapp: { body: "Body 2" } },
            },
          ],
          meta: { next_page_url: "https://content.twilio.com/v1/Content?PageSize=100&PageToken=page3" },
        },
      },
      {
        status: 200,
        body: {
          contents: [
            {
              sid: "HXccc",
              friendly_name: "Template3",
              language: "en",
              types: { twilio_whatsapp: { body: "Body 3" } },
            },
          ],
          meta: { next_page_url: null },
        },
      },
    ]);

    const client = createTwilioClient({
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      fetch,
    });

    const result = await client.listContentTemplates();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(3);
      expect(result.value.map((t) => t.sid)).toEqual(["HXaaa", "HXbbb", "HXccc"]);
    }

    expect(calls).toHaveLength(3);
    expect(calls[1]!.url).toBe("https://content.twilio.com/v1/Content?PageSize=100&PageToken=page2");
    expect(calls[2]!.url).toBe("https://content.twilio.com/v1/Content?PageSize=100&PageToken=page3");
  });

  it("stops pagination after 5 pages", async () => {
    const pages = Array.from({ length: 7 }, (_, i) => ({
      status: 200,
      body: {
        contents: [
          {
            sid: `HX${i}`,
            friendly_name: `Template${i}`,
            language: "en",
            types: { twilio_whatsapp: { body: `Body ${i}` } },
          },
        ],
        meta: {
          next_page_url: `https://content.twilio.com/v1/Content?PageSize=100&PageToken=page${i + 1}`,
        },
      },
    }));

    const { fetch, calls } = fakeFetch(pages);

    const client = createTwilioClient({
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      fetch,
    });

    const result = await client.listContentTemplates();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(5); // Only 5 pages
    }
    expect(calls).toHaveLength(5);
  });
});

describe("Twilio Client: getApprovalStatus", () => {
  it("GETs approval status and maps whatsapp.status", async () => {
    const { fetch, calls } = fakeFetch([
      {
        status: 200,
        body: {
          requests: [
            {
              whatsapp: {
                status: "approved",
              },
            },
          ],
        },
      },
    ]);

    const client = createTwilioClient({
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      fetch,
    });

    const result = await client.getApprovalStatus("HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");

    expect(result).toEqual({
      ok: true,
      value: "approved",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://content.twilio.com/v1/Content/HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/ApprovalRequests",
      method: "GET",
      headers: {
        Authorization: BASIC_AUTH,
      },
    });
  });

  it("maps all valid approval statuses", async () => {
    const statuses = ["approved", "pending", "rejected", "unsubmitted"] as const;

    for (const status of statuses) {
      const { fetch } = fakeFetch([
        {
          status: 200,
          body: {
            requests: [
              {
                whatsapp: {
                  status,
                },
              },
            ],
          },
        },
      ]);

      const client = createTwilioClient({
        accountSid: ACCOUNT_SID,
        authToken: AUTH_TOKEN,
        fetch,
      });

      const result = await client.getApprovalStatus("HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");

      expect(result).toEqual({ ok: true, value: status });
    }
  });

  it("returns unknown when status is unrecognized", async () => {
    const { fetch } = fakeFetch([
      {
        status: 200,
        body: {
          requests: [
            {
              whatsapp: {
                status: "processing",
              },
            },
          ],
        },
      },
    ]);

    const client = createTwilioClient({
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      fetch,
    });

    const result = await client.getApprovalStatus("HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");

    expect(result).toEqual({ ok: true, value: "unknown" });
  });

  it("handles API errors", async () => {
    const { fetch } = fakeFetch([
      {
        status: 401,
        body: { message: "Unauthorized" },
      },
    ]);

    const client = createTwilioClient({
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      fetch,
    });

    const result = await client.getApprovalStatus("HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");

    expect(result).toEqual({
      ok: false,
      failure: {
        kind: "auth",
        status: 401,
        code: null,
        error: "Unauthorized",
      },
    });
  });
});

describe("classifyTwilioFailure", () => {
  it("classifies 429 as rate_limited", () => {
    const failure = classifyTwilioFailure(429, { message: "Too many requests" });
    expect(failure.kind).toBe("rate_limited");
  });

  it("classifies 401 as auth", () => {
    const failure = classifyTwilioFailure(401, { message: "Unauthorized" });
    expect(failure.kind).toBe("auth");
  });

  it("classifies 400 with code 63016 as rejected", () => {
    const failure = classifyTwilioFailure(400, { code: 63016, message: "ContentSid not approved" });
    expect(failure.kind).toBe("rejected");
    expect(failure.code).toBe(63016);
  });

  it("classifies other 4xx as rejected", () => {
    const failure = classifyTwilioFailure(403, { message: "Forbidden" });
    expect(failure.kind).toBe("rejected");
  });

  it("classifies 5xx as retryable", () => {
    const failure = classifyTwilioFailure(500, { message: "Internal Server Error" });
    expect(failure.kind).toBe("retryable");
  });

  it("parses Retry-After header as seconds", () => {
    const failure = classifyTwilioFailure(429, { message: "Rate limited" }, "30");
    expect(failure.retryAfterSeconds).toBe(30);
  });

  it("rounds up fractional Retry-After seconds", () => {
    const failure = classifyTwilioFailure(429, { message: "Rate limited" }, "30.5");
    expect(failure.retryAfterSeconds).toBe(31);
  });

  it("ignores non-numeric Retry-After values", () => {
    const failure = classifyTwilioFailure(429, { message: "Rate limited" }, "Wed, 21 Oct 2026");
    expect(failure.retryAfterSeconds).toBeUndefined();
  });

  it("truncates long error messages from Twilio", () => {
    const longMessage = "A".repeat(500);
    const failure = classifyTwilioFailure(400, { message: longMessage });
    expect(failure.error.length).toBeLessThanOrEqual(300);
  });
});
