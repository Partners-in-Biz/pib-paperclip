/**
 * The provider adapters, with no database: Stripe's link creation and signature check, PayFast's checkout
 * signature and its four ITN checks, and the readiness rules (everything off until its secrets exist).
 */
import { describe, expect, it } from "vitest";
import { hmacHex, md5Hex, phpUrlencode, remoteIpFrom, safeEqual } from "../src/pay/crypto.js";
import { ITN_VIA_HOST, PayFastProvider, itnParamString, itnSignature, parseForm, payfastCheckoutSignature, payfastReadiness, signItn } from "../src/pay/payfast.js";
import { providerState, providerStates, enabledProviderKeys, webhookUrl, clearingAccountCode } from "../src/pay/settings.js";
import { PaymentProviderError, StripeProvider, checkStripeSignatureShape, parseStripeSignature, signStripeBody, stripeForm, verifyStripeSignature } from "../src/pay/stripe.js";
import { decimalFromMinor, minorFromDecimal, WebhookRejected, type WebhookInput } from "../src/pay/types.js";
import { mockEvent } from "../src/pay/mock.js";

const NOW = new Date("2026-10-03T10:00:00.000Z");
const SECRET = "whsec_test_secret";

function stripeInput(rawBody: string, signature: string | null, now = NOW): WebhookInput {
  return { rawBody, headers: signature ? { "stripe-signature": signature } : {}, now };
}
const t = Math.floor(NOW.getTime() / 1000);

describe("helpers", () => {
  it("urlencodes the way PHP does (what PayFast signs)", () => {
    expect(phpUrlencode("Invoice INV-001 (R 1,150.00)")).toBe("Invoice+INV-001+%28R+1%2C150.00%29");
    expect(phpUrlencode("a~b*c'd!e")).toBe("a%7Eb%2Ac%27d%21e");
    expect(phpUrlencode("café & co")).toBe("caf%C3%A9+%26+co");
    expect(phpUrlencode("a_b-c.d")).toBe("a_b-c.d");
  });

  it("compares in constant time, and never equal across lengths", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(hmacHex("k", "m")).toMatch(/^[0-9a-f]{64}$/);
    expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
  });

  it("reads the client address from the proxy header, the entry nearest to us", () => {
    expect(remoteIpFrom({ "x-forwarded-for": "9.9.9.9, 197.97.145.144" })).toBe("197.97.145.144");
    expect(remoteIpFrom({ "x-forwarded-for": "::ffff:197.97.145.144" })).toBe("197.97.145.144");
    expect(remoteIpFrom({ "x-real-ip": "1.2.3.4" })).toBe("1.2.3.4");
    expect(remoteIpFrom({})).toBeNull();
  });

  it("turns decimal text into cents and back, refusing anything else", () => {
    expect(minorFromDecimal("1150.00")).toBe(115_000);
    expect(minorFromDecimal("0.5")).toBe(50);
    expect(minorFromDecimal("12")).toBe(1_200);
    expect(minorFromDecimal("1,150.00")).toBeNull();
    expect(minorFromDecimal("-5.00")).toBeNull();
    expect(minorFromDecimal("1.234")).toBeNull();
    expect(decimalFromMinor(115_000)).toBe("1150.00");
    expect(decimalFromMinor(5)).toBe("0.05");
  });
});

