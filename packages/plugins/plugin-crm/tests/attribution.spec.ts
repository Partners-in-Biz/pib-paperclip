import { describe, expect, it } from "vitest";
import { rememberPluginUiBase } from "@partnersinbiz/pib-plugin-kit";
import {
  buildClientAttribution,
  buildOwnAttribution,
  growthSection,
  periodsIn,
  type ClientInput,
  type OwnInput,
} from "../src/attribution.js";
import { resetLeadCaches } from "../src/lead-capture.js";
import { resetEventCaches, handleEventsWebhook } from "../src/site-events.js";
import { BOARD, bootCare, careSeed, CO, tool } from "./helpers/care.js";
import { deal } from "./helpers/crm.js";
import { beforeEach } from "vitest";

const FROM = "2026-08-31T22:00:00.000Z";
const TO = "2026-09-30T22:00:00.000Z";

const organic = { pageUrl: "https://acme.co.za/", utmSource: "google", utmMedium: "organic" };
const googleAd = { pageUrl: "https://acme.co.za/", utmSource: "google", utmMedium: "cpc", utmCampaign: "spring", gclid: "x" };
const facebook = { pageUrl: "https://acme.co.za/", referrer: "https://l.facebook.com/", utmCampaign: "launch" };
const newsletter = { pageUrl: "https://acme.co.za/", utmSource: "newsletter", utmMedium: "email", utmCampaign: "september" };

function own(extra: Partial<OwnInput> = {}): OwnInput {
  return { from: FROM, to: TO, captures: [], contacts: [], deals: [], revenue: [], costs: [], ...extra };
}

describe("our own attribution: remembered visits and the period", () => {
  // Eve first found us through organic search, and came back through an ad before she filled the form.
  const remembered = { pageUrl: "https://acme.co.za/", utmSource: "google", utmMedium: "cpc", ftSource: "google", ftMedium: "organic", ltSource: "google", ltMedium: "cpc" };
  const report = buildOwnAttribution(
    own({
      captures: [{ key: "p1", createdAt: "2026-09-03T08:00:00Z", contactId: "eve", attribution: remembered }],
      contacts: [{ id: "eve", lifecycle: "customer", accountIds: ["eve-co"] }],
      deals: [
        { id: "d-now", contactId: "eve", accountId: "eve-co", amountMinor: 100_000, currency: "ZAR", won: true, wonAt: "2026-09-10T08:00:00Z" },
        // Won last month and next month: neither belongs to September.
        { id: "d-old", contactId: "eve", accountId: "eve-co", amountMinor: 200_000, currency: "ZAR", won: true, wonAt: "2026-08-15T08:00:00Z" },
        { id: "d-next", contactId: "eve", accountId: "eve-co", amountMinor: 400_000, currency: "ZAR", won: true, wonAt: "2026-10-15T08:00:00Z" },
      ],
    }),
  );
  const row = (channel: string) => report.rows.find((r) => r.channel === channel);

  it("gives the lead's first touch to the remembered first visit and its last touch to the remembered last visit", () => {
    expect(row("organic_search")!.first.leads).toBe(1);
    expect(row("paid")!.last.leads).toBe(1);
    expect(row("organic_search")!.last.leads).toBe(0);
    expect(row("paid")!.first.leads).toBe(0);
    expect(report.persistedShare).toBe(1);
  });

  it("credits a sale to the customer's first touch and, separately, to the touch before the sale: never split, never twice", () => {
    expect(row("organic_search")!.first.won).toBe(1);
    expect(row("paid")!.last.won).toBe(1);
    expect(row("paid")!.first.won).toBe(0);
    expect(row("organic_search")!.last.won).toBe(0);
  });

  it("counts only the deals won in the period", () => {
    expect(row("organic_search")!.first.wonValue).toEqual({ ZAR: 100_000 });
    expect(row("paid")!.last.wonValue).toEqual({ ZAR: 100_000 });
    expect(report.totals.first.won).toBe(1);
  });
});

