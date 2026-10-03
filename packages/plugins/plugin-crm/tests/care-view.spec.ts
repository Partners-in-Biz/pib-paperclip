import { describe, expect, it } from "vitest";
import { consentLine, actionLine, actionTone, bandTone, canSendReport, careVisible, lastMonth, relativeHours, reportLine, reportTone, severityTone, siteLine, slaLine, type CareActionView, type CareCaseView, type CareSiteView, type CareView } from "../src/ui/care-view.js";

const NOW = Date.parse("2026-10-03T10:00:00.000Z");
const H = 3_600_000;
const at = (hours: number) => new Date(NOW + hours * H).toISOString();

function caseView(extra: Partial<CareCaseView> = {}): CareCaseView {
  return { caseId: "c1", title: "Site slow", severity: "normal", status: "open", source: "manual", firstResponseDueAt: at(5), resolutionDueAt: at(60), firstResponseAt: null, resolvedAt: null, sla: { firstResponse: "ok", resolution: "ok" }, issueId: null, ...extra };
}

function siteView(extra: Partial<CareSiteView> = {}): CareSiteView {
  return { siteId: "s1", url: "https://acme.co.za/", monitored: true, status: "up", downMinutes: 0, lastCheckedAt: at(-0.1), certificate: { expiresAt: at(24 * 60), daysLeft: 60, problem: null }, domain: { name: "acme.co.za", expiresAt: at(24 * 400), daysLeft: 400, manual: false, problem: null }, ...extra };
}

describe("how long ago or how far off", () => {
  it("says hours, then days, past or future", () => {
    expect(relativeHours(at(3), NOW)).toBe("in 3 h");
    expect(relativeHours(at(-2), NOW)).toBe("2 h ago");
    expect(relativeHours(at(0.2), NOW)).toBe("in under an hour");
    expect(relativeHours(at(72), NOW)).toBe("in 3 days");
    expect(relativeHours(at(-100), NOW)).toBe("4 days ago");
    expect(relativeHours(null, NOW)).toBeNull();
    expect(relativeHours("never", NOW)).toBeNull();
  });
});

describe("a case's targets in one line", () => {
  it("shows the one that matters now: overdue first, then close to running out, then what is next", () => {
    expect(slaLine(caseView({ sla: { firstResponse: "breached", resolution: "ok" }, firstResponseDueAt: at(-2) }), NOW)).toEqual({ text: "First response overdue (was due 2 h ago)", tone: "bad" });
    expect(slaLine(caseView({ firstResponseAt: at(-1), sla: { firstResponse: "met", resolution: "breached" }, resolutionDueAt: at(-30) }), NOW)).toEqual({ text: "Resolution overdue (was due 30 h ago)", tone: "bad" });
    expect(slaLine(caseView({ sla: { firstResponse: "at_risk", resolution: "ok" } }), NOW)).toEqual({ text: "First response due in 5 h", tone: "warn" });
    expect(slaLine(caseView({ firstResponseAt: at(-1), sla: { firstResponse: "met", resolution: "at_risk" } }), NOW)).toEqual({ text: "Resolution due in 3 days", tone: "warn" });
    expect(slaLine(caseView(), NOW)).toEqual({ text: "First response due in 5 h", tone: "neutral" });
    expect(slaLine(caseView({ firstResponseAt: at(-1), sla: { firstResponse: "met", resolution: "ok" } }), NOW)).toEqual({ text: "Resolution due in 3 days", tone: "neutral" });
    expect(slaLine(caseView({ firstResponseAt: at(-1), status: "waiting_client", sla: { firstResponse: "met", resolution: "paused" } }), NOW).tone).toBe("info");
    expect(slaLine(caseView({ status: "resolved", resolvedAt: at(-1) }), NOW)).toEqual({ text: "Resolved", tone: "ok" });
  });

  it("colours severity", () => {
    expect([severityTone("urgent"), severityTone("high"), severityTone("normal"), severityTone("low")]).toEqual(["bad", "warn", "neutral", "neutral"]);
  });
});

describe("a request to a client in one line", () => {
  const action = (extra: Partial<CareActionView> = {}): CareActionView => ({ actionId: "a1", kind: "sign_off", title: "Approve", status: "waiting", to: "Ada <ada@acme.co.za>", link: "https://x.test/p/1", requestedAt: at(-96), waitingDays: 4, reminders: 1, nextReminderAt: at(48), dueAt: at(-24), escalated: false, answer: null, ...extra });

  it("says how long it has waited, the reminders, the next one, the date wanted and who it went to", () => {
    expect(actionLine(action(), NOW)).toBe("asked 4 days ago · 1 reminder · next reminder in 2 days · wanted 24 h ago · to Ada <ada@acme.co.za>");
    expect(actionLine(action({ waitingDays: 0, reminders: 0, nextReminderAt: null, dueAt: null }), NOW)).toBe("asked today · 0 reminders · to Ada <ada@acme.co.za>");
    expect(actionLine(action({ escalated: true, nextReminderAt: null }), NOW)).toContain("the Account Manager is reaching them another way");
    expect(actionLine(action({ status: "done", answer: "Approved by phone", dueAt: at(-24) }), NOW)).toBe("answer: Approved by phone · to Ada <ada@acme.co.za>");
    expect(actionLine(action({ status: "draft", waitingDays: null, requestedAt: null, reminders: 0, nextReminderAt: null, dueAt: null }), NOW)).toBe("to Ada <ada@acme.co.za>");
  });

  it("is red when the client could not be reached, amber when they replied and nobody has read it", () => {
    expect(actionTone({ status: "waiting", escalated: true })).toBe("bad");
    expect(actionTone({ status: "replied", escalated: false })).toBe("warn");
    expect(actionTone({ status: "done", escalated: false })).toBe("ok");
    expect(actionTone({ status: "waiting", escalated: false })).toBe("info");
    expect(actionTone({ status: "cancelled", escalated: false })).toBe("neutral");
  });
});

