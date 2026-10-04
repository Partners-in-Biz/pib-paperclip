import { beforeEach, describe, expect, it } from "vitest";
import type { PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { rememberPluginUiBase } from "@partnersinbiz/pib-plugin-kit";
import { classifyChannel } from "../src/channels.js";
import { resetLeadCaches } from "../src/lead-capture.js";
import { purgeRollup, rollupRows } from "../src/site-events-store.js";
import {
  dayOf,
  EVENT_KEY_GRACE_DAYS,
  EVENT_LIMITS,
  EVENT_RATE,
  eventName,
  generateEventKey,
  isEventKey,
  lastDays,
  parseEvent,
  parseEventsBody,
  pathBucket,
  periodDays,
} from "../src/site-events-form.js";
import { countsFor, EventsRejected, handleEventsWebhook, resetEventCaches, summariseRollup } from "../src/site-events.js";
import { eventSnippet, eventUrls, PRIVACY_NOTES } from "../src/events-embed.js";
import { embedUrls } from "../src/lead-embed.js";
import { BOARD, bootCare, CO, tool, type Booted } from "./helpers/esign.js";

const UUID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const UI_BASE = `/_plugins/${UUID}/ui/`;
const rejected = async (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as Error);

beforeEach(() => {
  resetLeadCaches();
  resetEventCaches();
});

function delivery(body: unknown, headers: Record<string, string> = {}, raw?: string): PluginWebhookInput {
  const rawBody = raw ?? JSON.stringify(body);
  return { endpointKey: "ev", headers: { "x-real-ip": "203.0.113.9", "content-type": "application/json", ...headers }, rawBody, parsedBody: body, requestId: "req-1" };
}

const GOOGLE_AD = { s: "google", m: "cpc", c: "spring", r: "", k: "g" };
const pv = (extra: Record<string, unknown> = {}) => ({ t: "pv", p: "/services/seo", e: 1, v: GOOGLE_AD, ...extra });

async function bootEvents(): Promise<{ booted: Booted; key: string; keyId: string; post: (events: unknown[], extra?: Record<string, unknown>, headers?: Record<string, string>, now?: Date) => ReturnType<typeof handleEventsWebhook> }> {
  const booted = await bootCare();
  await rememberPluginUiBase(booted.harness.ctx, UI_BASE);
  const made = await tool<Record<string, any>>(booted.harness, "create-event-key", { client: "company:acme", label: "Acme website", siteUrl: "https://www.acme.co.za" });
  const key = made.key.writeKey as string;
  const post = (events: unknown[], extra: Record<string, unknown> = {}, headers: Record<string, string> = {}, now?: Date) =>
    handleEventsWebhook(booted.harness.ctx, delivery({ k: key, o: "https://www.acme.co.za", ev: events, ...extra }, headers), now ? { now } : {});
  return { booted, key, keyId: made.key.id as string, post };
}

describe("reading a request: only counts, only what the endpoint knows", () => {
  it("makes and recognises a write key", () => {
    const keys = new Set(Array.from({ length: 40 }, () => generateEventKey()));
    expect(keys.size).toBe(40);
    for (const key of keys) expect(isEventKey(key)).toBe(true);
    for (const bad of ["pibe_short", "pibl_abcdefghijklmnopqrstuvwx", "PIBE_ABCDEFGHIJKLMNOPQRSTUVWX", null, 7]) expect(isEventKey(bad)).toBe(false);
  });

  it("cuts a path to its first segment: no query, no ids, lower case", () => {
    expect(pathBucket("/Services/SEO?x=1#top")).toBe("/services");
    expect(pathBucket("/")).toBe("/");
    expect(pathBucket("/blog/2026/09/how-to-hire-a-plumber-in-ballito")).toBe("/blog");
    expect(pathBucket("/a b/<script>")).toBe("/ab");
    expect(pathBucket("no-slash")).toBeNull();
    expect(pathBucket(`/${"x".repeat(300)}`)).toBeNull();
    expect(pathBucket(5)).toBeNull();
    expect(pathBucket(`/${"y".repeat(100)}`.slice(0, 100))!.length).toBeLessThanOrEqual(EVENT_LIMITS.bucket);
  });

  it("turns an event name into one plain word group and refuses an empty one", () => {
    expect(eventName("Form Submitted!")).toBe("form_submitted");
    expect(eventName("call-clicked")).toBe("call_clicked");
    expect(eventName("  ")).toBe("");
    expect(eventName("x".repeat(100)).length).toBeLessThanOrEqual(EVENT_LIMITS.name);
    expect(eventName("<b>x</b>")).toBe("b_x_b");
  });

  it("parses the three kinds of event and drops anything else", () => {
    expect(parseEvent({ t: "pv", p: "/contact", e: 1, v: GOOGLE_AD })).toMatchObject({ type: "pv", bucket: "/contact", entrance: true, visit: { source: "google", medium: "cpc", click: "g" } });
    expect(parseEvent({ t: "out", n: "https://www.facebook.com/acme/posts/1?x=1" })).toMatchObject({ type: "out", name: "facebook.com" });
    expect(parseEvent({ t: "cv", n: "Form Submitted" })).toMatchObject({ type: "cv", name: "form_submitted" });
    for (const bad of [null, "pv", [], { t: "bogus" }, { t: "out" }, { t: "out", n: "not a host" }, { t: "cv" }, { t: "cv", n: "!!!" }]) expect(parseEvent(bad), JSON.stringify(bad)).toBeNull();
  });

  it("reads personal data out of nothing: a name, an email, a phone number or a visitor id in an event is never in what comes out", () => {
    const parsed = parseEvent({ t: "cv", n: "form_submitted", p: "/contact", email: "jane@acme.co.za", phone: "0821234567", name: "Jane Smith", visitorId: "v-123", v: { s: "google", email: "x@y.z", ip: "1.2.3.4", k: "g" } });
    expect(JSON.stringify(parsed)).not.toMatch(/jane|0821234567|v-123|x@y|1\.2\.3\.4/);
  });

  it("takes at most ten events, drops the ones that do not check out, and says so when none do", () => {
    const body = parseEventsBody({ k: generateEventKey(), ev: [...Array.from({ length: 15 }, () => ({ t: "pv", p: "/" })), { t: "bogus" }] });
    expect(body.ok && body.events).toHaveLength(EVENT_LIMITS.eventsPerRequest);
    expect(parseEventsBody({ k: generateEventKey(), ev: [{ t: "bogus" }] })).toMatchObject({ ok: false, message: "None of the events could be read." });
    expect(parseEventsBody({ k: generateEventKey(), ev: [] })).toMatchObject({ ok: false });
    expect(parseEventsBody({ k: "nope", ev: [{ t: "pv", p: "/" }] })).toMatchObject({ ok: false, message: "The site key is missing or not valid." });
    expect(parseEventsBody({ k: generateEventKey(), ev: "x" })).toMatchObject({ ok: false });
  });

  it("works out South African days, months and the last N days", () => {
    expect(dayOf(new Date("2026-09-30T22:30:00Z"))).toBe("2026-10-01");
    expect(dayOf(new Date("2026-09-30T21:30:00Z"))).toBe("2026-09-30");
    expect(periodDays("2026-09")).toEqual({ from: "2026-09-01", to: "2026-10-01" });
    expect(periodDays("2026-12")).toEqual({ from: "2026-12-01", to: "2027-01-01" });
    expect(lastDays(new Date("2026-10-04T10:00:00Z"), 7)).toEqual({ from: "2026-09-28", to: "2026-10-05" });
    expect(() => periodDays("2026-9")).toThrow();
  });
});

describe("what one event adds to the daily counts", () => {
  it("a page view counts the page; the first page of a visit also counts an entrance in its channel", () => {
    const plain = parseEvent({ t: "pv", p: "/services/seo" })!;
    expect(countsFor(plain, [])).toEqual([{ kind: "pageview", name: "/services", channel: "", firstChannel: "" }]);
    const entrance = parseEvent({ t: "pv", p: "/", e: 1, v: GOOGLE_AD })!;
    expect(countsFor(entrance, [])).toEqual([
      { kind: "pageview", name: "/", channel: "", firstChannel: "" },
      { kind: "entrance", name: "", channel: "paid", firstChannel: "" },
    ]);
  });

  it("a conversion is counted in the visit's channel, and in the first touch's too when the visitor allowed remembering", () => {
    const event = parseEvent({ t: "cv", n: "call_clicked", v: { r: "www.google.com" }, ft: { s: "newsletter", m: "email" }, lt: { r: "www.google.com" } })!;
    expect(countsFor(event, [])).toEqual([{ kind: "conversion", name: "call_clicked", channel: "organic_search", firstChannel: "email" }]);
  });

  it("the site's own host is not a referral, and a conversion with no visit on record is counted as none", () => {
    expect(countsFor(parseEvent({ t: "pv", p: "/", e: 1, v: { r: "www.acme.co.za" } })!, ["acme.co.za"]).find((row) => row.kind === "entrance")!.channel).toBe("direct");
    expect(countsFor(parseEvent({ t: "cv", n: "form_submitted" })!, [])[0]!.channel).toBe("");
    expect(classifyChannel({ referrerHost: "www.acme.co.za" }, ["acme.co.za"])).toBe("direct");
  });

  it("an outbound click counts the host only", () => {
    expect(countsFor(parseEvent({ t: "out", n: "https://www.facebook.com/acme" })!, [])).toEqual([{ kind: "outbound", name: "facebook.com", channel: "", firstChannel: "" }]);
  });
});

describe("making a key and the snippet that is only ever returned", () => {
  it("returns the snippet and the install steps, and says never to install it", async () => {
    const { booted } = await bootEvents();
    const listed = await tool<Record<string, any>>(booted.harness, "list-event-keys", { client: "company:acme" });
    const key = listed.keys[0];
    expect(key).toMatchObject({ label: "Acme website", client: "company:acme", clientName: null, site: "https://www.acme.co.za", hosts: ["acme.co.za"], status: "active", consentMode: "anonymous", counted: 0 });
    expect(key.install.snippet).toContain(`data-pib-ev="${key.writeKey}"`);
    expect(key.install.snippet).toContain(`src="https://paperclip.partnersinbiz.online${UI_BASE}ev.js"`);
    expect(key.install.snippet).not.toContain("data-consent");
    expect(key.install.endpoint).toBe("https://paperclip.partnersinbiz.online/api/plugins/partnersinbiz.crm/webhooks/ev");
    expect(key.install.steps.join("\n")).toMatch(/changes the client's site/);
    expect(key.install.steps.join("\n")).toMatch(/never install it yourself/);
    expect(key.install.doNotInstallYourself).toMatch(/Never put it on a live site yourself/);
    expect(key.privacy).toEqual(PRIVACY_NOTES);
    expect(PRIVACY_NOTES.join(" ")).toMatch(/no name, email, phone number, form content or visitor id/);
    expect(PRIVACY_NOTES.join(" ")).toMatch(/Do Not Track or Global Privacy Control/);
    // No tool installs it: the plugin has no way to touch a client site from here, and the description says so.
    const description = (await import("../src/growth-tools.js")).GROWTH_TOOLS.find((tool) => tool.name === "create-event-key")!.description;
    expect(description).toMatch(/only RETURNS the snippet/);
  });

  it("is one key per client and label, and refuses a bad address or consent mode", async () => {
    const { booted } = await bootEvents();
    const again = await tool<Record<string, any>>(booted.harness, "create-event-key", { client: "company:acme", label: "acme WEBSITE" });
    expect(again.created).toBe(false);
    expect(booted.store.event_keys).toHaveLength(1);
    await expect(tool(booted.harness, "create-event-key", { client: "company:acme", label: "Other", siteUrl: "not an address" })).rejects.toThrow(/siteUrl must be a web address/);
    await expect(tool(booted.harness, "create-event-key", { client: "company:acme", label: "Other", consentMode: "always" })).rejects.toThrow(/consentMode must be/);
    await expect(tool(booted.harness, "create-event-key", { client: "company:foreign", label: "x" })).rejects.toThrow(/not found or is not visible/);
    const required = await tool<Record<string, any>>(booted.harness, "create-event-key", { client: "company:acme", label: "Waits for consent", consentMode: "required" });
    expect(required.key.install.snippet).toContain('data-consent="required"');
  });

  it("a person can switch a key off for good; an agent can only pause and resume", async () => {
    const { booted, key, keyId } = await bootEvents();
    await tool(booted.harness, "update-event-key", { keyId, status: "paused" });
    expect(booted.store.event_keys![0]!.status).toBe("paused");
    await expect(tool(booted.harness, "update-event-key", { keyId, status: "revoked" })).rejects.toThrow(/Only a person can switch a key off/);
    await tool(booted.harness, "update-event-key", { keyId, status: "active", label: "Acme site", consentMode: "required" });
    expect(booted.store.event_keys![0]).toMatchObject({ status: "active", label: "Acme site", consent_mode: "required" });
    await booted.harness.performAction("crm.update-event-key", { keyId, status: "revoked" }, { companyId: CO, actor: BOARD });
    expect(booted.store.event_keys![0]!.status).toBe("revoked");
    await expect(tool(booted.harness, "update-event-key", { keyId, status: "active" })).rejects.toThrow(/cannot be turned on again/);
    await expect(tool(booted.harness, "rotate-event-key", { keyId })).rejects.toThrow(/switched off for good/);
    expect(key).toMatch(/^pibe_/);
  });

  it("rotating gives a new key and the old one keeps counting for a week, then stops", async () => {
    const { booted, key, keyId } = await bootEvents();
    const rotated = await tool<Record<string, any>>(booted.harness, "rotate-event-key", { keyId });
    const fresh = rotated.key.writeKey as string;
    expect(fresh).not.toBe(key);
    expect(rotated.key.warnings.join(" ")).toMatch(/old key stops working/);
    const send = (k: string, now?: Date) => handleEventsWebhook(booted.harness.ctx, delivery({ k, o: "https://acme.co.za", ev: [{ t: "pv", p: "/" }] }), now ? { now } : {});
    expect((await send(fresh)).status).toBe("counted");
    expect((await send(key)).status).toBe("counted");
    // A week, by the calendar and not by the constant: six days on it still counts, eight days on it does not.
    expect(EVENT_KEY_GRACE_DAYS).toBe(7);
    expect((await send(key, new Date(Date.now() + 6 * 86_400_000))).status).toBe("counted");
    const later = new Date(Date.now() + 8 * 86_400_000);
    expect((await rejected(send(key, later)))!.message).toMatch(/not active/);
    expect((await send(fresh, later)).status).toBe("counted");
  });
});

describe("counting", () => {
  it("adds one to a daily row per kind, name and channel; nothing finer is stored", async () => {
    const { booted, keyId, post } = await bootEvents();
    expect(await post([pv(), { t: "pv", p: "/contact" }, { t: "cv", n: "form_submitted", p: "/contact", v: GOOGLE_AD }, { t: "out", n: "https://www.facebook.com/acme" }])).toMatchObject({ status: "counted", counted: 4 });
    await post([pv()]);
    const rows = await rollupRows(booted.harness.ctx, CO, keyId, "2000-01-01", "2100-01-01");
    const by = (kind: string, name = "", channel = "") => rows.find((row) => row.kind === kind && row.name === name && row.channel === channel)?.n;
    expect(by("entrance", "", "paid")).toBe(2);
    expect(by("pageview", "/services")).toBe(2);
    expect(by("pageview", "/contact")).toBe(1);
    expect(by("conversion", "form_submitted", "paid")).toBe(1);
    expect(by("outbound", "facebook.com")).toBe(1);
    expect(rows.every((row) => row.day === dayOf(new Date()))).toBe(true);
    // No raw event table, no visitor id: the rollup rows have only the day, the kind, the name, the two channels and the count.
    const columns = Object.keys(booted.store.site_event_daily![0]!);
    for (const column of columns) expect(["channel", "company_id", "created_at", "day", "first_channel", "key_id", "kind", "n", "name", "updated_at"]).toContain(column);
    expect(booted.store.site_events ?? []).toHaveLength(0);
    expect(booted.store.event_keys![0]).toMatchObject({ accepted_count: 5 });
  });

  it("keeps no personal data and no address: what a visitor sent and the address they came from are nowhere in the stored rows", async () => {
    const { booted, post } = await bootEvents();
    await post([{ t: "cv", n: "form_submitted", p: "/contact?email=jane@acme.co.za", email: "jane@acme.co.za", phone: "0821234567", name: "Jane Smith", v: { s: "google", ip: "9.9.9.9", email: "x@y.z" } }], {}, { "x-real-ip": "198.51.100.77" });
    const stored = JSON.stringify({ rows: booted.store.site_event_daily, keys: booted.store.event_keys });
    expect(stored).not.toMatch(/jane|0821234567|x@y\.z|9\.9\.9\.9|198\.51\.100\.77/);
    // The address is in the request log only as a keyed hash, for the rate limit.
    const hit = booted.store.public_hits!.find((row) => row.scope === "ev" && row.outcome === "ok")!;
    expect(hit.ip_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(booted.store.public_hits)).not.toContain("198.51.100.77");
  });

  it("a conversion keeps the first-touch channel only when the visitor's site remembered earlier visits", async () => {
    const { booted, keyId, post } = await bootEvents();
    await post([{ t: "cv", n: "call_clicked", v: { r: "www.google.com" }, ft: { s: "newsletter", m: "email" }, lt: { r: "www.google.com" } }, { t: "cv", n: "call_clicked", v: { r: "www.google.com" } }]);
    const rows = await rollupRows(booted.harness.ctx, CO, keyId, "2000-01-01", "2100-01-01");
    expect(rows.filter((r) => r.kind === "conversion").map((r) => [r.channel, r.firstChannel, r.n]).sort()).toEqual([["organic_search", "", 1], ["organic_search", "email", 1]]);
    const report = await tool<Record<string, any>>(booted.harness, "site-events-report", { client: "company:acme", days: 7 });
    expect(report.firstTouchCoverage).toBe(0.5);
  });

  it("a table cannot be grown by a script: past the daily cap of distinct names, new ones count as other", async () => {
    const { booted, keyId, post } = await bootEvents();
    for (let batch = 0; batch < 6; batch += 1) await post(Array.from({ length: 5 }, (_, i) => ({ t: "cv", n: `action_${batch * 5 + i}`, v: GOOGLE_AD })));
    const rows = await rollupRows(booted.harness.ctx, CO, keyId, "2000-01-01", "2100-01-01");
    const names = new Set(rows.filter((r) => r.kind === "conversion").map((r) => r.name));
    expect(names.size).toBe(EVENT_LIMITS.conversionNamesPerDay + 1);
    expect(names.has("other")).toBe(true);
    expect(rows.filter((r) => r.kind === "conversion").reduce((sum, r) => sum + r.n, 0)).toBe(30);
    // The same for pages and outbound hosts.
    for (let batch = 0; batch < 12; batch += 1) await post(Array.from({ length: 5 }, (_, i) => ({ t: "pv", p: `/page-${batch * 5 + i}` })));
    const pages = new Set((await rollupRows(booted.harness.ctx, CO, keyId, "2000-01-01", "2100-01-01")).filter((r) => r.kind === "pageview").map((r) => r.name));
    expect(pages.size).toBeLessThanOrEqual(EVENT_LIMITS.pathBucketsPerDay + 1);
    expect(pages.has("/other")).toBe(true);
  });
});

describe("abuse: bad keys, wrong sites, oversized, floods", () => {
  it("refuses a key nobody made, a paused or switched-off key, and a body with no key; none is counted", async () => {
    const { booted, keyId, post } = await bootEvents();
    const forged = generateEventKey();
    const failure = await rejected(handleEventsWebhook(booted.harness.ctx, delivery({ k: forged, ev: [{ t: "pv", p: "/" }] })));
    expect(failure).toBeInstanceOf(EventsRejected);
    expect(failure!.message).toBe("This site key is not active.");
    expect((await rejected(handleEventsWebhook(booted.harness.ctx, delivery({ ev: [{ t: "pv", p: "/" }] }))))!.message).toMatch(/not valid/);
    await tool(booted.harness, "update-event-key", { keyId, status: "paused" });
    expect((await rejected(post([pv()])))!.message).toMatch(/not active/);
    expect(booted.store.site_event_daily ?? []).toHaveLength(0);
    // An unknown key is counted against the visitor, never against a made-up key id.
    expect(booted.store.public_hits!.filter((h) => h.subject === "unknown")).toHaveLength(2);
    expect(booted.store.public_hits!.every((h) => h.subject === "unknown" || h.subject === keyId)).toBe(true);
  });

  it("a scanner guessing keys cannot grow the request log: past the hourly limit no more rows are written for it, and another visitor is still recorded", async () => {
    const { booted } = await bootEvents();
    const guess = (headers: Record<string, string> = {}) => rejected(handleEventsWebhook(booted.harness.ctx, delivery({ k: generateEventKey(), ev: [{ t: "pv", p: "/" }] }, headers)));
    for (let i = 0; i < EVENT_RATE.ipPerHour + 25; i += 1) expect((await guess())!.message).toBe("This site key is not active.");
    // Every one was refused the same way, but only the first `ipPerHour` left a row.
    expect(booted.store.public_hits!.filter((h) => h.subject === "unknown")).toHaveLength(EVENT_RATE.ipPerHour);
    expect((await guess({ "x-real-ip": "203.0.113.77" }))!.message).toBe("This site key is not active.");
    expect(booted.store.public_hits!.filter((h) => h.subject === "unknown")).toHaveLength(EVENT_RATE.ipPerHour + 1);
    // A request that carries no address has nothing to be counted against, so it leaves no row at all.
    const before = booted.store.public_hits!.length;
    const noAddress = delivery({ k: generateEventKey(), ev: [{ t: "pv", p: "/" }] });
    delete noAddress.headers["x-real-ip"];
    expect((await rejected(handleEventsWebhook(booted.harness.ctx, noAddress)))!.message).toBe("This site key is not active.");
    expect(booted.store.public_hits!.length).toBe(before);
  });

  it("refuses events that say they come from another site", async () => {
    const { booted, post } = await bootEvents();
    const failure = await rejected(post([pv()], { o: "https://evil.example" }));
    expect(failure!.message).toBe("This site is not allowed to use this key.");
    expect(booted.store.site_event_daily ?? []).toHaveLength(0);
    expect(booted.store.event_keys![0]!.rejected_count).toBe(1);
    // A subdomain of the site, and a request that does not say, are fine.
    expect((await post([pv()], { o: "https://shop.acme.co.za" })).status).toBe("counted");
    expect((await post([pv()], { o: undefined })).status).toBe("counted");
  });

  it("refuses an oversized body, a body that is not JSON, and an unknown endpoint", async () => {
    const { booted, key } = await bootEvents();
    const big = JSON.stringify({ k: key, ev: [{ t: "pv", p: "/" }], pad: "x".repeat(EVENT_LIMITS.bodyBytes) });
    expect((await rejected(handleEventsWebhook(booted.harness.ctx, delivery({}, {}, big))))!.message).toBe("The request is too large.");
    expect((await rejected(handleEventsWebhook(booted.harness.ctx, { ...delivery({}), rawBody: "plain", parsedBody: undefined })))!.message).toMatch(/JSON/);
    expect((await rejected(handleEventsWebhook(booted.harness.ctx, { ...delivery({ k: key, ev: [{ t: "pv", p: "/" }] }), endpointKey: "lead" })))!.message).toMatch(/Unknown endpoint/);
    expect(booted.store.site_event_daily ?? []).toHaveLength(0);
  });

  it("stops a visitor who floods: per minute and per hour, and another visitor is not affected", async () => {
    const { booted, post } = await bootEvents();
    for (let i = 0; i < EVENT_RATE.ipPerMinute; i += 1) await post([{ t: "pv", p: "/" }]);
    const failure = await rejected(post([{ t: "pv", p: "/" }]));
    expect(failure!.message).toBe("Too many events. Slow down.");
    expect((await post([{ t: "pv", p: "/" }], {}, { "x-real-ip": "203.0.113.200" })).status).toBe("counted");
    // A minute later the same visitor may send again.
    expect((await post([{ t: "pv", p: "/" }], {}, {}, new Date(Date.now() + 61_000))).status).toBe("counted");
    // A refused request is not written down: a flood must not become a flood of rows.
    expect(booted.store.public_hits!.filter((h) => h.outcome === "rate_limited")).toHaveLength(0);
  });

  it("stops a key that is being hit from many addresses, so one site cannot fill the table", async () => {
    const { booted, post } = await bootEvents();
    for (let i = 0; i < EVENT_RATE.keyPerMinute; i += 1) await post([{ t: "pv", p: "/" }], {}, { "x-real-ip": `198.51.${Math.floor(i / 250)}.${(i % 250) + 1}` });
    const failure = await rejected(post([{ t: "pv", p: "/" }], {}, { "x-real-ip": "192.0.2.1" }));
    expect(failure!.message).toBe("Too many events. Slow down.");
    expect(booted.store.public_hits!.filter((h) => h.outcome === "ok")).toHaveLength(EVENT_RATE.keyPerMinute);
  });

  it("a replayed request counts again: the limits cap it, nothing pretends to prevent it", async () => {
    const { booted, keyId, post } = await bootEvents();
    await post([pv()]);
    await post([pv()]);
    const rows = await rollupRows(booted.harness.ctx, CO, keyId, "2000-01-01", "2100-01-01");
    expect(rows.find((r) => r.kind === "entrance")!.n).toBe(2);
    // So the report says counts are estimates.
    const report = await tool<Record<string, any>>(booted.harness, "site-events-report", { client: "company:acme", days: 7 });
    expect(report.notes.join(" ")).toMatch(/Counts are estimates: anyone holding the site key can add to them/);
  });

  it("junk events in a request are dropped and the good ones counted", async () => {
    const { booted, keyId, post } = await bootEvents();
    expect((await post([{ t: "bogus" }, null, "x", pv(), { t: "cv" }])).counted).toBe(1);
    expect((await rollupRows(booted.harness.ctx, CO, keyId, "2000-01-01", "2100-01-01")).length).toBeGreaterThan(0);
  });
});

describe("the report", () => {
  it("totals the visits, conversions and channels, the funnel and the top pages, and says what the numbers are", async () => {
    const { post, booted } = await bootEvents();
    await post([pv(), pv({ p: "/contact" }), { t: "pv", p: "/services/seo" }, { t: "cv", n: "form_submitted", v: GOOGLE_AD }, { t: "cv", n: "call_clicked", v: { r: "l.facebook.com" } }, { t: "out", n: "https://example.org" }]);
    await post([{ t: "pv", p: "/", e: 1, v: { r: "www.google.com" } }]);
    const report = await tool<Record<string, any>>(booted.harness, "site-events-report", { client: "company:acme", days: 30 });
    expect(report).toMatchObject({ keys: 1, entrances: 3, pageviews: 4, conversions: { total: 2 }, outbound: { total: 1 } });
    expect(report.funnel.map((step: { n: number }) => step.n)).toEqual([3, 4, 1, 2]);
    const paid = report.channels.find((c: { channel: string }) => c.channel === "paid");
    expect(paid).toMatchObject({ entrances: 2, conversions: 1, conversionRate: 50 });
    expect(report.channels.find((c: { channel: string }) => c.channel === "organic_search")).toMatchObject({ entrances: 1 });
    expect(report.channels.find((c: { channel: string }) => c.channel === "social")).toMatchObject({ conversions: 1 });
    expect(report.topPages[0]).toEqual({ path: "/services", n: 2 });
    expect(report.notes.join(" ")).toMatch(/not a person/);
    // A client with no key says what to do.
    const none = await tool<Record<string, any>>(booted.harness, "site-events-report", { client: "company:globex" });
    expect(none).toMatchObject({ keys: 0 });
    expect(none.note).toMatch(/no event key/);
    await expect(tool(booted.harness, "site-events-report", { client: "company:acme", period: "2026-13" })).rejects.toThrow(/period must be YYYY-MM/);
    await expect(tool(booted.harness, "site-events-report", { client: "company:acme", days: 0 })).rejects.toThrow(/days must be/);
  });

  it("a month report counts only that month's days", async () => {
    const { post, booted } = await bootEvents();
    await post([pv()], {}, {}, new Date("2026-09-15T10:00:00Z"));
    await post([pv()], {}, { "x-real-ip": "203.0.113.31" }, new Date("2026-10-02T10:00:00Z"));
    const sept = await tool<Record<string, any>>(booted.harness, "site-events-report", { client: "company:acme", period: "2026-09" });
    expect(sept.entrances).toBe(1);
    const oct = await tool<Record<string, any>>(booted.harness, "site-events-report", { client: "company:acme", period: "2026-10" });
    expect(oct.entrances).toBe(1);
  });

  it("summarises rollup rows with no database", () => {
    const summary = summariseRollup(
      [
        { day: "2026-09-01", kind: "entrance", name: "", channel: "paid", firstChannel: "", n: 10 },
        { day: "2026-09-01", kind: "entrance", name: "", channel: "", firstChannel: "", n: 2 },
        { day: "2026-09-01", kind: "conversion", name: "call_clicked", channel: "paid", firstChannel: "email", n: 4 },
      ],
      { from: "2026-09-01", to: "2026-10-01" },
    );
    expect(summary.entrances).toBe(12);
    expect(summary.channels.find((c) => c.channel === "paid")).toMatchObject({ entrances: 10, conversions: 4, conversionRate: 40 });
    expect(summary.channels.find((c) => c.channel === "unattributed")).toMatchObject({ entrances: 2 });
    expect(summary.channels.find((c) => c.channel === "email")).toMatchObject({ firstTouchConversions: 4 });
    expect(summary.firstTouchCoverage).toBe(1);
  });

  it("old daily counts are removed after the retention window", async () => {
    const { booted, keyId, post } = await bootEvents();
    await post([pv()], {}, {}, new Date("2024-01-15T10:00:00Z"));
    await post([pv()], {}, { "x-real-ip": "203.0.113.45" });
    await purgeRollup(booted.harness.ctx, "2025-01-01");
    const rows = await rollupRows(booted.harness.ctx, CO, keyId, "2000-01-01", "2100-01-01");
    expect(rows.every((row) => row.day >= "2025-01-01")).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("the snippet text", () => {
  it("escapes a label and carries the key and the consent mode", () => {
    const urls = eventUrls(embedUrls(null, UI_BASE)!);
    const text = eventSnippet({ writeKey: "pibe_abcdefghijklmnopqrstuvwx", label: 'Acme "main" --> site', consentMode: "required" }, urls);
    expect(text).toContain("<!-- PiB site events: Acme &quot;main&quot; - -&gt; site (daily visit counts, no names or visitor ids) -->");
    expect(text).not.toMatch(/-->\s*site/);
    expect(text).toContain('data-consent="required"');
    expect(urls.frameUrl).toBe(`https://paperclip.partnersinbiz.online${UI_BASE}ev-frame.html`);
  });
});
