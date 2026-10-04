/**
 * The SQL the fake database cannot check, on a real Postgres with every migration applied: the counters under concurrency, the hash
 * chain under concurrent writers, the one-winner status change, and the loaders the attribution report reads. Skipped when
 * embedded-postgres is not installed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import { appendEvent, verifyChain } from "../src/esign-audit.js";
import {
  countPublicHits,
  docsByStatus,
  docsNeedingEffects,
  eventsOf,
  getDocByPage,
  insertDoc,
  insertToken,
  listDocs,
  moveDoc,
  patchDoc,
  recordPublicHit,
  revokeTokens,
  tokenByHash,
  tokenHash,
  useToken,
} from "../src/esign-store.js";
import { attributionFor } from "../src/attribution.js";
import { clientLeadsBetween, costsOf, deleteRevenueOfDeals, insertRevenue, ownCaptures, putCost, revenueBetween, setLeadOutcome } from "../src/attribution-store.js";
import { canaryAccountId, canaryContactId } from "../src/canary-flag.js";
import { deleteGrowthDataOfClient } from "../src/growth-erase.js";
import { scrubSettledBody } from "../src/outbound.js";
import { handleEventsWebhook, eventsSummaryFor, resetEventCaches } from "../src/site-events.js";
import { resetLeadCaches } from "../src/lead-capture.js";
import { bumpRollup, insertEventKey, purgeRollup, rollupRows } from "../src/site-events-store.js";
import { generateEventKey } from "../src/site-events-form.js";
import { generatePageId } from "../src/esign-pages.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const CO = "co-1";
const available = await embeddedAvailable();

describe.skipIf(!available)("the new SQL on a real Postgres", () => {
  let pg: PgHarness;
  beforeAll(async () => {
    pg = await startPg();
  }, 120_000);
  afterAll(async () => {
    await pg?.stop();
  });
  beforeEach(async () => {
    await pg.reset();
    resetLeadCaches();
    resetEventCaches();
  });

  const newDoc = (id: string, extra: Record<string, unknown> = {}) => ({
    id, companyId: CO, clientKind: "company" as const, clientRef: "acme", dealId: null, quoteId: null, quoteNumber: null, kind: "proposal" as const, title: "Proposal", templateKey: "proposal", templateVersion: "v1", templateReviewed: true,
    content: "# Proposal\n\nWork.\n", contentSha256: "a".repeat(64), consentText: "I agree", consentSha256: "b".repeat(64), valueMinor: 100, currency: "ZAR", brand: { name: "PiB" }, pageId: generatePageId(),
    recipientContactId: "ada", recipientName: "Ada", recipientEmail: "ada@acme.co.za", validDays: 14, createdBy: "agent:a", ...extra,
  });

  it("counts one per event under fifty concurrent writers: none lost, none doubled", async () => {
    const row = { companyId: CO, keyId: "k1", day: "2026-09-15", kind: "pageview", name: "/", channel: "", firstChannel: "" };
    await Promise.all(Array.from({ length: 50 }, () => bumpRollup(pg.ctx, row)));
    const rows = await rollupRows(pg.ctx, CO, "k1", "2026-09-01", "2026-10-01");
    expect(rows).toEqual([{ day: "2026-09-15", kind: "pageview", name: "/", channel: "", firstChannel: "", n: 50 }]);
    // A different dimension is a different row; the range is half open.
    await bumpRollup(pg.ctx, { ...row, name: "/contact" });
    await bumpRollup(pg.ctx, { ...row, day: "2026-10-01" });
    expect((await rollupRows(pg.ctx, CO, "k1", "2026-09-01", "2026-10-01")).map((r) => r.name).sort()).toEqual(["/", "/contact"]);
    await purgeRollup(pg.ctx, "2026-09-16");
    expect((await rollupRows(pg.ctx, CO, "k1", "2026-01-01", "2027-01-01")).map((r) => r.day)).toEqual(["2026-10-01"]);
  });

  it("the audit chain stays valid when several writers append at once", async () => {
    const doc = newDoc("d1");
    await insertDoc(pg.ctx, doc);
    await Promise.all(Array.from({ length: 8 }, (_, i) => appendEvent(pg.ctx, { id: "d1", companyId: CO, contentSha256: doc.contentSha256 }, { kind: i % 2 ? "viewed" : "sent", actor: "system", detail: { n: i } })));
    const events = await eventsOf(pg.ctx, CO, "d1");
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(verifyChain("d1", doc.contentSha256, events)).toMatchObject({ ok: true, events: 8 });
    // A row changed in the database breaks the chain from that row.
    await pg.client.query(`UPDATE ${NAMESPACE}.sign_events SET detail = '{"n": 99}'::jsonb WHERE doc_id = 'd1' AND seq = 4`);
    const tampered = verifyChain("d1", doc.contentSha256, await eventsOf(pg.ctx, CO, "d1"));
    expect(tampered.ok).toBe(false);
    expect(tampered.problems[0]).toMatch(/Row 4 .* was changed after it was written/);
  });

  it("only one of two racing requests wins the signature, and a link is used once", async () => {
    await insertDoc(pg.ctx, newDoc("d2"));
    await moveDoc(pg.ctx, CO, "d2", ["draft"], { status: "sent", sentAt: new Date().toISOString() });
    const wins = await Promise.all(Array.from({ length: 6 }, (_, i) => moveDoc(pg.ctx, CO, "d2", ["sent", "viewed", "awaiting_approval"], { status: "signed", signedAt: new Date().toISOString(), signerName: `Signer ${i}`, nameMatches: false })));
    expect(wins.filter(Boolean)).toHaveLength(1);
    expect((await listDocs(pg.ctx, CO, { kind: "company", id: "acme" }))[0]).toMatchObject({ status: "signed", nameMatches: false });
    // Tokens: stored by hash, revoked together, used once.
    const hash = tokenHash("pibt_x");
    await insertToken(pg.ctx, { hash, companyId: CO, docId: "d2", approvalId: "a1", expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect((await tokenByHash(pg.ctx, hash))!.revokedAt).toBeNull();
    const used = await Promise.all([useToken(pg.ctx, hash), useToken(pg.ctx, hash)]);
    expect(used.filter(Boolean)).toHaveLength(1);
    expect(await revokeTokens(pg.ctx, CO, "d2")).toBe(1);
    expect((await tokenByHash(pg.ctx, hash))!.revokedAt).toBeTruthy();
  });

  it("finds documents by page, by status list, and the signed ones whose follow-up is unfinished", async () => {
    const a = newDoc("d3");
    const b = newDoc("d4");
    await insertDoc(pg.ctx, a);
    await insertDoc(pg.ctx, b);
    await moveDoc(pg.ctx, CO, "d3", ["draft"], { status: "sent" });
    await moveDoc(pg.ctx, CO, "d4", ["draft"], { status: "signed", signedAt: new Date().toISOString() });
    expect((await getDocByPage(pg.ctx, a.pageId))!.id).toBe("d3");
    expect(await getDocByPage(pg.ctx, "nope")).toBeNull();
    expect((await docsByStatus(pg.ctx, CO, ["sent", "viewed"])).map((d) => d.id)).toEqual(["d3"]);
    expect((await docsNeedingEffects(pg.ctx, CO)).map((d) => d.id)).toEqual(["d4"]);
    await patchDoc(pg.ctx, CO, "d4", { effectsDoneAt: { now: true } });
    expect(await docsNeedingEffects(pg.ctx, CO)).toEqual([]);
    // The text is frozen: no patch can reach it.
    await expect(patchDoc(pg.ctx, CO, "d4", { content: "changed" } as never)).rejects.toThrow(/cannot be changed/);
  });

  it("counts the request log by scope, subject, address and outcome within a window", async () => {
    for (let i = 0; i < 5; i += 1) await recordPublicHit(pg.ctx, "sign", "page1", "ip1", i < 2 ? "bad_token" : "ok");
    await recordPublicHit(pg.ctx, "sign", "page2", "ip2", "ok");
    const since = new Date(Date.now() - 60_000).toISOString();
    expect(await countPublicHits(pg.ctx, "sign", since, 100)).toBe(6);
    expect(await countPublicHits(pg.ctx, "sign", since, 100, { subject: "page1" })).toBe(5);
    expect(await countPublicHits(pg.ctx, "sign", since, 100, { ipHash: "ip1", outcome: "bad_token" })).toBe(2);
    expect(await countPublicHits(pg.ctx, "sign", since, 3)).toBe(3);
    expect(await countPublicHits(pg.ctx, "sign", new Date(Date.now() + 60_000).toISOString(), 100)).toBe(0);
  });

  it("takes events through the whole endpoint: key lookup, limits, counters, in one place", async () => {
    const key = generateEventKey();
    await insertEventKey(pg.ctx, { id: "key1", companyId: CO, clientKind: "company", clientRef: "acme", label: "Acme", siteId: null, siteUrl: "https://acme.co.za", hosts: ["acme.co.za"], writeKey: key, status: "active", canary: false, consentMode: "anonymous", rateLimitPerHour: 3000, createdBy: "agent:a" });
    const post = (events: unknown[], ip = "203.0.113.9") => handleEventsWebhook(pg.ctx, { endpointKey: "ev", headers: { "x-real-ip": ip }, rawBody: "{}", parsedBody: { k: key, o: "https://acme.co.za", ev: events }, requestId: "r" });
    await post([{ t: "pv", p: "/services/seo", e: 1, v: { s: "google", m: "cpc", k: "g" } }, { t: "cv", n: "form_submitted", v: { s: "google", m: "cpc" } }]);
    await Promise.all(Array.from({ length: 10 }, (_, i) => post([{ t: "pv", p: "/", e: 1, v: { r: "www.google.com" } }], `203.0.113.${20 + i}`)));
    const { summary } = await eventsSummaryFor(pg.ctx, CO, { kind: "company", id: "acme" }, { from: "2000-01-01", to: "2100-01-01" });
    expect(summary).toMatchObject({ entrances: 11, pageviews: 11, conversions: { total: 1 } });
    expect(summary.channels.find((c) => c.channel === "paid")).toMatchObject({ entrances: 1, conversions: 1, conversionRate: 100 });
    expect(summary.channels.find((c) => c.channel === "organic_search")!.entrances).toBe(10);
    const stored = (await pg.client.query(`SELECT accepted_count FROM ${NAMESPACE}.event_keys WHERE id = 'key1'`)).rows[0] as { accepted_count: string };
    expect(Number(stored.accepted_count)).toBe(12);
    // The request log holds a keyed hash of the address, never the address.
    const hits = (await pg.client.query(`SELECT ip_hash FROM ${NAMESPACE}.public_hits WHERE scope = 'ev'`)).rows as Array<{ ip_hash: string }>;
    expect(hits.length).toBe(11);
    expect(hits.every((h) => /^[0-9a-f]{32}$/.test(h.ip_hash))).toBe(true);
  });

  it("builds our attribution report from the real tables: captures, contacts, links, deals, stages, payments and costs", async () => {
    const q = (sql: string, params: unknown[] = []) => pg.client.query(sql, params);
    await q(`INSERT INTO ${NAMESPACE}.companies (id, company_id, name) VALUES ('acme', $1, 'Acme')`, [CO]);
    await q(`INSERT INTO ${NAMESPACE}.contacts (id, company_id, name, lifecycle) VALUES ('ada', $1, 'Ada', 'customer'), ('bob', $1, 'Bob', 'lead')`, [CO]);
    await q(`INSERT INTO ${NAMESPACE}.contact_companies (id, company_id, contact_id, account_id) VALUES ('l1', $1, 'ada', 'acme')`, [CO]);
    await q(`INSERT INTO ${NAMESPACE}.pipelines (id, company_id, name) VALUES ('p1', $1, 'Sales')`, [CO]);
    await q(`INSERT INTO ${NAMESPACE}.pipeline_stages (id, company_id, pipeline_id, name, kind, position) VALUES ('open', $1, 'p1', 'Open', 'open', 0), ('won', $1, 'p1', 'Won', 'won', 1)`, [CO]);
    await q(`INSERT INTO ${NAMESPACE}.deals (id, company_id, pipeline_id, stage_id, account_id, contact_id, title, amount_minor, currency, won_at) VALUES ('d1', $1, 'p1', 'won', 'acme', 'ada', 'Retainer', 450000, 'ZAR', '2026-09-10T08:00:00Z')`, [CO]);
    await q(`INSERT INTO ${NAMESPACE}.lead_sources (id, company_id, label, public_key) VALUES ('s1', $1, 'Form', 'pibl_x')`, [CO]);
    await q(`INSERT INTO ${NAMESPACE}.lead_captures (id, company_id, source_id, key, contact_id, attribution, created_at) VALUES ('c1', $1, 's1', 'k1', 'ada', $2::jsonb, '2026-08-20T08:00:00Z'), ('c2', $1, 's1', 'k2', 'ada', $3::jsonb, '2026-09-02T08:00:00Z'), ('c3', $1, 's1', 'k3', 'bob', $4::jsonb, '2026-09-04T08:00:00Z')`, [CO, JSON.stringify({ pageUrl: "https://x/", utmSource: "google", utmMedium: "organic" }), JSON.stringify({ pageUrl: "https://x/", utmSource: "newsletter", utmMedium: "email" }), JSON.stringify({ gclid: "g", pageUrl: "https://x/" })]);
    await insertRevenue(pg.ctx, CO, { key: "billing:invoice:i1:paid", invoiceId: "i1", number: "INV-1", dealId: "d1", clientKind: "company", clientRef: "acme", totalMinor: 450_000, currency: "ZAR", paidAt: "2026-09-20T08:00:00Z" });
    expect(await insertRevenue(pg.ctx, CO, { key: "billing:invoice:i1:paid", invoiceId: "i1", number: "INV-1", dealId: "d1", clientKind: "company", clientRef: "acme", totalMinor: 450_000, currency: "ZAR", paidAt: "2026-09-20T08:00:00Z" })).toBe(false);
    expect(await putCost(pg.ctx, CO, { scope: "own", channel: "paid", period: "2026-09", amountMinor: 200_000, currency: "ZAR", note: null }, "agent:a")).toBe("created");
    expect(await putCost(pg.ctx, CO, { scope: "own", channel: "paid", period: "2026-09", amountMinor: 250_000, currency: "ZAR", note: "corrected" }, "agent:a")).toBe("updated");
    expect(await costsOf(pg.ctx, CO, "own")).toEqual([{ scope: "own", channel: "paid", period: "2026-09", amountMinor: 250_000, currency: "ZAR", note: "corrected" }]);
    expect((await ownCaptures(pg.ctx, CO, "2026-10-01T00:00:00Z")).map((c) => c.key)).toEqual(["k1", "k2", "k3"]);
    expect((await revenueBetween(pg.ctx, CO, "2026-08-31T22:00:00.000Z", "2026-09-30T22:00:00.000Z")).map((r) => r.number)).toEqual(["INV-1"]);

    const report = await attributionFor(pg.ctx, CO, null, { from: "2026-08-31T22:00:00.000Z", to: "2026-09-30T22:00:00.000Z" }, "2026-09");
    const row = (channel: string) => report.rows.find((r) => r.channel === channel)!;
    expect(row("email").first.leads).toBe(1);
    expect(row("paid").first).toMatchObject({ leads: 1 });
    expect(row("paid").cost).toEqual({ ZAR: 250_000 });
    expect(row("organic_search").first).toMatchObject({ won: 1, wonValue: { ZAR: 450_000 }, revenue: { ZAR: 450_000 } });
    expect(row("email").last).toMatchObject({ won: 1, revenue: { ZAR: 450_000 } });
  });

  it("a client's leads and what they reported, from the real table", async () => {
    await pg.client.query(`INSERT INTO ${NAMESPACE}.client_leads (id, key, company_id, client_kind, client_ref, source, name, captured_at, meta) VALUES ('a', 'ka', $1, 'company', 'acme', 'form', 'Jane', '2026-09-02T08:00:00Z', $2::jsonb), ('b', 'kb', $1, 'company', 'acme', 'social', 'Pat', '2026-09-03T08:00:00Z', '{}'::jsonb)`, [CO, JSON.stringify({ attribution: { utmSource: "google", utmMedium: "organic" } })]);
    await setLeadOutcome(pg.ctx, CO, "ka", { outcome: "won", valueMinor: 900_000, currency: "ZAR" });
    const leads = await clientLeadsBetween(pg.ctx, CO, { kind: "company", id: "acme" }, "2026-08-31T22:00:00.000Z", "2026-09-30T22:00:00.000Z");
    expect(leads.map((l) => [l.key, l.outcome, l.valueMinor])).toEqual([["ka", "won", 900_000], ["kb", "new", null]]);
    const report = await attributionFor(pg.ctx, CO, { kind: "company", id: "acme" }, { from: "2026-08-31T22:00:00.000Z", to: "2026-09-30T22:00:00.000Z" }, "2026-09");
    expect(report.rows.find((r) => r.channel === "organic_search")!.first).toMatchObject({ leads: 1, won: 1, revenue: { ZAR: 900_000 } });
    expect(report.rows.find((r) => r.channel === "social")!.first.leads).toBe(1);
  });
  it("blanks the text and html of a settled outbox row, never a pending one, in real SQL", async () => {
    const payload = JSON.stringify({ key: "crm:msg:x", subject: "Please sign", to: [{ email: "ada@acme.co.za" }], text: "Open it here: https://x/#pibt_secret", html: "<p>pibt_secret</p>", marketing: false });
    await pg.client.query(`INSERT INTO ${NAMESPACE}.outbox (key, company_id, event, payload, status) VALUES ('p', $1, 'mail.send.requested', $2::jsonb, 'pending'), ('d', $1, 'mail.send.requested', $2::jsonb, 'done'), ('f', $1, 'mail.send.requested', $2::jsonb, 'failed')`, [CO, payload]);
    expect(await scrubSettledBody(pg.ctx, "p")).toBe(false);
    expect(await scrubSettledBody(pg.ctx, "d")).toBe(true);
    expect(await scrubSettledBody(pg.ctx, "f")).toBe(true);
    // Again: nothing more to change is not an error.
    expect(await scrubSettledBody(pg.ctx, "d")).toBe(true);
    const rows = (await pg.client.query(`SELECT key, payload FROM ${NAMESPACE}.outbox ORDER BY key`)).rows as Array<{ key: string; payload: Record<string, unknown> }>;
    expect(rows.map((r) => [r.key, "text" in r.payload, "html" in r.payload])).toEqual([["d", false, false], ["f", false, false], ["p", true, true]]);
    expect(rows[0]!.payload).toMatchObject({ key: "crm:msg:x", subject: "Please sign", to: [{ email: "ada@acme.co.za" }], marketing: false });
  });

  it("leaves the canary's deal and test payment out of our report, and deletes them with the canary", async () => {
    const q = (sql: string, params: unknown[] = []) => pg.client.query(sql, params);
    const account = canaryAccountId(CO);
    const contact = canaryContactId(CO);
    await q(`INSERT INTO ${NAMESPACE}.companies (id, company_id, name) VALUES ($2, $1, 'PiB Canary Co'), ('acme', $1, 'Acme')`, [CO, account]);
    await q(`INSERT INTO ${NAMESPACE}.contacts (id, company_id, name, lifecycle) VALUES ($2, $1, 'Canary', 'lead')`, [CO, contact]);
    await q(`INSERT INTO ${NAMESPACE}.pipelines (id, company_id, name) VALUES ('p1', $1, 'Sales')`, [CO]);
    await q(`INSERT INTO ${NAMESPACE}.pipeline_stages (id, company_id, pipeline_id, name, kind, position) VALUES ('won', $1, 'p1', 'Won', 'won', 1)`, [CO]);
    await q(`INSERT INTO ${NAMESPACE}.deals (id, company_id, pipeline_id, stage_id, account_id, title, amount_minor, currency, won_at) VALUES ('canary-deal', $1, 'p1', 'won', $2, 'Canary retainer', 123400, 'ZAR', '2026-09-10T08:00:00Z'), ('real', $1, 'p1', 'won', 'acme', 'Real', 5000, 'ZAR', '2026-09-11T08:00:00Z')`, [CO, account]);
    await insertRevenue(pg.ctx, CO, { key: "k-canary", invoiceId: "c", number: "INV-C", dealId: null, clientKind: "company", clientRef: account, totalMinor: 123_400, currency: "ZAR", paidAt: "2026-09-20T08:00:00Z" });
    await insertRevenue(pg.ctx, CO, { key: "k-canary-deal", invoiceId: "c2", number: "INV-C2", dealId: "canary-deal", clientKind: null, clientRef: null, totalMinor: 77, currency: "ZAR", paidAt: "2026-09-20T08:00:00Z" });
    await insertRevenue(pg.ctx, CO, { key: "k-real", invoiceId: "r", number: "INV-R", dealId: "real", clientKind: "company", clientRef: "acme", totalMinor: 5_000, currency: "ZAR", paidAt: "2026-09-20T08:00:00Z" });
    const range = { from: "2026-08-31T22:00:00.000Z", to: "2026-09-30T22:00:00.000Z" };
    const report = await attributionFor(pg.ctx, CO, null, range, "2026-09");
    expect(report.totals.first.revenue).toEqual({ ZAR: 5_000 });
    expect(report.totals.first.won).toBe(1);
    expect(report.totals.first.wonValue).toEqual({ ZAR: 5_000 });
    // The cleanup: the canary's rows are deleted (a real client's are only unlinked).
    expect(await deleteRevenueOfDeals(pg.ctx, CO, ["canary-deal"])).toBe(1);
    expect(await deleteRevenueOfDeals(pg.ctx, CO, [])).toBe(0);
    await deleteGrowthDataOfClient(pg.ctx, CO, { kind: "company", id: account });
    await deleteGrowthDataOfClient(pg.ctx, CO, { kind: "company", id: "acme" });
    const left = (await q(`SELECT key, client_ref FROM ${NAMESPACE}.revenue_events ORDER BY key`)).rows;
    expect(left).toEqual([{ key: "k-real", client_ref: null }]);
  });
});
