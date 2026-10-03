import { describe, expect, it } from "vitest";
import { asClientSignal, currentSignal, parseSignalPayload, periodOrEmpty, signalFor, SIGNAL_SENDERS } from "../src/client-signals.js";
import { bootCare, CO, tool, toolRaw } from "./helpers/care.js";

describe("what a module may say about a client", () => {
  it("keeps headline lines and bullets within their limits and drops what says nothing", () => {
    const parsed = parseSignalPayload({
      headline: [{ label: "Clicks", value: "1,240", delta: "+18%" }, { label: "", value: "x" }, { label: "No value", value: "" }, ...Array.from({ length: 20 }, (_, i) => ({ label: `L${i}`, value: String(i) }))],
      bullets: ["  one  ", "", ...Array.from({ length: 20 }, (_, i) => `b${i}`)],
      note: "n".repeat(900),
    })!;
    expect(parsed.headline).toHaveLength(10);
    expect(parsed.headline[0]).toEqual({ label: "Clicks", value: "1,240", delta: "+18%" });
    expect(parsed.headline[1]).toEqual({ label: "L0", value: "0", delta: null });
    expect(parsed.bullets).toHaveLength(8);
    expect(parsed.bullets[0]).toBe("one");
    expect(parsed.note).toHaveLength(400);
    expect(parseSignalPayload({})).toBeNull();
    expect(parseSignalPayload({ headline: [{ label: "", value: "" }], bullets: [""] })).toBeNull();
    expect(parseSignalPayload("nonsense")).toBeNull();
  });

  it("clamps health figures to what they mean and ignores a made-up currency", () => {
    expect(parseSignalPayload({ health: { score: 140, overdueCount: -3, overdueMinor: 12_500, currency: "ZAR", note: "x" } })!.health).toEqual({ score: 100, overdueCount: 0, overdueMinor: 12_500, currency: "ZAR", note: "x" });
    expect(parseSignalPayload({ health: { score: "42", currency: "rand" } })!.health).toEqual({ score: 42 });
    expect(parseSignalPayload({ health: { score: "high" } })).toBeNull();
  });

  it("strips control characters so a sentence can never break a line or a document", () => {
    const parsed = parseSignalPayload({ bullets: ["Line one\u0000\u0007 \u001b[31mred\nline two"] })!;
    expect(parsed.bullets[0]).toBe("Line one [31mred line two");
  });

  it("reads a period as YYYY-MM or empty", () => {
    expect(periodOrEmpty("2026-09")).toBe("2026-09");
    expect(periodOrEmpty("")).toBe("");
    expect(periodOrEmpty(undefined)).toBe("");
    expect(periodOrEmpty("2026-13")).toBeNull();
    expect(periodOrEmpty("Sept")).toBeNull();
  });

  it("needs a client, a month and something to say", () => {
    const base = { clientKind: "company", clientRef: "acme", period: "2026-09", headline: [{ label: "A", value: "1" }] };
    expect(asClientSignal(base)).toMatchObject({ client: { kind: "company", id: "acme" }, period: "2026-09" });
    expect(asClientSignal({ ...base, clientKind: "org" })).toBeNull();
    expect(asClientSignal({ ...base, clientRef: "a b" })).toBeNull();
    expect(asClientSignal({ ...base, period: "soon" })).toBeNull();
    expect(asClientSignal({ clientKind: "company", clientRef: "acme" })).toBeNull();
    expect(asClientSignal({ ...base, updatedAt: "2026-10-01T00:00:00Z" })!.signalAt).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("signals from the other modules", () => {
  const body = { clientKind: "company", clientRef: "acme", period: "2026-09", headline: [{ label: "Clicks", value: "900" }] };

  it("are stored under the module that sent them, never under a module the payload names", async () => {
    const { harness, store } = await bootCare();
    await harness.emit("plugin.partnersinbiz.seo.client.signal", { ...body, module: "billing" }, { companyId: CO });
    expect(store.client_signals).toHaveLength(1);
    expect(store.client_signals![0]).toMatchObject({ module: "seo", source: "event", period: "2026-09", company_id: CO, recorded_by: "partnersinbiz.seo" });
    expect(Object.values(SIGNAL_SENDERS).sort()).toEqual(["billing", "campaigns", "mailbox", "seo", "social"]);
  });

  it("from a plugin that is not a sender are ignored", async () => {
    const { harness, store } = await bootCare();
    await harness.emit("plugin.partnersinbiz.partners.client.signal", body, { companyId: CO });
    await harness.emit("plugin.partnersinbiz.setup.client.signal", body, { companyId: CO });
    expect(store.client_signals ?? []).toHaveLength(0);
  });

  it("an older statement never replaces a newer one, a newer one does, and each company has its own", async () => {
    const { harness, store } = await bootCare();
    const send = (updatedAt: string, value: string, companyId = CO) => harness.emit("plugin.partnersinbiz.seo.client.signal", { ...body, headline: [{ label: "Clicks", value }], updatedAt }, { companyId });
    await send("2026-10-02T00:00:00Z", "900");
    await send("2026-10-01T00:00:00Z", "100");
    expect(store.client_signals![0]!.payload.headline[0].value).toBe("900");
    await send("2026-10-03T00:00:00Z", "1,100");
    expect(store.client_signals).toHaveLength(1);
    expect(store.client_signals![0]!.payload.headline[0].value).toBe("1,100");
    await send("2026-10-03T00:00:00Z", "5", "co-2");
    expect(store.client_signals).toHaveLength(2);
  });

  it("with nothing to say, or for a bad client, change nothing", async () => {
    const { harness, store } = await bootCare();
    await harness.emit("plugin.partnersinbiz.seo.client.signal", { clientKind: "company", clientRef: "acme" }, { companyId: CO });
    await harness.emit("plugin.partnersinbiz.seo.client.signal", { ...body, clientKind: "nope" }, { companyId: CO });
    expect(store.client_signals ?? []).toHaveLength(0);
  });
});

describe("record-client-signal", () => {
  it("records what an agent read from a module's tools, labelled as the agent's", async () => {
    const { harness, store } = await bootCare();
    const result = await tool<Record<string, any>>(harness, "record-client-signal", { client: "company:acme", module: "social", period: "2026-09", headline: [{ label: "Posts", value: "12" }], bullets: ["Best post: the launch photo."] });
    expect(result).toMatchObject({ module: "social", period: "2026-09", stored: true });
    expect(result.next).toMatch(/build-client-report again/);
    expect(store.client_signals![0]).toMatchObject({ module: "social", source: "agent", recorded_by: "agent:agent-1" });
    const rows = store.client_signals!.map((row) => ({ module: row.module, period: row.period, payload: row.payload, source: row.source, recordedBy: row.recorded_by, signalAt: row.signal_at, updatedAt: row.updated_at }));
    expect(signalFor(rows as never, "social", "2026-09")).toMatchObject({ source: "agent", payload: { headline: [{ label: "Posts", value: "12" }] } });
    expect(signalFor(rows as never, "social", "2026-08")).toBeNull();
    expect(currentSignal(rows as never, "social")).toBeNull();
  });

  it("without a month it is the client's current state, which the health score reads", async () => {
    const { harness } = await bootCare();
    const result = await tool<Record<string, any>>(harness, "record-client-signal", { client: "company:acme", module: "billing", health: { overdueCount: 2, overdueMinor: 450_000, currency: "ZAR" } });
    expect(result).toMatchObject({ period: "current" });
    expect(result.next).toMatch(/health score/);
  });

  it("checks the client, the module, the month and that there is something to record", async () => {
    const { harness } = await bootCare();
    expect((await toolRaw(harness, "record-client-signal", { client: "company:nobody", module: "seo", note: "x" })).error).toMatch(/not found/);
    expect((await toolRaw(harness, "record-client-signal", { client: "company:acme", module: "tiktok", note: "x" })).error).toMatch(/module must be one of/);
    expect((await toolRaw(harness, "record-client-signal", { client: "company:acme", module: "seo", period: "last month", note: "x" })).error).toMatch(/period must be YYYY-MM/);
    expect((await toolRaw(harness, "record-client-signal", { client: "company:acme", module: "seo" })).error).toMatch(/at least one headline line/);
  });
});