describe("our own attribution: lead capture to contact to deal to invoice", () => {
  const input = own({
    captures: [
      { key: "c1", createdAt: "2026-08-20T08:00:00Z", contactId: "ada", attribution: organic },
      { key: "c2", createdAt: "2026-09-02T08:00:00Z", contactId: "ada", attribution: newsletter },
      { key: "c3", createdAt: "2026-09-05T08:00:00Z", contactId: "bob", attribution: googleAd },
      { key: "c4", createdAt: "2026-09-06T08:00:00Z", contactId: "cy", attribution: {} },
      { key: "c5", createdAt: "2026-09-07T08:00:00Z", contactId: "dee", attribution: facebook },
    ],
    contacts: [
      { id: "ada", lifecycle: "customer", accountIds: ["acme"] },
      { id: "bob", lifecycle: "prospect", accountIds: [] },
      { id: "cy", lifecycle: "lead", accountIds: [] },
      { id: "dee", lifecycle: "lead", accountIds: [] },
    ],
    deals: [
      { id: "d-acme", contactId: "ada", accountId: "acme", amountMinor: 450_000, currency: "ZAR", won: true, wonAt: "2026-09-10T08:00:00Z" },
      { id: "d-zed", contactId: null, accountId: "zed", amountMinor: 100_000, currency: "ZAR", won: true, wonAt: "2026-09-12T08:00:00Z" },
      { id: "d-open", contactId: "dee", accountId: null, amountMinor: 50_000, currency: "ZAR", won: false, wonAt: null },
    ],
    revenue: [
      { key: "k1", invoiceId: "i1", number: "INV-1", dealId: "d-acme", clientKind: "company", clientRef: "acme", totalMinor: 450_000, currency: "ZAR", paidAt: "2026-09-20T08:00:00Z" },
      { key: "k2", invoiceId: "i2", number: "INV-2", dealId: null, clientKind: "company", clientRef: "zed", totalMinor: 100_000, currency: "ZAR", paidAt: "2026-09-21T08:00:00Z" },
      { key: "k3", invoiceId: "i3", number: "INV-3", dealId: null, clientKind: "company", clientRef: "acme", totalMinor: 99_900, currency: "ZAR", paidAt: "2026-10-05T08:00:00Z" },
    ],
    costs: [
      { scope: "own", channel: "paid", period: "2026-09", amountMinor: 200_000, currency: "ZAR", note: null },
      { scope: "own", channel: "paid", period: "2026-08", amountMinor: 999_999, currency: "ZAR", note: null },
    ],
  });
  const report = buildOwnAttribution(input);
  const row = (channel: string) => report.rows.find((r) => r.channel === channel);

  it("counts the period's leads under their first and last touch, and leaves out a lead from another month", () => {
    // Ada's August capture is not a September lead; her September capture (a newsletter) is.
    expect(row("email")!.first.leads).toBe(1);
    expect(row("email")!.last.leads).toBe(1);
    expect(row("organic_search")?.first.leads ?? 0).toBe(0);
    expect(row("paid")!.first.leads).toBe(1);
    expect(row("social")!.first.leads).toBe(1);
    // A lead with nothing on record at all is unattributed, never guessed.
    expect(row("unattributed")!.first.leads).toBe(1);
    expect(report.totals.first.leads).toBe(4);
  });

  it("counts a lead as qualified when its contact became a prospect or customer or has a deal", () => {
    expect(row("paid")!.first.qualified).toBe(1);
    expect(row("email")!.first.qualified).toBe(1);
    // Dee has an open deal; Cy has nothing.
    expect(row("social")!.first.qualified).toBe(1);
    expect(row("unattributed")!.first.qualified).toBe(0);
  });

  it("credits a won deal to the customer's FIRST touch (the earliest capture) and to its last touch before the win", () => {
    expect(row("organic_search")!.first.won).toBe(1);
    expect(row("organic_search")!.first.wonValue).toEqual({ ZAR: 450_000 });
    // Before the win on 10 September the latest capture was the newsletter.
    expect(row("email")!.last.won).toBe(1);
    expect(row("organic_search")!.last.won).toBe(0);
  });

  it("credits money paid in the period the same way, and leaves out an invoice paid after it", () => {
    expect(row("organic_search")!.first.revenue).toEqual({ ZAR: 450_000 });
    expect(row("email")!.last.revenue).toEqual({ ZAR: 450_000 });
    // INV-3 was paid in October: not in September's report.
    expect(report.totals.first.revenue).toEqual({ ZAR: 550_000 });
  });

  it("a sale with no capture behind it is unattributed, in both models", () => {
    expect(row("unattributed")!.first.won).toBe(1);
    expect(row("unattributed")!.last.won).toBe(1);
    expect(row("unattributed")!.first.revenue).toEqual({ ZAR: 100_000 });
    expect(row("unattributed")!.last.revenue).toEqual({ ZAR: 100_000 });
  });

  it("never counts a sale twice within a model, or splits it", () => {
    expect(report.totals.first.won).toBe(2);
    expect(report.totals.last.won).toBe(2);
    expect(report.totals.first.wonValue).toEqual({ ZAR: 550_000 });
    expect(report.totals.last.wonValue).toEqual({ ZAR: 550_000 });
  });

  it("shows the cost recorded for the period and the cost per first-touch lead, and ignores another month's", () => {
    expect(row("paid")!.cost).toEqual({ ZAR: 200_000 });
    expect(row("paid")!.costPerLead).toEqual({ ZAR: 200_000 });
    expect(report.totals.cost).toEqual({ ZAR: 200_000 });
    expect(row("social")!.costPerLead).toBeNull();
  });

  it("names the campaign the leads came from", () => {
    expect(report.campaigns.map((c) => c.campaign).sort()).toEqual(["launch", "september", "spring"]);
  });

  it("with remembered visits, a lead's first and last touch can differ and the report says how many were remembered", () => {
    const remembered = buildOwnAttribution(own({
      captures: [{ key: "c9", createdAt: "2026-09-08T08:00:00Z", contactId: "eve", attribution: { pageUrl: "https://acme.co.za/", ftSource: "google", ftMedium: "organic", ltSource: "newsletter", ltMedium: "email" } }],
      contacts: [{ id: "eve", lifecycle: "lead", accountIds: [] }],
    }));
    expect(remembered.rows.find((r) => r.channel === "organic_search")!.first.leads).toBe(1);
    expect(remembered.rows.find((r) => r.channel === "email")!.last.leads).toBe(1);
    expect(remembered.persistedShare).toBe(1);
    expect(report.persistedShare).toBe(0);
  });

  it("keeps money per currency and never converts it", () => {
    const mixed = buildOwnAttribution(own({
      captures: [{ key: "c1", createdAt: "2026-09-01T08:00:00Z", contactId: "ada", attribution: organic }],
      contacts: [{ id: "ada", lifecycle: "customer", accountIds: [] }],
      revenue: [
        { key: "k1", invoiceId: null, number: null, dealId: null, clientKind: "contact", clientRef: "ada", totalMinor: 100_000, currency: "ZAR", paidAt: "2026-09-02T08:00:00Z" },
        { key: "k2", invoiceId: null, number: null, dealId: null, clientKind: "contact", clientRef: "ada", totalMinor: 5_000, currency: "USD", paidAt: "2026-09-03T08:00:00Z" },
      ],
    }));
    expect(mixed.totals.first.revenue).toEqual({ ZAR: 100_000, USD: 5_000 });
  });

  it("an empty period gives an empty report, not an error", () => {
    const none = buildOwnAttribution(own());
    expect(none.rows).toEqual([]);
    expect(none.totals.first.leads).toBe(0);
    expect(none.persistedShare).toBeNull();
  });
});

