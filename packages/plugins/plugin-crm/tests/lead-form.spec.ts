import { describe, expect, it } from "vitest";
import {
  cleanText,
  clientIp,
  DISPOSABLE_EMAIL_DOMAINS,
  emailHash,
  generateLeadKey,
  generateSigningSecret,
  hashIp,
  headerValue,
  isDisposableEmail,
  isLeadKey,
  isReservedEmail,
  isValidEmail,
  keyId,
  leadCaptureKey,
  LIMITS,
  looksLikeSpam,
  MAX_LINKS,
  oneLine,
  parseAttribution,
  parseBlockedDomains,
  parseSubmission,
  SIGNATURE_SKEW_MS,
  signLeadRequest,
  verifyLeadSignature,
} from "../src/lead-form.js";

describe("lead form keys and signatures", () => {
  it("makes a public key and a secret that look right and never repeat", () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateLeadKey()));
    expect(keys.size).toBe(50);
    for (const key of keys) expect(isLeadKey(key)).toBe(true);
    expect(generateSigningSecret()).toMatch(/^pibs_[a-z2-7]{0}[a-z0-9]{40}$/);
    expect(isLeadKey("pibl_short")).toBe(false);
    expect(isLeadKey("pibl_AAAAAAAAAAAAAAAAAAAAAAAA")).toBe(false);
    expect(isLeadKey(undefined)).toBe(false);
    // A label for a secret reveals nothing of it.
    expect(keyId("pibs_secret")).toHaveLength(8);
    expect("pibs_secret").not.toContain(keyId("pibs_secret"));
  });

  it("accepts a signature over the exact bytes and refuses any other", () => {
    const secret = "pibs_test";
    const body = '{"key":"pibl_x","email":"jane@example.com"}';
    const now = 1_800_000_000_000;
    const timestamp = String(now);
    const signature = signLeadRequest(secret, timestamp, body);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyLeadSignature({ secret, timestamp, signature, rawBody: body, now })).toEqual({ ok: true });
    // One changed byte, another secret, another timestamp.
    expect(verifyLeadSignature({ secret, timestamp, signature, rawBody: body.replace("jane", "joan"), now })).toMatchObject({ ok: false });
    expect(verifyLeadSignature({ secret: "pibs_other", timestamp, signature, rawBody: body, now })).toMatchObject({ ok: false });
    expect(verifyLeadSignature({ secret, timestamp: String(now + 1), signature, rawBody: body, now })).toMatchObject({ ok: false });
    // A shorter or empty signature is refused, not crashed on.
    expect(verifyLeadSignature({ secret, timestamp, signature: "sha256=abc", rawBody: body, now })).toMatchObject({ ok: false });
    expect(verifyLeadSignature({ secret, timestamp, signature: undefined, rawBody: body, now })).toMatchObject({ ok: false });
  });

  it("refuses an old or future timestamp (replay) and a missing one", () => {
    const secret = "pibs_test";
    const body = "{}";
    const now = 1_800_000_000_000;
    for (const stamp of [now - SIGNATURE_SKEW_MS - 1, now + SIGNATURE_SKEW_MS + 1]) {
      const signature = signLeadRequest(secret, String(stamp), body);
      expect(verifyLeadSignature({ secret, timestamp: String(stamp), signature, rawBody: body, now })).toMatchObject({ ok: false, reason: expect.stringMatching(/too far/) });
    }
    const edge = signLeadRequest(secret, String(now - SIGNATURE_SKEW_MS), body);
    expect(verifyLeadSignature({ secret, timestamp: String(now - SIGNATURE_SKEW_MS), signature: edge, rawBody: body, now })).toEqual({ ok: true });
    expect(verifyLeadSignature({ secret, timestamp: undefined, signature: edge, rawBody: body, now })).toMatchObject({ ok: false, reason: expect.stringMatching(/missing/) });
    expect(verifyLeadSignature({ secret, timestamp: "soon", signature: edge, rawBody: body, now })).toMatchObject({ ok: false });
  });
});

