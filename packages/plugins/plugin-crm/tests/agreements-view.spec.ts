import { describe, expect, it } from "vitest";
import {
  agreementsVisible,
  canSend,
  canWithdraw,
  channelLine,
  docTone,
  esignLine,
  orderDocs,
  siteKeyLine,
  valueText,
  type AgreementDocView,
  type AgreementsView,
  type GrowthView,
  type SiteKeyView,
} from "../src/ui/agreements-view.js";
import { readFileSync } from "node:fs";

const NOW = Date.parse("2026-10-03T10:00:00.000Z");
const H = 3_600_000;
const at = (hours: number) => new Date(NOW + hours * H).toISOString();

function doc(extra: Partial<AgreementDocView> = {}): AgreementDocView {
  return { documentId: "d1", kind: "proposal", title: "SEO retainer", status: "draft", statusLine: "Draft: not sent.", to: "Ada", dealId: null, quoteId: null, valueMinor: null, currency: null, createdAt: at(-10), sentAt: null, viewedAt: null, expiresAt: null, signedAt: null, signerName: null, ...extra };
}

function agreements(extra: Partial<AgreementsView> = {}): AgreementsView {
  return { allowed: false, canary: false, enabledBy: null, enabledAt: null, templatesReviewed: false, templateVersion: "2026-10-v1", documents: [], ...extra };
}

function growth(extra: Partial<GrowthView> = {}): GrowthView {
  return { days: 90, channels: [], totals: { firstLeads: 0, revenue: "none" }, unattributedLeads: 0, siteKeys: [], site: null, ...extra };
}

function key(extra: Partial<SiteKeyView> = {}): SiteKeyView {
  return { id: "k1", label: "Acme site", site: "https://acme.co.za", status: "active", consentMode: "anonymous", counted: 0, lastEventAt: null, warnings: [], ...extra };
}

describe("a document in the list", () => {
  it("shows what a person has to look at first, then the signed ones, newest first", () => {
    const ordered = orderDocs([
      doc({ documentId: "signed-old", status: "signed", createdAt: at(-100) }),
      doc({ documentId: "void", status: "void", createdAt: at(-5) }),
      doc({ documentId: "draft", status: "draft", createdAt: at(-1) }),
      doc({ documentId: "viewed", status: "viewed", createdAt: at(-50) }),
      doc({ documentId: "signed-new", status: "signed", createdAt: at(-20) }),
      doc({ documentId: "waiting", status: "awaiting_approval", createdAt: at(-2) }),
      doc({ documentId: "expired", status: "expired", createdAt: at(-3) }),
    ]);
    expect(ordered.map((d) => d.documentId)).toEqual(["viewed", "waiting", "draft", "expired", "signed-new", "signed-old", "void"]);
  });

  it("only a draft or an expired document can be sent, and only while e-sign is on", () => {
    for (const status of ["draft", "expired"] as const) {
      expect(canSend({ status }, true)).toBe(true);
      expect(canSend({ status }, false)).toBe(false);
    }
    for (const status of ["awaiting_approval", "sent", "viewed", "signed", "declined", "void"] as const) expect(canSend({ status }, true)).toBe(false);
  });

  it("a signed document can never be withdrawn, and a withdrawn one needs no second withdrawal", () => {
    expect(canWithdraw({ status: "signed" })).toBe(false);
    expect(canWithdraw({ status: "void" })).toBe(false);
    for (const status of ["draft", "awaiting_approval", "sent", "viewed", "declined", "expired"] as const) expect(canWithdraw({ status })).toBe(true);
  });

  it("colours the status by what it means", () => {
    expect(docTone("signed")).toBe("ok");
    expect(docTone("declined")).toBe("bad");
    expect(docTone("expired")).toBe("warn");
    expect(docTone("viewed")).toBe("info");
    expect(docTone("draft")).toBe("neutral");
  });

  it("writes the value the same on every machine, or nothing", () => {
    expect(valueText({ valueMinor: 450_000, currency: "ZAR" })).toBe("ZAR 4500.00");
    expect(valueText({ valueMinor: null, currency: "ZAR" })).toBeNull();
    expect(valueText({ valueMinor: 100, currency: null })).toBeNull();
  });
});

