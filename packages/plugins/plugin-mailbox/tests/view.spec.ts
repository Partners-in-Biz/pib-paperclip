import { describe, expect, it } from "vitest";
import { MAP_TYPE_NAMES, canSendFrom, connectReadiness, domainFacts, domainStatusLabel, domainTone, draftRecipients, missingTechnical, moduleName, recentTime, sendBlock, sentBy, suggestMapping } from "../src/ui/view.js";
import { draftView, isoTime } from "../src/worker.js";

const READY = { saved: true, publicBaseUrl: "https://paperclip.example.com", encryptionKey: true, googleClientSecret: true };

describe("connecting Gmail from the page", () => {
  it("names the missing technical settings and disables Connect until they are saved", () => {
    expect(missingTechnical({ saved: true, publicBaseUrl: null, encryptionKey: false, googleClientSecret: false })).toEqual(["Public base URL", "Token encryption key", "Google client secret"]);
    expect(missingTechnical(READY)).toEqual([]);
    expect(connectReadiness(READY)).toEqual({ ready: true, reason: null });
    expect(connectReadiness({ ...READY, googleClientSecret: false })).toEqual({ ready: false, reason: "An admin first does the one-time technical setup." });
    expect(connectReadiness({ ...READY, saved: false }).ready).toBe(false);
    expect(connectReadiness(null).ready).toBe(false);
  });
});

describe("sending a draft from the page", () => {
  const gmail = { id: "acc-g", address: "peet@pib.test", status: "connected", has_credential: true };
  const manual = { id: "acc-m", address: "ada@northwind.test", status: "manual", has_credential: false };
  const draft = { status: "draft", account_id: "acc-g", to_addrs: [{ email: "ada@x.test" }], cc_addrs: [], bcc_addrs: [] };

  it("can send from a connected Gmail account (or one that needs reconnecting, as the worker does)", () => {
    expect(canSendFrom(gmail)).toBe(true);
    expect(canSendFrom({ ...gmail, status: "needs_reconnect" })).toBe(true);
    expect(canSendFrom(manual)).toBe(false);
    expect(canSendFrom(null)).toBe(false);
  });

  it("says why Send is off: Gmail not connected, no recipient, or both", () => {
    expect(sendBlock(draft, [gmail])).toBeNull();
    expect(sendBlock({ ...draft, to_addrs: [] }, [gmail])).toBe("Add a recipient first.");
    expect(sendBlock({ ...draft, to_addrs: [], cc_addrs: [{ email: "c@x.test" }] }, [gmail])).toBeNull();
    expect(sendBlock({ ...draft, account_id: "acc-m" }, [gmail, manual])).toBe("Connect Gmail for ada@northwind.test first.");
    // The review's "Hello Northwind": no recipient, on a mailbox without Gmail.
    expect(sendBlock({ ...draft, account_id: "acc-m", to_addrs: [] }, [gmail, manual])).toBe("Connect Gmail for ada@northwind.test first, and add a recipient.");
    expect(sendBlock({ ...draft, account_id: "gone" }, [gmail])).toBe("Connect Gmail first.");
    expect(sendBlock({ ...draft, status: "queued" }, [])).toBeNull();
    expect(draftRecipients({ ...draft, bcc_addrs: [{ email: "b@x.test" }] })).toEqual(["ada@x.test", "b@x.test"]);
  });
});

describe("page wording", () => {
  it("names modules, not plugin ids", () => {
    expect(moduleName("partnersinbiz.billing")).toBe("Billing");
    expect(moduleName("acme.time_sheets")).toBe("Time sheets");
    expect(sentBy({ sourcePlugin: "partnersinbiz.billing", context: { plugin: "partnersinbiz.billing", kind: "invoice" } })).toBe("Billing · invoice");
    expect(sentBy({ sourcePlugin: "partnersinbiz.campaigns", context: null })).toBe("Campaigns · mail");
    expect(sentBy({ sourcePlugin: "x", context: { plugin: "partnersinbiz.campaigns", kind: "campaign_step" } })).toBe("Campaigns · campaign step");
  });

  it("shows the last day relatively; older times are left to the shared date format", () => {
    const now = new Date("2026-09-27T12:00:00Z");
    expect(recentTime("2026-09-27T11:59:40Z", now)).toBe("just now");
    expect(recentTime("2026-09-27T11:15:00Z", now)).toBe("45 min ago");
    expect(recentTime("2026-09-27T07:00:00Z", now)).toBe("5 h ago");
    expect(recentTime("2026-09-20T07:00:00Z", now)).toBeNull();
    expect(recentTime(null, now)).toBeNull();
    expect(recentTime("not a date", now)).toBeNull();
  });
});

