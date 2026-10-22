import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getApproval } from "../src/care-store.js";
import { RecipientRefused, sendApproved } from "../src/outbound.js";
import { composeSpeedToLeadDraft, detectSpeedToLeadLang, isOptedOut, onLeadStoredForSpeedToLead, type SpeedToLeadInput } from "../src/speed-to-lead.js";
import { answerSend, bootCare, careSeed, CO, contact, decide, sentMail } from "./helpers/care.js";

const SOURCE = readFileSync(new URL("../src/speed-to-lead.ts", import.meta.url), "utf8");

function stlInput(overrides: Partial<SpeedToLeadInput> = {}): SpeedToLeadInput {
  return {
    companyId: CO,
    contactId: "ada",
    leadKey: "form:stl-default",
    source: "form",
    text: "We need a website",
    name: "Ada Lovelace",
    email: "ada@acme.co.za",
    arrivedAt: "2026-10-22T09:00:00.000Z",
    ...overrides,
  };
}

async function openSpeedToLeadApproval(overrides: Partial<SpeedToLeadInput> = {}) {
  const booted = await bootCare();
  const result = await onLeadStoredForSpeedToLead(booted.harness.ctx, stlInput(overrides));
  expect(result.skipped).toBe(false);
  const row = booted.store.care_approvals!.find((a) => a.id === result.approvalId)!;
  expect(row.kind).toBe("speed_to_lead");
  expect(row.issue_id).toBeTruthy();
  return { ...booted, result, row };
}

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
  it("picks AF from markers or hint, else EN, with a plain call CTA (no slot placeholders)", () => {
    expect(detectSpeedToLeadLang("Need a website")).toBe("en");
    expect(detectSpeedToLeadLang("asseblief help")).toBe("af");
    expect(detectSpeedToLeadLang("Hello", "af")).toBe("af");
    const af = composeSpeedToLeadDraft({ name: "Jan", email: "j@x.test", text: "asseblief", contactId: "c1" });
    expect(af.lang).toBe("af");
    expect(af.draft.text).toMatch(/Peet|skakel/i);
    expect(af.draft.text).not.toMatch(/\[Slot/i);
    const en = composeSpeedToLeadDraft({ name: "Ada", email: "a@x.test", text: "Need a quote", contactId: "c1" });
    expect(en.lang).toBe("en");
    expect(en.draft.text).toMatch(/Quick call|day and time/i);
    expect(en.draft.text).not.toMatch(/R\d|\$\d|\[Slot/i);
  });
});

describe("speed-to-lead draft-only", () => {
  it("source never references send paths or autonomous approval", () => {
    expect(SOURCE).not.toMatch(/mail\.send\.requested|MAIL_EVENTS\.sendRequested|sendApproved|schedule/i);
    expect(SOURCE).not.toMatch(/setTimeout|setInterval|autoApprove|cron/i);
    expect(SOURCE).toContain("MAIL_EVENTS.draftRequested");
  });

  it("creates approval + mail.draft.requested, never a send", async () => {
    const { harness, store, emit } = await bootCare();
    const result = await onLeadStoredForSpeedToLead(harness.ctx, stlInput({ leadKey: "form:stl-1" }));
    expect(result.skipped).toBe(false);
    const row = store.care_approvals!.find((a) => a.id === result.approvalId)!;
    expect(row.kind).toBe("speed_to_lead");
    expect(row.payload.metrics.t_arrival).toBe("2026-10-22T09:00:00.000Z");
    expect(emit.mock.calls.filter((c) => c[0] === "mail.draft.requested")).toHaveLength(1);
    expect(emit.mock.calls.filter((c) => c[0] === "mail.send.requested")).toHaveLength(0);
  });
});

