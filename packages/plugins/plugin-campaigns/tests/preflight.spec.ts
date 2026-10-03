import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { checkLinks, classifyLink, evaluatePreflight, linkProblem, preflightLines, type PreflightFacts } from "../src/preflight.js";
import { setMessagingProvider } from "../src/messaging.js";
import type { CampaignStepDraft } from "../src/domain.js";
import { boot, campaign, CO, seed, step } from "./helpers/harness.js";
import { MockProvider } from "./helpers/mock-provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
  setMessagingProvider(null);
});

const email = (over: Partial<CampaignStepDraft> = {}): CampaignStepDraft => ({ position: 1, delayDays: 0, subject: "Hello", body: "Hi {{first_name}}, your boiler is due.", htmlBody: null, variant: "a", channel: "email", ...over });
const text = (channel: "sms" | "whatsapp", over: Partial<CampaignStepDraft> = {}): CampaignStepDraft => ({ position: 1, delayDays: 0, subject: "", body: "Hi {{first_name}}, 10% off this week.", htmlBody: null, variant: "a", channel, ...over });

const ownOk = { ok: true as const, senderKey: "own", identity: null, fromName: "Partners in Biz", replyTo: null };
const clientOk = { ok: true as const, senderKey: "company:acme", identity: { senderKey: "company:acme", fromAddress: "hello@acme.test", fromName: "Acme", replyTo: "b@acme.test" }, fromName: "Acme", replyTo: "b@acme.test" };

function facts(over: Partial<PreflightFacts> = {}): PreflightFacts {
  return {
    campaign: { name: "Spring", delivery: "email", clientKind: null, clientRef: null, clientName: null },
    steps: [email()],
    email: ownOk,
    emailHealth: { status: "ok", detail: "", checkedAt: null },
    mailboxOn: true,
    linkProblem: null,
    oneClick: true,
    channels: {},
    audience: null,
    liveLinks: null,
    ...over,
  };
}

const codes = (result: ReturnType<typeof evaluatePreflight>) => [...result.errors, ...result.warnings].map((f) => f.code);

