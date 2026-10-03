import { describe, expect, it, vi } from "vitest";
import {
  CONSENT_SOURCES,
  ERASURE_PARTICIPANTS,
  HANDOFF_EVENTS,
  asConsentRecorded,
  asEraseCompleted,
  asEraseRequested,
  consentIsNewer,
  consentKey,
  consentSubjectKey,
  eraseSummary,
  handleEraseRequest,
  reannounceErasures,
  recordEraseResult,
  redactLedgerEntry,
  staleErasures,
  staleErasuresCheck,
  registerConsentReceiver,
  registerEraseReceiver,
  registerEraseResultWatch,
  startErasure,
  type ContactEraseRequested,
  type EraseOutcome,
} from "../src/index.js";
import { fakeCtx } from "./helpers/fake-ctx.js";

const request = (patch: Partial<ContactEraseRequested> = {}): ContactEraseRequested => ({
  key: "erase:req-1",
  requestId: "req-1",
  subject: { email: "Jane@Example.com", contactId: "c1" },
  scope: "all",
  reason: "data_subject_request",
  approvedByUserId: "owner",
  requestedAt: "2026-10-03T09:00:00.000Z",
  source: "partnersinbiz.crm",
  ...patch,
});

describe("event names and subjects", () => {
  it("adds the three events to the hand-off list", () => {
    expect(HANDOFF_EVENTS.contactEraseRequested).toBe("contact.erase.requested");
    expect(HANDOFF_EVENTS.contactEraseCompleted).toBe("contact.erase.completed");
    expect(HANDOFF_EVENTS.consentRecorded).toBe("consent.recorded");
    expect(ERASURE_PARTICIPANTS).toContain("partnersinbiz.mailbox");
    expect(CONSENT_SOURCES).toContain("partnersinbiz.campaigns");
  });

  it("keys a subject by email, then phone, then contact id", () => {
    expect(consentSubjectKey({ email: " Jane@Example.COM " })).toBe("email:jane@example.com");
    expect(consentSubjectKey({ phone: "+27 82 123 4567" })).toBe("phone:+27821234567");
    expect(consentSubjectKey({ contactId: "c1" })).toBe("contact:c1");
    expect(consentSubjectKey({ email: "nope", phone: "12" })).toBeNull();
    expect(consentKey({ email: "a@b.co" }, "marketing_email", "2026-10-03T09:00:00.000Z")).toBe("consent:email:a@b.co:marketing_email:2026-10-03T09:00:00.000Z");
    expect(consentKey({}, "marketing_email", "x")).toBeNull();
  });

  it("orders consent records by time, and treats a re-send as harmless", () => {
    expect(consentIsNewer({ recordedAt: "2026-10-03T09:00:00.000Z" }, { recordedAt: "2026-10-03T10:00:00.000Z" })).toBe(true);
    expect(consentIsNewer({ recordedAt: "2026-10-03T09:00:00.000Z" }, { recordedAt: "2026-10-03T09:00:00.000Z" })).toBe(true);
    expect(consentIsNewer({ recordedAt: "2026-10-03T10:00:00.000Z" }, { recordedAt: "2026-10-03T09:00:00.000Z" })).toBe(false);
    expect(consentIsNewer(null, { recordedAt: "x" })).toBe(true);
  });
});

describe("parsing what arrives", () => {
  it("accepts a well-formed consent record and refuses a malformed one", () => {
    const good = { key: "k", subject: { email: "a@b.co" }, purpose: "marketing_email", basis: "consent", granted: true, source: "form", evidence: { wording: "Tick to get news", url: "https://x.co/form" }, recordedAt: "2026-10-03T09:00:00.000Z" };
    expect(asConsentRecorded(good)).toMatchObject({ purpose: "marketing_email", granted: true, evidence: { wording: "Tick to get news" } });
    expect(asConsentRecorded({ ...good, purpose: "spam" })).toBeNull();
    expect(asConsentRecorded({ ...good, granted: "yes" })).toBeNull();
    expect(asConsentRecorded({ ...good, subject: {} })).toBeNull();
    expect(asConsentRecorded({ ...good, source: "telepathy" })!.source).toBe("api");
  });

  it("builds an erase request, defaulting the safe way, and keeps approval empty when absent", () => {
    expect(asEraseRequested({ requestId: "r", subject: { email: "a@b.co" } })).toMatchObject({ key: "erase:r", scope: "all", reason: "data_subject_request", approvedByUserId: "" });
    expect(asEraseRequested({ subject: { email: "a@b.co" } })).toBeNull();
    expect(asEraseRequested({ requestId: "r", subject: {} })).toBeNull();
  });

  it("builds an erase answer and drops junk counts", () => {
    const done = asEraseCompleted({ requestId: "r", plugin: "p", status: "erased", counts: { contacts: 1, bad: "x" }, retained: [{ what: "invoices", why: "tax law" }, { nope: 1 }] });
    expect(done).toMatchObject({ key: "erase:r:p", counts: { contacts: 1 }, retained: [{ what: "invoices", why: "tax law" }] });
    expect(asEraseCompleted({ requestId: "r", plugin: "p", status: "weird" })!.status).toBe("failed");
    expect(asEraseCompleted({ plugin: "p" })).toBeNull();
  });
});

