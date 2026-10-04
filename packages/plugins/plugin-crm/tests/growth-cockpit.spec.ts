import { beforeEach, describe, expect, it } from "vitest";
import { rememberPluginUiBase } from "@partnersinbiz/pib-plugin-kit";
import { cockpitSnapshot } from "../src/cockpit.js";
import { eventKeyItems } from "../src/care-setup.js";
import { runClientCareJob } from "../src/care-jobs.js";
import { configurePagesDir } from "../src/esign-pages.js";
import { esignHealth, esignSetupItem, runEsignCare } from "../src/esign.js";
import { growthKpis } from "../src/growth-kpis.js";
import { handleEventsWebhook, resetEventCaches } from "../src/site-events.js";
import { eventKeysHealth, EVENT_KEY_QUIET_DAYS } from "../src/site-events-health.js";
import { resetLeadCaches } from "../src/lead-capture.js";
import { setupStatus } from "../src/setup-status.js";
import { bootCare, CO, DAY, enableFor, makeDoc, sendAndApprove, signBody, signDelivery, SERVER_IPS, tool, usePages } from "./helpers/esign.js";
import { handleSignWebhook } from "../src/esign-public.js";

const pages = usePages();
const UUID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";

beforeEach(() => {
  resetLeadCaches();
  resetEventCaches();
});

const ev = (booted: Awaited<ReturnType<typeof bootCare>>, key: string, events: unknown[], now?: Date) =>
  handleEventsWebhook(booted.harness.ctx, { endpointKey: "ev", headers: { "x-real-ip": "203.0.113.5" }, rawBody: "{}", parsedBody: { k: key, ev: events }, requestId: "r" }, now ? { now } : {});

describe("numbers for the Cockpit's goals", () => {
  it("a company with nothing set up gets no growth numbers: a number that cannot be read is absent, not zero", async () => {
    const booted = await bootCare();
    expect(await growthKpis(booted.harness.ctx, CO, "ZAR")).toEqual([]);
    const snap = await cockpitSnapshot(booted.harness.ctx, CO);
    expect(snap.kpis.some((k) => ["leads_30d", "site_visits_30d", "docs_signed_30d"].includes(k.key))).toBe(false);
  });

  it("our own lead form gives leads, leads from organic search, and the paid revenue that can be traced to a source", async () => {
    const booted = await bootCare();
    await tool(booted.harness, "create-lead-endpoint", { label: "Our contact form" });
    const stamp = new Date().toISOString();
    booted.store.lead_captures!.push(
      { id: "c1", company_id: CO, source_id: "s", key: "k1", outcome: "stored", contact_id: "ada", client_kind: null, client_ref: null, attribution: { pageUrl: "https://x.co.za/", utmSource: "google", utmMedium: "organic" }, consent: false, ip_hash: null, created_at: stamp },
      { id: "c2", company_id: CO, source_id: "s", key: "k2", outcome: "stored", contact_id: "grace", client_kind: null, client_ref: null, attribution: { pageUrl: "https://x.co.za/", utmSource: "newsletter", utmMedium: "email" }, consent: false, ip_hash: null, created_at: stamp },
    );
    booted.store.revenue_events = [{ id: "r1", company_id: CO, key: "k", invoice_id: "i", number: "INV-1", deal_id: null, client_kind: "company", client_ref: "acme", total_minor: 450_000, currency: "ZAR", paid_at: stamp }];
    const kpis = await growthKpis(booted.harness.ctx, CO, "ZAR");
    const by = (key: string) => kpis.find((k) => k.key === key)!;
    expect(by("leads_30d")).toMatchObject({ value: "2", raw: 2, group: "marketing" });
    expect(by("organic_leads_30d")).toMatchObject({ value: "1", raw: 1 });
    // Ada (who works at Acme) came through the form, so Acme's payment is traced to her first touch. The money is formatted the way the
    // Cockpit's goals read it (whole units from minor units); the number in the KPI is minor units.
    expect(by("attributed_revenue_30d")).toMatchObject({ raw: 450_000, value: "R 4,500.00", hint: "R 4,500.00 paid in all" });
    // (the Cockpit reads a value that looks like money as raw / 100, which is why raw is in cents and value says "R 4,500.00")
    expect(Number(by("attributed_revenue_30d").value.replace(/[^0-9.]/g, "")) * 100).toBe(by("attributed_revenue_30d").raw);
    // Goals read these by key: kpi:partnersinbiz.crm:leads_30d.
    const snap = await cockpitSnapshot(booted.harness.ctx, CO);
    expect(snap.kpis.find((k) => k.key === "leads_30d")).toMatchObject({ raw: 2 });
  });

  it("our own site's visits and actions, and the documents clients signed and are still to sign", async () => {
    const booted = await bootCare();
    await rememberPluginUiBase(booted.harness.ctx, `/_plugins/${UUID}/ui/`);
    const made = await tool<Record<string, any>>(booted.harness, "create-event-key", { label: "Our site", siteUrl: "https://partnersinbiz.online" });
    await ev(booted, made.key.writeKey, [{ t: "pv", p: "/", e: 1 }, { t: "cv", n: "form_submitted" }]);
    await enableFor(booted);
    const doc = await makeDoc(booted, "company:acme");
    const out = await sendAndApprove(booted, doc.documentId);
    const row = booted.store.sign_documents![0]!;
    let kpis = await growthKpis(booted.harness.ctx, CO, "ZAR");
    expect(kpis.find((k) => k.key === "site_visits_30d")).toMatchObject({ raw: 1 });
    expect(kpis.find((k) => k.key === "site_conversions_30d")).toMatchObject({ raw: 1 });
    expect(kpis.find((k) => k.key === "docs_waiting_signature")).toMatchObject({ raw: 1, tone: "warn" });
    expect(kpis.find((k) => k.key === "docs_signed_30d")).toMatchObject({ raw: 0 });
    const result = await handleSignWebhook(booted.harness.ctx, signDelivery(signBody({ pageId: row.page_id, contentSha256: row.content_sha256, consentSha256: row.consent_sha256 }, out.token)), { serverIps: SERVER_IPS });
    if (result.status === "signed") await result.effects;
    kpis = await growthKpis(booted.harness.ctx, CO, "ZAR");
    expect(kpis.find((k) => k.key === "docs_signed_30d")).toMatchObject({ raw: 1 });
    expect(kpis.find((k) => k.key === "docs_waiting_signature")).toMatchObject({ raw: 0, tone: "ok" });
  });
});

