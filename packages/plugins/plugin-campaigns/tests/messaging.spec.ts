import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import {
  classifyTwilioFailure,
  clearMessagingCache,
  defaultSender,
  messagingConfigFrom,
  messagingSetup,
  readinessOf,
  requestNeverSent,
  setMessagingProvider,
  TwilioProvider,
  type OutboundMessage,
} from "../src/messaging.js";
import { MockProvider } from "./helpers/mock-provider.js";

const SID = "AC" + "0123456789abcdef".repeat(2); // a fake account id built at runtime so secret scanners do not mistake the source for a real one
const TOKEN = "super-secret-token-value";
const MSG_SID = "SM0123456789abcdef0123456789abcdef";

const sms = (extra: Partial<OutboundMessage> = {}): OutboundMessage => ({ channel: "sms", to: "+27821234567", from: "+14155550100", body: "Hi Ada. Reply STOP to opt out.", reference: "campaigns:msg:e1:1", ...extra });

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A provider whose fetch is a spy answering from `answers` in order. */
function twilio(...answers: Array<Response | Error>) {
  const queue = [...answers];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const next = queue.shift() ?? reply(201, { sid: MSG_SID, status: "queued", num_segments: "1" });
    if (next instanceof Error) throw next;
    return next;
  });
  return { provider: new TwilioProvider({ accountSid: SID, authToken: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch }), fetchImpl };
}

const called = (fetchImpl: ReturnType<typeof twilio>["fetchImpl"], index = 0) => {
  const [url, init] = fetchImpl.mock.calls[index] as [string, RequestInit];
  return { url, init, form: new URLSearchParams(String(init.body ?? "")), headers: init.headers as Record<string, string> };
};