describe("a participant erasing", () => {
  it("never erases without a person's approval", async () => {
    const fake = fakeCtx();
    const erase = vi.fn(async () => ({ counts: { contacts: 1 } }));
    const result = await handleEraseRequest(fake.ctx, { plugin: "partnersinbiz.mailbox", erase }, "co-1", request({ approvedByUserId: " " }));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Not approved by a person");
    expect(erase).not.toHaveBeenCalled();
  });

  it("erases once and replays the stored answer on a re-announcement", async () => {
    const fake = fakeCtx();
    const erase = vi.fn(async () => ({ counts: { messages: 12, threads: 3 }, retained: [] }));
    const options = { plugin: "partnersinbiz.mailbox", erase };
    const first = await handleEraseRequest(fake.ctx, options, "co-1", request());
    const second = await handleEraseRequest(fake.ctx, options, "co-1", request());
    expect(first).toMatchObject({ status: "erased", counts: { messages: 12, threads: 3 } });
    expect(second).toEqual(first);
    expect(erase).toHaveBeenCalledTimes(1);
  });

  it("reports what the law makes it keep, and nothing found", async () => {
    const fake = fakeCtx();
    const retained = await handleEraseRequest(fake.ctx, { plugin: "partnersinbiz.billing", erase: async () => ({ counts: {}, retained: [{ what: "5 invoices", why: "kept 5 years for SARS" }] }) }, "co-1", request());
    expect(retained).toMatchObject({ status: "retained", retained: [{ what: "5 invoices", why: "kept 5 years for SARS" }] });
    const none = await handleEraseRequest(fake.ctx, { plugin: "partnersinbiz.social", erase: async () => ({ counts: { posts: 0 } }) }, "co-1", request());
    expect(none.status).toBe("nothing_found");
  });

  it("stores nothing for a failure or a partial result, so the next announcement retries", async () => {
    const fake = fakeCtx();
    let attempt = 0;
    const erase = vi.fn(async (): Promise<EraseOutcome> => {
      attempt += 1;
      if (attempt === 1) throw new Error("db timeout");
      if (attempt === 2) return { counts: { contacts: 1 }, errors: ["enrollments"] };
      return { counts: { contacts: 1, enrollments: 2 } };
    });
    const options = { plugin: "partnersinbiz.crm", erase };
    expect((await handleEraseRequest(fake.ctx, options, "co-1", request())).status).toBe("failed");
    expect((await handleEraseRequest(fake.ctx, options, "co-1", request())).status).toBe("partial");
    expect((await handleEraseRequest(fake.ctx, options, "co-1", request())).status).toBe("erased");
    expect(erase).toHaveBeenCalledTimes(3);
  });

  it("listens for requests from the CRM only, and answers with an event", async () => {
    const mailbox = fakeCtx();
    registerEraseReceiver(mailbox.ctx, { plugin: "partnersinbiz.mailbox", erase: async () => ({ counts: { messages: 2 } }) });
    expect([...mailbox.handlers.keys()]).toEqual(["plugin.partnersinbiz.crm.contact.erase.requested"]);
    await mailbox.deliver("plugin.partnersinbiz.crm.contact.erase.requested", "co-1", request());
    await mailbox.deliver("plugin.partnersinbiz.crm.contact.erase.requested", "co-1", { garbage: true });
    expect(mailbox.emitted).toHaveLength(1);
    expect(mailbox.emitted[0]).toMatchObject({ name: HANDOFF_EVENTS.contactEraseCompleted, payload: { requestId: "req-1", plugin: "partnersinbiz.mailbox", status: "erased" } });
    const crm = fakeCtx();
    registerEraseReceiver(crm.ctx, { plugin: "partnersinbiz.crm", erase: async () => ({ counts: {} }) });
    expect(crm.handlers.size).toBe(0);
  });
});

