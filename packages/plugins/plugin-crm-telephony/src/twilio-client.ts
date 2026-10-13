/**
 * Twilio Content API client for WhatsApp messaging.
 *
 * Implements message sending, content template listing, and approval status checks.
 */

export type HttpFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ status: number; ok?: boolean; headers?: any; text(): Promise<string>; json?(): Promise<unknown> }>;

export type TwilioFailureKind = "rate_limited" | "auth" | "rejected" | "retryable" | "timeout" | "unknown";

export interface TwilioFailure {
  kind: TwilioFailureKind;
  status: number | null;
  code: number | null;
  error: string;
  retryAfterSeconds?: number;
}

export type TwilioResult<T> = { ok: true; value: T } | { ok: false; failure: TwilioFailure };

export interface TwilioClientOptions {
  accountSid: string;
  authToken: string;
  fetch: HttpFetch;
  timeoutMs?: number; // default 15000
}

export interface SendMessageInput {
  from: string; // 'whatsapp:+27...'
  to: string; // 'whatsapp:+27...'
  body?: string;
  contentSid?: string;
  contentVariables?: Record<string, string>;
  statusCallback?: string;
}

export interface SentMessage {
  sid: string;
  status: string;
}

export interface ContentTemplate {
  sid: string;
  friendlyName: string;
  language: string;
  bodyPreview: string;
}

export type ApprovalStatus = "approved" | "pending" | "rejected" | "unsubmitted" | "unknown";

export interface TwilioClient {
  sendMessage(i: SendMessageInput): Promise<TwilioResult<SentMessage>>;
  listContentTemplates(): Promise<TwilioResult<ContentTemplate[]>>;
  getApprovalStatus(contentSid: string): Promise<TwilioResult<ApprovalStatus>>;
}

const DEFAULT_TIMEOUT_MS = 15000;

function encodeFormData(data: Record<string, string | null | undefined>): string {
  return Object.entries(data)
    .filter(([, v]) => v != null)
    .map(([k, v]) => {
      const encoded = encodeURIComponent(v as string).replace(/%20/g, "+");
      return `${encodeURIComponent(k)}=${encoded}`;
    })
    .join("&");
}

function toBase64(str: string): string {
  return Buffer.from(str, "utf-8").toString("base64");
}

function short(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 300);
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Classifies Twilio API errors into actionable failure kinds.
 * Never includes the auth token in error strings.
 */
export function classifyTwilioFailure(
  status: number,
  body: unknown,
  retryAfter?: string | null
): TwilioFailure {
  const b = obj(body);
  const code = typeof b.code === "number" ? b.code : null;
  const message = short(
    typeof b.message === "string" ? b.message : status ? `Twilio answered HTTP ${status}` : "Twilio did not answer"
  );
  const seconds = retryAfter && /^\d+(\.\d+)?$/.test(retryAfter.trim())
    ? Math.ceil(Number(retryAfter))
    : undefined;

  const base = { status, code, error: message, retryAfterSeconds: seconds };

  // 429 with Retry-After: rate limited
  if (status === 429) {
    return { kind: "rate_limited", ...base };
  }

  // 401: auth failure
  if (status === 401) {
    return { kind: "auth", ...base };
  }

  // 400 with specific codes: rejected message (content not approved, etc.)
  if (status === 400) {
    // Code 63016 is "ContentSid not approved"
    if (code === 63016) {
      return { kind: "rejected", ...base };
    }
    return { kind: "rejected", ...base };
  }

  // 500+: retryable server errors
  if (status >= 500) {
    return { kind: "retryable", ...base };
  }

  // Any other 4xx: rejected
  if (status >= 400) {
    return { kind: "rejected", ...base };
  }

  // Unknown error
  return { kind: "unknown", ...base };
}

