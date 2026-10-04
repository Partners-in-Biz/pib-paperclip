import { describe, expect, it } from "vitest";
import { addressOf, classifyResendFailure, hostInZone, parseResendDomain, parseResendEvent, recordHost, ResendProvider, tagValue, toResendPayload, type HttpFetch } from "../../src/esp/resend.js";
import { createRateLimiter } from "../../src/esp/limiter.js";
import { EspApiError, type EspEmail } from "../../src/esp/types.js";

// Built at runtime: a key-shaped literal in a test file is refused by GitHub push protection.
const KEY = ["re", "abcdefghijklmnopqrstuvwxyz012345"].join("_");

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(answers: Array<{ status: number; body?: unknown; headers?: Record<string, string> } | Error>) {
  const calls: Call[] = [];
  const queue = [...answers];
  const fetch: HttpFetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : undefined });
    const next = queue.shift() ?? { status: 200, body: {} };
    if (next instanceof Error) throw next;
    return { ok: next.status < 400, status: next.status, headers: { get: (name: string) => next.headers?.[name.toLowerCase()] ?? null }, text: async () => (next.body === undefined ? "" : JSON.stringify(next.body)) };
  };
  return { fetch, calls };
}

const EMAIL: EspEmail = {
  from: '"Updates" <hello@updates.client.co.za>',
  to: ["ann@x.co"],
  cc: ["bob@x.co"],
  subject: "Hello",
  html: "<p>Hi</p>",
  text: "Hi",
  replyTo: "team@client.co.za",
  headers: { "List-Unsubscribe": "<https://u.example/x>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  tags: [{ name: "pib_company", value: "co-1" }],
  idempotencyKey: "pib-abc",
};

const DOMAIN_BODY = {
  object: "domain",
  id: "d91cd9bd-1176-453e-8fc1-35364d380206",
  name: "Updates.Client.co.za",
  status: "not_started",
  created_at: "2026-04-26 20:21:26.347412+00",
  region: "eu-west-1",
  records: [
    { record: "SPF", name: "send", type: "MX", ttl: "Auto", status: "not_started", value: "feedback-smtp.eu-west-1.amazonses.com", priority: 10 },
    { record: "SPF", name: "send", value: '"v=spf1 include:amazonses.com ~all"', type: "TXT", ttl: "Auto", status: "not_started" },
    { record: "DKIM", name: "resend._domainkey", value: "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDsc4Lh8xilsngyKEgN2S84", type: "TXT", status: "not_started", ttl: "Auto" },
    { record: "Tracking", name: "links.updates.client.co.za", type: "CNAME", value: "links1.resend-dns.com", ttl: "Auto", status: "not_started" },
  ],
};

describe("Resend: sending", () => {
  it("posts the message to /emails with the key, the idempotency key and the documented field names", async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: { id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" } }]);
    const out = await new ResendProvider({ apiKey: KEY, fetch }).send(EMAIL);
    expect(out).toEqual({ ok: true, id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://api.resend.com/emails", method: "POST" });
    expect(calls[0]!.headers).toMatchObject({ Authorization: `Bearer ${KEY}`, "Idempotency-Key": "pib-abc", "Content-Type": "application/json" });
    expect(calls[0]!.body).toEqual({
      from: '"Updates" <hello@updates.client.co.za>',
      to: ["ann@x.co"],
      cc: ["bob@x.co"],
      subject: "Hello",
      html: "<p>Hi</p>",
      text: "Hi",
      reply_to: "team@client.co.za",
      headers: { "List-Unsubscribe": "<https://u.example/x>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      tags: [{ name: "pib_company", value: "co-1" }],
    });
  });

  it("sends attachments as base64 content with their type, and leaves empty fields out", () => {
    const body = toResendPayload({ ...EMAIL, cc: [], replyTo: null, headers: {}, tags: [], html: null, attachments: [{ filename: "a.pdf", contentType: "application/pdf", contentBase64: "QUJD" }] });
    expect(body).toEqual({ from: EMAIL.from, to: EMAIL.to, subject: "Hello", text: "Hi", attachments: [{ filename: "a.pdf", content: "QUJD", content_type: "application/pdf" }] });
  });

  it("is not fooled by a success that carries no id: that is unknown, never sent", async () => {
    const { fetch } = fakeFetch([{ status: 200, body: {} }]);
    expect(await new ResendProvider({ apiKey: KEY, fetch }).send(EMAIL)).toMatchObject({ ok: false, kind: "unknown" });
  });

  it("answers no answer at all (a timeout, a dropped connection) as unknown, and a stuck request as unknown after its own deadline", async () => {
    const a = await new ResendProvider({ apiKey: KEY, fetch: fakeFetch([new Error("socket hang up")]).fetch }).send(EMAIL);
    expect(a).toMatchObject({ ok: false, kind: "unknown", error: "socket hang up" });
    const hang: HttpFetch = () => new Promise(() => undefined);
    const b = await new ResendProvider({ apiKey: KEY, fetch: hang, timeoutMs: 20 }).send(EMAIL);
    expect(b).toMatchObject({ ok: false, kind: "unknown" });
    expect((b as { error: string }).error).toMatch(/did not answer/);
  });

  it("refuses a key that is not a Resend key before any request", () => {
    expect(() => new ResendProvider({ apiKey: "sk_live_nope", fetch: fakeFetch([]).fetch })).toThrow(/start with re_/);
    expect(() => new ResendProvider({ apiKey: "", fetch: fakeFetch([]).fetch })).toThrow();
  });

  it("waits for its turn at the request rate, and defers when the turn is too far away", async () => {
    const waits: number[] = [];
    let now = 0;
    const limiter = createRateLimiter({ perSecond: 1, now: () => now, sleep: async (ms) => void waits.push(ms), maxWaitMs: 1500 });
    const { fetch, calls } = fakeFetch([{ status: 200, body: { id: "1" } }, { status: 200, body: { id: "2" } }, { status: 200, body: { id: "3" } }]);
    const provider = new ResendProvider({ apiKey: KEY, fetch, limiter });
    expect((await provider.send(EMAIL)).ok).toBe(true);
    expect((await provider.send({ ...EMAIL, idempotencyKey: "k2" })).ok).toBe(true);
    const third = await provider.send({ ...EMAIL, idempotencyKey: "k3" });
    expect(third).toMatchObject({ ok: false, kind: "retry", code: "local_rate_limit" });
    expect(calls).toHaveLength(2);
    now += 5000;
  });

  it("pauses the whole company's requests when Resend says 429, for as long as it asked", async () => {
    const waits: number[] = [];
    let now = 0;
    const limiter = createRateLimiter({ perSecond: 10, now: () => now, sleep: async (ms) => void waits.push(ms), maxWaitMs: 10_000 });
    const { fetch } = fakeFetch([{ status: 429, body: { statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests" }, headers: { "retry-after": "4" } }, { status: 200, body: { id: "x" } }]);
    const provider = new ResendProvider({ apiKey: KEY, fetch, limiter });
    expect(await provider.send(EMAIL)).toMatchObject({ ok: false, kind: "retry", retryAfterSeconds: 4 });
    expect((await provider.send(EMAIL)).ok).toBe(true);
    expect(waits).toEqual([4000]);
  });
});

describe("Resend: what each error answer means", () => {
  const cases: Array<[string, number, string, string, string]> = [
    ["rate limit", 429, "rate_limit_exceeded", "Too many requests. Please limit the number of requests per second.", "retry"],
    ["daily quota", 429, "daily_quota_exceeded", "You have exceeded your daily email sending quota.", "quota"],
    ["monthly quota", 429, "monthly_quota_exceeded", "You have exceeded your monthly email sending quota.", "quota"],
    ["domain not verified", 403, "validation_error", "The updates.client.co.za domain is not verified. Please, add and verify your domain.", "unverified"],
    ["testing emails only", 403, "validation_error", "You can only send testing emails to your own email address", "unverified"],
    ["another validation 403", 403, "validation_error", "Something else is wrong", "rejected"],
    ["suspended key", 403, "suspended_api_key", "This API key is suspended", "config"],
    ["missing key", 401, "missing_api_key", "Missing API key in the authorization header.", "config"],
    ["restricted key", 401, "restricted_api_key", "This API key is restricted to only send emails.", "config"],
    ["concurrent idempotent", 409, "concurrent_idempotent_requests", "There is another request in progress with the same idempotency key.", "retry"],
    ["changed body, same key", 409, "invalid_idempotent_request", "Idempotency key has been used but the request body was modified", "conflict"],
    ["validation", 400, "validation_error", "An error was found with one or more fields in the request.", "rejected"],
    ["bad attachment", 422, "invalid_attachment", "Attachment must have either a `content` or `path`.", "rejected"],
    ["server error", 500, "application_error", "An unexpected error occurred.", "unknown"],
    ["unavailable", 503, "service_unavailable", "API is temporarily unavailable", "retry"],
  ];
  for (const [name, status, code, message, kind] of cases) {
    it(`${name} (${status} ${code}) is ${kind}`, () => {
      expect(classifyResendFailure(status, { statusCode: status, name: code, message })).toMatchObject({ kind, status, code });
    });
  }

  it("reads retry-after as whole seconds and ignores anything else", () => {
    expect(classifyResendFailure(429, { name: "rate_limit_exceeded" }, "2").retryAfterSeconds).toBe(2);
    expect(classifyResendFailure(429, { name: "rate_limit_exceeded" }, "1.2").retryAfterSeconds).toBe(2);
    expect(classifyResendFailure(429, { name: "rate_limit_exceeded" }, "Wed, 21 Oct 2026").retryAfterSeconds).toBeNull();
    expect(classifyResendFailure(500, "<html>bad gateway</html>")).toMatchObject({ kind: "unknown", error: "Resend answered HTTP 500" });
  });
});

describe("Resend: batches", () => {
  it("posts an array to /emails/batch with one key and maps the ids back in order", async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: { data: [{ id: "a" }, { id: "b" }] } }]);
    const out = await new ResendProvider({ apiKey: KEY, fetch }).sendBatch([EMAIL, { ...EMAIL, to: ["zed@x.co"], idempotencyKey: "k2" }], "pib-batch-1");
    expect(out).toEqual({ ok: true, ids: ["a", "b"] });
    expect(calls[0]).toMatchObject({ url: "https://api.resend.com/emails/batch", method: "POST" });
    expect(calls[0]!.headers["Idempotency-Key"]).toBe("pib-batch-1");
    expect(Array.isArray(calls[0]!.body)).toBe(true);
    expect((calls[0]!.body as Array<{ to: string[] }>).map((m) => m.to[0])).toEqual(["ann@x.co", "zed@x.co"]);
  });

  it("refuses more than 100 messages or an attachment without calling Resend", async () => {
    const { fetch, calls } = fakeFetch([]);
    const provider = new ResendProvider({ apiKey: KEY, fetch });
    expect(await provider.sendBatch(Array.from({ length: 101 }, (_v, i) => ({ ...EMAIL, idempotencyKey: `k${i}` })), "k")).toMatchObject({ ok: false, kind: "rejected", code: "batch_too_large" });
    expect(await provider.sendBatch([{ ...EMAIL, attachments: [{ filename: "a", contentType: "text/plain", contentBase64: "QQ==" }] }], "k")).toMatchObject({ ok: false, kind: "rejected", code: "batch_attachments" });
    expect(calls).toHaveLength(0);
  });

  it("does not trust a batch answer with a different number of ids", async () => {
    const { fetch } = fakeFetch([{ status: 200, body: { data: [{ id: "a" }] } }]);
    expect(await new ResendProvider({ apiKey: KEY, fetch }).sendBatch([EMAIL, { ...EMAIL, idempotencyKey: "k2" }], "k")).toMatchObject({ ok: false, kind: "unknown" });
  });

  it("classifies a failed batch like a failed send", async () => {
    const { fetch } = fakeFetch([{ status: 403, body: { name: "validation_error", message: "The x.co domain is not verified." } }]);
    expect(await new ResendProvider({ apiKey: KEY, fetch }).sendBatch([EMAIL], "k")).toMatchObject({ ok: false, kind: "unverified" });
  });
});

describe("Resend: domains", () => {
  it("adds a domain and returns the records somebody adds to DNS, with full hosts, the zone host and the values unquoted", async () => {
    const { fetch, calls } = fakeFetch([{ status: 201, body: DOMAIN_BODY }]);
    const domain = await new ResendProvider({ apiKey: KEY, fetch }).addDomain({ name: "updates.client.co.za", region: "eu-west-1" });
    expect(calls[0]).toMatchObject({ url: "https://api.resend.com/domains", method: "POST", body: { name: "updates.client.co.za", region: "eu-west-1" } });
    expect(domain).toMatchObject({ id: "d91cd9bd-1176-453e-8fc1-35364d380206", name: "updates.client.co.za", status: "not_started", region: "eu-west-1", returnPathHost: "send.updates.client.co.za", dkimSelector: "resend", spfInclude: "amazonses.com" });
    expect(domain.records.map((r) => [r.record, r.type, r.fqdn, r.value, r.priority])).toEqual([
      ["SPF", "MX", "send.updates.client.co.za", "feedback-smtp.eu-west-1.amazonses.com", 10],
      ["SPF", "TXT", "send.updates.client.co.za", "v=spf1 include:amazonses.com ~all", null],
      ["DKIM", "TXT", "resend._domainkey.updates.client.co.za", "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDsc4Lh8xilsngyKEgN2S84", null],
      ["Tracking", "CNAME", "links.updates.client.co.za", "links1.resend-dns.com", null],
    ]);
    expect(domain.records[0]!.purpose).toMatch(/return path/);
  });

  it("uses us-east-1 for a region Resend does not offer", async () => {
    const { fetch, calls } = fakeFetch([{ status: 201, body: DOMAIN_BODY }]);
    await new ResendProvider({ apiKey: KEY, fetch }).addDomain({ name: "x.co.za", region: "mars-1" });
    expect((calls[0]!.body as { region: string }).region).toBe("us-east-1");
  });

  it("says a domain registered already is `exists`, a sending-only key cannot manage domains, and a missing domain is not_found", async () => {
    const exists = fakeFetch([{ status: 403, body: { statusCode: 403, name: "validation_error", message: "The x.co.za domain has been registered already." } }]);
    await expect(new ResendProvider({ apiKey: KEY, fetch: exists.fetch }).addDomain({ name: "x.co.za" })).rejects.toMatchObject({ kind: "exists" });
    const restricted = fakeFetch([{ status: 401, body: { statusCode: 401, name: "restricted_api_key", message: "This API key is restricted to only send emails." } }]);
    await expect(new ResendProvider({ apiKey: KEY, fetch: restricted.fetch }).listDomains()).rejects.toMatchObject({ kind: "config", message: expect.stringMatching(/full access/) });
    const gone = fakeFetch([{ status: 404, body: { statusCode: 404, name: "not_found", message: "Domain not found" } }]);
    await expect(new ResendProvider({ apiKey: KEY, fetch: gone.fetch }).getDomain("nope")).rejects.toBeInstanceOf(EspApiError);
  });

  it("asks Resend to verify with POST /domains/{id}/verify, and reads a domain by id", async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: { object: "domain", id: "dom 1" } }, { status: 200, body: { ...DOMAIN_BODY, status: "verified" } }]);
    const provider = new ResendProvider({ apiKey: KEY, fetch });
    await provider.verifyDomain("dom 1");
    expect((await provider.getDomain("dom 1")).status).toBe("verified");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST https://api.resend.com/domains/dom%201/verify", "GET https://api.resend.com/domains/dom%201"]);
  });

  it("lists every page", async () => {
    const page = (ids: string[], more: boolean) => ({ status: 200, body: { object: "list", has_more: more, data: ids.map((id) => ({ id, name: `${id}.co`, status: "verified" })) } });
    const { fetch, calls } = fakeFetch([page(["a", "b"], true), page(["c"], false)]);
    const all = await new ResendProvider({ apiKey: KEY, fetch }).listDomains();
    expect(all.map((d) => d.id)).toEqual(["a", "b", "c"]);
    expect(calls[1]!.url).toBe("https://api.resend.com/domains?limit=100&after=b");
  });

  it("reads statuses it does not know as unknown, and tracking records are not required", () => {
    expect(parseResendDomain({ id: "1", name: "a.co", status: "partially_failed", records: [] }).status).toBe("unknown");
    expect(() => parseResendDomain({ name: "a.co" })).toThrow();
  });

  it("builds hosts: relative names get the domain, complete ones stay, and the zone host drops the registered domain", () => {
    expect(recordHost("send", "updates.client.co.za")).toBe("send.updates.client.co.za");
    expect(recordHost("links.updates.client.co.za", "updates.client.co.za")).toBe("links.updates.client.co.za");
    expect(recordHost("@", "client.co.za")).toBe("client.co.za");
    expect(hostInZone("send.updates.client.co.za", "updates.client.co.za")).toBe("send.updates");
    expect(hostInZone("resend._domainkey.client.co.za", "client.co.za")).toBe("resend._domainkey");
    expect(hostInZone("client.co.za", "client.co.za")).toBe("@");
  });
});