describe("the sender's ledger", () => {
  it("will not start an erasure without an approving person or a subject", async () => {
    const fake = fakeCtx();
    await expect(startErasure(fake.ctx, "co-1", request({ approvedByUserId: "" }))).rejects.toThrow("needs a person's approval");
    await expect(startErasure(fake.ctx, "co-1", request({ subject: {} }))).rejects.toThrow("email, phone or contact id");
    expect(fake.emitted).toEqual([]);
  });

  it("announces to every other participant, tracks answers, keeps failures open and re-announces until done", async () => {
    const fake = fakeCtx();
    const entry = await startErasure(fake.ctx, "co-1", request(), ["partnersinbiz.crm", "partnersinbiz.mailbox", "partnersinbiz.billing"]);
    expect(entry.pending).toEqual(["partnersinbiz.mailbox", "partnersinbiz.billing"]);
    expect(fake.emitted).toHaveLength(1);
    expect(fake.emitted[0]!.name).toBe(HANDOFF_EVENTS.contactEraseRequested);
    const answer = (plugin: string, status: string) => ({ key: `erase:req-1:${plugin}`, requestId: "req-1", plugin, status: status as never, counts: { x: 1 }, retained: [], completedAt: "2026-10-03T10:00:00.000Z" });
    expect((await recordEraseResult(fake.ctx, "co-1", answer("partnersinbiz.mailbox", "erased"))).done).toBe(false);
    expect((await recordEraseResult(fake.ctx, "co-1", answer("partnersinbiz.billing", "failed"))).done).toBe(false);
    expect(await reannounceErasures(fake.ctx, "co-1")).toBe(1);
    const final = await recordEraseResult(fake.ctx, "co-1", { ...answer("partnersinbiz.billing", "retained"), retained: [{ what: "invoices", why: "tax law" }] });
    expect(final.done).toBe(true);
    expect(await reannounceErasures(fake.ctx, "co-1")).toBe(0);
    const summary = eraseSummary(final.entry!);
    expect(summary).toContain("approved by user owner");
    expect(summary).toContain("Kept by law: invoices (tax law)");
    expect(summary).toContain("Every plugin has answered.");
  });

  it("keeps the subject's email and phone only while someone still has to erase, then keeps a hash as proof", async () => {
    const fake = fakeCtx();
    const stateOf = (requestId: string) => fake.state.get(`company|co-1|pib-privacy|ledger:${requestId}`) as { request: ContactEraseRequested; subjectHash?: string; redactedAt?: string };
    await startErasure(fake.ctx, "co-1", request({ subject: { email: "Jane@Example.com", phone: "+27 82 555 0100", contactId: "c1" } }), ["partnersinbiz.crm", "partnersinbiz.mailbox", "partnersinbiz.social"]);
    const answer = (plugin: string) => ({ key: `erase:req-1:${plugin}`, requestId: "req-1", plugin, status: "erased" as const, counts: { x: 1 }, retained: [], completedAt: "2026-10-03T10:00:00.000Z" });
    await recordEraseResult(fake.ctx, "co-1", answer("partnersinbiz.mailbox"));
    // still waiting on Social: the identifiers are needed to retry, so they are still there
    expect(stateOf("req-1").request.subject.email).toBe("Jane@Example.com");
    expect(stateOf("req-1").subjectHash).toBeUndefined();
    const final = await recordEraseResult(fake.ctx, "co-1", answer("partnersinbiz.social"));
    expect(final.done).toBe(true);
    const kept = stateOf("req-1");
    expect(kept.request.subject).toEqual({});
    expect(kept.redactedAt).toBeTruthy();
    // the hash matches what a person re-checking would compute from the same subject
    expect(kept.subjectHash).toMatch(/^[0-9a-f]{64}$/);
    expect(kept.subjectHash).toBe((await redactLedgerEntry({ request: request(), pending: [], completed: {}, announcedAt: "" })).subjectHash);
    expect(JSON.stringify(kept)).not.toContain("example.com");
    expect(JSON.stringify(kept)).not.toContain("555");
    expect(JSON.stringify(final.entry)).not.toContain("Jane");
    // the proof of who approved it and what each plugin did survives
    expect(eraseSummary(final.entry!)).toContain("approved by user owner");
    // redacting twice changes nothing
    expect(await redactLedgerEntry(final.entry!)).toBe(final.entry);
  });

  it("surfaces an erasure a participant never answered, naming plugins and never the person", async () => {
    const fake = fakeCtx();
    const day = 86_400_000;
    const t0 = Date.parse("2026-10-03T09:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    try {
      await startErasure(fake.ctx, "co-1", request({ requestId: "req-old", dueBy: new Date(t0 + 30 * day).toISOString() }), ["partnersinbiz.crm", "partnersinbiz.social"]);
      await startErasure(fake.ctx, "co-1", request({ requestId: "req-late", dueBy: new Date(t0 + 3 * day).toISOString() }), ["partnersinbiz.crm", "partnersinbiz.mailbox"]);
    } finally {
      vi.useRealTimers();
    }
    expect(await staleErasures(fake.ctx, "co-1", { now: t0 + 2 * day })).toEqual([]);
    expect(await staleErasuresCheck(fake.ctx, "co-1", { now: t0 + 2 * day })).toBeNull();
    const week = await staleErasures(fake.ctx, "co-1", { now: t0 + 8 * day });
    expect(week.map((w) => [w.requestId, w.overdue])).toEqual([["req-old", false], ["req-late", true]]);
    // one of them is past its deadline: red, and it names the plugins and the request, never the person
    const overdue = await staleErasuresCheck(fake.ctx, "co-1", { now: t0 + 8 * day });
    expect(overdue).toMatchObject({ key: "privacy:erasure-stale", status: "bad" });
    expect(overdue!.detail).toContain("social");
    expect(overdue!.detail).toContain("past its deadline");
    expect(overdue!.detail!.toLowerCase()).not.toContain("jane");
    expect(overdue!.detail!.toLowerCase()).not.toContain("example.com");
    // only old, deadline not reached: a warning
    const justOld = fakeCtx();
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    try {
      await startErasure(justOld.ctx, "co-1", request({ requestId: "r2" }), ["partnersinbiz.crm", "partnersinbiz.social"]);
    } finally {
      vi.useRealTimers();
    }
    expect((await staleErasuresCheck(justOld.ctx, "co-1", { now: t0 + 8 * day }))!.status).toBe("warn");
    // a young request is stale on its deadline alone (2 days old, deadline yesterday)
    const due = fakeCtx();
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    try {
      await startErasure(due.ctx, "co-1", request({ requestId: "r3", dueBy: new Date(t0 + day).toISOString() }), ["partnersinbiz.crm", "partnersinbiz.social"]);
    } finally {
      vi.useRealTimers();
    }
    expect((await staleErasures(due.ctx, "co-1", { now: t0 + 2 * day })).map((w) => [w.requestId, w.overdue])).toEqual([["r3", true]]);
    expect(await staleErasures(due.ctx, "co-1", { now: t0 + day / 2 })).toEqual([]);
    // answered requests are never stale
    await recordEraseResult(justOld.ctx, "co-1", { key: "k", requestId: "r2", plugin: "partnersinbiz.social", status: "erased", counts: {}, retained: [], completedAt: "" });
    expect(await staleErasuresCheck(justOld.ctx, "co-1", { now: t0 + 40 * day })).toBeNull();
  });

  it("ignores an answer for a request it never made, and hands answers to the watcher", async () => {
    const fake = fakeCtx();
    expect(await recordEraseResult(fake.ctx, "co-1", { key: "k", requestId: "unknown", plugin: "p", status: "erased", counts: {}, retained: [], completedAt: "" })).toEqual({ done: false, entry: null });
    await startErasure(fake.ctx, "co-1", request(), ["partnersinbiz.crm", "partnersinbiz.mailbox"]);
    const seen: boolean[] = [];
    registerEraseResultWatch(fake.ctx, async (_c, _r, ledger) => void seen.push(ledger.done), ["partnersinbiz.mailbox"]);
    await fake.deliver("plugin.partnersinbiz.mailbox.contact.erase.completed", "co-1", { requestId: "req-1", plugin: "partnersinbiz.mailbox", status: "erased", counts: { messages: 1 } });
    expect(seen).toEqual([true]);
  });
});

describe("consent receiver", () => {
  it("hands each valid record to the plugin and skips its own events", async () => {
    const fake = fakeCtx();
    const got: string[] = [];
    registerConsentReceiver(fake.ctx, { plugin: "partnersinbiz.crm", onConsent: async (_c, consent) => void got.push(consent.key) });
    expect(fake.handlers.has("plugin.partnersinbiz.crm.consent.recorded")).toBe(false);
    expect(fake.handlers.has("plugin.partnersinbiz.mailbox.consent.recorded")).toBe(true);
    const payload = { key: "k1", subject: { email: "a@b.co" }, purpose: "newsletter", basis: "consent", granted: false, source: "unsubscribe_link", recordedAt: "2026-10-03T09:00:00.000Z" };
    await fake.deliver("plugin.partnersinbiz.mailbox.consent.recorded", "co-1", payload);
    await fake.deliver("plugin.partnersinbiz.mailbox.consent.recorded", "co-1", { ...payload, purpose: "nope" });
    expect(got).toEqual(["k1"]);
  });
});
