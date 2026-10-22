import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { composeSpeedToLeadDraft, detectSpeedToLeadLang, isOptedOut, onLeadStoredForSpeedToLead } from "../src/speed-to-lead.js";
import { bootCare, careSeed, CO, contact } from "./helpers/care.js";

const SOURCE = readFileSync(new URL("../src/speed-to-lead.ts", import.meta.url), "utf8");

describe("speed-to-lead consent", () => {
  it("treats unsubscribed and bounced as opted out", () => {
    expect(isOptedOut("ok")).toBe(false);
    expect(isOptedOut("unsubscribed")).toBe(true);
    expect(isOptedOut("bounced")).toBe(true);
  });

  it("skips draft and approval when the contact is opted out", async () => {
    const base = careSeed();
    const { harness, store, emit } = await bootCare({
      store: {
        ...base,
        contacts: [contact("ada", "Ada Lovelace", { emails: ["ada@acme.co.za"], email_status: "unsubscribed" }), ...(base.contacts ?? []).filter((row) => row.id !== "ada")],
      },
    });
    const before = store.care_approvals?.length ?? 0;
    const result = await onLeadStoredForSpeedToLead(harness.ctx, {
      companyId: CO,
      contactId: "ada",
      leadKey: "form:opt-out-1",
      source: "form",
      text: "Please call me",
      name: "Ada",
      email: "ada@acme.co.za",
    });
    expect(result).toEqual({ skipped: true, reason: "opted_out" });
    expect(store.care_approvals?.length ?? 0).toBe(before);
    expect(emit.mock.calls.filter((c) => c[0] === "mail.draft.requested")).toHaveLength(0);
  });
});

describe("speed-to-lead compose language", () => {
  it("picks AF from markers or hint, else EN", () => {
    expect(detectSpeedToLeadLang("Need a website")).toBe("en");
    expect(detectSpeedToLeadLang("asseblief help")).toBe("af");
    expect(detectSpeedToLeadLang("Hello", "af")).toBe("af");
    const af = composeSpeedToLeadDraft({ name: "Jan", email: "j@x.test", text: "asseblief", contactId: "c1" });
    expect(af.lang).toBe("af");
    expect(af.draft.text).toMatch(/Peet|Slot 1/);
    const en = composeSpeedToLeadDraft({ name: "Ada", email: "a@x.test", text: "Need a quote", contactId: "c1" });
    expect(en.lang).toBe("en");
    expect(en.draft.text).not.toMatch(/R\d|\$\d/);
  });
});

describe("speed-to-lead draft-only", () => {
  it("source never references send paths", () => {
    expect(SOURCE).not.toMatch(/mail\.send\.requested|MAIL_EVENTS\.sendRequested|sendApproved|schedule/i);
    expect(SOURCE).toContain("MAIL_EVENTS.draftRequested");
  });

  it("creates approval + mail.draft.requested, never a send", async () => {
    const { harness, store, emit } = await bootCare();
    const result = await onLeadStoredForSpeedToLead(harness.ctx, {
      companyId: CO,
      contactId: "ada",
      leadKey: "form:stl-1",
      source: "form",
      text: "We need a website",
      name: "Ada Lovelace",
      email: "ada@acme.co.za",
      arrivedAt: "2026-10-22T09:00:00.000Z",
    });
    expect(result.skipped).toBe(false);
    const row = store.care_approvals!.find((a) => a.id === result.approvalId)!;
    expect(row.kind).toBe("speed_to_lead");
    expect(row.payload.metrics.t_arrival).toBe("2026-10-22T09:00:00.000Z");
    expect(emit.mock.calls.filter((c) => c[0] === "mail.draft.requested")).toHaveLength(1);
    expect(emit.mock.calls.filter((c) => c[0] === "mail.send.requested")).toHaveLength(0);
  });
});
