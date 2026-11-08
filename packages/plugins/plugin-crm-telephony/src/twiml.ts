/**
 * TwiML for an outbound call placed from the browser.
 *
 * The call is created with Twilio's REST API and rings the person's browser
 * (`client:<identity>`). When the browser answers, Twilio runs this TwiML and
 * dials the contact's number from the company's caller ID. Pure: no I/O.
 */

const E164 = /^\+[1-9]\d{6,14}$/;

/** Twilio accepts at most 4,000 characters of inline TwiML on a REST call. */
export const MAX_INLINE_TWIML_CHARS = 4000;

export interface DialTwimlInput {
  /** The contact's number, E.164. */
  to: string;
  /** The company's Twilio number for the contact's region, E.164. */
  callerId: string;
  /** Record both legs from the moment the contact answers. */
  record: boolean;
  /** Where Twilio posts the recording when it is ready (only used when `record` is true). */
  recordingStatusCallbackUrl?: string;
  /** Where Twilio posts the contact leg's status (ringing, answered, completed, busy, no-answer). */
  statusCallbackUrl?: string;
  /** Seconds to let the contact's phone ring before giving up. Default 30, range 5-120. */
  timeoutSeconds?: number;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function assertHttpsUrl(url: string, what: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${what} is not a valid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${what} must use http or https`);
  }
}

export function buildDialTwiml(input: DialTwimlInput): string {
  if (!E164.test(input.to)) throw new Error("to must be an E.164 number");
  if (!E164.test(input.callerId)) throw new Error("callerId must be an E.164 number");

  const timeout = Math.min(120, Math.max(5, Math.trunc(input.timeoutSeconds ?? 30)));

  const dialAttrs: string[] = [
    `callerId="${escapeXml(input.callerId)}"`,
    `answerOnBridge="true"`,
    `timeout="${timeout}"`,
  ];

  if (input.record) {
    dialAttrs.push(`record="record-from-answer-dual"`);
    if (input.recordingStatusCallbackUrl) {
      assertHttpsUrl(input.recordingStatusCallbackUrl, "recordingStatusCallbackUrl");
      dialAttrs.push(`recordingStatusCallback="${escapeXml(input.recordingStatusCallbackUrl)}"`);
      dialAttrs.push(`recordingStatusCallbackEvent="completed absent failed"`);
      dialAttrs.push(`recordingStatusCallbackMethod="POST"`);
    }
  }

  const numberAttrs: string[] = [];
  if (input.statusCallbackUrl) {
    assertHttpsUrl(input.statusCallbackUrl, "statusCallbackUrl");
    numberAttrs.push(`statusCallback="${escapeXml(input.statusCallbackUrl)}"`);
    numberAttrs.push(`statusCallbackEvent="initiated ringing answered completed"`);
    numberAttrs.push(`statusCallbackMethod="POST"`);
  }

  const number = numberAttrs.length > 0
    ? `<Number ${numberAttrs.join(" ")}>${escapeXml(input.to)}</Number>`
    : `<Number>${escapeXml(input.to)}</Number>`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Dial ${dialAttrs.join(" ")}>${number}</Dial></Response>`;

  if (twiml.length > MAX_INLINE_TWIML_CHARS) {
    throw new Error("TwiML is too long for an inline REST call");
  }
  return twiml;
}