describe("Stripe signature", () => {
  const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });

  it("accepts a delivery signed with the secret within five minutes", () => {
    expect(() => verifyStripeSignature(stripeInput(body, signStripeBody(SECRET, body, t)), SECRET)).not.toThrow();
    expect(() => verifyStripeSignature(stripeInput(body, signStripeBody(SECRET, body, t - 299)), SECRET)).not.toThrow();
  });

  it("refuses a changed body, another secret, no header, and a header with no v1", () => {
    const good = signStripeBody(SECRET, body, t);
    expect(() => verifyStripeSignature(stripeInput(`${body} `, good), SECRET)).toThrow(WebhookRejected);
    expect(() => verifyStripeSignature(stripeInput(body, signStripeBody("whsec_other", body, t)), SECRET)).toThrow(/does not match/);
    expect(() => verifyStripeSignature(stripeInput(body, null), SECRET)).toThrow(/No usable/);
    expect(() => verifyStripeSignature(stripeInput(body, `t=${t},v0=${hmacHex(SECRET, `${t}.${body}`)}`), SECRET)).toThrow(/No usable/);
    expect(() => verifyStripeSignature(stripeInput(body, good), "")).toThrow(/not set/);
  });

  it("refuses a replay older than five minutes, and one from the future", () => {
    expect(() => verifyStripeSignature(stripeInput(body, signStripeBody(SECRET, body, t - 301)), SECRET)).toThrow(/too old/);
    expect(() => verifyStripeSignature(stripeInput(body, signStripeBody(SECRET, body, t + 400)), SECRET)).toThrow(/too old or too far/);
    try {
      verifyStripeSignature(stripeInput(body, signStripeBody(SECRET, body, t - 301)), SECRET);
    } catch (error) {
      expect((error as WebhookRejected).code).toBe("stale");
    }
  });

  it("tells a plainly unsigned delivery apart without the secret, and proves nothing about a well-formed one", () => {
    const good = signStripeBody(SECRET, body, t);
    expect(() => checkStripeSignatureShape(stripeInput(body, good))).not.toThrow();
    // Anyone can write a header of the right shape: it passes the shape check and then fails the real one.
    const forged = signStripeBody("whsec_attacker", body, t);
    expect(() => checkStripeSignatureShape(stripeInput(body, forged))).not.toThrow();
    expect(() => verifyStripeSignature(stripeInput(body, forged), SECRET)).toThrow(/does not match/);
    for (const header of [null, "garbage", `t=${t}`, `v1=${"a".repeat(64)}`, `t=${t},v1=${"a".repeat(63)}`, `t=${t},v1=${"g".repeat(64)}`, `t=${t},v0=${"a".repeat(64)}`]) {
      expect(() => checkStripeSignatureShape(stripeInput(body, header)), String(header)).toThrow(expect.objectContaining({ code: "bad_signature" }));
    }
    expect(() => checkStripeSignatureShape(stripeInput(body, signStripeBody(SECRET, body, t - 301)))).toThrow(expect.objectContaining({ code: "stale" }));
    expect(() => checkStripeSignatureShape(stripeInput(body, signStripeBody(SECRET, body, t + 400)))).toThrow(expect.objectContaining({ code: "stale" }));
  });

  it("believes any one of several v1 signatures (a rolled secret) and ignores other schemes", () => {
    const header = `t=${t},v1=${"0".repeat(64)},v1=${hmacHex(SECRET, `${t}.${body}`)},v0=abc`;
    expect(parseStripeSignature(header)).toMatchObject({ timestamp: t, signatures: expect.arrayContaining([hmacHex(SECRET, `${t}.${body}`)]) });
    expect(() => verifyStripeSignature(stripeInput(body, header), SECRET)).not.toThrow();
  });
});

