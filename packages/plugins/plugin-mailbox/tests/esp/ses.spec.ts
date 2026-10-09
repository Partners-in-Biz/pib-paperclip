import { describe, expect, it } from "vitest";
import { loadMailboxConfig, parseEspConfig } from "../../src/config.js";
import { createRateLimiter, limiterRateFor } from "../../src/esp/limiter.js";
import { effectiveEspRate, espProviderFor, QUOTA_TTL_MS } from "../../src/esp/runtime.js";
import { classifySesFailure, SesProvider, sesErrorCode, toSesPayload } from "../../src/esp/ses.js";
import type { EspEmail } from "../../src/esp/types.js";
import { CO } from "../helpers/memory.js";
import { API_KEY, SES_TOPIC_ARN, sesMockSetup, sesSetup } from "../helpers/esp.js";
import { FakeSes, hostFetch, SES_ACCESS_KEY_ID, SES_CONFIGURATION_SET, SES_REGION, SES_SECRET_ACCESS_KEY } from "../helpers/fake-ses.js";

const email = (over: Partial<EspEmail> = {}): EspEmail => ({
  from: '"Client Co" <hello@updates.client.co.za>',
  to: ["ann@x.co", "bob@x.co"],
  subject: "Spring offer — énorme",
  html: "<p>Hi Ann</p>",
  text: "Hi Ann",
  replyTo: "team@client.co.za",
  headers: { "List-Unsubscribe": "<https://paperclip.example.com/unsub?t=abc>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  tags: [{ name: "pib_company", value: CO }, { name: "pib_send", value: "campaigns_step_e1_1" }],
  idempotencyKey: "pib-key-1",
  ...over,
});

function provider(ses: FakeSes, over: Partial<ConstructorParameters<typeof SesProvider>[0]> = {}) {
  return new SesProvider({ region: SES_REGION, accessKeyId: SES_ACCESS_KEY_ID, secretAccessKey: SES_SECRET_ACCESS_KEY, configurationSet: SES_CONFIGURATION_SET, fetch: hostFetch(ses.handle), ...over });
}

describe("SesProvider.send", () => {
  it("posts Raw MIME to the SESv2 endpoint with the configuration set and both tags, signed over exactly four headers", async () => {
    const ses = new FakeSes();
    const outcome = await provider(ses).send(email());
    expect(outcome).toEqual({ ok: true, id: expect.stringMatching(/ses-test-id$/) });
    expect(ses.sends).toHaveLength(1);
    const request = ses.sends[0]!;
    expect(request.method).toBe("POST");
    expect(request.body).toMatchObject({
      ConfigurationSetName: SES_CONFIGURATION_SET,
      EmailTags: [{ Name: "pib_company", Value: CO }, { Name: "pib_send", Value: "campaigns_step_e1_1" }],
      Destination: { ToAddresses: ["ann@x.co", "bob@x.co"] },
    });
    expect(request.body!.Content).toEqual({ Raw: { Data: expect.any(String) } });
    // The MIME carries the unsubscribe pair, the reply-to and an RFC 2047 subject.
    expect(request.mime).toContain("List-Unsubscribe: <https://paperclip.example.com/unsub?t=abc>");
    expect(request.mime).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    expect(request.mime).toContain("Reply-To: team@client.co.za");
    expect(request.mime).toMatch(/Subject: =\?UTF-8\?B\?/);
    expect(request.mime).toContain("From: Client Co <hello@updates.client.co.za>");
    // The fake checked the signature the way AWS does, on the headers as the host's fetch delivered them.
    expect(ses.signatureProblems).toEqual([]);
    expect(request.headers.authorization).toContain("SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date");
    expect(request.headers.host).toBe("email.eu-north-1.amazonaws.com");
  });

  it("leaves the unsubscribe headers out of a message that has none, and a Bcc address out of the headers", async () => {
    const ses = new FakeSes();
    await provider(ses).send(email({ headers: undefined, bcc: ["hidden@x.co"] }));
    const request = ses.sends[0]!;
    expect(request.mime).not.toMatch(/List-Unsubscribe/i);
    expect(request.mime).not.toContain("hidden@x.co");
    expect(request.body!.Destination.BccAddresses).toEqual(["hidden@x.co"]);
  });

  it("carries attachments in the MIME", async () => {
    const ses = new FakeSes();
    await provider(ses).send(email({ attachments: [{ filename: "inv.pdf", contentType: "application/pdf", contentBase64: Buffer.from("PDFDATA").toString("base64") }] }));
    expect(ses.sends[0]!.mime).toContain('filename="inv.pdf"');
    expect(ses.sends[0]!.mime).toContain("multipart/mixed");
  });

  it("the signature breaks if the fetch rewrites a signed header, so the check above proves the host leaves all four alone", async () => {
    const ses = new FakeSes();
    const rewriting = provider(ses, { fetch: (url, init) => hostFetch(ses.handle)(url, { ...init, headers: { ...init!.headers, "content-type": "application/json; charset=utf-8" } }) });
    await rewriting.send(email());
    expect(ses.signatureProblems).toContain("signature does not match");
    // ...and the host's own additions (Content-Length, Host from the URL) are not signed and do not break it.
    const ok = new FakeSes();
    await provider(ok).send(email());
    expect(ok.signatureProblems).toEqual([]);
    expect(ok.requests[0]!.headers["content-length"]).toBe(String(Buffer.byteLength(ok.requests[0]!.rawBody)));
  });

  it("sends no secret anywhere it should not: not in the body, the MIME, the outcome or the error", async () => {
    const ses = new FakeSes();
    ses.errors.push({ status: 400, type: "BadRequestException", message: "bad" });
    const outcome = await provider(ses).send(email());
    const seen = JSON.stringify([outcome, ses.requests.map((r) => [r.rawBody, r.mime])]);
    expect(seen).not.toContain(SES_SECRET_ACCESS_KEY);
    // The access key id travels only in the Authorization credential scope.
    expect(JSON.stringify(ses.requests.map((r) => r.rawBody))).not.toContain(SES_ACCESS_KEY_ID);
  });

  it("is refused locally for an invalid From, and without keys the adapter is not built", async () => {
    const ses = new FakeSes();
    expect(await provider(ses).send(email({ from: "not an address" }))).toMatchObject({ ok: false, kind: "rejected" });
    expect(ses.requests).toHaveLength(0);
    expect(() => provider(ses, { secretAccessKey: " " })).toThrow(/both needed/);
    expect(() => provider(ses, { region: "nowhere" })).toThrow(/region/);
  });

  it("refuses a batch and says why; it declares itself non-idempotent and without batching", async () => {
    const ses = new FakeSes();
    const p = provider(ses);
    expect(p.idempotentSends).toBe(false);
    expect(p.batching).toBe(false);
    expect(await p.sendBatch([email(), email()], "k")).toMatchObject({ ok: false, kind: "rejected", code: "batch_unsupported" });
    expect(ses.requests).toHaveLength(0);
  });
});

describe("SES failures", () => {
  const table: Array<[string, number | null, string | null, string | null, string]> = [
    ["429 with no name", 429, null, null, "retry"],
    ["TooManyRequestsException", 429, "TooManyRequestsException", "Too many requests", "retry"],
    ["LimitExceededException", 400, "LimitExceededException", "There are too many instances", "quota"],
    ["the daily quota in words", 400, "Throttling", "Daily message quota exceeded.", "quota"],
    ["SendingPausedException", 400, "SendingPausedException", "paused", "config"],
    ["AccountSuspendedException", 400, "AccountSuspendedException", "suspended", "config"],
    ["403", 403, "AccessDeniedException", "not authorized", "config"],
    ["MessageRejected for an unverified identity", 400, "MessageRejected", "Email address is not verified. The following identities failed the check in region EU-NORTH-1: a@b.co", "unverified"],
    ["MessageRejected for content", 400, "MessageRejected", "Illegal address", "rejected"],
    ["MailFromDomainNotVerifiedException", 400, "MailFromDomainNotVerifiedException", "domain not verified", "unverified"],
    ["BadRequestException", 400, "BadRequestException", "invalid", "rejected"],
    ["NotFoundException", 404, "NotFoundException", "no such set", "rejected"],
    ["500", 500, null, null, "unknown"],
    ["503", 503, "ServiceUnavailable", null, "unknown"],
  ];
  it.each(table)("maps %s", (_name, status, code, message, kind) => {
    expect(classifySesFailure(status, code, message)).toMatchObject({ kind, status, code });
  });

  it("reads the exception name from the header, the body type or the body code", () => {
    const h = (v: string | null) => ({ get: () => v });
    expect(sesErrorCode(h("TooManyRequestsException:http://internal.amazon.com/x"), null)).toBe("TooManyRequestsException");
    expect(sesErrorCode(h(null), { __type: "com.amazon#MessageRejected" })).toBe("MessageRejected");
    expect(sesErrorCode(h(null), { code: "BadRequestException" })).toBe("BadRequestException");
    expect(sesErrorCode(h(null), {})).toBeNull();
  });

  it("a 429 is a retry that pauses the limiter one second, or what Retry-After says", async () => {
    const ses = new FakeSes();
    const pauses: number[] = [];
    const limiter = { acquire: async () => true, pause: (s: number) => void pauses.push(s) };
    ses.errors.push({ status: 429, type: "TooManyRequestsException", message: "slow down" });
    expect(await provider(ses, { limiter }).send(email())).toMatchObject({ ok: false, kind: "retry", status: 429, retryAfterSeconds: 1 });
    ses.errors.push({ status: 429, type: "TooManyRequestsException", message: "slow down", headers: { "retry-after": "7" } });
    expect(await provider(ses, { limiter }).send(email())).toMatchObject({ ok: false, kind: "retry", retryAfterSeconds: 7 });
    expect(pauses).toEqual([1, 7]);
  });

  it("a 5xx, a timeout, a thrown error and a 200 without a MessageId are all unknown", async () => {
    const ses = new FakeSes();
    ses.errors.push({ status: 500, message: "boom" });
    expect(await provider(ses).send(email())).toMatchObject({ ok: false, kind: "unknown", status: 500 });
    ses.errors.push({ status: 0, throws: "socket hang up" });
    expect(await provider(ses).send(email())).toMatchObject({ ok: false, kind: "unknown", status: null });
    ses.errors.push({ status: 200, body: {} });
    expect(await provider(ses).send(email())).toMatchObject({ ok: false, kind: "unknown", status: 200 });
    // No answer within the deadline.
    const hang = new SesProvider({ region: SES_REGION, accessKeyId: SES_ACCESS_KEY_ID, secretAccessKey: SES_SECRET_ACCESS_KEY, timeoutMs: 20, fetch: () => new Promise(() => undefined) });
    expect(await hang.send(email())).toMatchObject({ ok: false, kind: "unknown", error: expect.stringMatching(/did not answer/) });
  });

  it("a local rate wait that is too long is a retry, not an unknown", async () => {
    const ses = new FakeSes();
    const limiter = createRateLimiter({ perSecond: 1, maxWaitMs: 0, now: () => 0, sleep: async () => undefined });
    await limiter.acquire();
    expect(await provider(ses, { limiter }).send(email())).toMatchObject({ ok: false, kind: "retry", code: "local_rate_limit" });
    expect(ses.requests).toHaveLength(0);
  });
});

describe("SES account quota", () => {
  it("reads GetAccount into the quota", async () => {
    const ses = new FakeSes();
    ses.account = { maxSendRate: 14, max24HourSend: 50_000, sentLast24Hours: 120, productionAccessEnabled: false, sendingEnabled: true };
    expect(await provider(ses).getAccountQuota()).toEqual({ maxSendRate: 14, max24HourSend: 50_000, sentLast24Hours: 120, productionAccessEnabled: false, sendingEnabled: true });
    expect(ses.requests[0]).toMatchObject({ method: "GET", path: "/v2/email/account" });
    expect(ses.signatureProblems).toEqual([]);
  });

  it("throws a typed error when SES refuses the keys", async () => {
    const ses = new FakeSes();
    ses.errors.push({ on: /account/, status: 403, type: "UnrecognizedClientException", message: "The security token included in the request is invalid." });
    await expect(provider(ses).getAccountQuota()).rejects.toMatchObject({ kind: "config", status: 403 });
  });
});

describe("the runtime builds the provider by esp.provider", () => {
  it("reports credentials for SES with both keys and no apiKey, and not with one key", () => {
    const ses = { provider: "ses", ses: { accessKeyId: "a", secretAccessKey: "b" } };
    expect(parseEspConfig({ esp: ses })).toMatchObject({ provider: "ses", hasCredentials: true, ses: { region: "eu-north-1" } });
    expect(parseEspConfig({ esp: { provider: "ses", ses: { accessKeyId: "a" } } }).hasCredentials).toBe(false);
    expect(parseEspConfig({ esp: { provider: "resend", ses: { accessKeyId: "a", secretAccessKey: "b" } } }).hasCredentials).toBe(false);
    expect(parseEspConfig({ esp: { provider: "resend", apiKey: API_KEY } }).hasCredentials).toBe(true);
  });

  it("hands the seam { region, accessKeyId, secretAccessKey } for SES and { apiKey } for Resend", async () => {
    const seen: Array<[string, unknown]> = [];
    const t = sesMockSetup();
    t.env.esp = { provider: (key, credentials) => (seen.push([key, credentials]), t.provider) };
    const loaded = await loadMailboxConfig(t.env.ctx, CO);
    expect((await espProviderFor(t.env, loaded, { forSending: true })).ok).toBe(true);
    expect(seen).toEqual([["ses", { region: "eu-north-1", accessKeyId: SES_ACCESS_KEY_ID, secretAccessKey: SES_SECRET_ACCESS_KEY }]]);
    const r = sesMockSetup({ esp: { enabled: true, provider: "resend", apiKey: API_KEY, webhookSecret: "x" } });
    const seenR: Array<[string, unknown]> = [];
    r.env.esp = { provider: (key, credentials) => (seenR.push([key, credentials]), r.provider) };
    expect((await espProviderFor(r.env, await loadMailboxConfig(r.env.ctx, CO), { forSending: false })).ok).toBe(true);
    expect(seenR).toEqual([["resend", { apiKey: API_KEY }]]);
  });

  it("builds the real SES adapter over the fetch when there is no seam, and sends through it", async () => {
    const t = sesSetup();
    const result = await espProviderFor(t.env, await loadMailboxConfig(t.env.ctx, CO), { forSending: true });
    expect(result).toMatchObject({ ok: true, batcher: null });
    if (!result.ok) throw new Error("not ready");
    expect(result.provider.key).toBe("ses");
    expect(await result.provider.send(email())).toMatchObject({ ok: true });
    expect(t.ses.signatureProblems).toEqual([]);
  });

  it("builds no batcher for SES even with esp.batch on, and one for a batching provider", async () => {
    const ses = sesMockSetup({ esp: { enabled: true, provider: "ses", batch: true, ses: { accessKeyId: SES_ACCESS_KEY_ID, secretAccessKey: SES_SECRET_ACCESS_KEY, configurationSet: SES_CONFIGURATION_SET, snsTopicArn: SES_TOPIC_ARN } } });
    expect(await espProviderFor(ses.env, await loadMailboxConfig(ses.env.ctx, CO), { forSending: true })).toMatchObject({ ok: true, batcher: null });
    const resend = sesMockSetup({ esp: { enabled: true, provider: "ses", batch: true, ses: { accessKeyId: SES_ACCESS_KEY_ID, secretAccessKey: SES_SECRET_ACCESS_KEY, configurationSet: SES_CONFIGURATION_SET, snsTopicArn: SES_TOPIC_ARN } } }, { batching: true });
    const built = await espProviderFor(resend.env, await loadMailboxConfig(resend.env.ctx, CO), { forSending: true });
    expect(built.ok && built.batcher).toBeTruthy();
  });

  it("needs the configuration set to send, and says so", async () => {
    const t = sesSetup({ esp: { enabled: true, provider: "ses", ses: { accessKeyId: SES_ACCESS_KEY_ID, secretAccessKey: SES_SECRET_ACCESS_KEY, snsTopicArn: SES_TOPIC_ARN } } });
    const result = await espProviderFor(t.env, await loadMailboxConfig(t.env.ctx, CO), { forSending: true });
    expect(result).toMatchObject({ ok: false, blockers: [expect.stringMatching(/configuration set/)] });
    expect(JSON.stringify(result)).not.toContain(SES_SECRET_ACCESS_KEY);
  });

  it("runs the limiter at min(setting, floor(MaxSendRate)), never below 1, and asks GetAccount at most hourly", async () => {
    expect(effectiveEspRate(10, { maxSendRate: 14 })).toBe(10);
    expect(effectiveEspRate(10, { maxSendRate: 3.9 })).toBe(3);
    expect(effectiveEspRate(10, { maxSendRate: 0.5 })).toBe(1);
    expect(effectiveEspRate(4, null)).toBe(4);

    let clock = 1_000_000;
    const t = sesSetup();
    t.env.now = () => clock;
    t.ses.account.maxSendRate = 2.5;
    const loaded = await loadMailboxConfig(t.env.ctx, CO);
    const first = await espProviderFor(t.env, loaded, { forSending: true });
    expect(first).toMatchObject({ ok: true, quota: { maxSendRate: 2.5, productionAccessEnabled: true } });
    if (!first.ok) throw new Error("not ready");
    await first.provider.send(email());
    expect(limiterRateFor(CO)).toBe(2);
    const account = () => t.ses.requests.filter((r) => r.path === "/v2/email/account").length;
    expect(account()).toBe(1);
    // Many sends and provider lookups within the hour: one GetAccount.
    for (let i = 0; i < 5; i += 1) await espProviderFor(t.env, loaded, { forSending: true });
    expect(account()).toBe(1);
    // After the hour it is read again and the new rate applies.
    clock += QUOTA_TTL_MS + 1;
    t.ses.account.maxSendRate = 1;
    expect(await espProviderFor(t.env, loaded, { forSending: true })).toMatchObject({ ok: true, quota: { maxSendRate: 1 } });
    expect(account()).toBe(2);
    const again = await espProviderFor(t.env, loaded, { forSending: true });
    if (!again.ok) throw new Error("not ready");
    await again.provider.send(email());
    expect(limiterRateFor(CO)).toBe(1);
  });

  it("shares one GetAccount between concurrent callers, and a failed read is null, not a crash", async () => {
    const t = sesSetup();
    const loaded = await loadMailboxConfig(t.env.ctx, CO);
    await Promise.all([1, 2, 3, 4].map(() => espProviderFor(t.env, loaded, { forSending: true })));
    expect(t.ses.requests.filter((r) => r.path === "/v2/email/account")).toHaveLength(1);
    const bad = sesSetup();
    bad.ses.errors.push({ status: 500, on: /account/, message: "down" });
    expect(await espProviderFor(bad.env, await loadMailboxConfig(bad.env.ctx, CO), { forSending: true })).toMatchObject({ ok: true, quota: null });
  });
});

describe("toSesPayload", () => {
  it("leaves out ConfigurationSetName when none is set and keeps the tags as given", () => {
    const body = toSesPayload(email(), { at: new Date("2026-10-09T00:00:00Z") });
    expect(body.ConfigurationSetName).toBeUndefined();
    expect(body.EmailTags).toHaveLength(2);
  });
});

describe("SES domains", () => {
  const DOMAIN = "partnersinbiz.online";
  const calls = (ses: FakeSes, method: string, suffix = "") => ses.identityCalls(method, suffix);

  it("addDomain creates the identity, sets MAIL FROM mail.<domain> on it, and returns three DKIM CNAMEs plus the MAIL FROM MX and TXT", async () => {
    const ses = new FakeSes();
    const domain = await provider(ses).addDomain({ name: DOMAIN });
    expect(calls(ses, "POST")[0]!.body).toEqual({ EmailIdentity: DOMAIN });
    const put = calls(ses, "PUT", "/mail-from");
    expect(put).toHaveLength(1);
    expect(put[0]!.path).toBe(`/v2/email/identities/${DOMAIN}/mail-from`);
    expect(put[0]!.body).toMatchObject({ MailFromDomain: `mail.${DOMAIN}`, BehaviorOnMxFailure: "USE_DEFAULT_VALUE" });
    expect(domain).toMatchObject({ id: DOMAIN, name: DOMAIN, status: "pending", region: SES_REGION, returnPathHost: `mail.${DOMAIN}`, spfInclude: "amazonses.com" });
    const dkim = domain.records.filter((r) => r.type === "CNAME");
    expect(dkim).toHaveLength(3);
    for (const r of dkim) {
      const token = r.name.replace("._domainkey", "");
      expect(r).toMatchObject({ record: "DKIM", fqdn: `${token}._domainkey.${DOMAIN}`, value: `${token}.dkim.amazonses.com` });
    }
    expect(domain.records.find((r) => r.type === "MX")).toMatchObject({ fqdn: `mail.${DOMAIN}`, value: `feedback-smtp.${SES_REGION}.amazonses.com`, priority: 10 });
    expect(domain.records.find((r) => r.type === "TXT")).toMatchObject({ fqdn: `mail.${DOMAIN}`, value: "v=spf1 include:amazonses.com ~all" });
    expect(ses.signatureProblems).toEqual([]);
  });

  it("addDomain on an identity that already exists returns it without error and never calls PutEmailIdentityMailFromAttributes", async () => {
    const ses = new FakeSes();
    ses.identities.set(DOMAIN, { verifiedForSending: true, dkimStatus: "SUCCESS" });
    const domain = await provider(ses).addDomain({ name: DOMAIN });
    expect(calls(ses, "PUT")).toEqual([]);
    expect(domain.status).toBe("verified");
    // No custom MAIL FROM on it: DKIM CNAMEs only, and no return-path host.
    expect(domain.records.map((r) => r.type)).toEqual(["CNAME", "CNAME", "CNAME"]);
    expect(domain.returnPathHost).toBeNull();
  });

  it("an existing identity that has a MAIL FROM keeps it, and its MX and TXT are listed", async () => {
    const ses = new FakeSes();
    ses.identities.set(DOMAIN, { verifiedForSending: true, dkimStatus: "SUCCESS", mailFromDomain: `bounce.${DOMAIN}`, mailFromStatus: "SUCCESS" });
    const domain = await provider(ses).addDomain({ name: DOMAIN });
    expect(calls(ses, "PUT")).toEqual([]);
    expect(domain.returnPathHost).toBe(`bounce.${DOMAIN}`);
    expect(domain.records.filter((r) => r.type !== "CNAME").map((r) => [r.type, r.fqdn, r.status])).toEqual([["MX", `bounce.${DOMAIN}`, "verified"], ["TXT", `bounce.${DOMAIN}`, "verified"]]);
  });

  it("a refused MAIL FROM call on a new identity still returns the identity (default MAIL FROM, no MX or TXT)", async () => {
    const ses = new FakeSes();
    ses.errors.push({ status: 403, type: "AccessDeniedException", on: /mail-from/ });
    const domain = await provider(ses).addDomain({ name: DOMAIN });
    expect(domain.records.map((r) => r.type)).toEqual(["CNAME", "CNAME", "CNAME"]);
  });

  it("verified needs VerifiedForSendingStatus AND DKIM SUCCESS; the other states map as named", async () => {
    const ses = new FakeSes();
    const cases: Array<[Parameters<FakeSes["identities"]["set"]>[1], string]> = [
      [{ verifiedForSending: true, dkimStatus: "SUCCESS" }, "verified"],
      [{ verifiedForSending: false, dkimStatus: "SUCCESS" }, "pending"],
      [{ verifiedForSending: true, dkimStatus: "PENDING" }, "pending"],
      [{ verifiedForSending: false, dkimStatus: "PENDING" }, "pending"],
      [{ verifiedForSending: false, dkimStatus: "FAILED" }, "failed"],
      [{ verifiedForSending: true, dkimStatus: "FAILED" }, "failed"],
      [{ verifiedForSending: false, dkimStatus: "TEMPORARY_FAILURE" }, "temporary_failure"],
      [{ verifiedForSending: false, dkimStatus: "NOT_STARTED" }, "not_started"],
    ];
    for (const [identity, status] of cases) {
      ses.identities.set("x.example.com", identity);
      expect((await provider(ses).getDomain("x.example.com")).status, JSON.stringify(identity)).toBe(status);
    }
  });

  it("getDomain of an identity SES does not have is not_found", async () => {
    await expect(provider(new FakeSes()).getDomain("nope.example.com")).rejects.toMatchObject({ kind: "not_found" });
  });

  it("verifyDomain is a no-op: no request at all", async () => {
    const ses = new FakeSes();
    await provider(ses).verifyDomain(DOMAIN);
    expect(ses.requests).toEqual([]);
  });

  it("listDomains returns DOMAIN identities only, across pages", async () => {
    const ses = new FakeSes();
    ses.identities.set("a.example.com", { type: "DOMAIN", verifiedForSending: true, dkimStatus: "SUCCESS" });
    ses.identities.set("peet@example.com", { type: "EMAIL_ADDRESS", verifiedForSending: true });
    ses.identities.set("b.example.com", { type: "DOMAIN" });
    ses.identities.set("managed.example.com", { type: "MANAGED_DOMAIN" });
    const listed = await provider(ses).listDomains();
    expect(listed.map((d) => d.name)).toEqual(["a.example.com", "b.example.com"]);
    expect(ses.identityCalls("GET").some((r) => r.path === "/v2/email/identities")).toBe(true);
    expect(ses.signatureProblems).toEqual([]);
  });

  it("an SES refusal of the keys is a typed error, and the secret is nowhere in it", async () => {
    const ses = new FakeSes();
    ses.errors.push({ status: 403, type: "AccessDeniedException", message: "not authorized", on: /identities/ });
    const error = await provider(ses).getDomain(DOMAIN).catch((e) => e);
    expect(error).toMatchObject({ kind: "config", status: 403 });
    expect(JSON.stringify(error.message)).not.toContain(SES_SECRET_ACCESS_KEY);
  });
});