describe("preflight rules", () => {
  it("passes a complete own email campaign and says who it goes out as", () => {
    const result = evaluatePreflight(facts());
    expect(result).toMatchObject({ ok: true, errors: [], warnings: [], sentAs: "Partners in Biz (the Mailbox's default account)" });
  });

  it("refuses an empty campaign and steps with nothing to send", () => {
    expect(codes(evaluatePreflight(facts({ steps: [] })))).toContain("no-steps");
    const empty = evaluatePreflight(facts({ steps: [email({ subject: " ", body: "" })] }));
    expect(empty.errors.map((e) => e.code)).toEqual(["empty-subject", "empty-body"]);
    expect(evaluatePreflight(facts({ steps: [email({ body: "", htmlBody: "<p>designed</p>" })] })).ok).toBe(true);
    expect(codes(evaluatePreflight(facts({ campaign: { ...facts().campaign, delivery: "auto" }, steps: [text("sms", { body: "" })], channels: { sms: { ready: true, reason: null, sentFrom: "+14155550100", senderError: null } } })))).toContain("empty-body");
  });

  it("a client's campaign needs its own sender; own marketing may use the default account", () => {
    const client = { name: "Spring", delivery: "email" as const, clientKind: "company" as const, clientRef: "acme", clientName: "Acme" };
    const none = evaluatePreflight(facts({ campaign: client, email: { ok: false, senderKey: "company:acme", error: "No sender is set up for company:acme" } }));
    expect(none.errors).toEqual([expect.objectContaining({ code: "no-sender", message: expect.stringContaining("No sender is set up") })]);
    const ok = evaluatePreflight(facts({ campaign: client, email: clientOk }));
    expect(ok.ok).toBe(true);
    expect(ok.sentAs).toBe("Acme <hello@acme.test>, replies to b@acme.test");
  });

  it("only an automatic campaign has a sender to check: an agent sending by hand does not", () => {
    const client = { name: "Spring", delivery: "issue" as const, clientKind: "company" as const, clientRef: "acme", clientName: "Acme" };
    const result = evaluatePreflight(facts({ campaign: client, email: { ok: false, senderKey: "company:acme", error: "No sender" }, mailboxOn: false, linkProblem: null, oneClick: false }));
    expect(result).toMatchObject({ ok: true, sentAs: null, warnings: [] });
  });

  it("issue delivery: the step issues carry the footer, and a missing unsubscribe link is a warning (never silent, never an error for a hand-sent email)", () => {
    const client = { name: "Spring", delivery: "issue" as const, clientKind: "company" as const, clientRef: "acme", clientName: "Acme" };
    const result = evaluatePreflight(facts({ campaign: client, email: null, mailboxOn: false, linkProblem: "no url", oneClick: false }));
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([expect.objectContaining({ code: "no-unsubscribe-link", message: expect.stringMatching(/reply STOP.* only.*no url/) })]);
    // Own work warns the same way; with a link nothing is said; a campaign with no email step is not asked about it.
    const own = { name: "Spring", delivery: "issue" as const, clientKind: null, clientRef: null, clientName: null };
    expect(codes(evaluatePreflight(facts({ campaign: own, email: null, linkProblem: "no url" })))).toEqual(["no-unsubscribe-link"]);
    expect(codes(evaluatePreflight(facts({ campaign: own, email: null, linkProblem: null })))).toEqual([]);
    expect(codes(evaluatePreflight(facts({ campaign: client, email: null, steps: [], linkProblem: "no url" })))).not.toContain("no-unsubscribe-link");
  });

  it("the sender's domain: bad blocks, a warning and an unknown report are shown, ok is quiet", () => {
    const base = { email: clientOk, campaign: { name: "x", delivery: "email" as const, clientKind: "company" as const, clientRef: "acme", clientName: "Acme" } };
    expect(codes(evaluatePreflight(facts({ ...base, emailHealth: { status: "bad", detail: "No SPF record", checkedAt: null } })))).toEqual(["domain-bad"]);
    expect(codes(evaluatePreflight(facts({ ...base, emailHealth: { status: "warn", detail: "DMARC is p=none", checkedAt: null } })))).toEqual(["domain-warn"]);
    expect(codes(evaluatePreflight(facts({ ...base, emailHealth: null })))).toEqual(["domain-unknown"]);
    expect(codes(evaluatePreflight(facts({ ...base, emailHealth: { status: "unknown", detail: "", checkedAt: null } })))).toEqual(["domain-unknown"]);
    expect(codes(evaluatePreflight(facts({ ...base, emailHealth: { status: "ok", detail: "", checkedAt: null } })))).toEqual([]);
    expect(evaluatePreflight(facts({ ...base, emailHealth: null })).warnings[0]!.message).toContain("from acme.test");
  });

  it("without an unsubscribe link a client's email is refused and PiB's own is warned; no one-click header is a warning", () => {
    const client = { name: "x", delivery: "email" as const, clientKind: "company" as const, clientRef: "acme", clientName: "Acme" };
    const refused = evaluatePreflight(facts({ campaign: client, email: clientOk, linkProblem: "The public address is not set" }));
    expect(refused.errors).toEqual([expect.objectContaining({ code: "no-unsubscribe-link" })]);
    const own = evaluatePreflight(facts({ linkProblem: "The public address is not set" }));
    expect(own.ok).toBe(true);
    expect(own.warnings.map((w) => w.code)).toEqual(["no-unsubscribe-link"]);
    expect(codes(evaluatePreflight(facts({ oneClick: false })))).toEqual(["no-one-click"]);
  });

  it("warns on a client campaign with no reply-to and on tokens it does not fill", () => {
    const client = { name: "x", delivery: "email" as const, clientKind: "company" as const, clientRef: "acme", clientName: "Acme" };
    expect(codes(evaluatePreflight(facts({ campaign: client, email: { ...clientOk, replyTo: null } })))).toContain("no-reply-to");
    const tokens = evaluatePreflight(facts({ steps: [email({ body: "Hi {{firstname}} and {{first_name|there}} {{ unsubscribe_url }}" })] }));
    expect(tokens.warnings).toEqual([expect.objectContaining({ code: "unknown-token", message: expect.stringContaining("{{firstname}}") })]);
  });

  it("links: a test address is an error, http and an unfilled token are warnings", () => {
    const result = evaluatePreflight(facts({ steps: [email({ body: "See https://staging.acme.co.za/offer, http://acme.co.za/a, https://acme.co.za/{{token}} and https://acme.co.za/ok" })] }));
    expect(result.errors.map((e) => e.message)).toEqual([expect.stringContaining("https://staging.acme.co.za/offer looks like a test or private address")]);
    expect(result.warnings.map((w) => w.message).join(" ")).toMatch(/not https/);
    expect(result.warnings.map((w) => w.message).join(" ")).toMatch(/still has a \{\{token\}\}/);
    for (const url of ["http://localhost:3000/x", "https://192.168.1.4/x", "https://127.0.0.1/x", "https://app.local/x", "https://example.com/x", "https://dev.acme.co.za/x", "https://acme.internal/x", "https://shop.test/x"]) {
      expect(linkProblem(url), url).toMatchObject({ level: "error" });
    }
    expect(linkProblem("https://acme.co.za/spring")).toBeNull();
  });

  it("live links: 404, 410 and an unknown host are errors; a site that blocks robots or is slow is a warning", () => {
    expect(classifyLink({ url: "u", status: 200, error: null })).toBe("ok");
    expect(classifyLink({ url: "u", status: 301, error: null })).toBe("ok");
    expect(classifyLink({ url: "u", status: 404, error: null })).toBe("broken");
    expect(classifyLink({ url: "u", status: 410, error: null })).toBe("broken");
    expect(classifyLink({ url: "u", status: 403, error: null })).toBe("unsure");
    expect(classifyLink({ url: "u", status: 503, error: null })).toBe("unsure");
    expect(classifyLink({ url: "u", status: null, error: "getaddrinfo ENOTFOUND nope.test" })).toBe("broken");
    expect(classifyLink({ url: "u", status: null, error: "timed out" })).toBe("unsure");
    const result = evaluatePreflight(facts({ liveLinks: [{ url: "https://a.co.za/gone", status: 404, error: null }, { url: "https://b.co.za", status: 403, error: null }, { url: "https://c.co.za", status: 200, error: null }] }));
    expect(result.errors.map((e) => e.code)).toEqual(["broken-link"]);
    expect(result.warnings.map((w) => w.code)).toEqual(["link-unsure"]);
  });

  it("a text channel that is not configured stops the campaign, and says what to do", () => {
    const sms = evaluatePreflight(facts({ campaign: { ...facts().campaign, delivery: "auto" }, steps: [text("sms")], channels: { sms: { ready: false, reason: "Twilio is not set up for this company yet.", sentFrom: null, senderError: null } } }));
    expect(sms.errors).toEqual([expect.objectContaining({ code: "channel-not-ready", message: expect.stringContaining("SMS steps cannot go out: Twilio is not set up"), fix: expect.stringContaining("Setup page") })]);
    // A client without its own number is refused too.
    const noNumber = evaluatePreflight(facts({ campaign: { ...facts().campaign, delivery: "auto" }, steps: [text("sms")], channels: { sms: { ready: true, reason: null, sentFrom: null, senderError: "No SMS number is set up for company:acme" } } }));
    expect(codes(noNumber)).toContain("no-sender-number");
    // And a text step in a campaign that is not automatic.
    expect(codes(evaluatePreflight(facts({ steps: [text("sms")], channels: { sms: { ready: true, reason: null, sentFrom: "+1", senderError: null } } })))).toContain("needs-auto");
  });

  it("SMS: more than three parts and characters that force UCS-2 are warnings; over the provider's limit is an error", () => {
    const auto = { ...facts().campaign, delivery: "auto" as const };
    const ready = { sms: { ready: true, reason: null, sentFrom: "+14155550100", senderError: null } };
    expect(codes(evaluatePreflight(facts({ campaign: auto, steps: [text("sms", { body: "a".repeat(500) })], channels: ready })))).toEqual(["sms-parts"]);
    const smart = evaluatePreflight(facts({ campaign: auto, steps: [text("sms", { body: "Don’t miss it" })], channels: ready }));
    expect(smart.warnings).toEqual([expect.objectContaining({ code: "sms-ucs2", message: expect.stringContaining("70 characters a part") })]);
    expect(codes(evaluatePreflight(facts({ campaign: auto, steps: [text("sms", { body: "a".repeat(1700) })], channels: ready })))).toContain("sms-too-long");
    expect(evaluatePreflight(facts({ campaign: auto, steps: [text("sms")], channels: ready })).ok).toBe(true);
  });

  it("WhatsApp: no template is a warning, a template without an opt-out line is a warning", () => {
    const auto = { ...facts().campaign, delivery: "auto" as const };
    const ready = { whatsapp: { ready: true, reason: null, sentFrom: "+14155238886", senderError: null } };
    expect(codes(evaluatePreflight(facts({ campaign: auto, steps: [text("whatsapp")], channels: ready })))).toEqual(["whatsapp-template"]);
    expect(codes(evaluatePreflight(facts({ campaign: auto, steps: [text("whatsapp", { templateRef: "HX0123456789abcdef0123456789abcdef" })], channels: ready })))).toEqual(["whatsapp-stop"]);
    expect(evaluatePreflight(facts({ campaign: auto, steps: [text("whatsapp", { templateRef: "HX0123456789abcdef0123456789abcdef", body: "Hi. Reply STOP to opt out." })], channels: ready })).ok).toBe(true);
    // Copy that only contains the word does not say how to opt out.
    for (const body of ["Stop paying too much for power. Offer ends Friday.", "We are next to the bus stop on Main Rd"]) {
      expect(codes(evaluatePreflight(facts({ campaign: auto, steps: [text("whatsapp", { templateRef: "HX0123456789abcdef0123456789abcdef", body })], channels: ready }))), body).toEqual(["whatsapp-stop"]);
    }
  });

  it("who can receive each channel: nobody is an error, some is a warning", () => {
    const auto = { ...facts().campaign, delivery: "auto" as const };
    const ready = { sms: { ready: true, reason: null, sentFrom: "+14155550100", senderError: null } };
    const contacts = [{}, {}, {}, {}] as never;
    const none = evaluatePreflight(facts({ campaign: auto, steps: [text("sms")], channels: ready, audience: { contacts, reach: { email: 4, sms: 0, whatsapp: 0 } } }));
    expect(none.errors).toEqual([expect.objectContaining({ code: "nobody-reachable", fix: expect.stringContaining("record-channel-consent") })]);
    const some = evaluatePreflight(facts({ campaign: auto, steps: [text("sms")], channels: ready, audience: { contacts, reach: { email: 4, sms: 3, whatsapp: 0 } } }));
    expect(some.warnings).toEqual([expect.objectContaining({ code: "partly-reachable", message: expect.stringContaining("3 of 4 contacts") })]);
    expect(codes(evaluatePreflight(facts({ audience: { contacts, reach: { email: 0, sms: 0, whatsapp: 0 } } })))).toContain("nobody-reachable");
    expect(evaluatePreflight(facts({ audience: { contacts: [] as never, reach: { email: 0, sms: 0, whatsapp: 0 } } })).ok).toBe(true);
  });

  it("the Mailbox being off stops an automatic email campaign", () => {
    expect(codes(evaluatePreflight(facts({ mailboxOn: false })))).toEqual(["mailbox-off"]);
  });

  it("writes errors and warnings as lines for the approval issue", () => {
    const result = evaluatePreflight(facts({ oneClick: false, steps: [email({ subject: "" })] }));
    expect(preflightLines(result)).toEqual([expect.stringMatching(/^- \*\*Fix before approval:\*\* Step 1 has no subject/), expect.stringMatching(/^- Check: The one-click unsubscribe header/)]);
  });
});