describe("speed-to-lead person-done send path", () => {
  it("queues send with the approved draft text, then marks sent when the Mailbox answers", async () => {
    const { harness, store, emit, row } = await openSpeedToLeadApproval({ leadKey: "form:stl-happy" });
    const approvedText = (row.payload.draft as { text: string }).text;

    await decide(harness, row.issue_id!, "done", "user");

    expect(emit.mock.calls.filter((c) => c[0] === "mail.draft.requested")).toHaveLength(1);
    const sends = sentMail(emit);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.text).toBe(approvedText);

    const key = `crm:msg:${row.id}`;
    await answerSend(harness, key, "sent");

    const after = store.care_approvals!.find((a) => a.id === row.id)!;
    expect(after.status).toBe("sent");
    expect(store.outbox!.find((o) => o.key === key)!.payload.text).toBe(approvedText);
    expect(store.activities!.some((a) => a.kind === "speed_to_lead_sent")).toBe(true);
  });

  it("refuses send when the contact unsubscribed after the draft was opened", async () => {
    const { harness, store, emit, row } = await openSpeedToLeadApproval({ leadKey: "form:stl-unsub-send" });
    store.contacts!.find((c) => c.id === "ada")!.email_status = "unsubscribed";

    await decide(harness, row.issue_id!, "done", "user");

    expect(sentMail(emit)).toHaveLength(0);
    const after = store.care_approvals!.find((a) => a.id === row.id)!;
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/opted out/i);
    expect(store.activities!.some((a) => a.kind === "speed_to_lead_refused" && String(a.body).includes("opted out"))).toBe(true);
  });

  it("refuses sendApproved when the draft still has slot placeholders", async () => {
    const { harness, row } = await openSpeedToLeadApproval({ leadKey: "form:stl-slot" });
    const approval = (await getApproval(harness.ctx, CO, row.id))!;
    const draft = { ...(approval.payload.draft as { to: { email: string; name: string }[]; subject: string; text: string }), text: "Hi,\n\nPick [Slot 1].\n\nPeet" };
    await expect(sendApproved(harness.ctx, approval, "user:test", { draft })).rejects.toBeInstanceOf(RecipientRefused);
    await expect(sendApproved(harness.ctx, approval, "user:test", { draft })).rejects.toThrow(/slot placeholders/i);
  });
});

describe("speed-to-lead skips", () => {
  it("skips stale leads older than 24 hours", async () => {
    const { harness, store, emit } = await bootCare();
    const staleAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const result = await onLeadStoredForSpeedToLead(harness.ctx, stlInput({ leadKey: "form:stl-stale", arrivedAt: staleAt }));
    expect(result).toEqual({ skipped: true, reason: "stale_lead" });
    expect((store.care_approvals ?? []).filter((a) => a.kind === "speed_to_lead")).toHaveLength(0);
    expect(emit.mock.calls.filter((c) => c[0] === "mail.draft.requested")).toHaveLength(0);
    expect((store.activities ?? []).some((a) => a.kind === "speed_to_lead_skipped" && String(a.body).includes("24 hours"))).toBe(true);
  });

  it("skips when the contact already has an open speed-to-lead approval", async () => {
    const { harness, store, emit } = await bootCare();
    const input = stlInput({ leadKey: "form:stl-dedupe" });
    const first = await onLeadStoredForSpeedToLead(harness.ctx, input);
    const second = await onLeadStoredForSpeedToLead(harness.ctx, { ...input, leadKey: "form:stl-dedupe-2", text: "Another enquiry" });

    expect(first.skipped).toBe(false);
    expect(second).toEqual({ skipped: true, reason: "open_approval_exists" });
    expect(store.care_approvals!.filter((a) => a.kind === "speed_to_lead" && a.client_ref === "ada")).toHaveLength(1);
    expect(emit.mock.calls.filter((c) => c[0] === "mail.draft.requested")).toHaveLength(1);
    expect((store.activities ?? []).some((a) => a.kind === "speed_to_lead_skipped" && String(a.body).includes("open or approved"))).toBe(true);
  });
});
