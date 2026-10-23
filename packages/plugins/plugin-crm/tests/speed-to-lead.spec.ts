import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getApproval } from "../src/care-store.js";
import { intakeLead } from "../src/leads.js";
import { RecipientRefused, sendApproved } from "../src/outbound.js";
import {
  classifyNotALead,
  composeSpeedToLeadDraft,
  detectSpeedToLeadLang,
  hasDoNotContactTag,
  hasOptOutText,
  isOptedOut,
  onClientLeadStoredForSpeedToLead,
  onLeadStoredForSpeedToLead,
  type SpeedToLeadInput,
} from "../src/speed-to-lead.js";
import { answerSend, bootCare, careSeed, CO, contact, decide, sentMail } from "./helpers/care.js";

const SOURCE = readFileSync(new URL("../src/speed-to-lead.ts", import.meta.url), "utf8");
const MAIL_SOURCE = readFileSync(new URL("../src/mail.ts", import.meta.url), "utf8");

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
  booted.harness.seed({
    agents: [{ id: "elon-1", companyId: CO, name: "Elon", role: "ceo", status: "idle", urlKey: "elon" } as never],
  });
  const result = await onLeadStoredForSpeedToLead(booted.harness.ctx, stlInput(overrides));
  expect(result.skipped).toBe(false);
  const row = booted.store.care_approvals!.find((a) => a.id === result.approvalId)!;
  expect(row.kind).toBe("speed_to_lead");
  expect(row.issue_id).toBeTruthy();
  return { ...booted, result, row };
}

// The fixtures arrive on 2026-10-22 and the code skips a lead older than 24 hours, so the real clock made every test
// fail from 2026-10-23 09:00 UTC. Only Date is frozen (to the day the fixtures were written); timers stay real.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-22T14:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("speed-to-lead consent", () => {
  it("treats unsubscribed and bounced as opted out", () => {
    expect(isOptedOut("ok")).toBe(false);
    expect(isOptedOut("unsubscribed")).toBe(true);
    expect(isOptedOut("bounced")).toBe(true);
  });

  it("detects explicit opt-out phrases and the do-not-contact tag", () => {
    expect(hasOptOutText("stop")).toBe(true);
    expect(hasOptOutText("Please STOP emailing me")).toBe(true);
    expect(hasOptOutText("unsubscribe me from your list")).toBe(true);
    expect(hasOptOutText("remove me from your list")).toBe(true);
    expect(hasOptOutText("do not contact me")).toBe(true);
    // Real-lead negatives: bare words must not tag do-not-contact
    expect(hasOptOutText("We need to stop losing leads")).toBe(false);
    expect(hasOptOutText("can you stop by")).toBe(false);
    expect(hasOptOutText("non-stop support please")).toBe(false);
    expect(hasOptOutText("unsubscribe from my current host")).toBe(false);
    expect(hasOptOutText("We need a website")).toBe(false);
    expect(hasDoNotContactTag(["lead", "Do-Not-Contact"])).toBe(true);
    expect(hasDoNotContactTag(["lead"])).toBe(false);
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

  it("skips when inbound text asks to stop and tags do-not-contact", async () => {
    const { harness, store, emit } = await bootCare();
    const result = await onLeadStoredForSpeedToLead(harness.ctx, stlInput({ leadKey: "form:stop-text", text: "Please stop emailing me — remove me from your list" }));
    expect(result).toEqual({ skipped: true, reason: "opted_out" });
    expect(emit.mock.calls.filter((c) => c[0] === "mail.draft.requested")).toHaveLength(0);
    expect(store.contacts!.find((c) => c.id === "ada")!.tags.map(String)).toContain("do-not-contact");
    expect((store.activities ?? []).some((a) => a.kind === "speed_to_lead_skipped" && String(a.body).includes("opted out"))).toBe(true);
  });

  it("tags do-not-contact for unsubscribe-me-from-newsletter before the spam gate", async () => {
    const { harness, store, emit } = await bootCare();
    const result = await onLeadStoredForSpeedToLead(
      harness.ctx,
      stlInput({ leadKey: "form:unsub-newsletter", text: "unsubscribe me from your newsletter" }),
    );
    expect(result).toEqual({ skipped: true, reason: "opted_out" });
    expect(store.contacts!.find((c) => c.id === "ada")!.tags.map(String)).toContain("do-not-contact");
    expect(emit.mock.calls.filter((c) => c[0] === "mail.draft.requested")).toHaveLength(0);
  });

  it("does not tag when a newsletter footer only has bare unsubscribe", async () => {
    const { harness, store, emit } = await bootCare();
    const result = await onLeadStoredForSpeedToLead(
      harness.ctx,
      stlInput({ leadKey: "form:newsletter-footer", text: "Here is our weekly newsletter digest. Click unsubscribe below." }),
    );
    expect(result).toEqual({ skipped: true, reason: "not_a_lead" });
    expect(store.contacts!.find((c) => c.id === "ada")!.tags.map(String)).not.toContain("do-not-contact");
    expect(emit.mock.calls.filter((c) => c[0] === "mail.draft.requested")).toHaveLength(0);
  });

  it("skips when the contact already has tag do-not-contact", async () => {
    const base = careSeed();
    const { harness, store, emit } = await bootCare({
      store: {
        ...base,
        contacts: [contact("ada", "Ada Lovelace", { emails: ["ada@acme.co.za"], tags: ["do-not-contact"] }), ...(base.contacts ?? []).filter((row) => row.id !== "ada")],
      },
    });
    const result = await onLeadStoredForSpeedToLead(harness.ctx, stlInput({ leadKey: "form:dnc-tag", text: "Need a quote" }));
    expect(result).toEqual({ skipped: true, reason: "opted_out" });
    expect(emit.mock.calls.filter((c) => c[0] === "mail.draft.requested")).toHaveLength(0);
    expect((store.care_approvals ?? []).filter((a) => a.kind === "speed_to_lead")).toHaveLength(0);
  });
});