describe("a client's attribution: its enquiries and what it told us became of them", () => {
  const lead = (key: string, at: string, attribution: Record<string, unknown>, outcome: ClientInput["leads"][number]["outcome"] = "new", value: number | null = null, source = "form") => ({ key, source, platform: null, capturedAt: at, attribution, outcome, valueMinor: value, currency: value == null ? null : "ZAR", name: null });
  const report = buildClientAttribution({
    from: FROM,
    to: TO,
    ownHosts: ["acme.co.za"],
    leads: [
      lead("a", "2026-09-02T08:00:00Z", organic, "won", 1_200_000),
      lead("b", "2026-09-03T08:00:00Z", organic, "qualified"),
      lead("c", "2026-09-04T08:00:00Z", googleAd, "lost"),
      lead("d", "2026-09-05T08:00:00Z", {}, "new"),
      lead("e", "2026-09-06T08:00:00Z", {}, "new", null, "social"),
      lead("f", "2026-10-02T08:00:00Z", organic),
    ],
    costs: [{ scope: "company:acme", channel: "organic_search", period: "2026-09", amountMinor: 600_000, currency: "ZAR", note: "SEO retainer" }],
  });
  const row = (channel: string) => report.rows.find((r) => r.channel === channel)!;

  it("counts enquiries by channel, what the client called serious, and what became work with its value", () => {
    expect(row("organic_search").first).toMatchObject({ leads: 2, qualified: 2, won: 1, wonValue: { ZAR: 1_200_000 }, revenue: { ZAR: 1_200_000 } });
    expect(row("paid").first).toMatchObject({ leads: 1, qualified: 0, won: 0 });
    // A social message counts where it arrived; a lead with no tags at all is unattributed.
    expect(row("social").first.leads).toBe(1);
    expect(row("unattributed").first.leads).toBe(1);
    expect(report.totals.first.leads).toBe(5);
  });

  it("leaves out an enquiry from another month and shows the cost per lead", () => {
    expect(report.totals.first.leads).toBe(5);
    expect(row("organic_search").cost).toEqual({ ZAR: 600_000 });
    expect(row("organic_search").costPerLead).toEqual({ ZAR: 300_000 });
  });

  it("a client's revenue is only what it reported", () => {
    expect(report.totals.first.revenue).toEqual({ ZAR: 1_200_000 });
  });
});