describe("the visitor's address", () => {
  it("trusts X-Real-IP (set by the proxy) over X-Forwarded-For, whatever the header's case", () => {
    expect(clientIp({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1, 10.0.0.1" })).toBe("203.0.113.9");
    expect(clientIp({ "X-Forwarded-For": "198.51.100.1, 10.0.0.1" })).toBe("198.51.100.1");
    expect(clientIp({ "x-real-ip": "::ffff:203.0.113.9" })).toBe("203.0.113.9");
    expect(clientIp({ "x-real-ip": ["2001:db8::1"] })).toBe("2001:db8::1");
    expect(clientIp({})).toBeNull();
    expect(clientIp(undefined)).toBeNull();
    // Anything that is not an address is not used.
    expect(clientIp({ "x-real-ip": "'; DROP TABLE x" })).toBeNull();
    expect(headerValue({ "Content-Type": "application/json" }, "content-type")).toBe("application/json");
  });

  it("hashes with a key: the same address and key always give the same hash, another key another hash, and the address is not in it", () => {
    const hash = hashIp("salt-one", "203.0.113.9");
    expect(hash).toBe(hashIp("salt-one", "203.0.113.9"));
    expect(hash).not.toBe(hashIp("salt-two", "203.0.113.9"));
    expect(hash).not.toBe(hashIp("salt-one", "203.0.113.10"));
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).not.toContain("203");
  });
});

describe("text, email and spam checks", () => {
  it("strips control characters (header injection) and caps length", () => {
    expect(cleanText("Jane\r\nBcc: attacker@evil.test", 100)).toBe("Jane Bcc: attacker@evil.test");
    expect(cleanText("a\u0000b\u0007c", 10)).toBe("a b c");
    expect(cleanText("x".repeat(500), 20)).toHaveLength(20);
    expect(cleanText(42, 10)).toBe("");
    expect(cleanText("line one\n\n\n\nline two", 100, true)).toBe("line one\n\nline two");
    expect(cleanText("tab\there", 100)).toBe("tab here");
  });

  it("turns every kind of line break into one plain newline, so a lone CR, NEL or a Unicode separator cannot start a line a markdown reader would see", () => {
    expect(cleanText("a\r\rb", 100, true)).toBe("a\n\nb");
    expect(cleanText("a\r\nb", 100, true)).toBe("a\nb");
    expect(cleanText("a\u2028\u2029b\u0085c", 100, true)).toBe("a\n\nb\nc");
    // On a one-line field every break is a space.
    expect(cleanText("a\rb\u2028c\u0085d\u2029e", 100)).toBe("a b c d e");
    expect(oneLine("a\r\n\r\nb\u2028c\u0085d\u2029e\nf")).toBe("a b c d e f");
    expect(oneLine("no breaks")).toBe("no breaks");
  });

  it("validates an email address the way a form needs", () => {
    for (const ok of ["jane@acme.co.za", "jane.smith+shop@sub.acme.co.za", "a@b.io"]) expect(isValidEmail(ok), ok).toBe(true);
    for (const bad of ["jane", "jane@", "@acme.co.za", "jane@acme", "jane@@acme.co.za", "jane smith@acme.co.za", "jane@acme..co.za", ".jane@acme.co.za", "jane.@acme.co.za", "jane@acme.co.za,other@acme.co.za", "<jane@acme.co.za>", `${"a".repeat(250)}@acme.co.za`]) {
      expect(isValidEmail(bad), bad).toBe(false);
    }
  });

  it("blocks throwaway mailboxes, including their subdomains and the company's own extra list", () => {
    expect(DISPOSABLE_EMAIL_DOMAINS.size).toBeGreaterThan(100);
    expect(isDisposableEmail("x@mailinator.com")).toBe(true);
    expect(isDisposableEmail("x@sub.mailinator.com")).toBe(true);
    expect(isDisposableEmail("x@YOPMAIL.com")).toBe(true);
    expect(isDisposableEmail("x@gmail.com")).toBe(false);
    expect(isDisposableEmail("x@acme.co.za")).toBe(false);
    // `mailinator.com.evil.co.za` is another domain.
    expect(isDisposableEmail("x@mailinator.com.evil.co.za")).toBe(false);
    expect(isDisposableEmail("x@burner.example.org", ["burner.example.org"])).toBe(true);
    expect(isDisposableEmail("x")).toBe(true);
  });

  it("knows the reserved names no real address uses", () => {
    expect(isReservedEmail("canary@canary.invalid")).toBe(true);
    expect(isReservedEmail("x@foo.example")).toBe(true);
    expect(isReservedEmail("x@acme.co.za")).toBe(false);
  });

  it("reads the extra blocked domains from the settings text", () => {
    expect(parseBlockedDomains("Tempmail.Example, @burner.example\nhttps://junk.example/path  ;spam.example")).toEqual(["tempmail.example", "burner.example", "junk.example", "spam.example"]);
    expect(parseBlockedDomains("nodots")).toEqual([]);
    expect(parseBlockedDomains(undefined)).toEqual([]);
  });

  it("calls a message with more than three links spam, and counts www links too", () => {
    const links = (n: number) => Array.from({ length: n }, (_, i) => `https://spam${i}.example`).join(" ");
    expect(MAX_LINKS).toBe(3);
    expect(looksLikeSpam(links(3))).toBe(false);
    expect(looksLikeSpam(links(4))).toBe(true);
    expect(looksLikeSpam("see www.a.example www.b.example www.c.example www.d.example")).toBe(true);
    expect(looksLikeSpam("Hi, I need a quote for SEO.")).toBe(false);
  });
});

describe("reading a submission", () => {
  it("reads a clean one", () => {
    const result = parseSubmission({ email: " Jane@Acme.CO.za ", name: "Jane Smith", phone: "+27 82 123 4567", company: "Acme", message: "Need SEO\nfor my shop", consent: true, consentText: "Yes email me", t: 8000, fields: { service: "SEO", budget: "R10k" }, hp_website: "" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.submission).toMatchObject({ email: "jane@acme.co.za", name: "Jane Smith", phone: "+27 82 123 4567", company: "Acme", message: "Need SEO\nfor my shop", consent: true, consentText: "Yes email me", fillMs: 8000, extra: { service: "SEO", budget: "R10k" }, honeypot: "" });
  });

  it("asks for a usable email in plain words", () => {
    expect(parseSubmission({})).toMatchObject({ ok: false, reason: "invalid", message: expect.stringMatching(/enter your email/) });
    expect(parseSubmission({ email: "nope" })).toMatchObject({ ok: false, reason: "invalid", message: expect.stringMatching(/does not look right/) });
    expect(parseSubmission({ email: "x@mailinator.com" })).toMatchObject({ ok: false, reason: "blocked_email", message: expect.stringMatching(/permanent email/) });
    expect(parseSubmission({ email: "x@mail.test.invalid" })).toMatchObject({ ok: false, reason: "blocked_email" });
    // Only a canary source takes a reserved address.
    expect(parseSubmission({ email: "canary@canary.invalid" }, { allowReserved: true }).ok).toBe(true);
    expect(parseSubmission({ email: "x@burner.example.org" }, { extraBlockedDomains: ["burner.example.org"] })).toMatchObject({ ok: false, reason: "blocked_email" });
  });

  it("caps every field, drops control characters and keeps at most ten short extra fields", () => {
    const result = parseSubmission({
      email: "jane@acme.co.za",
      name: `${"N".repeat(300)}\r\nBcc: x`,
      message: "m".repeat(5000),
      phone: "call me on 082 123 4567 ext <b>1</b>",
      fields: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`Field ${i}`, "v".repeat(1000)])),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.submission.name).toHaveLength(LIMITS.name);
    expect(result.submission.name).not.toMatch(/[\r\n]/);
    expect(result.submission.message).toHaveLength(LIMITS.message);
    expect(result.submission.phone).toBe("082 123 4567 1");
    expect(Object.keys(result.submission.extra)).toHaveLength(LIMITS.extraKeys);
    for (const value of Object.values(result.submission.extra)) expect(value).toHaveLength(LIMITS.extraValue);
  });

  it("does not take a consent that was not ticked, whatever else is sent", () => {
    for (const body of [{ email: "jane@acme.co.za" }, { email: "jane@acme.co.za", consent: false }, { email: "jane@acme.co.za", consent: "no" }, { email: "jane@acme.co.za", consent: 1 }]) {
      const result = parseSubmission(body);
      expect(result.ok && result.submission.consent).toBe(false);
    }
    const ticked = parseSubmission({ email: "jane@acme.co.za", consent: "on" });
    expect(ticked.ok && ticked.submission.consent).toBe(true);
  });

  it("reads campaign tags nested or flat, and keeps only web addresses", () => {
    const nested = parseAttribution({ utm: { source: "google", medium: "cpc", campaign: "spring" }, pageUrl: "https://acme.co.za/contact?x=1#top", referrer: "https://www.google.com/" });
    expect(nested).toMatchObject({ utmSource: "google", utmMedium: "cpc", utmCampaign: "spring", pageUrl: "https://acme.co.za/contact?x=1", referrer: "https://www.google.com/" });
    const flat = parseAttribution({ utm_source: "newsletter", utm_term: "seo durban", gclid: "abc123" });
    expect(flat).toMatchObject({ utmSource: "newsletter", utmTerm: "seo durban", gclid: "abc123" });
    // Not a web address: dropped, not stored.
    expect(parseAttribution({ pageUrl: "javascript:alert(1)", referrer: "data:text/html,x", landingUrl: "ftp://x" })).toMatchObject({ pageUrl: null, referrer: null, landingUrl: null });
    expect(parseAttribution({ utm: { source: "s".repeat(500) } }).utmSource).toHaveLength(LIMITS.utmValue);
    expect(parseAttribution({})).toMatchObject({ utmSource: null, pageUrl: null });
  });

  it("keys one lead per email per source per day, whatever the case", () => {
    const day = new Date("2026-10-03T10:00:00Z");
    const key = leadCaptureKey("src1", "Jane@Acme.co.za", day);
    expect(key).toBe(`form:src1:${emailHash("jane@acme.co.za")}:20261003`);
    expect(leadCaptureKey("src1", " jane@acme.co.za ", new Date("2026-10-03T23:59:00Z"))).toBe(key);
    expect(leadCaptureKey("src1", "jane@acme.co.za", new Date("2026-10-04T00:01:00Z"))).not.toBe(key);
    expect(leadCaptureKey("src2", "jane@acme.co.za", day)).not.toBe(key);
    // The key holds a hash, never the address.
    expect(key).not.toContain("jane");
  });

  it("with the installation's salt the hash is keyed: it is not the plain hash, changes with the salt, and still ignores case and spacing", () => {
    const day = new Date("2026-10-03T10:00:00Z");
    expect(emailHash("jane@acme.co.za", "salt-a")).toMatch(/^[0-9a-f]{16}$/);
    expect(emailHash("jane@acme.co.za", "salt-a")).not.toBe(emailHash("jane@acme.co.za"));
    expect(emailHash("jane@acme.co.za", "salt-a")).not.toBe(emailHash("jane@acme.co.za", "salt-b"));
    expect(emailHash(" Jane@Acme.co.za ", "salt-a")).toBe(emailHash("jane@acme.co.za", "salt-a"));
    const key = leadCaptureKey("src1", "Jane@Acme.co.za", day, "salt-a");
    expect(key).toBe(`form:src1:${emailHash("jane@acme.co.za", "salt-a")}:20261003`);
    expect(key).not.toBe(leadCaptureKey("src1", "jane@acme.co.za", day));
    expect(leadCaptureKey("src1", " jane@acme.co.za ", day, "salt-a")).toBe(key);
  });
});
