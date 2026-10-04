import { beforeEach, describe, expect, it } from "vitest";
import { rememberPluginUiBase } from "@partnersinbiz/pib-plugin-kit";
import { eraseSubjectInCrm, findPerson, collectPersonData, personDataCounts } from "../src/privacy.js";
import { resetLeadCaches } from "../src/lead-capture.js";
import { handleSignWebhook } from "../src/esign-public.js";
import { handleEventsWebhook, resetEventCaches } from "../src/site-events.js";
import { BOARD, bootCare, canaryClient, CO, enableFor, makeDoc, sendAndApprove, signBody, SERVER_IPS, signDelivery, tool, usePages } from "./helpers/esign.js";

usePages();
beforeEach(() => {
  resetLeadCaches();
  resetEventCaches();
});

const UUID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";

async function acmeWithEverything() {
  const booted = await bootCare();
  await rememberPluginUiBase(booted.harness.ctx, `/_plugins/${UUID}/ui/`);
  await enableFor(booted);
  // One document signed, one waiting.
  const signed = await makeDoc(booted, "company:acme", { title: "Signed one" });
  const out = await sendAndApprove(booted, signed.documentId);
  const row = booted.store.sign_documents!.find((d) => d.id === signed.documentId)!;
  const result = await handleSignWebhook(booted.harness.ctx, signDelivery(signBody({ pageId: row.page_id, contentSha256: row.content_sha256, consentSha256: row.consent_sha256 }, out.token)), { serverIps: SERVER_IPS });
  if (result.status === "signed") await result.effects;
  const waiting = await makeDoc(booted, "company:acme", { title: "Waiting one" });
  // A site counter, a cost and a payment.
  const made = await tool<Record<string, any>>(booted.harness, "create-event-key", { client: "company:acme", label: "Acme", siteUrl: "https://acme.co.za" });
  await handleEventsWebhook(booted.harness.ctx, { endpointKey: "ev", headers: { "x-real-ip": "203.0.113.5" }, rawBody: "{}", parsedBody: { k: made.key.writeKey, ev: [{ t: "pv", p: "/", e: 1 }] }, requestId: "r" });
  await tool(booted.harness, "record-channel-cost", { client: "company:acme", channel: "organic_search", period: "2026-09", amountMinor: 600_000 });
  await booted.harness.emit("plugin.partnersinbiz.billing.invoice.paid", { key: "billing:invoice:i1:paid", invoiceId: "i1", number: "INV-1", dealId: null, clientKind: "company", clientRef: "acme", totalMinor: 99_900, currency: "ZAR", paidAt: "2026-09-20T08:00:00Z" }, { companyId: CO });
  return { booted, signed, waiting };
}

describe("deleting a client takes its e-sign, site counts and costs with it", () => {
  it("removes the documents that were not signed, the counters, the keys and the costs; keeps the signed agreement and unlinks the payment", async () => {
    const { booted, signed, waiting } = await acmeWithEverything();
    expect(booted.store.sign_documents).toHaveLength(2);
    await booted.harness.performAction("crm.delete-company", { companyRecordId: "acme", confirm: "Acme Plumbing" }, { companyId: CO, actor: BOARD });
    // The waiting document and its trail and links are gone; the signed one is the record of an agreement and stays.
    expect(booted.store.sign_documents!.map((d) => d.id)).toEqual([signed.documentId]);
    expect(booted.store.sign_events!.every((e) => e.doc_id === signed.documentId)).toBe(true);
    expect(booted.store.sign_tokens!.every((t) => t.doc_id === signed.documentId)).toBe(true);
    expect(booted.store.sign_documents!.some((d) => d.id === waiting.documentId)).toBe(false);
    expect(booted.store.esign_clients).toHaveLength(0);
    expect(booted.store.event_keys).toHaveLength(0);
    expect(booted.store.site_event_daily).toHaveLength(0);
    expect(booted.store.channel_costs).toHaveLength(0);
    // The payment is a copy of what Billing was paid: kept, no longer pointing at the client.
    expect(booted.store.revenue_events).toHaveLength(1);
    expect(booted.store.revenue_events![0]).toMatchObject({ client_kind: null, client_ref: null, total_minor: 99_900 });
  });

  it("the canary client's cleanup removes everything of its own, signed documents too", async () => {
    const booted = await bootCare();
    await rememberPluginUiBase(booted.harness.ctx, `/_plugins/${UUID}/ui/`);
    const client = await canaryClient(booted);
    const made = await makeDoc(booted, client);
    const sent = await tool<Record<string, any>>(booted.harness, "send-for-signature", { documentId: made.documentId });
    const { decide } = await import("./helpers/esign.js");
    await decide(booted.harness, sent.approvalIssueId, "done", "user");
    const got = await tool<Record<string, any>>(booted.harness, "get-sign-document", { documentId: made.documentId });
    const token = /#(pibt_[a-z2-7]{40})/.exec(got.canaryLink)![1]!;
    const row = booted.store.sign_documents![0]!;
    const result = await handleSignWebhook(booted.harness.ctx, signDelivery(signBody({ pageId: row.page_id, contentSha256: row.content_sha256, consentSha256: row.consent_sha256 }, token, { typedName: "Canary Contact" })), { serverIps: SERVER_IPS });
    expect(result.status).toBe("signed");
    if (result.status === "signed") await result.effects;
    expect(booted.store.sign_documents![0]!.status).toBe("signed");
    await tool(booted.harness, "cleanup-canary", { confirm: true });
    expect(booted.store.sign_documents).toHaveLength(0);
    expect(booted.store.sign_events).toHaveLength(0);
    expect(booted.store.sign_tokens).toHaveLength(0);
  });
});

describe("erasing a person", () => {
  it("shows what is kept and what goes before a person approves: unsigned documents go, a signed agreement stays", async () => {
    const { booted } = await acmeWithEverything();
    const person = await findPerson(booted.harness.ctx, CO, { email: "ada@acme.co.za" });
    const data = await collectPersonData(booted.harness.ctx, CO, person);
    expect(personDataCounts(data)).toMatchObject({ documents_sent_to_sign: 2 });
    expect(data.documents).toEqual({ total: 2, signed: 1 });
    const outcome = await eraseSubjectInCrm(booted.harness.ctx, CO, person, "all");
    expect(outcome.counts.documents_sent_to_sign).toBe(1);
    expect(outcome.retained.map((r) => r.what).join(" ")).toMatch(/1 signed document \(the text, the signature and the audit trail\)/);
    expect(booted.store.sign_documents).toHaveLength(1);
    expect(booted.store.sign_documents![0]!.status).toBe("signed");
    // Erasing again finds nothing more to remove.
    const again = await eraseSubjectInCrm(booted.harness.ctx, CO, person, "all");
    expect(again.counts.documents_sent_to_sign ?? 0).toBe(0);
  });
});
