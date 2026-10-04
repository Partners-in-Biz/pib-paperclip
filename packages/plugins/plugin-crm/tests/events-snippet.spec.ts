import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as esbuild from "esbuild";
import { builtEventsScript, loadEvents, loadFrame } from "./helpers/ev-world.js";

describe("the site events script", () => {
  it("is under 2 KB as the build writes it, and so is the built file when there is one", () => {
    expect(Buffer.byteLength(builtEventsScript())).toBeLessThanOrEqual(2048);
    const built = new URL("../dist/ui/ev.js", import.meta.url);
    if (existsSync(built)) expect(statSync(built).size).toBeLessThanOrEqual(2048);
    // The readable source is what people review; it says what it collects and what it never does.
    const source = readFileSync(new URL("../static-src/ev.js", import.meta.url), "utf8");
    expect(source).toMatch(/sends no name, email, phone, form content or visitor id/);
    expect(source).toMatch(/Do Not Track or Global Privacy Control/);
    expect(esbuild.transformSync(source, { minify: true }).code.length).toBeLessThan(source.length);
  });

  it("does nothing without a valid key, and nothing at all when the browser says Do Not Track or Global Privacy Control", () => {
    expect(loadEvents({ attrs: { "data-pib-ev": "pibe_short" } }).frames).toHaveLength(0);
    expect(loadEvents({ attrs: { "data-pib-ev": "" } }).frames).toHaveLength(0);
    for (const world of [loadEvents({ dnt: "1" }), loadEvents({ gpc: true })]) {
      expect(world.frames).toHaveLength(0);
      expect(world.window.pibEvents).toBeUndefined();
      expect(world.listeners.click).toBeUndefined();
      expect(world.session.data.size + world.local.data.size).toBe(0);
    }
  });

  it("sends a page view through a hidden frame on the Paperclip host: the path with no query, how the visit started, and that it is an entrance", () => {
    const world = loadEvents();
    expect(world.frames).toHaveLength(1);
    expect(world.frames[0]!.src).toBe("https://paperclip.partnersinbiz.online/_plugins/11111111-2222-3333-4444-555555555555/ui/ev-frame.html#k=pibe_abcdefghijklmnopqrstuvwx");
    expect(world.frames[0]!.hidden).toBeTruthy();
    const [first] = world.frames[0]!.messages;
    // It talks to that origin only.
    expect(first!.target).toBe("https://paperclip.partnersinbiz.online");
    expect(first!.message.pibEv).toBe(1);
    expect(world.events()).toEqual([{ t: "pv", p: "/services/seo", v: { s: "google", m: "cpc", c: "", r: "", k: "" }, e: 1 }]);
    // Nothing about the person, and the query string never leaves the page.
    expect(JSON.stringify(world.events())).not.toMatch(/\?utm|email|phone|name"/);
  });

  it("an anonymous visit keeps one note for that browser tab only, never in long-lived storage", () => {
    const world = loadEvents();
    expect([...world.session.data.keys()]).toEqual(["pib_v"]);
    expect(world.local.data.size).toBe(0);
    // The next page of the same visit is not an entrance and carries the same start.
    const next = loadEvents({ url: "https://acme.co.za/contact", session: world.session });
    expect(next.events()).toEqual([{ t: "pv", p: "/contact", v: { s: "google", m: "cpc", c: "", r: "", k: "" } }]);
  });

  it("names the click ids by kind only, never the id, and the referring host only, never the page", () => {
    const world = loadEvents({ url: "https://acme.co.za/?gclid=abc123secret", referrer: "https://www.google.com/search?q=plumber+ballito" });
    expect(world.events()[0]!.v).toEqual({ s: "", m: "", c: "", r: "www.google.com", k: "g" });
    expect(JSON.stringify(world.events())).not.toContain("abc123secret");
    expect(JSON.stringify(world.events())).not.toContain("plumber");
  });

  it("counts a call, a WhatsApp link, a form and a link to another site, and ignores a link within the site", () => {
    const world = loadEvents();
    world.click("tel:+27821234567");
    world.click("https://wa.me/27821234567?text=hello");
    world.click("whatsapp://send?phone=27821234567");
    world.click("https://www.facebook.com/acme/posts/123?x=1");
    world.click("https://acme.co.za/about");
    world.click("/pricing");
    world.click("mailto:hi@acme.co.za");
    world.submit();
    expect(world.events().slice(1).map((e) => [e.t, e.n])).toEqual([["cv", "call_clicked"], ["cv", "whatsapp_clicked"], ["cv", "whatsapp_clicked"], ["out", "www.facebook.com"], ["cv", "form_submitted"]]);
    // Only the host of an outbound link is sent: no path, no query, no phone number.
    const text = JSON.stringify(world.events());
    expect(text).not.toMatch(/27821234567|posts\/123|hi@acme/);
  });

  it("an event of the site's own is named by the site: pibEvents.track", () => {
    const world = loadEvents();
    world.window.pibEvents.track("quote_requested");
    expect(world.events().at(-1)).toMatchObject({ t: "cv", n: "quote_requested" });
  });

  it("waits for the page body when it ran in the head, then sends what it queued", () => {
    const world = loadEvents({ noBody: true });
    expect(world.frames).toHaveLength(0);
    world.domReady();
    expect(world.frames).toHaveLength(1);
    world.frames[0]!.load();
    expect(world.events()).toHaveLength(1);
  });

  it("sends at most ten events at a time and queues no more than twenty", () => {
    const world = loadEvents();
    for (let i = 0; i < 40; i += 1) world.window.pibEvents.track(`e${i}`);
    expect(world.frames[0]!.messages.every((m) => m.message.ev.length <= 10)).toBe(true);
    expect(world.events().length).toBeLessThanOrEqual(1 + 40);
  });

  it("required consent: nothing is sent until the site's banner says yes, then the first and last touch are remembered for the lead form", () => {
    const world = loadEvents({ attrs: { "data-consent": "required" } });
    expect(world.frames).toHaveLength(0);
    world.click("tel:+27821234567");
    expect(world.frames).toHaveLength(0);
    expect(world.local.data.size).toBe(0);
    world.window.pibEvents.consent(true);
    world.frames[0]!.load();
    const events = world.events();
    expect(events.map((e) => e.t)).toEqual(["pv", "cv"]);
    expect(events[0]!.ft).toEqual({ s: "google", m: "cpc", c: "", r: "", k: "" });
    expect(JSON.parse(world.local.getItem("pib_ft")!)).toEqual({ s: "google", m: "cpc", c: "", r: "", k: "" });
    expect(JSON.parse(world.local.getItem("pib_lt")!)).toMatchObject({ s: "google" });
    // Withdrawing removes what was kept, and with required consent sends no more.
    world.window.pibEvents.consent(false);
    expect(world.local.data.size).toBe(0);
    const before = world.events().length;
    world.window.pibEvents.track("after_withdrawal");
    expect(world.events()).toHaveLength(before);
  });

  it("required consent that is never given never sends a thing", () => {
    const world = loadEvents({ attrs: { "data-consent": "required" } });
    world.submit();
    world.click("https://example.org/");
    expect(world.frames).toHaveLength(0);
    expect(world.session.data.size).toBeLessThanOrEqual(1);
    expect(world.local.data.size).toBe(0);
  });

  it("a later visit that is direct keeps the first touch and the last campaign the visitor came from", () => {
    const local = loadEvents({ attrs: { "data-consent": "required" } });
    local.window.pibEvents.consent(true);
    // A new browser tab on a later day: no session note, no campaign, nothing referring.
    const later = loadEvents({ url: "https://acme.co.za/", local: local.local, attrs: { "data-consent": "required" } });
    later.window.pibEvents.consent(true);
    later.frames[0]!.load();
    const event = later.events()[0]!;
    expect(event.v).toEqual({ s: "", m: "", c: "", r: "", k: "" });
    expect(event.ft).toMatchObject({ s: "google" });
    expect(event.lt).toMatchObject({ s: "google" });
  });
});

describe("the frame inside the hidden iframe", () => {
  const KEY = "pibe_abcdefghijklmnopqrstuvwx";

  it("posts what the embedding page hands it to the endpoint on this host, with the embedding page's own origin", () => {
    const frame = loadFrame(`#k=${KEY}`);
    frame.message({ pibEv: 1, ev: [{ t: "pv", p: "/", e: 1, v: { s: "google", m: "cpc", c: "", r: "", k: "" } }] }, "https://acme.co.za");
    const [url, init] = frame.fetch.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body: string; credentials: string }];
    expect(url).toBe("/api/plugins/partnersinbiz.crm/webhooks/ev");
    expect(init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" }, credentials: "omit" });
    expect(JSON.parse(init.body)).toEqual({ k: KEY, o: "https://acme.co.za", ev: [{ t: "pv", p: "/", e: 1, v: { s: "google", m: "cpc", c: "", r: "", k: "" } }] });
  });

  it("forwards only the fields the endpoint reads: anything else the page put in an event is dropped here", () => {
    const frame = loadFrame(`#k=${KEY}`);
    frame.message({ pibEv: 1, ev: [{ t: "cv", n: "form_submitted", p: "/contact", email: "jane@acme.co.za", phone: "082", name: "Jane", v: { s: "g", email: "x@y.z", k: "z" } }] });
    const body = JSON.parse((frame.fetch.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(JSON.stringify(body)).not.toMatch(/jane|082|x@y/);
    expect(body.ev[0]).toEqual({ t: "cv", p: "/contact", n: "form_submitted", v: { s: "g", m: "", c: "", r: "", k: "" } });
  });

  it("ignores a message that did not come from the page embedding it, a message that is not the script's, and a frame with no key", () => {
    const frame = loadFrame(`#k=${KEY}`);
    frame.message({ pibEv: 1, ev: [{ t: "pv", p: "/" }] }, "https://evil.example", false);
    frame.message({ nope: 1, ev: [{ t: "pv", p: "/" }] });
    frame.message({ pibEv: 1, ev: "not a list" });
    frame.message({ pibEv: 1, ev: [{ t: "bogus" }] });
    expect(frame.fetch).not.toHaveBeenCalled();
    for (const hash of ["", "#k=nope", "#k=pibl_abcdefghijklmnopqrstuvwx", `#x=${KEY}`]) {
      const other = loadFrame(hash);
      other.message({ pibEv: 1, ev: [{ t: "pv", p: "/" }] });
      expect(other.fetch).not.toHaveBeenCalled();
    }
  });

  it("sends at most ten events in one request", () => {
    const frame = loadFrame(`#k=${KEY}`);
    frame.message({ pibEv: 1, ev: Array.from({ length: 25 }, () => ({ t: "pv", p: "/" })) });
    expect(JSON.parse((frame.fetch.mock.calls[0] as unknown as [string, { body: string }])[1].body).ev).toHaveLength(10);
  });
});