export function createTwilioClient(opts: TwilioClientOptions): TwilioClient {
  const { accountSid, authToken, fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

  const basicAuth = toBase64(`${accountSid}:${authToken}`);

  async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(new Error("Timeout")),
          ms
        )
      ),
    ]);
  }

  async function sendMessage(input: SendMessageInput): Promise<TwilioResult<SentMessage>> {
    try {
      const formData: Record<string, string | null | undefined> = {
        From: input.from,
        To: input.to,
        StatusCallback: input.statusCallback || null,
      };

      if (input.body) {
        formData.Body = input.body;
      } else if (input.contentSid) {
        formData.ContentSid = input.contentSid;
        if (input.contentVariables && Object.keys(input.contentVariables).length > 0) {
          formData.ContentVariables = JSON.stringify(input.contentVariables);
        }
      }

      const response = await withTimeout(
        fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
          method: "POST",
          headers: {
            Authorization: `Basic ${basicAuth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: encodeFormData(formData),
        }),
        timeoutMs
      );

      const text = await response.text();

      if (response.ok) {
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          return {
            ok: false,
            failure: {
              kind: "unknown",
              status: response.status,
              code: null,
              error: "Invalid JSON response from Twilio",
            },
          };
        }

        if (typeof data.sid === "string" && typeof data.status === "string") {
          return {
            ok: true,
            value: { sid: data.sid, status: data.status },
          };
        }

        return {
          ok: false,
          failure: {
            kind: "unknown",
            status: response.status,
            code: null,
            error: "Response missing sid or status",
          },
        };
      }

      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: text };
      }

      const retryAfter = response.headers?.get?.("retry-after");
      return {
        ok: false,
        failure: classifyTwilioFailure(response.status, body, retryAfter),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (message === "Timeout") {
        return {
          ok: false,
          failure: {
            kind: "timeout",
            status: null,
            code: null,
            error: "Request timeout",
          },
        };
      }
      return {
        ok: false,
        failure: {
          kind: "unknown",
          status: null,
          code: null,
          error: message,
        },
      };
    }
  }

  async function listContentTemplates(): Promise<TwilioResult<ContentTemplate[]>> {
    try {
      const templates: ContentTemplate[] = [];
      let nextUrl: string | null = "https://content.twilio.com/v1/Content?PageSize=100";
      let pageCount = 0;

      while (nextUrl && pageCount < 5) {
        pageCount++;

        const response = await withTimeout(
          fetch(nextUrl, {
            method: "GET",
            headers: {
              Authorization: `Basic ${basicAuth}`,
            },
          }),
          timeoutMs
        );

        const text = await response.text();

        if (!response.ok) {
          let body;
          try {
            body = JSON.parse(text);
          } catch {
            body = { message: text };
          }
          const retryAfter = response.headers?.get?.("retry-after");
          return {
            ok: false,
            failure: classifyTwilioFailure(response.status, body, retryAfter),
          };
        }

        let data;
        try {
          data = JSON.parse(text);
        } catch {
          return {
            ok: false,
            failure: {
              kind: "unknown",
              status: response.status,
              code: null,
              error: "Invalid JSON response from Twilio",
            },
          };
        }

        if (Array.isArray(data.contents)) {
          for (const item of data.contents) {
            if (typeof item.sid === "string" && typeof item.friendly_name === "string") {
              const types = item.types || {};
              let bodyPreview = "";

              if (typeof types.twilio_whatsapp === "object" && types.twilio_whatsapp !== null) {
                const wa = types.twilio_whatsapp as Record<string, unknown>;
                if (typeof wa.body === "string") {
                  bodyPreview = wa.body;
                }
              }

              templates.push({
                sid: item.sid,
                friendlyName: item.friendly_name,
                language: typeof item.language === "string" ? item.language : "",
                bodyPreview,
              });
            }
          }
        }

        nextUrl = typeof data.meta?.next_page_url === "string" ? data.meta.next_page_url : null;
      }

      return {
        ok: true,
        value: templates,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (message === "Timeout") {
        return {
          ok: false,
          failure: {
            kind: "timeout",
            status: null,
            code: null,
            error: "Request timeout",
          },
        };
      }
      return {
        ok: false,
        failure: {
          kind: "unknown",
          status: null,
          code: null,
          error: message,
        },
      };
    }
  }

  async function getApprovalStatus(contentSid: string): Promise<TwilioResult<ApprovalStatus>> {
    try {
      const response = await withTimeout(
        fetch(`https://content.twilio.com/v1/Content/${contentSid}/ApprovalRequests`, {
          method: "GET",
          headers: {
            Authorization: `Basic ${basicAuth}`,
          },
        }),
        timeoutMs
      );

      const text = await response.text();

      if (!response.ok) {
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          body = { message: text };
        }
        const retryAfter = response.headers?.get?.("retry-after");
        return {
          ok: false,
          failure: classifyTwilioFailure(response.status, body, retryAfter),
        };
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return {
          ok: false,
          failure: {
            kind: "unknown",
            status: response.status,
            code: null,
            error: "Invalid JSON response from Twilio",
          },
        };
      }

      // The response contains whatsapp approval requests in an array
      // We look for the whatsapp approval status
      if (Array.isArray(data.requests) && data.requests.length > 0) {
        const request = data.requests[0] as Record<string, unknown>;
        const waApproval = request.whatsapp as Record<string, unknown> | undefined;

        if (waApproval && typeof waApproval.status === "string") {
          const status = waApproval.status.toLowerCase();
          if (["approved", "pending", "rejected", "unsubmitted"].includes(status)) {
            return {
              ok: true,
              value: status as ApprovalStatus,
            };
          }
        }
      }

      return {
        ok: true,
        value: "unknown",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (message === "Timeout") {
        return {
          ok: false,
          failure: {
            kind: "timeout",
            status: null,
            code: null,
            error: "Request timeout",
          },
        };
      }
      return {
        ok: false,
        failure: {
          kind: "unknown",
          status: null,
          code: null,
          error: message,
        },
      };
    }
  }

  return {
    sendMessage,
    listContentTemplates,
    getApprovalStatus,
  };
}