describe("a website in one line", () => {
  it("says up or down, when it was last checked, the certificate and the domain", () => {
    expect(siteLine(siteView(), NOW)).toEqual({ text: "Up · checked under an hour ago · certificate 60 days left · domain 400 days left", tone: "ok" });
    expect(siteLine(siteView({ status: "down", downMinutes: 12 }), NOW).tone).toBe("bad");
    expect(siteLine(siteView({ status: "down", downMinutes: 12 }), NOW).text).toMatch(/^Down for 12 min/);
    expect(siteLine(siteView({ certificate: { expiresAt: at(24 * 10), daysLeft: 10, problem: null } }), NOW).tone).toBe("warn");
    expect(siteLine(siteView({ certificate: { expiresAt: at(-24), daysLeft: -1, problem: null } }), NOW)).toMatchObject({ tone: "bad", text: expect.stringContaining("certificate expired") });
    expect(siteLine(siteView({ domain: { name: "acme.co.za", expiresAt: at(24 * 5), daysLeft: 5, manual: true, problem: null } }), NOW).tone).toBe("bad");
    expect(siteLine(siteView({ domain: { name: "acme.co.za", expiresAt: null, daysLeft: null, manual: false, problem: "The registry lookup answered 404." } }), NOW).text).toContain("domain expiry unknown");
    expect(siteLine(siteView({ certificate: { expiresAt: null, daysLeft: null, problem: "TLS failed (ECONNRESET)." } }), NOW).text).toContain("TLS failed (ECONNRESET).");
    expect(siteLine(siteView({ monitored: false }), NOW)).toEqual({ text: "Monitoring paused", tone: "neutral" });
    expect(siteLine(siteView({ status: "unknown" }), NOW)).toEqual({ text: "Not checked yet", tone: "neutral" });
  });
});

describe("reports and the card", () => {
  const report = (extra: Record<string, unknown> = {}) => ({ reportId: "r1", period: "2026-09", periodLabel: "September 2026", status: "built" as const, narrativeWritten: false, builtAt: null, sentAt: null, issueId: null, ...extra });

  it("names a report's state and offers sending only when the summary is written", () => {
    expect(reportLine(report())).toBe("September 2026: Being written (summary not written)");
    expect(reportLine(report({ narrativeWritten: true }))).toBe("September 2026: Being written");
    expect(reportLine(report({ status: "sent" }))).toBe("September 2026: Sent");
    expect(canSendReport(report())).toBe(false);
    expect(canSendReport(report({ narrativeWritten: true }))).toBe(true);
    expect(canSendReport(report({ narrativeWritten: true, status: "awaiting_approval" }))).toBe(false);
    expect([reportTone("sent"), reportTone("awaiting_approval"), reportTone("built"), reportTone("skipped")]).toEqual(["ok", "info", "warn", "neutral"]);
    expect([bandTone("healthy"), bandTone("watch"), bandTone("at_risk")]).toEqual(["ok", "warn", "bad"]);
  });

  it("last month is the South African month before this one", () => {
    expect(lastMonth(new Date("2026-10-03T10:00:00Z"))).toBe("2026-09");
    expect(lastMonth(new Date("2027-01-01T00:00:00Z"))).toBe("2026-12");
    expect(lastMonth(new Date("2026-10-31T22:30:00Z"))).toBe("2026-10");
  });

  it("is shown for a customer, or anything with data, never for an empty lead", () => {
    const care = (extra: Partial<CareView> = {}): CareView => ({ customer: false, health: null, cases: [], actions: [], reports: [], sites: [], feedback: { items: [], nps: null }, sensitivity: { level: "standard", reason: null, keepOffSystems: [] }, consent: [], ...extra });
    expect(careVisible(null)).toBe(false);
    expect(careVisible(care())).toBe(false);
    expect(careVisible(care({ customer: true }))).toBe(true);
    expect(careVisible(care({ sites: [siteView()] }))).toBe(true);
    expect(careVisible(care({ sensitivity: { level: "sensitive", reason: "x", keepOffSystems: [] } }))).toBe(true);
  });

  it("says what a person agreed to, on what basis, from where and when; a withdrawal and an expiry show", () => {
    const base = { person: "Ada", purpose: "marketing_email", basis: "legitimate_interest", granted: true, source: "unsubscribe_link", recordedAt: "2026-10-03T08:00:00.000Z", expiresAt: null };
    expect(consentLine(base)).toBe("Ada: marketing email, legitimate interest (unsubscribe link), 2026-10-03");
    expect(consentLine({ ...base, granted: false })).toBe("Ada: marketing email, withdrawn (unsubscribe link), 2026-10-03");
    expect(consentLine({ ...base, expiresAt: "2020-01-01T00:00:00Z" })).toMatch(/, expired$/);
    expect(consentLine({ ...base, purpose: "odd", basis: "odd" })).toBe("Ada: odd, odd (unsubscribe link), 2026-10-03");
  });
});