describe("the months a range covers", () => {
  it("lists them in South African time", () => {
    expect(periodsIn(FROM, TO)).toEqual(["2026-09"]);
    expect(periodsIn("2026-08-15T00:00:00Z", "2026-10-05T00:00:00Z")).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(periodsIn("2026-12-20T00:00:00Z", "2027-01-05T00:00:00Z")).toEqual(["2026-12", "2027-01"]);
  });
});

// ---------------------------------------------------------------------------

const UUID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const BILLING = "plugin.partnersinbiz.billing";

beforeEach(() => {
  resetLeadCaches();
  resetEventCaches();
});

function capture(key: string, contactId: string | null, at: string, attribution: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { id: `cap-${key}`, company_id: CO, source_id: "src1", key, outcome: "stored", contact_id: contactId, client_kind: null, client_ref: null, attribution, consent: false, ip_hash: null, created_at: at, ...extra };
}

function attributionStore() {
  return careSeed({
    deals: [
      deal("d-acme", "Acme SEO retainer", { account_id: "acme", contact_id: "ada", stage_id: "st-won", amount_minor: 450_000, won_at: "2026-09-10T08:00:00Z" }),
      deal("d-solo", "Solo website", { contact_id: "solo", amount_minor: 1_500_000 }),
    ],
    lead_captures: [
      capture("k-ada-1", "ada", "2026-08-20T08:00:00Z", { pageUrl: "https://pib.example.co.za/", utmSource: "google", utmMedium: "organic" }),
      capture("k-ada-2", "ada", "2026-09-02T08:00:00Z", { pageUrl: "https://pib.example.co.za/", utmSource: "newsletter", utmMedium: "email" }),
      capture("k-grace", "grace", "2026-09-04T08:00:00Z", { pageUrl: "https://pib.example.co.za/", utmSource: "google", utmMedium: "cpc", gclid: "x" }),
      // A client's capture is the client's: never part of our own report.
      capture("k-theirs", null, "2026-09-05T08:00:00Z", { utmSource: "google", utmMedium: "organic" }, { client_kind: "company", client_ref: "acme" }),
    ],
    channel_costs: [],
    revenue_events: [],
  });
}