describe("Stripe events", () => {
  const provider = new StripeProvider({ secretKey: "sk_test_x", webhookSecret: SECRET });
  const link = { id: "link-1", amountMinor: 115_000, currency: "ZAR" };
  const deliver = (event: Record<string, unknown>) => {
    const raw = JSON.stringify(event);
    return stripeInput(raw, signStripeBody(SECRET, raw, t));
  };
  const session = (over: Record<string, unknown> = {}) => ({ id: "evt_s1", type: "checkout.session.completed", created: t, data: { object: { id: "cs_1", client_reference_id: "link-1", payment_intent: "pi_1", payment_status: "paid", amount_total: 115_000, currency: "zar", ...over } } });

  it("finds our link from the reference, or the payment intent, without trusting it", () => {
    expect(provider.locate(deliver(session()))).toEqual({ linkId: "link-1", providerPaymentId: "pi_1" });
    expect(provider.locate(deliver(session({ client_reference_id: null, metadata: { pib_link: "link-9" } })))).toEqual({ linkId: "link-9", providerPaymentId: "pi_1" });
    expect(provider.locate(deliver({ id: "e", type: "charge.refunded", data: { object: { id: "ch_1", payment_intent: "pi_1" } } }))).toEqual({ linkId: null, providerPaymentId: "pi_1" });
    expect(provider.locate(deliver({ id: "e", type: "customer.created", data: { object: {} } }))).toBeNull();
    expect(provider.locate(stripeInput("not json", null))).toBeNull();
  });

  it("turns a paid session into a confirmed payment of exactly what was paid", async () => {
    const events = await provider.verify(deliver(session()), link);
    expect(events).toEqual([{ kind: "payment_confirmed", eventId: "evt_s1", linkId: "link-1", providerPaymentId: "pi_1", amountMinor: 115_000, currency: "ZAR", feeMinor: null, paidAt: new Date(t * 1000).toISOString(), reference: "cs_1", status: "paid" }]);
    expect((await provider.verify(deliver({ ...session(), type: "checkout.session.async_payment_succeeded" }), link))[0]!.kind).toBe("payment_confirmed");
  });

  it("does not count a session that is not paid yet, and reports an async failure", async () => {
    expect(await provider.verify(deliver(session({ payment_status: "unpaid" })), link)).toEqual([]);
    expect((await provider.verify(deliver({ ...session(), type: "checkout.session.async_payment_failed" }), link))[0]).toMatchObject({ kind: "payment_failed", linkId: "link-1" });
  });

  it("reports a refund as the total refunded so far", async () => {
    const refund = { id: "evt_r1", type: "charge.refunded", created: t, data: { object: { id: "ch_1", payment_intent: "pi_1", amount_refunded: 5_000, currency: "zar" } } };
    expect(await provider.verify(deliver(refund), link)).toEqual([expect.objectContaining({ kind: "refund", amountMinor: 5_000, providerPaymentId: "pi_1", eventId: "evt_r1" })]);
    expect(await provider.verify(deliver({ ...refund, data: { object: { id: "ch_1", payment_intent: "pi_1", amount_refunded: 0 } } }), link)).toEqual([]);
  });

  it("ignores events it does not act on, and refuses anything unsigned or unreadable", async () => {
    expect(await provider.verify(deliver({ id: "e", type: "invoice.created", data: { object: {} } }), link)).toEqual([]);
    await expect(provider.verify(stripeInput(JSON.stringify(session()), "t=1,v1=00"), link)).rejects.toMatchObject({ code: "stale" });
    const raw = "{\"type\":1}";
    await expect(provider.verify(stripeInput(raw, signStripeBody(SECRET, raw, t)), link)).rejects.toMatchObject({ code: "invalid" });
    await expect(new StripeProvider({ secretKey: "", webhookSecret: "" }).verify(deliver(session()), link)).rejects.toMatchObject({ code: "not_configured" });
  });
});

