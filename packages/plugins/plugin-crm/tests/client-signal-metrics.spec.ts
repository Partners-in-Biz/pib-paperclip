import { beforeEach, describe, expect, it } from "vitest";
import { emitAllOwnMetrics, emitOwnMetrics, ownMetrics, OWN_METRICS_EVENT } from "../src/own-metrics.js";
import { handleEventsWebhook, resetEventCaches } from "../src/site-events.js";
import { resetLeadCaches } from "../src/lead-capture.js";
import { bootCare, CO, tool } from "./helpers/esign.js";

beforeEach(() => {
  resetLeadCaches();
  resetEventCaches();
});

const ev = (booted: Awaited<ReturnType<typeof bootCare>>, key: string, events: unknown[]) =>
  handleEventsWebhook(booted.harness.ctx, { endpointKey: "ev", headers: { "x-real-ip": "203.0.113.5" }, rawBody: "{}", parsedBody: { k: key, ev: events }, requestId: "r" });


describe("own-scope metrics event", () => {
  it("sends nothing when nothing is set up: an unreadable number is absent, not zero", async () => {
    const booted = await bootCare();
    expect(await ownMetrics(booted.harness.ctx, CO)).toEqual([]);
    expect(await emitOwnMetrics(booted.harness.ctx, CO)).toBe(false);
  });

  it("carries website conversion and revenue by source, own scope only", async () => {
    const booted = await bootCare();
    const made = await tool<Record<string, any>>(booted.harness, "create-event-key", { label: "Our site", siteUrl: "https://partnersinbiz.online" });
    await ev(booted, made.key.writeKey, [{ t: "pv", p: "/", e: 1 }, { t: "cv", n: "form_submitted" }]);
    const stamp = new Date().toISOString();
    booted.store.revenue_events = [{ id: "r1", company_id: CO, key: "k", invoice_id: "i", number: "INV-1", deal_id: null, client_kind: "company", client_ref: "acme", total_minor: 450_000, currency: "ZAR", paid_at: stamp }];
    const metrics = await ownMetrics(booted.harness.ctx, CO);
    expect(metrics.find((m) => m.key === "site_conversions")).toMatchObject({ value: 1, unit: "count", period: "30d" });
    expect(metrics.find((m) => m.key === "site_conversion_rate")).toMatchObject({ value: 100, unit: "percent" });
    expect(metrics.find((m) => m.key === "revenue.unattributed.ZAR")).toMatchObject({ value: 4500, unit: "ZAR" });
    expect(metrics.every((m) => Number.isFinite(m.value))).toBe(true);
  });

  it("two scopes: a client's site events never reach the own figures", async () => {
    const booted = await bootCare();
    const own = await tool<Record<string, any>>(booted.harness, "create-event-key", { label: "Our site", siteUrl: "https://partnersinbiz.online" });
    const acme = await tool<Record<string, any>>(booted.harness, "create-event-key", { client: "company:acme", label: "Acme", siteUrl: "https://acme.co.za" });
    await ev(booted, own.key.writeKey, [{ t: "pv", p: "/", e: 1 }]);
    await ev(booted, acme.key.writeKey, [{ t: "pv", p: "/", e: 1 }, { t: "cv", n: "form_submitted" }, { t: "cv", n: "form_submitted" }]);
    const metrics = await ownMetrics(booted.harness.ctx, CO);
    expect(metrics.find((m) => m.key === "site_conversions")).toMatchObject({ value: 0 });
  });

  it("emits one own-scope event with no client keys", async () => {
    const booted = await bootCare();
    const made = await tool<Record<string, any>>(booted.harness, "create-event-key", { label: "Our site", siteUrl: "https://partnersinbiz.online" });
    await ev(booted, made.key.writeKey, [{ t: "pv", p: "/", e: 1 }]);
    const calls: Array<[string, string, Record<string, unknown>]> = [];
    const ctx = { ...booted.harness.ctx, events: { ...booted.harness.ctx.events, emit: async (...args: [string, string, Record<string, unknown>]) => void calls.push(args) } } as typeof booted.harness.ctx;
    expect(await emitOwnMetrics(ctx, CO)).toBe(true);
    expect(calls).toHaveLength(1);
    const [name, company, payload] = calls[0]!;
    expect(name).toBe(OWN_METRICS_EVENT);
    expect(company).toBe(CO);
    expect(payload).toMatchObject({ scope: "own" });
    expect(payload).not.toHaveProperty("clientRef");
    expect(payload).not.toHaveProperty("clientKind");
  });

  it("never throws when the emit fails", async () => {
    const booted = await bootCare();
    const made = await tool<Record<string, any>>(booted.harness, "create-event-key", { label: "Our site", siteUrl: "https://partnersinbiz.online" });
    await ev(booted, made.key.writeKey, [{ t: "pv", p: "/", e: 1 }]);
    const ctx = { ...booted.harness.ctx, events: { ...booted.harness.ctx.events, emit: async () => { throw new Error("boom"); } } } as typeof booted.harness.ctx;
    expect(await emitOwnMetrics(ctx, CO)).toBe(false);
    expect(await emitAllOwnMetrics(ctx)).toBe(0);
  });
});