describe("checking links on the web", () => {
  const ctxWith = (fetch: (url: string, init: RequestInit) => Promise<Response>) => ({ http: { fetch } }) as unknown as PluginContext;

  it("asks each distinct link once, follows redirects, falls back to GET when HEAD is refused, and reports an unknown host", async () => {
    const seen: string[] = [];
    const ctx = ctxWith(async (url, init) => {
      seen.push(`${init.method} ${url}`);
      if (url.includes("gone.co.za")) throw new Error("getaddrinfo ENOTFOUND gone.co.za");
      if (url.includes("robots.co.za")) return new Response(null, { status: init.method === "HEAD" ? 405 : 200 });
      if (url === "https://moved.co.za/old") return new Response(null, { status: 301, headers: { location: "https://www.moved.co.za/new" } });
      if (url.includes("missing.co.za")) return new Response(null, { status: 404 });
      return new Response(null, { status: 200 });
    });
    const out = await checkLinks(ctx, ["https://ok.co.za/a", "https://ok.co.za/a", "https://robots.co.za/x", "https://moved.co.za/old", "https://missing.co.za/p", "https://gone.co.za/", "http://localhost/skip", "https://x.test/skip"]);
    expect(out.map((c) => [c.url, c.status])).toEqual([["https://ok.co.za/a", 200], ["https://robots.co.za/x", 200], ["https://moved.co.za/old", 200], ["https://missing.co.za/p", 404], ["https://gone.co.za/", null]]);
    expect(out.find((c) => c.url === "https://gone.co.za/")!.error).toMatch(/ENOTFOUND/);
    expect(seen.filter((s) => s.includes("ok.co.za"))).toHaveLength(1);
    expect(seen).toContain("GET https://robots.co.za/x");
    expect(seen).toContain("HEAD https://www.moved.co.za/new");
    // A test address is never asked.
    expect(seen.some((s) => s.includes("localhost"))).toBe(false);
  });

  it("checks at most twelve links", async () => {
    const ctx = ctxWith(async () => new Response(null, { status: 200 }));
    const out = await checkLinks(ctx, Array.from({ length: 30 }, (_v, i) => `https://site${i}.co.za/`));
    expect(out).toHaveLength(12);
  });
});