describe("the e-sign line", () => {
  it("says it is off, and that agents cannot prepare documents", () => {
    const line = esignLine(agreements());
    expect(line.text).toMatch(/off for this client/);
    expect(line.tone).toBe("neutral");
  });

  it("says when a lawyer has not reviewed the templates, as a warning, never as legal advice", () => {
    const line = esignLine(agreements({ allowed: true, enabledBy: "user:local-board" }));
    expect(line.text).toMatch(/drafts no lawyer has reviewed/);
    expect(line.text).toMatch(/turned on by a person/);
    expect(line.text).not.toMatch(/local-board/);
    expect(line.tone).toBe("warn");
  });

  it("says the owner reported a review, without claiming one itself", () => {
    const line = esignLine(agreements({ allowed: true, templatesReviewed: true }));
    expect(line.text).toMatch(/owner said a lawyer reviewed/);
    expect(line.tone).toBe("ok");
  });

  it("explains the practice client", () => {
    expect(esignLine(agreements({ canary: true, allowed: true })).text).toMatch(/practice client/);
  });
});

describe("site counters and channels", () => {
  it("says a paused counter counts nothing", () => {
    expect(siteKeyLine(key({ status: "paused" }), NOW)).toEqual({ text: "Paused: nothing is counted", tone: "neutral" });
  });

  it("says a counter that never counted probably is not installed, as a warning", () => {
    expect(siteKeyLine(key({ warnings: ["No event has arrived yet."] }), NOW)).toEqual({ text: "Nothing counted yet: the snippet is probably not installed", tone: "warn" });
    expect(siteKeyLine(key(), NOW).tone).toBe("neutral");
  });

  it("says how many were counted and how long ago", () => {
    expect(siteKeyLine(key({ counted: 42, lastEventAt: at(-3) }), NOW)).toEqual({ text: "42 counted, last 3 h ago", tone: "ok" });
    expect(siteKeyLine(key({ counted: 9, lastEventAt: at(-96) }), NOW).text).toBe("9 counted, last 4 days ago");
    expect(siteKeyLine(key({ counted: 1, lastEventAt: at(-0.1) }), NOW).text).toBe("1 counted, last under an hour ago");
  });

  it("describes a channel row and leaves out what is zero", () => {
    expect(channelLine({ firstLeads: 5, lastLeads: 3, qualified: 0, won: 0, revenue: "none" })).toBe("5 first-touch · 3 last-touch");
    expect(channelLine({ firstLeads: 5, lastLeads: 6, qualified: 2, won: 1, revenue: "ZAR 4500.00" })).toBe("5 first-touch · 6 last-touch · 2 qualified · 1 won · ZAR 4500.00");
  });
});

describe("when the card shows", () => {
  it("shows for a client the worker could read agreements for, and for one with channels or counters", () => {
    expect(agreementsVisible(agreements(), null)).toBe(true);
    expect(agreementsVisible(null, growth({ channels: [{ channel: "organic_search", label: "Organic search", firstLeads: 1, lastLeads: 1, qualified: 0, won: 0, revenue: "none", cost: "none" }] }))).toBe(true);
    expect(agreementsVisible(null, growth({ siteKeys: [key()] }))).toBe(true);
  });

  it("stays away when there is nothing to read", () => {
    expect(agreementsVisible(null, null)).toBe(false);
    expect(agreementsVisible(undefined, growth())).toBe(false);
  });

  it("the timeline knows a signed document: the activity the worker writes has a label and a look", () => {
    // overview.tsx needs React, which the worker tests do not load: read its text.
    const overview = readFileSync(new URL("../src/ui/overview.tsx", import.meta.url), "utf8");
    const written = readFileSync(new URL("../src/esign.ts", import.meta.url), "utf8");
    expect(written).toContain('kind: "document_signed"');
    expect(overview).toContain('document_signed: "Document signed"');
    expect(overview).toMatch(/document_signed: \{ tone: "ok"/);
  });
});
