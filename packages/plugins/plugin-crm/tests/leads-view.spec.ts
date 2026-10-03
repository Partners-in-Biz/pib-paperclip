import { describe, expect, it } from "vitest";
import { formEditable, formFacts, FORM_STATUS_LABEL, formStatusTone, leadOrigin, leadReach, leadsLine, type LeadFormView } from "../src/ui/leads-view.js";
import { stateTone, STATE_LABEL } from "../src/ui/checklist-view.js";
import { anyProfileField, missingFields, type ClientProfileView } from "../src/ui/profile-view.js";

const when = (at: string | null) => (at ? "2 days ago" : null);
const form = (extra: Partial<LeadFormView> = {}): LeadFormView => ({
  id: "f1", label: "Contact form", status: "active", canary: false, key: "pibl_x", site: "https://www.acme.co.za", ownedBy: "client", accepted: 0, rejected: 0, lastLeadAt: null,
  serverSecret: { set: false }, consentText: null, privacyUrl: null, turnstile: false, previousKeyValidUntil: null, embed: null, ...extra,
});

describe("the lead form card's wording", () => {
  it("says how a form is doing in one line", () => {
    expect(leadsLine(form(), when)).toBe("No lead yet");
    expect(leadsLine(form({ accepted: 1, lastLeadAt: "2026-10-01" }), when)).toBe("1 lead, the last 2 days ago");
    expect(leadsLine(form({ accepted: 5, lastLeadAt: null }), when)).toBe("5 leads");
    expect(formFacts(form({ accepted: 3, lastLeadAt: "x", rejected: 2, turnstile: true, serverSecret: { set: true, keyId: "ab12cd34" } }), when)).toBe("3 leads, the last 2 days ago · 2 refused (spam or a bad address) · Turnstile check on · server secret ab12cd34 · www.acme.co.za");
    expect(formFacts(form({ site: null }), when)).toBe("No lead yet");
  });

  it("names the status and its tone, and only an unswitched form can be changed", () => {
    expect(FORM_STATUS_LABEL).toEqual({ active: "Taking leads", paused: "Paused", revoked: "Switched off" });
    expect(formStatusTone("active")).toBe("ok");
    expect(formStatusTone("paused")).toBe("warn");
    expect(formStatusTone("revoked")).toBe("neutral");
    expect(formEditable({ status: "active" })).toBe(true);
    expect(formEditable({ status: "paused" })).toBe(true);
    expect(formEditable({ status: "revoked" })).toBe(false);
  });

  it("shows a form lead's contact details and where it came from", () => {
    expect(leadReach({ email: "jane@acme.co.za", phone: "082 123 4567" })).toBe("jane@acme.co.za · 082 123 4567");
    expect(leadReach({ email: "jane@acme.co.za" })).toBe("jane@acme.co.za");
    expect(leadReach({})).toBe("");
    expect(leadOrigin({ sourceLabel: "Contact form", attribution: { utmSource: "google", utmMedium: "cpc", utmCampaign: "spring", pageUrl: "https://www.acme.co.za/contact" }, consent: true })).toBe("Contact form · via google / cpc / spring · on acme.co.za/contact · marketing email ticked");
    expect(leadOrigin({ sourceLabel: "Quote form", attribution: {}, consent: false })).toBe("Quote form · marketing email not ticked");
    expect(leadOrigin(null)).toBe("");
    expect(leadOrigin({})).toBe("");
  });
});

describe("the new-client card's wording", () => {
  it("has a label and a tone for every state", () => {
    expect(STATE_LABEL).toEqual({ done: "Done", todo: "To do", unknown: "Check", waits: "Waiting" });
    expect(stateTone("done")).toBe("ok");
    expect(stateTone("todo")).toBe("warn");
    expect(stateTone("unknown")).toBe("info");
    expect(stateTone("waits")).toBe("neutral");
  });
});

describe("the client profile card", () => {
  const empty: ClientProfileView = { brandVoice: null, audience: null, services: [], website: null, bookingLink: null, bannedWords: [], toneNotes: null };

  it("counts services the list does not know as filled in, and the brand kit as something filled in", () => {
    expect(missingFields(empty)).toHaveLength(7);
    expect(missingFields({ ...empty, servicesOther: ["Bespoke thing"] })).not.toContain("Services they buy");
    expect(missingFields({ ...empty, services: ["seo"] })).not.toContain("Services they buy");
    expect(missingFields(null)).toHaveLength(7);
    expect(anyProfileField(empty)).toBe(false);
    expect(anyProfileField(null)).toBe(false);
    expect(anyProfileField({ ...empty, primaryColor: "#112233" })).toBe(true);
    expect(anyProfileField({ ...empty, fonts: ["Inter"] })).toBe(true);
    expect(anyProfileField({ ...empty, brandVoice: "Warm" })).toBe(true);
  });
});