describe("speed-to-lead spam gate", () => {
  it("classifies newsletter, no-reply, receipt and SEO-pitch fixtures (positive)", () => {
    expect(classifyNotALead({ email: "ada@acme.co.za", text: "Here is our weekly newsletter digest" })).toBe("newsletter");
    expect(classifyNotALead({ email: "noreply@vendor.test", text: "Hello" })).toBe("no_reply_sender");
    expect(classifyNotALead({ email: "do-not-reply@vendor.test", text: "Hello" })).toBe("no_reply_sender");
    expect(classifyNotALead({ email: "mailer-daemon@vendor.test", text: "Hello" })).toBe("no_reply_sender");
    expect(classifyNotALead({ email: "ada@acme.co.za", text: "Your receipt for order #123" })).toBe("receipt");
    expect(classifyNotALead({ email: "ada@acme.co.za", text: "We can rank your site — buy backlinks today" })).toBe("seo_pitch");
    expect(classifyNotALead({ email: "ada@acme.co.za", text: "We offer guest post packages for agencies" })).toBe("seo_pitch");
  });

  it("does not classify real-lead negatives for each kept spam row", () => {
    expect(classifyNotALead({ email: "ada@acme.co.za", text: "Sign me up for the newsletter" })).toBeNull();
    expect(classifyNotALead({ email: "ada@acme.co.za", text: "Please send me a tax invoice for the deposit" })).toBeNull();
    expect(classifyNotALead({ email: "ada@acme.co.za", text: "I need SEO services for my shop" })).toBeNull();
    expect(classifyNotALead({ email: "notifications@acme.co.za", text: "We need a website" })).toBeNull();
    expect(classifyNotALead({ email: "newsletter@acme.co.za", text: "We need a website" })).toBeNull();
    expect(classifyNotALead({ email: "ada@acme.co.za", text: "We accept crypto payments" })).toBeNull();
    expect(classifyNotALead({ email: "ada@acme.co.za", text: "I want an auto-reply for after hours" })).toBeNull();
    expect(classifyNotALead({ email: "ada@acme.co.za", text: "I am away from the office next week" })).toBeNull();
    expect(classifyNotALead({ email: "ada@acme.co.za", text: "Is there a limited time offer on the package?" })).toBeNull();
    expect(classifyNotALead({ email: "ada@acme.co.za", text: "We need a website for our shop" })).toBeNull();
  });

  it("produces no draft for a newsletter fixture (spec §8)", async () => {
    const { harness, store, emit } = await bootCare();
    const result = await onLeadStoredForSpeedToLead(
      harness.ctx,
      stlInput({ leadKey: "form:newsletter", text: "Hi — here is our weekly newsletter with this month's tips" }),
    );
    expect(result).toEqual({ skipped: true, reason: "not_a_lead" });
    expect((store.care_approvals ?? []).filter((a) => a.kind === "speed_to_lead")).toHaveLength(0);
    expect(emit.mock.calls.filter((c) => c[0] === "mail.draft.requested")).toHaveLength(0);
    expect((store.activities ?? []).some((a) => a.kind === "speed_to_lead_skipped" && String(a.body).includes("newsletter"))).toBe(true);
  });

  it("produces no draft for no-reply and SEO-pitch fixtures", async () => {
    const { harness, emit } = await bootCare();
    const noreply = await onLeadStoredForSpeedToLead(harness.ctx, stlInput({ leadKey: "form:noreply", email: "no-reply@spam.test", text: "Need help" }));
    expect(noreply).toEqual({ skipped: true, reason: "not_a_lead" });
    const seo = await onLeadStoredForSpeedToLead(harness.ctx, stlInput({ leadKey: "form:seo", text: "Buy backlinks to grow your rankings" }));
    expect(seo).toEqual({ skipped: true, reason: "not_a_lead" });
    expect(emit.mock.calls.filter((c) => c[0] === "mail.draft.requested")).toHaveLength(0);
  });

  it("still drafts a real SEO prospect enquiry", async () => {
    const { harness, emit } = await bootCare();
    harness.seed({
      agents: [{ id: "elon-1", companyId: CO, name: "Elon", role: "ceo", status: "idle", urlKey: "elon" } as never],
    });
    const result = await onLeadStoredForSpeedToLead(
      harness.ctx,
      stlInput({ leadKey: "form:seo-lead", text: "I need SEO services for my shop" }),
    );
    expect(result.skipped).toBe(false);
    expect(emit.mock.calls.filter((c) => c[0] === "mail.draft.requested")).toHaveLength(1);
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
    // Jagter reply trigger in mail.ts only calls onLeadStoredForSpeedToLead (draft path).
    expect(MAIL_SOURCE).toContain("onLeadStoredForSpeedToLead");
    expect(MAIL_SOURCE).toContain('source: "sequence_reply"');
    const start = MAIL_SOURCE.indexOf("Jagter / sequence outreach reply");
    const end = MAIL_SOURCE.indexOf("return { matched: true, contactId: contact.id, enrollments: running.length", start);
    const replyTrigger = MAIL_SOURCE.slice(start, end);
    expect(replyTrigger).toContain("onLeadStoredForSpeedToLead");
    expect(replyTrigger).not.toMatch(/sendRequested|mail\.send\.requested/i);
  });

  it("creates approval + mail.draft.requested, never a send", async () => {
    const { harness, store, emit } = await bootCare();
    harness.seed({
      agents: [{ id: "elon-1", companyId: CO, name: "Elon", role: "ceo", status: "idle", urlKey: "elon" } as never],
    });
    const result = await onLeadStoredForSpeedToLead(harness.ctx, stlInput({ leadKey: "form:stl-1" }));
    expect(result.skipped).toBe(false);
    const row = store.care_approvals!.find((a) => a.id === result.approvalId)!;
    expect(row.kind).toBe("speed_to_lead");
    expect(row.payload.metrics.t_arrival).toBe("2026-10-22T09:00:00.000Z");
    expect(emit.mock.calls.filter((c) => c[0] === "mail.draft.requested")).toHaveLength(1);
    expect(emit.mock.calls.filter((c) => c[0] === "mail.send.requested")).toHaveLength(0);
  });
});