describe("Stripe payment link", () => {
  function fakeStripe(responses: Array<{ ok?: boolean; status?: number; body: unknown }>) {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
    const fetchImpl = (async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      const next = responses.shift()!;
      return { ok: next.ok ?? true, status: next.status ?? 200, json: async () => next.body } as Response;
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }
  const request = { linkId: "6f1e", invoiceNumber: "LUM-001", amountMinor: 115_000, currency: "ZAR", description: "Invoice LUM-001" };

  it("makes a price and a one-payment payment link, each with an idempotency key, and addresses it with our reference", async () => {
    const { calls, fetchImpl } = fakeStripe([{ body: { id: "price_1" } }, { body: { id: "plink_1", url: "https://buy.stripe.com/test_abc" } }]);
    const link = await new StripeProvider({ secretKey: "sk_test_k", webhookSecret: SECRET, fetchImpl }).createLink(request);
    expect(link).toEqual({ url: "https://buy.stripe.com/test_abc?client_reference_id=6f1e", providerRef: "plink_1" });
    expect(calls.map((c) => c.url)).toEqual(["https://api.stripe.com/v1/prices", "https://api.stripe.com/v1/payment_links"]);
    expect(calls[0]!.headers).toMatchObject({ authorization: "Bearer sk_test_k", "idempotency-key": "6f1e:price", "content-type": "application/x-www-form-urlencoded" });
    expect(calls[1]!.headers["idempotency-key"]).toBe("6f1e:link");
    const price = new URLSearchParams(calls[0]!.body);
    expect(price.get("currency")).toBe("zar");
    expect(price.get("unit_amount")).toBe("115000");
    expect(price.get("product_data[name]")).toBe("Invoice LUM-001");
    const form = new URLSearchParams(calls[1]!.body);
    expect(form.get("line_items[0][price]")).toBe("price_1");
    expect(form.get("line_items[0][quantity]")).toBe("1");
    expect(form.get("metadata[pib_link]")).toBe("6f1e");
    expect(form.get("payment_intent_data[metadata][pib_link]")).toBe("6f1e");
    expect(form.get("restrictions[completed_sessions][limit]")).toBe("1");
    // Only the invoice and the amount reach the provider: every field of both requests is on this list, so a customer name, email or phone cannot slip in unnoticed.
    expect([...price.keys()].sort()).toEqual(["currency", "product_data[name]", "unit_amount"]);
    expect([...form.keys()].sort()).toEqual([
      "after_completion[hosted_confirmation][custom_message]", "after_completion[type]", "inactive_message", "line_items[0][price]", "line_items[0][quantity]",
      "metadata[invoice]", "metadata[pib_link]", "payment_intent_data[description]", "payment_intent_data[metadata][invoice]", "payment_intent_data[metadata][pib_link]",
      "restrictions[completed_sessions][limit]",
    ]);
    expect([...new URL(link.url).searchParams.keys()]).toEqual(["client_reference_id"]);
  });

  it("explains a refusal without echoing the key, refuses a currency with no cents and a zero amount", async () => {
    const { fetchImpl } = fakeStripe([{ ok: false, status: 401, body: { error: { message: "Invalid API Key provided: sk_test_****abcd" } } }]);
    const provider = new StripeProvider({ secretKey: "sk_test_secretvalue", webhookSecret: SECRET, fetchImpl });
    await expect(provider.createLink(request)).rejects.toThrow(/Stripe refused the request: Invalid API Key provided: sk_test_\*\*\*\*abcd/);
    await expect(provider.createLink({ ...request, currency: "JPY" })).rejects.toThrow(/no cents/);
    await expect(provider.createLink({ ...request, amountMinor: 0 })).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it("switches a link off", async () => {
    const { calls, fetchImpl } = fakeStripe([{ body: {} }]);
    await new StripeProvider({ secretKey: "sk_test_k", webhookSecret: SECRET, fetchImpl }).deactivateLink({ providerRef: "plink_1" });
    expect(calls[0]!.url).toBe("https://api.stripe.com/v1/payment_links/plink_1");
    expect(new URLSearchParams(calls[0]!.body).get("active")).toBe("false");
  });

  it("form-encodes nested values the way Stripe reads them", () => {
    expect(decodeURIComponent(stripeForm({ a: { b: [{ c: 1 }, { c: 2 }] }, d: "x y", e: null }))).toBe("a[b][0][c]=1&a[b][1][c]=2&d=x y");
  });
});

describe("PayFast checkout", () => {
  const fields = { merchant_id: "10000100", merchant_key: "46f0cd694581a", return_url: "", cancel_url: "", notify_url: "https://paperclip.example/api/plugins/partnersinbiz.billing/webhooks/payfast", name_first: "", name_last: "", email_address: "", m_payment_id: "6f1e", amount: "1150.00", item_name: "Invoice LUM-001", item_description: "Invoice LUM-001" };

  it("signs the non-empty fields in the documented order, then the passphrase, with MD5", () => {
    const expected = md5Hex(`merchant_id=10000100&merchant_key=46f0cd694581a&notify_url=https%3A%2F%2Fpaperclip.example%2Fapi%2Fplugins%2Fpartnersinbiz.billing%2Fwebhooks%2Fpayfast&m_payment_id=6f1e&amount=1150.00&item_name=Invoice+LUM-001&item_description=Invoice+LUM-001&passphrase=my+secret`);
    expect(payfastCheckoutSignature(fields, "my secret")).toBe(expected);
    expect(payfastCheckoutSignature(fields, null)).toBe(md5Hex("merchant_id=10000100&merchant_key=46f0cd694581a&notify_url=https%3A%2F%2Fpaperclip.example%2Fapi%2Fplugins%2Fpartnersinbiz.billing%2Fwebhooks%2Fpayfast&m_payment_id=6f1e&amount=1150.00&item_name=Invoice+LUM-001&item_description=Invoice+LUM-001"));
    expect(payfastCheckoutSignature(fields, "my secret")).not.toBe(payfastCheckoutSignature(fields, "other"));
  });

  const provider = (sandbox = false) => new PayFastProvider({ merchantId: "10000100", merchantKey: "46f0cd694581a", passphrase: "pass phrase", sandbox, notifyUrl: fields.notify_url, returnUrl: "https://example.com/thanks" });
  const request = { linkId: "6f1e", invoiceNumber: "LUM-001", amountMinor: 115_000, currency: "ZAR", description: "Invoice LUM-001" };

  it("builds the signed address, sandbox or live, with only the invoice number and amount (no customer details)", async () => {
    const live = await provider().createLink(request);
    expect(live.url.startsWith("https://www.payfast.co.za/eng/process?")).toBe(true);
    expect((await provider(true).createLink(request)).url.startsWith("https://sandbox.payfast.co.za/eng/process?")).toBe(true);
    const query = new URLSearchParams(live.url.split("?")[1]);
    expect(query.get("m_payment_id")).toBe("6f1e");
    expect(query.get("amount")).toBe("1150.00");
    expect(query.get("return_url")).toBe("https://example.com/thanks");
    expect(live.url).not.toContain("Lumen");
    expect(live.url).not.toContain("ap%40lumen");
    const signed = Object.fromEntries([...query.entries()].filter(([k]) => k !== "signature"));
    expect(query.get("signature")).toBe(payfastCheckoutSignature({ ...signed }, "pass phrase"));
    expect(live.providerRef).toBeNull();
  });

  it("takes rand only and an amount above zero", async () => {
    await expect(provider().createLink({ ...request, currency: "USD" })).rejects.toThrow(/rand only/);
    await expect(provider().createLink({ ...request, amountMinor: 0 })).rejects.toBeInstanceOf(PaymentProviderError);
  });
});

describe("PayFast ITN", () => {
  const PASS = "pass phrase";
  const ADDRESSES = ["197.97.145.144", "41.74.179.194"];
  const entries: Array<[string, string]> = [
    ["m_payment_id", "6f1e"], ["pf_payment_id", "1089250"], ["payment_status", "COMPLETE"], ["item_name", "Invoice LUM-001"], ["item_description", ""],
    ["amount_gross", "1150.00"], ["amount_fee", "-26.45"], ["amount_net", "1123.55"], ["custom_str1", ""], ["name_first", "Sipho"], ["email_address", "sipho@lumen.test"], ["merchant_id", "10000100"],
  ];
  const link = { id: "6f1e", amountMinor: 115_000, currency: "ZAR" };
  const NOW2 = new Date("2026-10-03T10:00:00Z");
  function make(over: { fetch?: (body: string) => string | Response; entries?: Array<[string, string]>; passphrase?: string | null } = {}) {
    const posted: string[] = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      posted.push(init.body);
      const answer = over.fetch ? over.fetch(init.body) : "VALID";
      return typeof answer === "string" ? new Response(answer, { status: 200 }) : answer;
    }) as unknown as typeof fetch;
    const payfast = new PayFastProvider({ merchantId: "10000100", merchantKey: "k", passphrase: over.passphrase === undefined ? PASS : over.passphrase, notifyUrl: "https://x", fetchImpl, resolveAddresses: async () => ADDRESSES });
    return { payfast, posted, body: signItn(over.entries ?? entries, over.passphrase === undefined ? PASS : over.passphrase) };
  }
  const input = (rawBody: string): WebhookInput => ({ rawBody, headers: {}, now: NOW2 });

  it("parses the form in order and signs every field but the signature, empty ones included", () => {
    const body = signItn(entries, PASS);
    const parsed = parseForm(body);
    expect(parsed.map(([k]) => k).slice(0, 3)).toEqual(["m_payment_id", "pf_payment_id", "payment_status"]);
    expect(parsed.at(-1)![0]).toBe("signature");
    expect(itnParamString(parsed)).toContain("item_description=&amount_gross=1150.00");
    expect(itnParamString(parsed)).toContain("email_address=sipho%40lumen.test");
    expect(itnSignature(parsed, PASS)).toBe(parsed.at(-1)![1]);
    expect(itnSignature(parsed, null)).not.toBe(parsed.at(-1)![1]);
    expect(parseForm("   ")).toEqual([]);
  });

  it("finds our link from m_payment_id", () => {
    const { payfast, body } = make();
    expect(payfast.locate(input(body))).toEqual({ linkId: "6f1e", providerPaymentId: "1089250" });
    expect(payfast.locate(input(""))).toBeNull();
  });

  it("passes all four checks and reports the payment with its fee", async () => {
    const { payfast, body, posted } = make();
    const events = await payfast.verify(input(body), link, "197.97.145.144");
    expect(events).toEqual([{ kind: "payment_confirmed", eventId: "1089250:COMPLETE", linkId: "6f1e", providerPaymentId: "1089250", amountMinor: 115_000, currency: "ZAR", feeMinor: 2_645, paidAt: NOW2.toISOString(), reference: "1089250", status: "COMPLETE" }]);
    // Check 4 posts exactly what was received (without the signature) back to PayFast.
    expect(posted).toHaveLength(1);
    expect(posted[0]).toBe(itnParamString(parseForm(body)));
    expect(posted[0]).not.toContain("signature");
  });

  it("check 1: refuses a bad or missing signature, and a changed field", async () => {
    const { payfast, body } = make();
    await expect(payfast.verify(input(body.replace("1150.00", "11.50")), link, "197.97.145.144")).rejects.toMatchObject({ code: "bad_signature" });
    await expect(payfast.verify(input(body.replace(/signature=[0-9a-f]+/, "signature=" + "0".repeat(32))), link, "197.97.145.144")).rejects.toMatchObject({ code: "bad_signature" });
    await expect(payfast.verify(input(itnParamString(parseForm(body))), link, "197.97.145.144")).rejects.toMatchObject({ code: "bad_signature" });
    const wrongPass = make({ passphrase: "other" });
    await expect(payfast.verify(input(wrongPass.body), link, "197.97.145.144")).rejects.toMatchObject({ code: "bad_signature" });
  });

  it("check 2: refuses a request from any address that is not PayFast's, or with no address", async () => {
    const { payfast, body } = make();
    await expect(payfast.verify(input(body), link, "203.0.113.9")).rejects.toMatchObject({ code: "bad_source" });
    await expect(payfast.verify(input(body), link, null)).rejects.toMatchObject({ code: "bad_source" });
  });

  it("check 3: refuses another merchant or another payment", async () => {
    const other = make({ entries: entries.map(([k, v]) => [k, k === "merchant_id" ? "999" : v] as [string, string]) });
    await expect(other.payfast.verify(input(other.body), link, "197.97.145.144")).rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/another merchant/) });
    const { payfast, body } = make();
    await expect(payfast.verify(input(body), { ...link, id: "other-link" }, "197.97.145.144")).rejects.toMatchObject({ code: "invalid" });
  });

  it("check 4: refuses what PayFast does not confirm", async () => {
    const invalid = make({ fetch: () => "INVALID" });
    await expect(invalid.payfast.verify(input(invalid.body), link, "197.97.145.144")).rejects.toMatchObject({ code: "not_confirmed" });
    const down = make({ fetch: () => new Response("busy", { status: 503 }) });
    await expect(down.payfast.verify(input(down.body), link, "197.97.145.144")).rejects.toMatchObject({ code: "not_confirmed" });
  });

  it("an empty body (the host did not pass the form on) is refused, never believed", async () => {
    const { payfast } = make();
    await expect(payfast.verify(input(""), link, "197.97.145.144")).rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/no body/) });
  });

  it("maps the status: failed and cancelled are reported, pending is not money", async () => {
    for (const [status, kind] of [["FAILED", "payment_failed"], ["CANCELLED", "payment_failed"]] as const) {
      const m = make({ entries: entries.map(([k, v]) => [k, k === "payment_status" ? status : v] as [string, string]) });
      expect((await m.payfast.verify(input(m.body), link, "197.97.145.144"))[0]!.kind).toBe(kind);
    }
    const pending = make({ entries: entries.map(([k, v]) => [k, k === "payment_status" ? "PENDING" : v] as [string, string]) });
    expect(await pending.payfast.verify(input(pending.body), link, "197.97.145.144")).toEqual([]);
  });

  it("reports the paid amount as it came, so a different amount is the caller's to refuse", async () => {
    const m = make({ entries: entries.map(([k, v]) => [k, k === "amount_gross" ? "10.00" : v] as [string, string]) });
    expect((await m.payfast.verify(input(m.body), link, "197.97.145.144"))[0]).toMatchObject({ amountMinor: 1_000 });
  });
});