describe("the attribution report on the real tables", () => {
  it("our own report joins captures, contacts, deals and the invoices Billing said were paid", async () => {
    const booted = await bootCare({ store: attributionStore() });
    await booted.harness.emit(`${BILLING}.invoice.paid`, { key: "billing:invoice:i1:paid", invoiceId: "i1", number: "INV-1", dealId: "d-acme", clientKind: "company", clientRef: "acme", totalMinor: 450_000, currency: "ZAR", paidAt: "2026-09-20T08:00:00Z" }, { companyId: CO });
    // Billing sends it more than once: it is one payment.
    await booted.harness.emit(`${BILLING}.invoice.paid`, { key: "billing:invoice:i1:paid", invoiceId: "i1", number: "INV-1", dealId: "d-acme", clientKind: "company", clientRef: "acme", totalMinor: 450_000, currency: "ZAR", paidAt: "2026-09-20T08:00:00Z" }, { companyId: CO });
    expect(booted.store.revenue_events).toHaveLength(1);
    expect(booted.store.revenue_events![0]).toMatchObject({ key: "billing:invoice:i1:paid", deal_id: "d-acme", total_minor: 450_000, currency: "ZAR", client_ref: "acme" });
    await tool(booted.harness, "record-channel-cost", { channel: "paid", period: "2026-09", amountMinor: 200_000, note: "Google Ads, from the card statement" });

    const report = await tool<Record<string, any>>(booted.harness, "attribution-report", { period: "2026-09" });
    expect(report).toMatchObject({ scope: "own", client: null, period: "2026-09" });
    const by = (channel: string) => report.channels.find((c: { channel: string }) => c.channel === channel);
    expect(by("email").firstTouch.leads).toBe(1);
    expect(by("paid")).toMatchObject({ cost: "R 2,000.00", costPerLead: "R 2,000.00" });
    expect(by("organic_search").firstTouch).toMatchObject({ won: 1, wonValue: "R 4,500.00", revenue: "R 4,500.00" });
    expect(by("email").lastTouch).toMatchObject({ won: 1, revenue: "R 4,500.00" });
    expect(report.totals.firstTouch.leads).toBe(2);
    expect(report.notes.join(" ")).toMatch(/Nothing is guessed/);
    expect(report.notes.join(" ")).toMatch(/invoices not yet paid are not counted/);
    // The client's own capture is not in our report.
    expect(JSON.stringify(report)).not.toContain("k-theirs");
  });

  it("an invoice paid with no client still leaves a revenue row when it names a deal", async () => {
    const booted = await bootCare({ store: attributionStore() });
    await booted.harness.emit(`${BILLING}.invoice.paid`, { key: "billing:invoice:i2:paid", invoiceId: "i2", number: "INV-2", dealId: "d-solo", clientKind: null, clientRef: null, totalMinor: 100, currency: "ZAR", paidAt: "2026-09-21T08:00:00Z" }, { companyId: CO });
    expect(booted.store.revenue_events).toHaveLength(1);
    expect(booted.store.revenue_events![0]).toMatchObject({ deal_id: "d-solo", client_ref: "solo" });
    // A payment with nothing to hang it on is still kept, as unattributed money.
    await booted.harness.emit(`${BILLING}.invoice.paid`, { key: "billing:invoice:i3:paid", invoiceId: "i3", number: "INV-3", dealId: null, clientKind: null, clientRef: null, totalMinor: 777, currency: "ZAR", paidAt: "2026-09-22T08:00:00Z" }, { companyId: CO });
    expect(booted.store.revenue_events).toHaveLength(2);
    const report = await tool<Record<string, any>>(booted.harness, "attribution-report", { period: "2026-09" });
    expect(report.channels.find((c: { channel: string }) => c.channel === "unattributed").firstTouch.revenueMinor).toEqual({ ZAR: 877 });
  });

  it("records a cost once per channel and month: a second figure corrects the first", async () => {
    const booted = await bootCare({ store: attributionStore() });
    const first = await tool<Record<string, any>>(booted.harness, "record-channel-cost", { client: "company:acme", channel: "organic_search", period: "2026-09", amountMinor: 600_000, note: "SEO retainer" });
    expect(first).toMatchObject({ recorded: "created", scope: "company:acme", cost: "R 6,000.00" });
    expect(await tool(booted.harness, "record-channel-cost", { client: "company:acme", channel: "organic_search", period: "2026-09", amountMinor: 650_000 })).toMatchObject({ recorded: "updated" });
    expect(booted.store.channel_costs).toHaveLength(1);
    expect(booted.store.channel_costs![0]).toMatchObject({ amount_minor: 650_000, scope: "company:acme" });
    for (const [params, pattern] of [
      [{ channel: "tv", period: "2026-09", amountMinor: 1 }, /channel must be one of/],
      [{ channel: "paid", period: "Sept", amountMinor: 1 }, /period must be YYYY-MM/],
      [{ channel: "paid", period: "2026-09", amountMinor: -5 }, /whole number of cents/],
      [{ channel: "paid", period: "2026-09", amountMinor: 1.5 }, /whole number of cents/],
      [{ channel: "paid", period: "2026-09", amountMinor: 5, currency: "RANDS" }, /3-letter/],
    ] as const) await expect(tool(booted.harness, "record-channel-cost", params)).rejects.toThrow(pattern);
  });

  it("a client's report: its enquiries by channel, what it told us became of them, and its site visits", async () => {
    const booted = await bootCare({ store: attributionStore() });
    await rememberPluginUiBase(booted.harness.ctx, `/_plugins/${UUID}/ui/`);
    const stamp = new Date().toISOString();
    booted.store.client_leads!.push(
      { id: "cl1", key: "form:src:aaa:20260902", company_id: CO, client_kind: "company", client_ref: "acme", source: "form", platform: null, name: "Jane Smith", handle: null, email: "jane@smith.test", message: "quote", url: null, item_id: null, confidence: null, captured_at: "2026-09-02T08:00:00Z", phone: null, meta: { attribution: { pageUrl: "https://acme.co.za/", utmSource: "google", utmMedium: "organic" } }, issue_id: null, outcome: "new", value_minor: null, value_currency: null },
      { id: "cl2", key: "form:src:bbb:20260903", company_id: CO, client_kind: "company", client_ref: "acme", source: "form", platform: null, name: "Pat", handle: null, email: "pat@smith.test", message: "quote", url: null, item_id: null, confidence: null, captured_at: "2026-09-03T08:00:00Z", phone: null, meta: { attribution: { pageUrl: "https://acme.co.za/", referrer: "https://l.facebook.com/" } }, issue_id: null, outcome: "new", value_minor: null, value_currency: null },
    );
    expect(stamp).toBeTruthy();
    // The agent sees the enquiries and what they came from, with no address or phone number.
    const listed = await tool<Record<string, any>>(booted.harness, "list-client-leads", { client: "company:acme", period: "2026-09" });
    expect(listed.count).toBe(2);
    expect(JSON.stringify(listed)).not.toMatch(/jane@smith|pat@smith|phone/);
    expect(listed.leads.find((l: { key: string }) => l.key === "form:src:aaa:20260902")).toMatchObject({ firstTouch: "organic_search", outcome: "new", name: "Jane Smith" });
    // The client says what became of one.
    await expect(tool(booted.harness, "record-lead-outcome", { client: "company:acme", key: "form:src:aaa:20260902", outcome: "contacted", valueMinor: 5 })).rejects.toThrow(/only with outcome won/);
    await expect(tool(booted.harness, "record-lead-outcome", { client: "company:acme", key: "nope", outcome: "won" })).rejects.toThrow(/was not found for this client/);
    await expect(tool(booted.harness, "record-lead-outcome", { client: "company:acme", key: "form:src:aaa:20260902", outcome: "great" })).rejects.toThrow(/outcome must be one of/);
    await expect(tool(booted.harness, "record-lead-outcome", { client: "company:globex", key: "form:src:aaa:20260902", outcome: "won" })).rejects.toThrow(/was not found for this client/);
    expect(await tool(booted.harness, "record-lead-outcome", { client: "company:acme", key: "form:src:aaa:20260902", outcome: "won", valueMinor: 1_200_000 })).toMatchObject({ outcome: "won", value: "R 12,000.00" });
    // Site visits for the same client, from its event key.
    const made = await tool<Record<string, any>>(booted.harness, "create-event-key", { client: "company:acme", label: "Acme", siteUrl: "https://acme.co.za" });
    await handleEventsWebhook(booted.harness.ctx, { endpointKey: "ev", headers: { "x-real-ip": "203.0.113.5" }, rawBody: "{}", parsedBody: { k: made.key.writeKey, ev: [{ t: "pv", p: "/", e: 1, v: { r: "www.google.com" } }] }, requestId: "r" });

    const report = await tool<Record<string, any>>(booted.harness, "attribution-report", { client: "company:acme", period: "2026-09" });
    expect(report).toMatchObject({ scope: "client", client: "company:acme", clientName: "Acme Plumbing" });
    expect(report.channels.find((c: { channel: string }) => c.channel === "organic_search").firstTouch).toMatchObject({ leads: 1, qualified: 1, won: 1, revenue: "R 12,000.00" });
    expect(report.channels.find((c: { channel: string }) => c.channel === "social").firstTouch.leads).toBe(1);
    expect(report.notes.join(" ")).toMatch(/only what the client told us/);
    // The visits come from the site events, in the current month (the report asks for September, so none): asking for 90 days has them.
    expect(report.siteEvents).toBeUndefined();
    const recent = await tool<Record<string, any>>(booted.harness, "attribution-report", { client: "company:acme", days: 30 });
    expect(recent.siteEvents).toMatchObject({ visits: 1 });
  });

  it("the tools refuse a client the caller cannot see, and a bad month", async () => {
    const booted = await bootCare({ store: attributionStore() });
    await expect(tool(booted.harness, "attribution-report", { client: "company:foreign" })).rejects.toThrow(/not found or is not visible/);
    await expect(tool(booted.harness, "attribution-report", { period: "2026-13" })).rejects.toThrow(/period must be YYYY-MM/);
    await expect(tool(booted.harness, "list-client-leads", { client: "company:foreign" })).rejects.toThrow(/not found or is not visible/);
    expect(await booted.harness.performAction("crm.attribution-report", { period: "2026-09" }, { companyId: CO, actor: BOARD })).toMatchObject({ scope: "own" });
  });
});