describe("speed-to-lead CEO ping", () => {
  it("opens a 3-line ping issue for Elon with a link to the approval card", async () => {
    const { harness, result, row } = await openSpeedToLeadApproval({ leadKey: "form:stl-ping" });
    const ping = (await harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.crm", originId: `crm:stl-ping:${result.approvalId}`, limit: 1 }))[0];
    expect(ping).toBeTruthy();
    expect(ping!.assigneeAgentId).toBe("elon-1");
    const body = String(ping!.description ?? "");
    const lines = body.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(body).toMatch(/speed-to-lead/i);
    expect(body).toContain(row.issue_id!);
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

describe("speed-to-lead Jagter / sequence reply", () => {
  it("drafts with sequence_reply source and keeps the Gmail thread on the approval", async () => {
    const { harness, store, emit } = await bootCare();
    harness.seed({
      agents: [{ id: "elon-1", companyId: CO, name: "Elon", role: "ceo", status: "idle", urlKey: "elon" } as never],
    });
    const result = await onLeadStoredForSpeedToLead(
      harness.ctx,
      stlInput({
        leadKey: "reply:m-jagter-1",
        source: "sequence_reply",
        text: "Re: Intro\n\nYes please, can we talk on Tuesday?",
        threadId: "thread-jagter-1",
        arrivedAt: "2026-10-22T10:00:00.000Z",
      }),
    );
    expect(result.skipped).toBe(false);
    const row = store.care_approvals!.find((a) => a.id === result.approvalId)!;
    expect(row.kind).toBe("speed_to_lead");
    expect(row.payload.source).toBe("sequence_reply");
    expect((row.payload.draft as { threadId?: string | null }).threadId).toBe("thread-jagter-1");
    expect(emit.mock.calls.filter((c) => c[0] === "mail.draft.requested")).toHaveLength(1);
    expect(emit.mock.calls.filter((c) => c[0] === "mail.send.requested")).toHaveLength(0);
  });
});

describe("speed-to-lead client-channel (no handleLead)", () => {
  it("reuses onLeadStoredForSpeedToLead when the email already has a CRM contact", async () => {
    const { harness, store, emit } = await bootCare();
    harness.seed({
      agents: [{ id: "elon-1", companyId: CO, name: "Elon", role: "ceo", status: "idle", urlKey: "elon" } as never],
    });
    const result = await onClientLeadStoredForSpeedToLead(harness.ctx, {
      companyId: CO,
      client: { kind: "company", id: "acme" },
      leadKey: "form:acme:visitor-known",
      source: "form",
      text: "Need a quote for SEO",
      name: "Ada Lovelace",
      email: "ada@acme.co.za",
      arrivedAt: "2026-10-22T11:00:00.000Z",
    });
    expect(result.skipped).toBe(false);
    const row = store.care_approvals!.find((a) => a.id === result.approvalId)!;
    expect(row.client_kind).toBe("contact");
    expect(row.client_ref).toBe("ada");
    expect(emit.mock.calls.filter((c) => c[0] === "mail.draft.requested")).toHaveLength(1);
    expect(emit.mock.calls.filter((c) => c[0] === "mail.send.requested")).toHaveLength(0);
  });

  it("opens a client-scoped draft without creating a CRM contact (POPIA)", async () => {
    const { harness, store, emit } = await bootCare();
    harness.seed({
      agents: [{ id: "elon-1", companyId: CO, name: "Elon", role: "ceo", status: "idle", urlKey: "elon" } as never],
    });
    const beforeContacts = (store.contacts ?? []).length;
    const result = await onClientLeadStoredForSpeedToLead(harness.ctx, {
      companyId: CO,
      client: { kind: "company", id: "acme" },
      leadKey: "social:inbox:client-lead-1",
      source: "social",
      text: "Do you deliver to Umhlanga?",
      name: "Jane Doe",
      email: "jane@new-visitor.test",
      arrivedAt: "2026-10-22T12:00:00.000Z",
    });
    expect(result.skipped).toBe(false);
    expect((store.contacts ?? []).length).toBe(beforeContacts);
    const row = store.care_approvals!.find((a) => a.id === result.approvalId)!;
    expect(row.kind).toBe("speed_to_lead");
    expect(row.client_kind).toBe("company");
    expect(row.client_ref).toBe("acme");
    expect(row.payload.clientChannel).toBe(true);
    expect((row.payload.draft as { contactId?: string | null }).contactId).toBeNull();
    expect(emit.mock.calls.filter((c) => c[0] === "mail.draft.requested")).toHaveLength(1);
    expect(emit.mock.calls.filter((c) => c[0] === "mail.send.requested")).toHaveLength(0);
  });

  it("intakeLead client-channel path (no CRM contact) requests one speed_to_lead approval and drafts only", async () => {
    const { harness, store, emit } = await bootCare();
    harness.seed({
      agents: [{ id: "elon-1", companyId: CO, name: "Elon", role: "ceo", status: "idle", urlKey: "elon" } as never],
    });
    const beforeContacts = (store.contacts ?? []).length;
    const result = await intakeLead(harness.ctx, CO, "plugin.partnersinbiz.social.lead.captured", {
      key: "social:inbox:stl-intake-1",
      source: "social",
      name: "Pat New",
      handle: "@Pat.New",
      platform: "instagram",
      email: "pat.new@visitor.test",
      text: "Can you help with Instagram ads?",
      url: "https://instagram.com/p/stl",
      clientKind: "company",
      clientRef: "acme",
      confidence: 0.9,
      capturedAt: "2026-10-22T13:00:00.000Z",
    });
    expect(result).toMatchObject({ status: "stored", contactId: null });
    expect((store.contacts ?? []).length).toBe(beforeContacts);
    expect(store.client_leads).toEqual([
      expect.objectContaining({ key: "social:inbox:stl-intake-1", client_kind: "company", client_ref: "acme", email: "pat.new@visitor.test" }),
    ]);
    const stl = (store.care_approvals ?? []).filter((a) => a.kind === "speed_to_lead");
    expect(stl).toHaveLength(1);
    expect(stl[0]).toMatchObject({ client_kind: "company", client_ref: "acme", kind: "speed_to_lead" });
    expect(stl[0]!.payload.clientChannel).toBe(true);
    expect(emit.mock.calls.filter((c) => c[0] === "mail.draft.requested")).toHaveLength(1);
    expect(emit.mock.calls.filter((c) => c[0] === "mail.send.requested")).toHaveLength(0);
  });
});