describe("Twilio adapter: sending", () => {
  it("posts the documented form to the account's Messages resource with basic auth", async () => {
    const { provider, fetchImpl } = twilio();
    const out = await provider.send(sms());
    expect(out).toEqual({ ok: true, providerId: MSG_SID, status: "queued", segments: 1 });
    const { url, init, form, headers } = called(fetchImpl);
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`);
    expect(init.method).toBe("POST");
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(headers.Authorization).toBe(`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString("base64")}`);
    expect(Object.fromEntries(form)).toEqual({ To: "+27821234567", From: "+14155550100", Body: "Hi Ada. Reply STOP to opt out." });
    // The token travels only in the Authorization header.
    expect(String(init.body)).not.toContain(TOKEN);
  });

  it("sends WhatsApp with whatsapp: addresses, and a Messaging Service SID as MessagingServiceSid", async () => {
    const wa = twilio();
    await wa.provider.send(sms({ channel: "whatsapp", from: "+14155238886", to: "+27821234567" }));
    expect(Object.fromEntries(called(wa.fetchImpl).form)).toMatchObject({ To: "whatsapp:+27821234567", From: "whatsapp:+14155238886" });
    const service = twilio();
    await service.provider.send(sms({ from: "MG0123456789abcdef0123456789abcdef" }));
    const form = Object.fromEntries(called(service.fetchImpl).form);
    expect(form.MessagingServiceSid).toBe("MG0123456789abcdef0123456789abcdef");
    expect(form.From).toBeUndefined();
  });

  it("sends a WhatsApp template as ContentSid and ContentVariables, with no Body", async () => {
    const { provider, fetchImpl } = twilio();
    await provider.send(sms({ channel: "whatsapp", from: "+14155238886", template: { ref: "HX0123456789abcdef0123456789abcdef", vars: { "1": "Ada", "2": "Acme" } } }));
    const form = Object.fromEntries(called(fetchImpl).form);
    expect(form).toMatchObject({ ContentSid: "HX0123456789abcdef0123456789abcdef", ContentVariables: JSON.stringify({ "1": "Ada", "2": "Acme" }) });
    expect(form.Body).toBeUndefined();
  });

  it("refuses to build with a malformed account SID or no token", () => {
    expect(() => new TwilioProvider({ accountSid: "nope", authToken: TOKEN })).toThrow(/start with AC/);
    expect(() => new TwilioProvider({ accountSid: SID, authToken: "" })).toThrow(/auth token/);
  });

  it("tells a STOP block, a bad number, a missing template, a bad account and a busy provider apart", async () => {
    const answer = async (status: number, code: number | undefined, message: string) => {
      const { provider } = twilio(reply(status, { code, message, status }));
      return provider.send(sms());
    };
    expect(await answer(400, 21610, "Attempt to send to unsubscribed recipient")).toMatchObject({ ok: false, kind: "rejected", code: "21610", optedOut: true });
    expect(await answer(400, 21211, "Invalid 'To' Phone Number")).toMatchObject({ ok: false, kind: "rejected", invalidRecipient: true });
    expect(await answer(400, 21614, "'To' number is not a valid mobile number")).toMatchObject({ ok: false, invalidRecipient: true });
    expect(await answer(400, 63016, "Failed to send freeform message outside the allowed window")).toMatchObject({ ok: false, kind: "rejected", needsTemplate: true });
    expect(await answer(401, 20003, "Authenticate")).toMatchObject({ ok: false, kind: "config" });
    expect(await answer(400, 21606, "The From phone number is not a valid, SMS-capable Twilio phone number")).toMatchObject({ ok: false, kind: "config" });
    expect(await answer(400, 21408, "Permission to send an SMS has not been enabled for the region")).toMatchObject({ ok: false, kind: "config" });
    expect(await answer(429, 20429, "Too many requests")).toMatchObject({ ok: false, kind: "retry" });
    expect(await answer(503, undefined, "Service unavailable")).toMatchObject({ ok: false, kind: "retry" });
    // A server error may still have created the message: never retried by itself.
    expect(await answer(500, undefined, "Internal error")).toMatchObject({ ok: false, kind: "unknown" });
    expect(await answer(400, 21617, "The concatenated message body exceeds the 1600 character limit")).toMatchObject({ ok: false, kind: "rejected" });
  });

  it("calls a request with no answer unknown, never a failure it could retry", async () => {
    const { provider } = twilio(new Error("socket hang up"));
    const out = await provider.send(sms());
    expect(out).toMatchObject({ ok: false, kind: "unknown" });
    expect((out as { error: string }).error).not.toContain(TOKEN);
  });

  it("a request that never left the machine (no DNS, connection refused, a bad certificate) is safe to retry; one that may have arrived is not", async () => {
    const failed = (code: string, name = "TypeError") => Object.assign(new TypeError("fetch failed"), { name, cause: Object.assign(new Error(`connect ${code}`), { code }) });
    for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED"]) {
      const out = await twilio(failed(code)).provider.send(sms());
      expect(out, code).toMatchObject({ ok: false, kind: "retry", code: null });
      expect((out as { error: string }).error).toMatch(/not sent/);
    }
    // The request could have been received before the connection broke or timed out: never repeated by itself.
    for (const code of ["ECONNRESET", "ETIMEDOUT", "UND_ERR_SOCKET", "EPIPE"]) expect((await twilio(failed(code)).provider.send(sms())) as unknown, code).toMatchObject({ ok: false, kind: "unknown" });
    expect(await twilio(Object.assign(new Error("aborted"), { name: "AbortError" })).provider.send(sms())).toMatchObject({ ok: false, kind: "unknown" });
    // A cause buried two levels down is still found.
    const nested = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("outer"), { cause: Object.assign(new Error("inner"), { code: "ENOTFOUND" }) }) });
    expect(await twilio(nested).provider.send(sms())).toMatchObject({ ok: false, kind: "retry" });
    expect(requestNeverSent(null)).toBe(false);
    expect(requestNeverSent("ENOTFOUND")).toBe(false);
  });

  it("does not call a 200 without a message sid a success", async () => {
    const { provider } = twilio(reply(200, { status: "queued" }));
    expect(await provider.send(sms())).toMatchObject({ ok: false });
  });

  it("gives up on a request that hangs", async () => {
    const hang = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const provider = new TwilioProvider({ accountSid: SID, authToken: TOKEN, fetchImpl: hang as unknown as typeof fetch, timeoutMs: 20 });
    expect(await provider.send(sms())).toMatchObject({ ok: false, kind: "unknown" });
  });

  it("maps failures the same way on their own", () => {
    expect(classifyTwilioFailure(400, "21610", "x")).toMatchObject({ optedOut: true });
    expect(classifyTwilioFailure(null, null, "no answer")).toMatchObject({ kind: "rejected" });
    expect(classifyTwilioFailure(502, null, "bad gateway")).toMatchObject({ kind: "unknown" });
  });
});

describe("Twilio adapter: replies and delivery status", () => {
  const since = new Date("2026-10-05T08:00:00Z");
  const message = (over: Record<string, unknown>) => ({ sid: MSG_SID, direction: "inbound", from: "+27821234567", to: "+14155550100", body: "STOP", date_created: "Mon, 05 Oct 2026 09:00:00 +0000", ...over });

  it("lists inbound messages to our number since the cursor, newest filtering by the exact moment", async () => {
    const { provider, fetchImpl } = twilio(reply(200, { messages: [
      message({ sid: "SM1" }),
      message({ sid: "SM2", direction: "outbound-api" }),
      message({ sid: "SM3", date_created: "Mon, 05 Oct 2026 07:00:00 +0000" }),
      message({ sid: "SM4", from: "whatsapp:+27829999999", body: "yes" }),
    ] }));
    const out = await provider.inbound({ since, numbers: [{ channel: "sms", address: "+14155550100" }] });
    expect(out.map((m) => m.providerId)).toEqual(["SM1", "SM4"]);
    expect(out[0]).toEqual({ providerId: "SM1", channel: "sms", from: "+27821234567", to: "+14155550100", body: "STOP", receivedAt: "2026-10-05T09:00:00.000Z" });
    const { url } = called(fetchImpl);
    expect(url).toContain("/Messages.json?");
    const query = new URL(url).searchParams;
    expect(query.get("To")).toBe("+14155550100");
    expect(query.get("DateSent>")).toBe("2026-10-05");
    expect(query.get("PageSize")).toBe("100");
  });

  it("asks for a WhatsApp number as whatsapp:+... and follows the next page", async () => {
    const first = reply(200, { messages: [message({ sid: "SM1", to: "whatsapp:+14155238886" })], next_page_uri: `/2010-04-01/Accounts/${SID}/Messages.json?Page=1&PageToken=abc` });
    const second = reply(200, { messages: [message({ sid: "SM2", to: "whatsapp:+14155238886" })] });
    const { provider, fetchImpl } = twilio(first, second);
    const out = await provider.inbound({ since, numbers: [{ channel: "whatsapp", address: "+14155238886" }] });
    expect(out.map((m) => m.providerId)).toEqual(["SM1", "SM2"]);
    expect(new URL(called(fetchImpl, 0).url).searchParams.get("To")).toBe("whatsapp:+14155238886");
    expect(called(fetchImpl, 1).url).toContain("PageToken=abc");
    expect(called(fetchImpl, 1).url.startsWith(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`)).toBe(true);
  });

  it("stops at five pages and fails loudly when Twilio refuses the read", async () => {
    const page = () => reply(200, { messages: [], next_page_uri: `/2010-04-01/Accounts/${SID}/Messages.json?Page=1` });
    const many = twilio(page(), page(), page(), page(), page(), page(), page());
    await many.provider.inbound({ since, numbers: [{ channel: "sms", address: "+14155550100" }] });
    expect(many.fetchImpl).toHaveBeenCalledTimes(5);
    const refused = twilio(reply(401, { code: 20003, message: "Authenticate" }));
    await expect(refused.provider.inbound({ since, numbers: [{ channel: "sms", address: "+14155550100" }] })).rejects.toThrow(/401/);
  });

  it("reads the delivery status of sent messages and ignores ids that are not message sids", async () => {
    const { provider, fetchImpl } = twilio(reply(200, { sid: MSG_SID, status: "undelivered", error_code: 30006 }), reply(404, { code: 20404 }));
    const out = await provider.statuses([MSG_SID, "not-a-sid", "SMffffffffffffffffffffffffffffffff"]);
    expect(out).toEqual([{ providerId: MSG_SID, status: "undelivered", errorCode: "30006" }, { providerId: "SMffffffffffffffffffffffffffffffff", status: "failed", errorCode: "404" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(called(fetchImpl).url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages/${MSG_SID}.json`);
  });
});

describe("messagingSetup: off until a secret and a sender exist", () => {
  beforeEach(() => clearMessagingCache());
  afterEach(() => setMessagingProvider(null));

  function harnessWith(messaging: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) {
    const harness = createTestHarness({ manifest, config: { timezone: "Africa/Johannesburg", ...(messaging ? { messaging } : {}), ...extra } });
    return harness.ctx;
  }

  it("a company with no settings has no provider and says what is missing for each channel", async () => {
    const setup = await messagingSetup(harnessWith(undefined), "co-1");
    expect(setup.provider).toBeNull();
    expect(setup.sms).toMatchObject({ ready: false });
    expect(setup.sms.reason).toMatch(/not set up.*account SID/i);
    expect(setup.whatsapp.ready).toBe(false);
  });

  it("an account SID without the token secret is still off, and says the secret is missing", async () => {
    const setup = await messagingSetup(harnessWith({ accountSid: SID, smsFrom: "+14155550100" }), "co-1");
    expect(setup.provider).toBeNull();
    expect(setup.sms.reason).toMatch(/auth token is not set/i);
  });

  it("a token without an account SID is off", async () => {
    const setup = await messagingSetup(harnessWith({ authToken: TOKEN, smsFrom: "+14155550100" }), "co-1");
    expect(setup.provider).toBeNull();
    expect(setup.sms.ready).toBe(false);
  });

  it("with the account and token saved, SMS needs its own sender and WhatsApp its own", async () => {
    const setup = await messagingSetup(harnessWith({ accountSid: SID, authToken: TOKEN }), "co-1");
    expect(setup.provider).toBeInstanceOf(TwilioProvider);
    expect(setup.sms).toEqual({ ready: false, reason: "No SMS sender is set. Add it in the Campaigns settings." });
    expect(setup.whatsapp.reason).toMatch(/No WhatsApp sender/);
  });

  it("is ready for SMS with a number or a Messaging Service, and for WhatsApp with a WhatsApp number", async () => {
    const withNumber = await messagingSetup(harnessWith({ accountSid: SID, authToken: TOKEN, smsFrom: "0821234567", whatsappFrom: "+14155238886" }), "co-1");
    expect(withNumber.sms.ready).toBe(true);
    expect(withNumber.whatsapp.ready).toBe(true);
    // A number written locally is converted with the default country.
    expect(withNumber.config.smsFrom).toBe("+27821234567");
    expect(defaultSender(withNumber, "sms")).toBe("+27821234567");
    clearMessagingCache();
    const service = await messagingSetup(harnessWith({ accountSid: SID, authToken: TOKEN, messagingServiceSid: "MG0123456789abcdef0123456789abcdef" }), "co-1");
    expect(readinessOf(service, "sms").ready).toBe(true);
    expect(defaultSender(service, "sms")).toBe("MG0123456789abcdef0123456789abcdef");
    expect(readinessOf(service, "whatsapp").ready).toBe(false);
  });

  it("a malformed account SID is not usable and does not throw", async () => {
    const setup = await messagingSetup(harnessWith({ accountSid: "wrong", authToken: TOKEN, smsFrom: "+14155550100" }), "co-1");
    expect(setup.provider).toBeNull();
    expect(setup.sms.reason).toMatch(/could not be used/);
  });

  it("remembers the answer for a few minutes but reads fresh when asked", async () => {
    const ctx = harnessWith({ accountSid: SID, authToken: TOKEN, smsFrom: "+14155550100" });
    const first = await messagingSetup(ctx, "co-1");
    expect(await messagingSetup(ctx, "co-1")).toBe(first);
    expect(await messagingSetup(ctx, "co-1", { fresh: true })).not.toBe(first);
  });

  it("uses an injected provider (tests) but still needs a sender per channel", async () => {
    const mock = new MockProvider();
    setMessagingProvider(() => mock);
    const setup = await messagingSetup(harnessWith({ smsFrom: "+14155550100" }), "co-1");
    expect(setup.provider).toBe(mock);
    expect(setup.sms.ready).toBe(true);
    expect(setup.whatsapp.ready).toBe(false);
  });

  it("reads the timezone and send windows from the settings", () => {
    const config = messagingConfigFrom({ timezone: "Africa/Cairo", messaging: { weekdays: "09:00-17:00", defaultCountry: "27" } });
    expect(config.timezone).toBe("Africa/Cairo");
    expect(config.defaultCountry).toBe("+27");
    expect(config.windows.days[1]).toEqual([540, 1020]);
  });
});