describe("the Cockpit's checks", () => {
  it("a counter that counted nothing for a week is amber, with what to do; one that is counting is fine", async () => {
    const booted = await bootCare();
    await rememberPluginUiBase(booted.harness.ctx, `/_plugins/${UUID}/ui/`);
    expect(await eventKeysHealth(booted.harness.ctx, CO)).toBeNull();
    const made = await tool<Record<string, any>>(booted.harness, "create-event-key", { client: "company:acme", label: "Acme", siteUrl: "https://acme.co.za" });
    expect((await eventKeysHealth(booted.harness.ctx, CO))!.status).toBe("ok");
    const later = Date.now() + (EVENT_KEY_QUIET_DAYS + 1) * DAY;
    const quiet = (await eventKeysHealth(booted.harness.ctx, CO, later))!;
    expect(quiet).toMatchObject({ key: "event-keys", status: "warn" });
    expect(quiet.fix).toMatch(/needs the owner's OK/);
    await ev(booted, made.key.writeKey, [{ t: "pv", p: "/" }]);
    expect((await eventKeysHealth(booted.harness.ctx, CO, later))!.status).toBe("ok");
  });

  it("a folder the signing pages cannot be written to is red, found before a client is", async () => {
    const booted = await bootCare();
    await enableFor(booted);
    const doc = await makeDoc(booted, "company:acme");
    await sendAndApprove(booted, doc.documentId);
    expect((await esignHealth(booted.harness.ctx, CO)).find((c) => c.key === "esign:pages")).toMatchObject({ status: "ok", detail: "1 document is out for signature." });
    configurePagesDir(null);
    const bad = (await esignHealth(booted.harness.ctx, CO)).find((c) => c.key === "esign:pages")!;
    expect(bad).toMatchObject({ status: "bad" });
    expect(bad.detail).toMatch(/cannot be written/);
    expect(bad.fix).toMatch(/dist\/ui\/s/);
    configurePagesDir(pages.dir);
    // A company with no documents gets no check at all.
    const clean = await bootCare();
    expect(await esignHealth(clean.harness.ctx, CO)).toEqual([]);
  });

  it("both ride in the Cockpit snapshot", async () => {
    const booted = await bootCare();
    await rememberPluginUiBase(booted.harness.ctx, `/_plugins/${UUID}/ui/`);
    await tool(booted.harness, "create-event-key", { client: "company:acme", label: "Acme", siteUrl: "https://acme.co.za" });
    await enableFor(booted);
    await makeDoc(booted, "company:acme");
    const snap = await cockpitSnapshot(booted.harness.ctx, CO);
    expect(snap.health.map((h) => h.key)).toEqual(expect.arrayContaining(["event-keys", "esign:pages"]));
  });
});

describe("the Setup lines", () => {
  it("e-sign is an owner decision with the lawyer's checklist, and says it is turned on once it is", async () => {
    const booted = await bootCare();
    const off = await esignSetupItem(booted.harness.ctx, CO);
    expect(off).toMatchObject({ key: "esign", status: "optional", required: false });
    expect(off.detail).toMatch(/templates are drafts nobody has had reviewed by a lawyer/);
    expect(off.steps!.join("\n")).toMatch(/NOT an advanced electronic signature/);
    expect(off.steps!.join("\n")).toMatch(/docs\/esign-legal-review\.md/);
    await enableFor(booted);
    const on = await esignSetupItem(booted.harness.ctx, CO);
    expect(on).toMatchObject({ status: "done" });
    expect(on.detail).toMatch(/Turned on for 1 client \(1 with the templates marked as reviewed\)\. 0 documents signed so far\./);
    const status = await setupStatus(booted.harness.ctx, CO);
    expect(status.items.map((i) => i.key)).toContain("esign");
    expect(status.items.find((i) => i.key === "esign")!.required).toBe(false);
  });

  it("a site counter is a line per key, with the snippet in its steps and the owner's OK said, and done once it counts", async () => {
    const booted = await bootCare();
    await rememberPluginUiBase(booted.harness.ctx, `/_plugins/${UUID}/ui/`);
    const made = await tool<Record<string, any>>(booted.harness, "create-event-key", { client: "company:acme", label: "Acme", siteUrl: "https://acme.co.za" });
    const [item] = await eventKeyItems(booted.harness.ctx, CO);
    expect(item).toMatchObject({ key: `site-events:${made.key.id}`, title: "Count visits on acme.co.za", status: "missing", required: false, href: "/crm?client=company%3Aacme" });
    expect(item!.steps!.join("\n")).toContain(`data-pib-ev="${made.key.writeKey}"`);
    expect(item!.steps!.join("\n")).toMatch(/never install it yourself/);
    expect(item!.detail).toMatch(/needs the owner's OK/);
    await ev(booted, made.key.writeKey, [{ t: "pv", p: "/" }]);
    expect((await eventKeyItems(booted.harness.ctx, CO))[0]).toMatchObject({ status: "done" });
    // The canary's counter is not a line.
    expect((await eventKeyItems((await bootCare()).harness.ctx, CO))).toEqual([]);
  });
});

describe("the jobs", () => {
  it("the care job expires, reminds and writes the signing pages again after a deploy emptied the folder", async () => {
    const booted = await bootCare();
    await enableFor(booted);
    const made = await makeDoc(booted, "company:acme", { validDays: 1 });
    const out = await sendAndApprove(booted, made.documentId);
    const { rmSync: rm } = await import("node:fs");
    rm(`${pages.dir}/${out.pageId}.html`);
    expect(pages.has(out.pageId)).toBe(false);
    const run = await runClientCareJob(booted.harness.ctx, new Date());
    expect(run.esign).toBe(0);
    expect(pages.has(out.pageId)).toBe(true);
    // Two days on the document ran out of time: the job expires it and its page says so.
    const later = await runClientCareJob(booted.harness.ctx, new Date(Date.now() + 2 * DAY));
    expect(later.esign).toBeGreaterThanOrEqual(1);
    expect(pages.read(out.pageId)).toContain("This link has expired");
    expect((await runEsignCare(booted.harness.ctx, CO, new Date(Date.now() + 3 * DAY))).expired).toBe(0);
  });

  it("the hourly job drops request-log rows past two days and daily counts past a year and more", async () => {
    const booted = await bootCare();
    const old = new Date(Date.now() - 3 * DAY).toISOString();
    booted.store.public_hits = [
      { id: "h1", scope: "sign", subject: "x", ip_hash: "a".repeat(32), outcome: "ok", created_at: old },
      { id: "h2", scope: "ev", subject: "y", ip_hash: "b".repeat(32), outcome: "ok", created_at: new Date().toISOString() },
    ];
    booted.store.site_event_daily = [
      { company_id: CO, key_id: "k", day: "2024-01-01", kind: "pageview", name: "/", channel: "", first_channel: "", n: 5 },
      { company_id: CO, key_id: "k", day: new Date().toISOString().slice(0, 10), kind: "pageview", name: "/", channel: "", first_channel: "", n: 3 },
    ];
    await booted.harness.runJob("setup-status");
    expect(booted.store.public_hits!.map((h) => h.id)).toEqual(["h2"]);
    expect(booted.store.site_event_daily!.map((r) => r.n)).toEqual([3]);
  });
});