describe("what is on", () => {
  const stripeOn = { payments: { stripe: { enabled: true, secretKey: { type: "secret_ref", secretId: "a" }, webhookSecret: { type: "secret_ref", secretId: "b" } } } };

  it("everything is off by default, EFT is the way to pay", () => {
    expect(enabledProviderKeys({})).toEqual([]);
    expect(providerStates({}).map((s) => [s.key, s.enabled, s.code])).toEqual([["stripe", false, "off"], ["payfast", false, "off"], ["mock", false, "off"]]);
  });

  it("a provider needs its switch AND every secret: switched on with a secret missing is not on", () => {
    expect(providerState(stripeOn, "stripe")).toMatchObject({ enabled: true, switchedOn: true, blocker: null });
    expect(providerState({ payments: { stripe: { ...stripeOn.payments.stripe, webhookSecret: undefined } } }, "stripe")).toMatchObject({ enabled: false, switchedOn: true, code: "missing", blocker: "Missing: webhook signing secret." });
    expect(providerState({ payments: { stripe: { secretKey: stripeOn.payments.stripe.secretKey, webhookSecret: stripeOn.payments.stripe.webhookSecret } } }, "stripe")).toMatchObject({ enabled: false, code: "off" });
    expect(enabledProviderKeys({ ...stripeOn, payments: { ...stripeOn.payments, mock: { enabled: true } } })).toEqual(["stripe", "mock"]);
  });

  it("PayFast stays off while the host cannot receive its notifications, however complete it is", () => {
    const complete = { payments: { publicBaseUrl: "https://paperclip.example", payfast: { enabled: true, merchantId: "10000100", merchantKey: { type: "secret_ref", secretId: "k" } } } };
    expect(ITN_VIA_HOST).toBe(false);
    expect(providerState(complete, "payfast")).toMatchObject({ enabled: false, switchedOn: true, code: "host_limit", blocker: expect.stringMatching(/cannot receive PayFast notifications/) });
    // The rule itself, for the day the host passes forms on:
    const settings = { enabled: true, merchantId: "1", merchantKey: true };
    expect(payfastReadiness(settings, "https://paperclip.example", true)).toEqual({ ready: true, blocker: null, code: "ok" });
    expect(payfastReadiness(settings, null, true)).toMatchObject({ ready: false, code: "missing", blocker: expect.stringMatching(/public address/) });
    expect(payfastReadiness({ ...settings, enabled: false }, "https://x", true).code).toBe("off");
  });

  it("builds the webhook address from the public address, https only, and defaults the clearing account", () => {
    expect(webhookUrl({ payments: { publicBaseUrl: "https://paperclip.example/" } }, "stripe")).toBe("https://paperclip.example/api/plugins/partnersinbiz.billing/webhooks/stripe");
    expect(webhookUrl({ payments: { publicBaseUrl: "http://paperclip.example" } }, "stripe")).toBeNull();
    expect(webhookUrl({}, "payfast")).toBeNull();
    expect(clearingAccountCode({})).toBe("1020");
    expect(clearingAccountCode({ payments: { clearingAccountCode: "1030" } })).toBe("1030");
    expect(clearingAccountCode({ payments: { clearingAccountCode: "bad code!" } })).toBe("1020");
  });

  it("the test provider makes events a real one would", () => {
    expect(mockEvent({ kind: "payment_confirmed", linkId: "l1", amountMinor: 100, currency: "ZAR", paymentId: "p1", feeMinor: 3 })).toMatchObject({ kind: "payment_confirmed", eventId: "mock:payment_confirmed:l1:1", feeMinor: 3, status: "paid" });
    expect(mockEvent({ kind: "refund", linkId: "l1", amountMinor: 50, currency: "ZAR", paymentId: "p1", seq: 50 }).eventId).toBe("mock:refund:l1:50");
  });
});