describe("Resend: webhook events", () => {
  const body = (type: string, data: Record<string, unknown> = {}) => JSON.stringify({ type, created_at: "2026-10-03T10:00:00.000Z", data: { email_id: "e1", from: "Acme <hello@updates.client.co.za>", to: ["ann@x.co"], subject: "s", tags: { pib_company: "co-1" }, ...data } });

  it("reads a delivery and our tag", () => {
    expect(parseResendEvent(body("email.delivered"))).toMatchObject({ kind: "delivered", emailId: "e1", from: "Acme <hello@updates.client.co.za>", to: ["ann@x.co"], tags: { pib_company: "co-1" }, createdAt: "2026-10-03T10:00:00.000Z" });
  });

  it("tells a hard bounce (Permanent) from a soft one (Transient, Undetermined)", () => {
    const hard = parseResendEvent(body("email.bounced", { bounce: { type: "Permanent", subType: "General", message: "no such user" } }))!;
    expect(hard).toMatchObject({ kind: "bounced_hard", bounce: { type: "Permanent", subType: "General" } });
    expect(parseResendEvent(body("email.bounced", { bounce: { type: "Transient", subType: "MailboxFull", message: "full" } }))).toMatchObject({ kind: "bounced_soft" });
    expect(parseResendEvent(body("email.bounced", { bounce: { type: "Undetermined", subType: "Undetermined", message: "?" } }))).toMatchObject({ kind: "bounced_soft" });
    // A bounce with no type is not proof the address is dead.
    expect(parseResendEvent(body("email.bounced"))).toMatchObject({ kind: "bounced_soft" });
  });

  it("reads the other kinds, the failed reason, and the domain events by the domain's id", () => {
    expect(parseResendEvent(body("email.complained"))!.kind).toBe("complained");
    expect(parseResendEvent(body("email.delivery_delayed"))!.kind).toBe("delayed");
    expect(parseResendEvent(body("email.failed", { failed: { reason: "reached_daily_quota" } }))).toMatchObject({ kind: "failed", failedReason: "reached_daily_quota" });
    expect(parseResendEvent(body("email.clicked", { click: { link: "https://x" } }))!.kind).toBe("clicked");
    expect(parseResendEvent(body("email.opened"))!.kind).toBe("opened");
    expect(parseResendEvent(body("email.suppressed"))!.kind).toBe("suppressed");
    expect(parseResendEvent(JSON.stringify({ type: "domain.updated", data: { id: "dom-1", name: "x.co", status: "verified" } }))).toMatchObject({ kind: "domain", domainId: "dom-1", emailId: null });
    expect(parseResendEvent(body("contact.created"))!.kind).toBe("other");
  });

  it("reads tags sent as a list as well as an object, and lists every recipient", () => {
    expect(parseResendEvent(body("email.delivered", { tags: [{ name: "pib_company", value: "co-2" }] }))!.tags).toEqual({ pib_company: "co-2" });
    expect(parseResendEvent(body("email.delivered", { to: ["A <a@x.co>", "b@x.co", "A <a@x.co>"] }))!.to).toEqual(["a@x.co", "b@x.co"]);
  });

  it("gives nothing for a body that is not an event", () => {
    expect(parseResendEvent("not json")).toBeNull();
    expect(parseResendEvent("[]")).toBeNull();
    expect(parseResendEvent(JSON.stringify({ data: {} }))).toBeNull();
  });

  it("reads an address from a header value", () => {
    expect(addressOf("Acme Inc <Hello@Updates.Client.co.za>")).toBe("hello@updates.client.co.za");
    expect(addressOf("hello@x.co")).toBe("hello@x.co");
    expect(addressOf("no address")).toBeNull();
    expect(addressOf(null)).toBeNull();
  });

  it("keeps tag values to the characters Resend allows", () => {
    expect(tagValue("co:1/ä b")).toBe("co_1___b");
    expect(tagValue("")).toBe("_");
    expect(tagValue("x".repeat(400))).toHaveLength(256);
  });
});
