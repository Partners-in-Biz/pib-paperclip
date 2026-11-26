import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BrowserView } from "../src/browser-status.js";
import { tabFromSearch } from "../src/ui/index.js";
import { BrowserBody } from "../src/ui/browser-page.js";
import { MAX_FAILED_CONNECTS, afterDisconnect, STABLE_CONNECT_MS, liveSocketUrl, TakeoverPanel, countdown, doneLabel, shownPhase, takeoverOver, takeoverPhase } from "../src/ui/browser-live-drawer.js";

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
  it("fails after repeated connect-then-drop under the stable time", () => {
    let failed = 0;
    let action = "";
    for (let n = 0; n < MAX_FAILED_CONNECTS; n++) {
      ({ action, failed } = afterDisconnect({ shown: true, connectedAt: 0, now: 1000, failed }));
      if (n < MAX_FAILED_CONNECTS - 1) expect(action).toBe("retry");
    }
    expect(action).toBe("fail");
  });
  it("resets the count and reconnects after a stable connection", () => {
    expect(afterDisconnect({ shown: true, connectedAt: 0, now: STABLE_CONNECT_MS, failed: MAX_FAILED_CONNECTS - 1 })).toEqual({ action: "reconnect", failed: 0 });
  });
  it("counts a drop that never connected as failed", () => {
    expect(afterDisconnect({ shown: false, connectedAt: 0, now: 99999, failed: 0 })).toEqual({ action: "retry", failed: 1 });
  });
});

describe("Take over (PAR-14514 S4)", () => {
  const live = { state: "live", identity: "client:ca:google-ads", userId: "u1", secondsLeft: 1150, controlConnected: true };
  const ended = (reason: string) => ({ state: "ended", confirmed: false, identity: "client:ca:google-ads", userId: "u1", reason, endedAt: "2026-11-26T10:00:00.000Z" });
  const row = (v: BrowserView, lease: unknown) => renderToStaticMarkup(createElement(BrowserBody, { view: v, lease }));

  it("reads the daemon's lease for one identity", () => {
    expect(takeoverPhase(null, "pib:meta")).toEqual({ kind: "none" });
    expect(takeoverPhase(live, "client:ca:google-ads")).toEqual({ kind: "live", secondsLeft: 1150 });
    expect(takeoverPhase(live, "pib:meta")).toEqual({ kind: "other", identity: "client:ca:google-ads" });
    expect(takeoverPhase(ended("logged_in"), "client:ca:google-ads")).toEqual({ kind: "logged_in" });
    expect(takeoverPhase(ended("time_limit"), "client:ca:google-ads")).toEqual({ kind: "ended", reason: "time_limit" });
    expect(takeoverPhase(ended("time_limit"), "pib:meta")).toEqual({ kind: "none" });
  });

  it("an older take-over's end is not this drawer's; after it was live, any other state ends it", () => {
    expect(shownPhase({ kind: "logged_in" }, false)).toEqual({ kind: "none" });
    expect(shownPhase({ kind: "logged_in" }, true)).toEqual({ kind: "logged_in" });
    expect(takeoverOver({ kind: "ended", reason: "x" }, false, false)).toBe(false);
    expect(takeoverOver({ kind: "live", secondsLeft: 5 }, false, true)).toBe(false);
    for (const phase of [{ kind: "none" }, { kind: "logged_in" }, { kind: "ended", reason: "x" }, { kind: "other", identity: "pib:meta" }] as const) expect(takeoverOver(phase, false, true)).toBe(true);
    expect(takeoverOver({ kind: "live", secondsLeft: 5 }, true, true)).toBe(true);
  });

  it("names Done by what it does", () => {
    expect(doneLabel([])).toBe("Done - check login");
    expect(doneLabel([{ identifier: "PAR-1", title: "x" }])).toBe("Done - resume agent");
    expect(countdown(1150)).toBe("19:10");
    expect(countdown(-3)).toBe("0:00");
  });

  it("the drawer names the tasks Done wakes, the countdown, and says nothing is woken after an unconfirmed end", () => {
    const panel = (props: Partial<Parameters<typeof TakeoverPanel>[0]>) => renderToStaticMarkup(createElement(TakeoverPanel, { identity: "pib:meta", phase: { kind: "live", secondsLeft: 600 }, secondsLeft: 600, tasks: [], result: null, ...props }));
    const withTasks = panel({ tasks: [{ identifier: "PAR-12", title: "Post the ad" }, { identifier: "PAR-13", title: "" }] });
    expect(withTasks).toContain("Done wakes:");
    expect(withTasks).toContain("PAR-12");
    expect(withTasks).toContain("PAR-13");
    expect(withTasks).toContain("10:00 left");
    expect(withTasks).toContain("Done - resume agent");
    expect(panel({})).toContain("No task is waiting for this login");
    expect(panel({ phase: { kind: "logged_in" } })).toContain("Logged in");
    const end = panel({ phase: { kind: "ended", reason: "time_limit" } });
    expect(end).toContain("Login finished, not confirmed");
    expect(end).toContain("the 20 minutes ran out");
    expect(end).toContain("Nothing is woken until you press it");
    expect(panel({ result: { ok: false, message: "The login for pib:meta did not hold" } })).toContain("did not hold");
  });

  it("each login row has Take over browser only at takeover and with no other take-over live", () => {
    expect(row(view({ live: "takeover" }), null).match(/Take over browser/g)).toHaveLength(2);
    expect(row(view({ live: "view" }), null)).not.toContain("Take over browser");
    expect(row(view({ live: "off" }), null)).not.toContain("Take over browser");
    const busy = row(view({ live: "takeover" }), live);
    expect(busy).toContain("Taken over now");
    expect(busy).not.toContain("Take over browser");
  });

  it("an unconfirmed take-over shows Login finished, not confirmed with a Done button, at every setting", () => {
    for (const l of ["off", "view", "takeover"] as const) {
      const out = row(view({ live: l }), ended("logged_in"));
      expect(out).toContain("Login finished, not confirmed");
      expect(out).toContain(">Done</button>");
      expect(out).toContain("Nothing is woken until you press Done.");
    }
  });
});
