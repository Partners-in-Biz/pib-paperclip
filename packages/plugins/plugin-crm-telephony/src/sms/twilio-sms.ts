/**
 * Twilio SMS transport implementation.
 *
 * Sends SMS via Twilio's Messaging Service API using Basic auth and form-encoded requests.
 * See: https://www.twilio.com/docs/sms/send-messages
 */

import { SmsTransportResult, SmsTransport } from "./types.js";

/**
 * The signature of a fetch function compatible with ctx.http.fetch.
 * Returns a response-like object with status, headers.get(), and text().
 */
export type HttpFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  }
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/**
 * Dependencies for the Twilio SMS transport.
 */
export interface TwilioSmsTransportDeps {
  fetch: HttpFetch;
  accountSid: string;
  authToken: string;
  messagingServiceSid: string;
}

/**
 * Encodes a string for application/x-www-form-urlencoded.
 */
function encodeFormData(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

/**
 * Creates a Twilio SMS transport.
 *
 * Sends SMS via POST https://api.twilio.com/2010-04-01/Accounts/{accountSid}/Messages.json
 * with To, Body, MessagingServiceSid, and Basic auth header (base64 accountSid:authToken).
 *
 * Maps outcomes:
 * - 2xx with `sid` in JSON → ok {providerMsgId: sid, status}
 * - 429/5xx/network error → {kind: 'retry', error: message}
 * - 4xx (except certain codes) → {kind: 'rejected', error: message}
 * - messagingServiceSid not matching /^MG[0-9a-zA-Z]{20,}$/ → {kind: 'config', error: message}
 *
 * Auth token is NEVER included in error strings.
 */
export function twilioSmsTransport(deps: TwilioSmsTransportDeps): SmsTransport {
  const { fetch, accountSid, authToken, messagingServiceSid } = deps;

  // Validate messagingServiceSid format (must be MG followed by at least 20 alphanumeric chars)
  if (!/^MG[0-9a-zA-Z]{20,}$/.test(messagingServiceSid)) {
    return {
      async send() {
        return {
          ok: false,
          kind: "config",
          error: `Invalid Twilio Messaging Service SID format. Expected MG followed by alphanumeric characters, got: ${messagingServiceSid.substring(0, 4)}...`,
        };
      },
    };
  }

  const apiUrl = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
  const authHeader = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;

  return {
    async send(args: { to: string; body: string }): Promise<SmsTransportResult> {
      try {
        // Build form-encoded body
        const formBody = [
          `To=${encodeFormData(args.to)}`,
          `Body=${encodeFormData(args.body)}`,
          `MessagingServiceSid=${encodeFormData(messagingServiceSid)}`,
        ].join("&");

        // Make the request
        const response = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: authHeader,
          },
          body: formBody,
        });

        const responseText = await response.text();

        // Try to parse as JSON for error details
        let responseJson: unknown;
        try {
          responseJson = JSON.parse(responseText);
        } catch {
          responseJson = null;
        }

        // Success: 2xx with sid
        if (response.status >= 200 && response.status < 300) {
          const json = responseJson && typeof responseJson === "object" ? responseJson : {};
          const sid = (json as Record<string, unknown>).sid;
          if (typeof sid === "string" && sid.length > 0) {
            return {
              ok: true,
              providerMsgId: sid,
              status: "sent",
            };
          }
          // 2xx but no sid is a configuration problem
          return {
            ok: false,
            kind: "config",
            error: "Twilio accepted the request but returned no message SID",
          };
        }

        // 429: rate limit, should retry
        if (response.status === 429) {
          return {
            ok: false,
            kind: "retry",
            error: "Twilio rate limit exceeded",
          };
        }

        // 5xx: server error, should retry
        if (response.status >= 500 && response.status < 600) {
          return {
            ok: false,
            kind: "retry",
            error: `Twilio server error (HTTP ${response.status})`,
          };
        }

        // 4xx: client error, likely permanent (except rate limit which is 429 above)
        if (response.status >= 400 && response.status < 500) {
          // Extract error details from Twilio's response
          const json = responseJson && typeof responseJson === "object" ? responseJson : {};
          const code = (json as Record<string, unknown>).code;
          const message = (json as Record<string, unknown>).message;

          const errorMsg =
            typeof code === "number" && typeof message === "string"
              ? `Twilio error ${code}: ${message}`
              : `Twilio error (HTTP ${response.status})`;

          return {
            ok: false,
            kind: "rejected",
            error: errorMsg,
          };
        }

        // Unexpected status code
        return {
          ok: false,
          kind: "rejected",
          error: `Unexpected Twilio response (HTTP ${response.status})`,
        };
      } catch (error) {
        // Network error or other failure
        const errorMsg = error instanceof Error ? error.message : String(error);
        // Never log the auth token or request body
        return {
          ok: false,
          kind: "retry",
          error: `Network error contacting Twilio: ${errorMsg}`,
        };
      }
    },
  };
}