describe("draft rows for the page", () => {
  it("carry the body, every recipient, who drafted it and an ISO time", () => {
    const view = draftView({
      id: "d-1", account_id: "acc-m", subject: "Hello Northwind", body: "Hi Ada", status: "draft", direction: "outbound", is_read: false,
      to_addrs: [], cc_addrs: null, bcc_addrs: [{ email: "b@x.test" }], draft: { html: "<p>Hi</p>", replyToMessageId: "m-1", by: { kind: "agent", id: "agent-am" } },
      send_error: null, created_at: "2026-09-25 17:09:53.906307+02",
    });
    expect(view).toMatchObject({
      body: "Hi Ada", to_addrs: [], cc_addrs: [], bcc_addrs: [{ email: "b@x.test" }], created_at: "2026-09-25T15:09:53.906Z",
      drafted_by: { kind: "agent", id: "agent-am" }, is_reply: true, has_html: true,
    });
    expect(draftView({ id: "d-2", account_id: "a", subject: "s", body: null, status: "draft", direction: "outbound", is_read: false, to_addrs: null, cc_addrs: null, bcc_addrs: null, draft: null, send_error: null, created_at: null }))
      .toMatchObject({ body: "", to_addrs: [], drafted_by: null, created_at: null, is_reply: false });
    expect(isoTime(new Date("2026-09-01T00:00:00Z"))).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("sender domains and client mail on the page", () => {
  it("words a domain's status and picks its pill", () => {
    expect(["healthy", "warn", "bad", "unknown"].map(domainStatusLabel)).toEqual(["Healthy", "Needs attention", "Problem", "Not known yet"]);
    expect(["healthy", "warn", "bad", "unknown", "anything"].map(domainTone)).toEqual(["ok", "warn", "bad", "neutral", "neutral"]);
  });

  it("sums up SPF, DKIM, DMARC and MX in one line, and says when DNS could not be read", () => {
    expect(domainFacts({ mx: "ok", spf: "missing", dkim: "ok", dmarc: "none" })).toBe("MX ok · SPF missing · DKIM ok · DMARC monitoring (p=none)");
    expect(domainFacts({ mx: "ok", spf: "ok", dkim: "ok", dmarc: "reject" })).toBe("MX ok · SPF ok · DKIM ok · DMARC p=reject");
    expect(domainFacts({ mx: null, spf: "unreadable", dkim: null, dmarc: "unreadable" })).toBe("MX not read · SPF unreadable · DKIM not read · DMARC unreadable");
  });

  it("suggests the sender's domain as a starting mapping, and nothing for a sender without one", () => {
    expect(suggestMapping({ from: { email: "WordPress@AHSLaw.co.za" } })).toEqual({ matchType: "sender_domain", pattern: "ahslaw.co.za" });
    expect(suggestMapping({ from: null })).toBeNull();
    expect(suggestMapping({ from: { email: "no-at-sign" } })).toBeNull();
    expect(Object.keys(MAP_TYPE_NAMES)).toEqual(["sender_domain", "sender_address", "recipient_domain", "recipient_address"]);
  });
});

describe("the email provider on the page", () => {
  const cap = (over: Partial<{ cap: number; day: number | null; warming: boolean; source: string; sentToday: number; remaining: number }> = {}) => ({ cap: 50, day: 1, warming: true, source: "warm-up", sentToday: 12, remaining: 38, ...over });

  it("says in words whether a domain is ready, waiting for records, or wrong", async () => {
    const { espStatusLabel, espStatusTone } = await import("../src/ui/view.js");
    expect([espStatusLabel({ status: "verified", ready: true }), espStatusTone({ status: "verified", ready: true })]).toEqual(["Ready to send", "ok"]);
    expect([espStatusLabel({ status: "pending", ready: false }), espStatusTone({ status: "pending", ready: false })]).toEqual(["Waiting for DNS records", "warn"]);
    expect([espStatusLabel({ status: "not_started", ready: false }), espStatusLabel({ status: "temporary_failure", ready: false })]).toEqual(["Waiting for DNS records", "Could not read the DNS"]);
    expect([espStatusLabel({ status: "failed", ready: false }), espStatusTone({ status: "failed", ready: false })]).toEqual(["Records wrong", "bad"]);
    expect(espStatusLabel({ status: "verified", ready: false })).toBe("Verified, account not connected");
  });

  it("shows today's cap with where it comes from", async () => {
    const { espCapLine } = await import("../src/ui/view.js");
    expect(espCapLine({ cap: cap() })).toBe("12 of 50 today · warm-up day 1 of 13");
    expect(espCapLine({ cap: cap({ cap: 10_000, day: 14, warming: false, source: "steady", sentToday: 0 }) })).toMatch(/^0 of 10.000 today$/);
    expect(espCapLine({ cap: cap({ cap: 300, day: null, warming: false, source: "override", sentToday: 300 }) })).toMatch(/300 of 300 today · set by a person/);
    expect(espCapLine({ cap: cap({ source: "established", warming: false, day: null }) })).toMatch(/marked as established/);
  });

  it("puts the last 7 days next to the limits", async () => {
    const { espReputationLine } = await import("../src/ui/view.js");
    expect(espReputationLine({ reputation: null })).toBe("Nothing sent in the last 7 days");
    expect(espReputationLine({ reputation: { sent: 0, hardBounces: 0, complaints: 0, bounceRate: null, complaintRate: null, problems: [] } })).toBe("Nothing sent in the last 7 days");
    expect(espReputationLine({ reputation: { sent: 100, hardBounces: 2, complaints: 1, bounceRate: 0.02, complaintRate: 0.01, problems: [] } })).toBe("2 bounced (2.0%, limit 2%) · 1 complaint (1.0%, limit 0.1%) of 100 sent in 7 days");
    expect(espReputationLine({ reputation: { sent: 2000, hardBounces: 0, complaints: 2, bounceRate: 0, complaintRate: 0.001, problems: [] } })).toMatch(/0 bounced \(0\.00%, limit 2%\) · 2 complaints \(0\.10%, limit 0\.1%\)/);
  });

  it("writes a DNS record as one line a person can read out", async () => {
    const { dnsRecordLine } = await import("../src/ui/view.js");
    expect(dnsRecordLine({ type: "MX", host: "send.updates.client.co.za", priority: 10, value: "feedback-smtp.eu-west-1.amazonses.com" })).toBe("MX  send.updates.client.co.za  10  feedback-smtp.eu-west-1.amazonses.com");
    expect(dnsRecordLine({ type: "TXT", host: "_dmarc.updates.client.co.za", priority: null, value: "v=DMARC1; p=none" })).toBe("TXT  _dmarc.updates.client.co.za  v=DMARC1; p=none");
  });
});