describe("the approval request runs the checks", () => {
  it("is refused with a broken link, and goes through (with a warning) when the site only blocks robots", async () => {
    const s = seed();
    s.campaigns!.push(campaign("camp-1", { status: "draft", audience_tags: ["vip"], owner_user_id: "user-peet" }));
    s.campaign_steps!.push(step("camp-1", 1, "a", "Offer", "See https://acme.co.za/gone and https://blocked.co.za/x"));
    const { harness } = await boot({ store: s });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(null, { status: String(url).includes("gone") ? 404 : 403 })));
    const refused = await harness.executeTool<{ error?: string }>("request-campaign-approval", { campaignId: "camp-1" }, { companyId: CO, agentId: "agent-camp" });
    expect(refused.error).toMatch(/Fix these before asking for approval/);
    expect(refused.error).toContain("https://acme.co.za/gone does not work (404)");
    s.campaign_steps![0]!.body = "See https://blocked.co.za/x";
    const asked = await harness.executeTool<{ data: { warnings: string[]; approvalIssueId: string } }>("request-campaign-approval", { campaignId: "camp-1" }, { companyId: CO, agentId: "agent-camp" });
    expect(asked.data.warnings.some((w) => /blocked\.co\.za\/x could not be confirmed/.test(w))).toBe(true);
    const issue = await harness.ctx.issues.get(asked.data.approvalIssueId, CO);
    expect(issue!.description).toContain("**Check before approving:**");
  });

  it("preflight-campaign shows the same findings without asking for approval, and can skip the web", async () => {
    const s = seed();
    s.campaigns!.push(campaign("camp-1", { status: "draft", delivery: "email" }));
    s.campaign_steps!.push(step("camp-1", 1, "a", "Offer", "See https://nowhere.co.za/page"));
    const { harness } = await boot({ store: s });
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const skipped = await harness.executeTool<{ data: { ok: boolean } }>("preflight-campaign", { campaignId: "camp-1", links: false }, { companyId: CO, agentId: "agent-camp" });
    expect(skipped.data.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const checked = await harness.executeTool<{ data: { ok: boolean; errors: Array<{ code: string }> } }>("preflight-campaign", { campaignId: "camp-1" }, { companyId: CO, agentId: "agent-camp" });
    expect(checked.data.ok).toBe(false);
    expect(checked.data.errors.map((e) => e.code)).toEqual(["broken-link"]);
    expect(s.campaigns![0]!.approval_issue_id ?? null).toBeNull();
    expect((await harness.executeTool<{ error?: string }>("preflight-campaign", { campaignId: "nope" }, { companyId: CO, agentId: "agent-camp" })).error).toMatch(/not found/);
  });

  it("counts who can receive a text campaign, so the approver sees the opt-ins it relies on", async () => {
    const s = seed();
    s.crm_contacts![0]!.phones = ["082 123 4567"];
    s.crm_contacts![1]!.phones = ["083 555 0001"];
    s.campaigns!.push(campaign("camp-1", { status: "draft", delivery: "auto", audience_tags: ["vip"], owner_user_id: "user-peet" }));
    s.campaign_steps!.push({ ...step("camp-1", 1, "a", "", "Hi {{first_name}}"), channel: "sms" });
    s.channel_consents = [{ company_id: CO, channel: "sms", address: "+27821234567", sender_key: "own", granted: true, basis: "consent", source: "form", recorded_at: "2026-09-01T00:00:00.000Z" }];
    const mock = new MockProvider();
    const { harness } = await boot({ store: s, config: { timezone: "Africa/Johannesburg", publicBaseUrl: "https://paperclip.test", messaging: { smsFrom: "+14155550100" } } });
    setMessagingProvider(() => mock);
    const asked = await harness.executeTool<{ data: { approvalIssueId: string; willGet: number } }>("request-campaign-approval", { campaignId: "camp-1" }, { companyId: CO, agentId: "agent-camp" });
    expect(asked.data.willGet).toBe(1);
    const issue = await harness.ctx.issues.get(asked.data.approvalIssueId, CO);
    expect(issue!.description).toContain("- **SMS:** from +14155550100. Only sent Mon-Fri 08:00-20:00, Sat 09:00-13:00, Sun closed (Africa/Johannesburg). 1 of 3 contacts have a mobile number and a recorded opt-in for this sender");
    expect(issue!.description).toContain("**SMS** (after 0 days, 1 SMS part)");
    expect(issue!.description).toContain("Hi {{first_name}} Reply STOP to opt out.");
    expect(issue!.description).toMatch(/2 have no mobile number or no opt-in on record and are left out/);
  });
});