describe("the client's monthly report", () => {
  it("has a section on where the enquiries and visitors came from when there is something to say, and none when there is not", async () => {
    const booted = await bootCare({ store: careSeed() });
    await rememberPluginUiBase(booted.harness.ctx, `/_plugins/${UUID}/ui/`);
    const none = await growthSection(booted.harness.ctx, CO, { kind: "company", id: "acme" }, "2026-09");
    expect(none).toBeNull();
    booted.store.client_leads!.push({ id: "cl1", key: "k1", company_id: CO, client_kind: "company", client_ref: "acme", source: "form", platform: null, name: "Jane", handle: null, email: "j@x.test", message: "", url: null, item_id: null, confidence: null, captured_at: "2026-09-02T08:00:00Z", phone: null, meta: { attribution: { utmSource: "google", utmMedium: "organic", pageUrl: "https://acme.co.za/" } }, issue_id: null, outcome: "won", value_minor: 900_000, value_currency: "ZAR" });
    const made = await tool<Record<string, any>>(booted.harness, "create-event-key", { client: "company:acme", label: "Acme", siteUrl: "https://acme.co.za" });
    await handleEventsWebhook(booted.harness.ctx, { endpointKey: "ev", headers: { "x-real-ip": "203.0.113.6" }, rawBody: "{}", parsedBody: { k: made.key.writeKey, ev: [{ t: "pv", p: "/", e: 1, v: { r: "www.google.com" } }, { t: "cv", n: "call_clicked", v: { r: "www.google.com" } }] }, requestId: "r" }, { now: new Date("2026-09-15T10:00:00Z") });
    const section = (await growthSection(booted.harness.ctx, CO, { kind: "company", id: "acme" }, "2026-09"))!;
    expect(section).toMatchObject({ module: "growth", title: "Where your enquiries came from", source: "crm" });
    expect(section.headline).toEqual([
      { label: "Website visits", value: "1", delta: null },
      { label: "Actions on your site", value: "1", delta: "100% of visits" },
      { label: "Enquiries that became work", value: "1", delta: "R 9,000.00" },
    ]);
    expect(section.bullets).toEqual(["Organic search: 1 enquiry, 1 serious, 1 became work (R 9,000.00).", "Organic search brought 1 visit and 1 action on your site."]);
    // A visit count is an estimate, and the client is told so where it reads the number.
    expect(section.note).toBe("Visit and action counts are estimates: visitors whose browser asks not to be tracked are not counted.");
    // What the client reads never carries a cost or an internal note.
    expect(JSON.stringify(section)).not.toMatch(/cost|internal|SEO retainer/i);
  });

  it("is in the built report, and the report is worth sending for a client whose only number is the visit counter", async () => {
    const booted = await bootCare({ store: careSeed() });
    await rememberPluginUiBase(booted.harness.ctx, `/_plugins/${UUID}/ui/`);
    const made = await tool<Record<string, any>>(booted.harness, "create-event-key", { client: "company:acme", label: "Acme", siteUrl: "https://acme.co.za" });
    await handleEventsWebhook(booted.harness.ctx, { endpointKey: "ev", headers: { "x-real-ip": "203.0.113.7" }, rawBody: "{}", parsedBody: { k: made.key.writeKey, ev: [{ t: "pv", p: "/", e: 1, v: { s: "newsletter", m: "email" } }] }, requestId: "r" }, { now: new Date("2026-09-15T10:00:00Z") });
    const dry = await tool<Record<string, any>>(booted.harness, "build-client-report", { client: "company:acme", period: "2026-09", dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, stored: false });
    expect(dry.preview).toMatch(/## Where your enquiries came from/);
    expect(dry.preview).toMatch(/- Website visits: 1/);
    expect(dry.preview).toMatch(/Email brought 1 visit/);
    expect(dry.preview).toMatch(/Visit and action counts are estimates/);
  });
});

describe("a very large company: the own report says when it did not read everything", () => {
  it("adds a note for each limit it reached, and none when it read everything", async () => {
    const store = attributionStore();
    const booted = await bootCare({ store });
    const quiet = await tool<Record<string, any>>(booted.harness, "attribution-report", { period: "2026-09" });
    expect(quiet.notes.join(" ")).not.toMatch(/read only/);
    // 5,000 deals: the most the report reads.
    for (let i = 0; i < 5_000; i += 1) store.deals!.push(deal(`bulk-${i}`, `Bulk ${i}`, { contact_id: "solo" }));
    const full = await tool<Record<string, any>>(booted.harness, "attribution-report", { period: "2026-09" });
    expect(full.notes.join(" ")).toMatch(/This report read only 5000 deals, so some deals may be missing\./);
    expect(full.notes.join(" ")).not.toMatch(/captures|contacts/);
  });
});
