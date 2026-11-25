import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BrowserView } from "../src/browser-status.js";
import { tabFromSearch } from "../src/ui/index.js";
import { BrowserBody } from "../src/ui/browser-page.js";
import { MAX_FAILED_CONNECTS, liveSocketUrl } from "../src/ui/browser-live-drawer.js";

const view = (over: Partial<BrowserView> = {}): BrowserView => ({
  state: "read",
  checkedAt: "2026-11-03T06:00:00.000Z",
  stale: false,
  live: "view",
  identities: [{ identity: "pib:meta", ok: true, reason: "" }, { identity: "client:ca:google-ads", ok: false, reason: "session_expired" }],
  ...over,
});
const html = (v: BrowserView, identity?: string | null) => renderToStaticMarkup(createElement(BrowserBody, { view: v, identity }));

describe("Browser tab", () => {
  it("opens from ?tab=browser", () => expect(tabFromSearch("?tab=browser&identity=pib:meta")).toBe("browser"));

  it("says No browser here for a company that is not the owner, with no login names", () => {
    const out = html({ state: "unavailable", checkedAt: null, stale: false, identities: [], live: "off" });
    expect(out).toContain("No browser here");
    expect(out).not.toContain("pib:meta");
  });

  it("lists a working and an expired login", () => {
    const out = html(view());
    expect(out).toContain("Working");
    expect(out).toContain("Expired");
    expect(out).toContain("session_expired");
    expect(out).not.toContain("Log in again:");
  });

  it("replaces the SSH steps with Watch live, shown only when the setting is not off", () => {
    for (const live of ["view", "takeover"] as const) expect(html(view({ live }), "client:ca:google-ads")).toContain("Watch live");
    const off = html(view({ live: "off" }), "client:ca:google-ads");
    expect(off).not.toContain("Watch live</button>");
    for (const out of [html(view(), "client:ca:google-ads"), off]) expect(out).not.toMatch(/ssh -N|pib-root|localhost:5900|VNC client/);
  });

  it("shows Watch live even when the status file is missing", () => {
    expect(html(view({ state: "missing", checkedAt: null, identities: [] }))).toContain("Watch live</button>");
  });

  it("says the selected expired login can be watched, and says nothing for a working one", () => {
    expect(html(view(), "client:ca:google-ads")).toContain("Log in again: client:ca:google-ads");
    expect(html(view(), "pib:meta")).not.toContain("Log in again");
  });

  it("says an unknown identity is unknown and shows no command", () => {
    const out = html(view(), "nobody:x");
    expect(out).toContain("Unknown login");
    expect(out).not.toContain("Log in again");
  });

  it("wraps a very long identity name", () => {
    const long = "client:" + "a".repeat(70);
    const out = html(view({ identities: [{ identity: long, ok: false, reason: "x".repeat(80) }] }), long);
    expect(out).toContain(long);
    expect(out).toContain("overflow-wrap:anywhere");
  });

  it("calls a stale file expired for every login", () => {
    const out = html(view({ stale: true }));
    expect(out).not.toContain("Working");
    expect(out).toContain("36 hours");
  });

  it("says unverified, not expired, with no status file", () => {
    const out = html(view({ state: "missing", checkedAt: null, identities: [] }));
    expect(out).toContain("Logins not verified");
    expect(out).not.toContain("Expired");
  });

  it("shows nothing secret-shaped", () => {
    expect(html(view(), "pib:meta")).not.toMatch(/token|password|cookie|known_hosts|ssh-(rsa|ed25519)/i);
  });
});

describe("Watch live socket address", () => {
  it("is wss on https, ws on http, with the ticket and company encoded", () => {
    expect(liveSocketUrl({ protocol: "https:", host: "p.example" }, "c 1", "a+b/c")).toMatch(/^wss:\/\/p\.example\/api\/plugins\/[^/]+\/api\/browser\/live\?companyId=c%201&ticket=a%2Bb%2Fc$/);
    expect(liveSocketUrl({ protocol: "http:", host: "localhost:3100" }, "c", "t")).toMatch(/^ws:\/\/localhost:3100\//);
  });
  it("stops after a few failed connects", () => expect(MAX_FAILED_CONNECTS).toBeGreaterThan(1));
});
