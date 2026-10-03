import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { daysUntil, isPublicAddress, parseRdapExpiry, rdapProblem, rdapUrl, registrableDomain, tlsExpiry } from "../src/monitor-net.js";
import { afterPageCheck, checkPage, defaultIo, downMinutes, emptyMonitor, listMonitors, runSiteMonitor, setSiteMonitoringTool, siteIssueResolved, siteMonitorHealth, uptimeFigures, type MonitorIo, type PageResult } from "../src/monitor.js";
import { BOARD, bootCare, careSeed, CO, DAY, issuesWith, tool, toolRaw, type Booted } from "./helpers/care.js";

const MIN = 60_000;
const T0 = new Date("2026-10-03T08:00:00.000Z");

function io(overrides: Partial<MonitorIo> = {}): MonitorIo & { page: ReturnType<typeof vi.fn>; tls: ReturnType<typeof vi.fn>; rdap: ReturnType<typeof vi.fn> } {
  return {
    page: vi.fn(async (): Promise<PageResult> => ({ ok: true, status: 200, ms: 180, error: null })),
    tls: vi.fn(async () => ({ expiresAt: new Date(T0.getTime() + 60 * DAY).toISOString(), error: null })),
    rdap: vi.fn(async () => ({ expiresAt: new Date(T0.getTime() + 400 * DAY).toISOString(), error: null })),
    sleep: vi.fn(async () => undefined),
    ...overrides,
  } as never;
}

const down: PageResult = { ok: false, status: null, ms: 15_000, error: "The request timed out" };

function site(id: string, url: string, extra: Record<string, unknown> = {}) {
  return { id, company_id: CO, client_kind: "company", client_ref: "acme", label: null, url, project_id: "proj-1", created_at: "2026-09-01T00:00:00Z", ...extra };
}

async function bootSites(sites = [site("site-1", "https://www.acme.co.za/")], deliveryLead = true): Promise<Booted> {
  const booted = await bootCare({ store: careSeed({ client_sites: sites }) });
  if (deliveryLead) booted.harness.seed({ agents: [{ id: "dl-1", companyId: CO, name: "Delivery Lead", status: "idle" } as never] });
  return booted;
}

describe("which addresses may be contacted", () => {
  it("refuses everything private, local, link-local, reserved and malformed", () => {
    for (const address of ["10.0.0.5", "127.0.0.1", "172.16.4.1", "172.31.255.255", "192.168.1.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "::", "fe80::1", "fd12::1", "::ffff:10.0.0.1", "ff02::1", "not an ip", ""]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    for (const address of ["8.8.8.8", "41.76.0.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPublicAddress(address), address).toBe(true);
  });

  it("reads IPv6 in every spelling: an IPv4 address hidden in hex, a 6to4, Teredo, NAT64 or IPv4-compatible form is judged as what it carries or refused", () => {
    const refused = [
      "::ffff:7f00:1", "::FFFF:7F00:0001", "0:0:0:0:0:ffff:7f00:1", "::ffff:a00:1", "::ffff:c0a8:1", "::ffff:a9fe:a9fe", "::ffff:0:0", "::ffff:0.0.0.0",
      "::7f00:1", "::10.0.0.1", "::a00:1", "::2", "0:0:0:0:0:0:0:1",
      "2002:7f00:1::", "2002:a00:1::1", "2002:808:808::", // 6to4 embeds an IPv4 address: never judged public
      "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:1::1", "2001:10::1", "2001:db8::1", "2001:DB8:abcd::1", "3fff::1", "3fff:fff::1",
      "64:ff9b::7f00:1", "64:ff9b::808:808", "64:ff9b:1::1",
      "100::1", "100:0:0:1::1", "fe80::1%eth0", "2606:4700:4700::1111%eth0", "febf::1", "fec0::1", "fc00::1", "fdff::1", "ff00::1", "ff0e::1", "4000::1", "8000::1", "1::1",
      "::1.2.3.4.5", ":::", "1:2:3:4:5:6:7:8:9", "g::1", "1::2::3", "12345::1",
    ];
    for (const address of refused) expect(isPublicAddress(address), address).toBe(false);
    const allowed = ["2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "2400:cb00::1", "2001:200::1", "2001:4860:4860::8888", "2c0f:f248::1", "3000::1", "::ffff:808:808", "::ffff:8.8.8.8", "0:0:0:0:0:ffff:2e4c:1"];
    for (const address of allowed) expect(isPublicAddress(address), address).toBe(true);
  });

  it("splits a host into its registrable domain", () => {
    expect(registrableDomain("www.acme.co.za")).toBe("acme.co.za");
    expect(registrableDomain("shop.acme.com")).toBe("acme.com");
    expect(registrableDomain("acme.co.za")).toBe("acme.co.za");
    expect(registrableDomain("co.za")).toBeNull();
    expect(registrableDomain("localhost")).toBeNull();
    expect(registrableDomain("1.2.3.4")).toBeNull();
    expect(registrableDomain("Acme.CO.UK.")).toBe("acme.co.uk");
    expect(rdapUrl("acme.co.za")).toBe("https://rdap.org/domain/acme.co.za");
  });

  it("says what to do when the registry lookup has no data for the domain's ending (.co.za), not just that it failed", () => {
    expect(rdapProblem("acme.co.za", 404)).toMatch(/no data for \.co\.za domains.*renewal date.*set-site-monitoring/);
    expect(rdapProblem("acme.com", 404)).toMatch(/no data for \.com domains/);
    expect(rdapProblem("acme.com", 503)).toBe("The registry lookup answered 503.");
  });

  it("reads an expiry from an RDAP record, or says there is none", () => {
    expect(parseRdapExpiry({ events: [{ eventAction: "registration", eventDate: "2020-01-01T00:00:00Z" }, { eventAction: "expiration", eventDate: "2027-03-31T00:00:00Z" }] })).toEqual({ expiresAt: "2027-03-31T00:00:00.000Z", error: null });
    expect(parseRdapExpiry({ events: [] }).error).toMatch(/no expiry date/);
    expect(parseRdapExpiry(null).expiresAt).toBeNull();
    expect(parseRdapExpiry({ events: [{ eventAction: "expiration", eventDate: "soon" }] }).expiresAt).toBeNull();
    expect(daysUntil("2026-10-13T00:00:00Z", Date.parse("2026-10-03T00:00:00Z"))).toBe(10);
    expect(daysUntil(null, 0)).toBeNull();
  });
});

describe("the certificate check", () => {
  function fakeConnect(cert: Record<string, unknown> | null, options: { authorized?: boolean; error?: string; hang?: boolean } = {}) {
    const calls: Array<Record<string, any>> = [];
    const connectFn = ((opts: Record<string, any>, onConnect: () => void) => {
      calls.push(opts);
      const socket = Object.assign(new EventEmitter(), {
        authorized: options.authorized !== false,
        authorizationError: options.authorized === false ? "CERT_HAS_EXPIRED" : null,
        getPeerCertificate: () => cert,
        destroy: vi.fn(),
      });
      setImmediate(() => {
        if (options.hang) socket.emit("timeout");
        else if (options.error) socket.emit("error", new Error(options.error));
        else onConnect();
      });
      return socket;
    }) as never;
    return { connectFn, calls };
  }

  it("never connects to a name that points inside our network, or to something that is not a host", async () => {
    const { connectFn, calls } = fakeConnect({ valid_to: "Jan 1 00:00:00 2030 GMT" });
    expect((await tlsExpiry("intranet.example", { resolve: async () => ["10.1.2.3"], connectFn })).error).toMatch(/private or reserved/);
    expect((await tlsExpiry("mixed.example", { resolve: async () => ["8.8.8.8", "192.168.0.9"], connectFn })).error).toMatch(/private or reserved/);
    expect((await tlsExpiry("169.254.169.254", { connectFn })).error).toMatch(/private or reserved/);
    expect((await tlsExpiry("a/b", { connectFn })).error).toMatch(/Not a host name/);
    expect((await tlsExpiry("host:8080", { connectFn })).error).toMatch(/Not a host name/);
    expect((await tlsExpiry("gone.example", { resolve: async () => { throw new Error("ENOTFOUND"); }, connectFn })).error).toMatch(/did not resolve/);
    expect(calls).toHaveLength(0);
  });

  it("does one handshake with the name it checked, sends nothing, and reads the expiry", async () => {
    const { connectFn, calls } = fakeConnect({ valid_to: "Dec 31 23:59:59 2026 GMT" });
    const result = await tlsExpiry("www.acme.co.za", { resolve: async () => ["41.76.1.1"], connectFn });
    expect(result).toEqual({ expiresAt: "2026-12-31T23:59:59.000Z", error: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ host: "41.76.1.1", port: 443, servername: "www.acme.co.za" });
  });

  it("connects to an IPv4 address when the name has one (a host with no IPv6 route would hang), and to IPv6 only when that is all there is", async () => {
    const v4 = fakeConnect({ valid_to: "Dec 31 23:59:59 2026 GMT" });
    await tlsExpiry("dual.example", { resolve: async () => ["2606:4700:4700::1111", "8.8.8.8"], connectFn: v4.connectFn });
    expect(v4.calls[0]).toMatchObject({ host: "8.8.8.8" });
    const v6 = fakeConnect({ valid_to: "Dec 31 23:59:59 2026 GMT" });
    await tlsExpiry("six.example", { resolve: async () => ["2606:4700:4700::1111"], connectFn: v6.connectFn });
    expect(v6.calls[0]).toMatchObject({ host: "2606:4700:4700::1111" });
    // A name that points inside through IPv6 in hex is refused before any connection.
    const inside = fakeConnect({ valid_to: "Dec 31 23:59:59 2026 GMT" });
    expect((await tlsExpiry("sneaky.example", { resolve: async () => ["::ffff:7f00:1"], connectFn: inside.connectFn })).error).toMatch(/private or reserved/);
    expect((await tlsExpiry("sneaky6.example", { resolve: async () => ["8.8.8.8", "2002:7f00:1::"], connectFn: inside.connectFn })).error).toMatch(/private or reserved/);
    expect(inside.calls).toHaveLength(0);
  });

  it("says when the certificate is not trusted, or the handshake fails or times out", async () => {
    expect((await tlsExpiry("a.example", { resolve: async () => ["8.8.8.8"], connectFn: fakeConnect({ valid_to: "Dec 31 23:59:59 2026 GMT" }, { authorized: false }).connectFn })).error).toMatch(/not trusted \(CERT_HAS_EXPIRED\)/);
    expect((await tlsExpiry("a.example", { resolve: async () => ["8.8.8.8"], connectFn: fakeConnect({}).connectFn })).error).toMatch(/no readable certificate/);
    expect((await tlsExpiry("a.example", { resolve: async () => ["8.8.8.8"], connectFn: fakeConnect(null, { error: "ECONNRESET" }).connectFn })).error).toMatch(/TLS failed \(ECONNRESET\)/);
    expect((await tlsExpiry("a.example", { resolve: async () => ["8.8.8.8"], connectFn: fakeConnect(null, { hang: true }).connectFn })).error).toMatch(/timed out/);
  });
});

describe("one page check", () => {
  it("a dropped request is tried again once before it counts; two failures count", async () => {
    const flaky = io({ page: vi.fn().mockResolvedValueOnce(down).mockResolvedValueOnce({ ok: true, status: 200, ms: 90, error: null }) });
    expect(await checkPage(flaky, "https://a.test/", 0)).toMatchObject({ ok: true, status: 200 });
    expect(flaky.sleep).toHaveBeenCalledTimes(1);
    const dead = io({ page: vi.fn(async () => down) });
    expect(await checkPage(dead, "https://a.test/", 0)).toMatchObject({ ok: false, error: "The request timed out" });
    expect(dead.page).toHaveBeenCalledTimes(2);
    const fine = io();
    await checkPage(fine, "https://a.test/", 0);
    expect(fine.page).toHaveBeenCalledTimes(1);
  });

  it("down stays down since the first failure, and up clears it", () => {
    const first = afterPageCheck(emptyMonitor("s", CO), down, T0);
    expect(first).toMatchObject({ status: "down", downSince: T0.toISOString(), failures: 1 });
    const second = afterPageCheck(first, down, new Date(T0.getTime() + 5 * MIN));
    expect(second).toMatchObject({ status: "down", downSince: T0.toISOString(), failures: 2 });
    expect(downMinutes(second, T0.getTime() + 5 * MIN)).toBe(5);
    expect(downMinutes(first, T0.getTime() + 2 * MIN)).toBe(2);
    const up = afterPageCheck(second, { ok: true, status: 200, ms: 100, error: null }, new Date(T0.getTime() + 10 * MIN));
    expect(up).toMatchObject({ status: "up", downSince: null, failures: 0, lastError: null });
    expect(downMinutes(up, T0.getTime() + 20 * MIN)).toBe(0);
  });
});

describe("the monitor run", () => {
  it("checks a client's site: up, its certificate and domain read, a day's count kept, no alarm", async () => {
    const { harness, store } = await bootSites();
    const mocks = io();
    const run = await runSiteMonitor(harness.ctx, CO, { io: mocks, now: () => T0 });
    expect(run).toEqual({ checked: 1, down: 0, tlsChecked: 1, domainChecked: 1, issues: 0 });
    expect(mocks.tls).toHaveBeenCalledWith("www.acme.co.za");
    expect(mocks.rdap).toHaveBeenCalledWith("acme.co.za");
    expect(store.site_monitor![0]).toMatchObject({ site_id: "site-1", status: "up", http_status: 200, response_ms: 180, failures: 0, domain: "acme.co.za" });
    expect(store.site_monitor![0]!.tls_expires_at).toBe(new Date(T0.getTime() + 60 * DAY).toISOString());
    expect(store.site_monitor![0]!.domain_expires_at).toBe(new Date(T0.getTime() + 400 * DAY).toISOString());
    expect(store.site_uptime_days![0]).toMatchObject({ id: "site-1:2026-10-03", checks: 1, failed: 0 });
    expect(await issuesWith(harness, "crm:site-")).toHaveLength(0);
  });

  it("is polite: a site is not checked twice within four minutes, and its certificate and domain only when due", async () => {
    const { harness } = await bootSites();
    const mocks = io();
    await runSiteMonitor(harness.ctx, CO, { io: mocks, now: () => T0 });
    expect((await runSiteMonitor(harness.ctx, CO, { io: mocks, now: () => new Date(T0.getTime() + 3 * MIN) })).checked).toBe(0);
    const again = await runSiteMonitor(harness.ctx, CO, { io: mocks, now: () => new Date(T0.getTime() + 5 * MIN) });
    expect(again).toMatchObject({ checked: 1, tlsChecked: 0, domainChecked: 0 });
    const much = await runSiteMonitor(harness.ctx, CO, { io: mocks, now: () => new Date(T0.getTime() + 13 * 3_600_000) });
    expect(much).toMatchObject({ checked: 1, tlsChecked: 1, domainChecked: 0 });
    const day = await runSiteMonitor(harness.ctx, CO, { io: mocks, now: () => new Date(T0.getTime() + 25 * 3_600_000) });
    expect(day).toMatchObject({ checked: 1, domainChecked: 1 });
    expect(mocks.page).toHaveBeenCalledTimes(4);
  });

  it("caps a run, takes never-checked sites and then the longest-unchecked first, and skips paused sites and sites of a client that is gone", async () => {
    const sites = [site("s1", "https://acme.co.za/"), site("s2", "https://www.acme.co.za/shop"), site("s3", "https://third.example/"), site("s4", "https://off.example/"), site("s5", "https://orphan.example/", { client_ref: "ghost" })];
    const { harness, store } = await bootSites(sites);
    store.site_monitor = [
      { ...emptyRow("s3"), last_checked_at: new Date(T0.getTime() - 3 * DAY).toISOString() },
      { ...emptyRow("s4"), enabled: false },
      { ...emptyRow("s1"), last_checked_at: new Date(T0.getTime() - 1 * DAY).toISOString() },
    ];
    const mocks = io();
    const run = await runSiteMonitor(harness.ctx, CO, { io: mocks, now: () => T0, maxSites: 2 });
    expect(run.checked).toBe(2);
    expect(mocks.page.mock.calls.map((call) => call[0]).sort()).toEqual(["https://third.example/", "https://www.acme.co.za/shop"]);
    // The rest are checked next run; the paused site and the orphan never are.
    const next = await runSiteMonitor(harness.ctx, CO, { io: mocks, now: () => new Date(T0.getTime() + 5 * MIN) });
    expect(next.checked).toBe(3);
    const urls = mocks.page.mock.calls.map((call) => call[0]);
    expect(urls).not.toContain("https://off.example/");
    expect(urls).not.toContain("https://orphan.example/");
    expect(urls).toContain("https://acme.co.za/");
  });

  it("asks the registry about a domain once per run, however many sites share it", async () => {
    const { harness, store } = await bootSites([site("s1", "https://acme.co.za/"), site("s2", "https://www.acme.co.za/shop")]);
    const mocks = io();
    await runSiteMonitor(harness.ctx, CO, { io: mocks, now: () => T0 });
    expect(mocks.rdap.mock.calls.filter((call) => call[0] === "acme.co.za")).toHaveLength(1);
    expect(store.site_monitor!.map((row) => row.domain_expires_at)).toEqual([expect.any(String), expect.any(String)]);
  });

  it("stops starting checks once the run has used its time", async () => {
    const { harness } = await bootSites([site("s1", "https://a.example/"), site("s2", "https://b.example/"), site("s3", "https://c.example/")]);
    let ticks = 0;
    const clock = () => new Date(T0.getTime() + ticks++ * 3 * MIN);
    const run = await runSiteMonitor(harness.ctx, CO, { io: io(), now: clock, budgetMs: 4 * MIN });
    expect(run.checked).toBeLessThan(3);
    expect(run.checked).toBeGreaterThan(0);
  });

  it("a site down for 5 minutes opens one issue for the Delivery Lead in the client's project; back up says so on it", async () => {
    const { harness, store } = await bootSites();
    const mocks = io({ page: vi.fn(async () => down) });
    // First failure: down, but not yet 5 minutes.
    expect((await runSiteMonitor(harness.ctx, CO, { io: mocks, now: () => T0 })).issues).toBe(0);
    expect(store.site_monitor![0]).toMatchObject({ status: "down", down_since: T0.toISOString() });
    expect(await issuesWith(harness, "crm:site-down:")).toHaveLength(0);
    expect((await siteMonitorHealth(harness.ctx, CO, T0.getTime() + 2 * MIN)).find((c) => c.key === "sites:uptime")!.status).toBe("ok");
    // Five minutes later still failing: the issue.
    const at5 = new Date(T0.getTime() + 5 * MIN);
    expect((await runSiteMonitor(harness.ctx, CO, { io: mocks, now: () => at5 })).issues).toBe(1);
    const [outage] = await issuesWith(harness, "crm:site-down:");
    expect(outage).toMatchObject({ assigneeAgentId: "dl-1", projectId: "proj-1", priority: "high", originId: "crm:site-down:site-1:202610030800" });
    expect(outage!.title).toBe("Site down: www.acme.co.za (Acme Plumbing)");
    expect(outage!.description).toContain("has not answered since 2026-10-03T08:00:00.000Z (5 minutes, 2 failed checks)");
    const red = (await siteMonitorHealth(harness.ctx, CO, at5.getTime())).find((c) => c.key === "sites:uptime")!;
    expect(red).toMatchObject({ status: "bad" });
    expect(red.detail).toMatch(/www\.acme\.co\.za \(5 min\)/);
    // Still down at 10 minutes: no second issue.
    await runSiteMonitor(harness.ctx, CO, { io: mocks, now: () => new Date(T0.getTime() + 10 * MIN) });
    expect(await issuesWith(harness, "crm:site-down:")).toHaveLength(1);
    // Back up: a comment on the outage's issue, the state cleared.
    const comments = vi.spyOn(harness.ctx.issues, "createComment");
    mocks.page.mockImplementation(async () => ({ ok: true, status: 200, ms: 120, error: null }));
    await runSiteMonitor(harness.ctx, CO, { io: mocks, now: () => new Date(T0.getTime() + 15 * MIN) });
    expect(String(comments.mock.calls[0]![1])).toMatch(/answers again/);
    expect(store.site_monitor![0]).toMatchObject({ status: "up", down_since: null });
    // A new outage later is a new issue.
    mocks.page.mockImplementation(async () => down);
    await runSiteMonitor(harness.ctx, CO, { io: mocks, now: () => new Date(T0.getTime() + 20 * MIN) });
    await runSiteMonitor(harness.ctx, CO, { io: mocks, now: () => new Date(T0.getTime() + 25 * MIN) });
    expect(await issuesWith(harness, "crm:site-down:")).toHaveLength(2);
  });

  it("the Delivery Lead's issue falls back to the Account Manager when there is no Delivery Lead", async () => {
    const { harness } = await bootSites(undefined, false);
    const mocks = io({ page: vi.fn(async () => down) });
    await runSiteMonitor(harness.ctx, CO, { io: mocks, now: () => T0 });
    await runSiteMonitor(harness.ctx, CO, { io: mocks, now: () => new Date(T0.getTime() + 5 * MIN) });
    const [outage] = await issuesWith(harness, "crm:site-down:");
    expect(outage!.assigneeAgentId).toBe("am-1");
  });

  it("a certificate under 14 days and a domain under 30 days each open one issue, once per expiry date", async () => {
    const { harness, store } = await bootSites();
    const soon = io({
      tls: vi.fn(async () => ({ expiresAt: new Date(T0.getTime() + 10 * DAY).toISOString(), error: null })),
      rdap: vi.fn(async () => ({ expiresAt: new Date(T0.getTime() + 20 * DAY).toISOString(), error: null })),
    });
    expect((await runSiteMonitor(harness.ctx, CO, { io: soon, now: () => T0 })).issues).toBe(2);
    const [tls] = await issuesWith(harness, "crm:site-tls:");
    const [domain] = await issuesWith(harness, "crm:site-domain:");
    expect(tls).toMatchObject({ assigneeAgentId: "dl-1", originId: `crm:site-tls:site-1:${new Date(T0.getTime() + 10 * DAY).toISOString().slice(0, 10)}` });
    expect(tls!.title).toBe("Certificate expires soon: www.acme.co.za (Acme Plumbing)");
    expect(domain!.title).toBe("Domain expires soon: acme.co.za (Acme Plumbing)");
    await runSiteMonitor(harness.ctx, CO, { io: soon, now: () => new Date(T0.getTime() + 13 * 3_600_000) });
    expect(await issuesWith(harness, "crm:site-tls:")).toHaveLength(1);
    const checks = await siteMonitorHealth(harness.ctx, CO, T0.getTime());
    expect(checks.find((c) => c.key === "sites:tls")).toMatchObject({ status: "warn" });
    expect(checks.find((c) => c.key === "sites:domain")).toMatchObject({ status: "warn" });
    expect(store.site_monitor![0]!.tls_expires_at).toBeTruthy();
  });

  it("a certificate that is not trusted opens an issue; an expired one is red", async () => {
    const { harness } = await bootSites();
    const bad = io({ tls: vi.fn(async () => ({ expiresAt: new Date(T0.getTime() - DAY).toISOString(), error: "The certificate is not trusted (CERT_HAS_EXPIRED)." })) });
    await runSiteMonitor(harness.ctx, CO, { io: bad, now: () => T0 });
    const issues = await issuesWith(harness, "crm:site-tls:");
    expect(issues.map((issue) => issue.title)).toEqual(["Certificate expired: www.acme.co.za (Acme Plumbing)"]);
    expect((await siteMonitorHealth(harness.ctx, CO, T0.getTime())).find((c) => c.key === "sites:tls")).toMatchObject({ status: "bad" });
  });

  it("a registry that does not know the domain is not an alarm, and a hand-set expiry is kept", async () => {
    const { harness, store } = await bootSites();
    const unknown = io({ rdap: vi.fn(async () => ({ expiresAt: null, error: "The registry lookup answered 404." })) });
    await runSiteMonitor(harness.ctx, CO, { io: unknown, now: () => T0 });
    expect(store.site_monitor![0]).toMatchObject({ domain_error: "The registry lookup answered 404.", domain_expires_at: null });
    expect((await siteMonitorHealth(harness.ctx, CO, T0.getTime())).find((c) => c.key === "sites:domain")!.status).toBe("ok");
    const set = await tool<Record<string, any>>(harness, "set-site-monitoring", { siteId: "site-1", domainExpiresAt: new Date(T0.getTime() + 20 * DAY).toISOString().slice(0, 10) });
    expect(set.domain).toMatchObject({ manual: true, name: "acme.co.za", problem: null });
    const manual = io();
    await runSiteMonitor(harness.ctx, CO, { io: manual, now: () => new Date(T0.getTime() + 2 * DAY) });
    expect(manual.rdap).not.toHaveBeenCalled();
    expect(await issuesWith(harness, "crm:site-domain:")).toHaveLength(1);
    const cleared = await tool<Record<string, any>>(harness, "set-site-monitoring", { siteId: "site-1", domainExpiresAt: "" });
    expect(cleared.domain).toMatchObject({ manual: false, expiresAt: null });
  });

  it("an http-only site gets no certificate check, and pausing a site stops its checks", async () => {
    const { harness } = await bootSites([site("s1", "http://old.example/")]);
    const mocks = io();
    expect((await runSiteMonitor(harness.ctx, CO, { io: mocks, now: () => T0 })).tlsChecked).toBe(0);
    await tool(harness, "set-site-monitoring", { siteId: "s1", enabled: false });
    expect((await runSiteMonitor(harness.ctx, CO, { io: mocks, now: () => new Date(T0.getTime() + 10 * MIN) })).checked).toBe(0);
    await tool(harness, "set-site-monitoring", { siteId: "s1", enabled: true });
    expect((await runSiteMonitor(harness.ctx, CO, { io: mocks, now: () => new Date(T0.getTime() + 10 * MIN) })).checked).toBe(1);
    expect((await toolRaw(harness, "set-site-monitoring", { siteId: "s1", domainExpiresAt: "someday" })).error).toMatch(/must be a date/);
    expect((await toolRaw(harness, "set-site-monitoring", { siteId: "nope" })).error).toMatch(/not found/);
  });

  it("counts a month's uptime from the day totals", async () => {
    const { harness, store } = await bootSites();
    const mocks = io();
    await runSiteMonitor(harness.ctx, CO, { io: mocks, now: () => T0 });
    store.site_uptime_days = [
      { id: "site-1:2026-09-10", site_id: "site-1", company_id: CO, day: "2026-09-10", checks: 288, failed: 3 },
      { id: "site-1:2026-09-11", site_id: "site-1", company_id: CO, day: "2026-09-11", checks: 288, failed: 0 },
      { id: "site-1:2026-10-03", site_id: "site-1", company_id: CO, day: "2026-10-03", checks: 10, failed: 5 },
    ];
    expect(await uptimeFigures(harness.ctx, CO, "site-1", "2026-09")).toEqual({ checks: 576, failed: 3, pct: 99.48 });
    expect(await uptimeFigures(harness.ctx, CO, "site-1", "2026-08")).toBeNull();
    expect((await tool<Record<string, any>>(harness, "site-monitoring", { client: "company:acme" })).sites[0]).toMatchObject({ siteId: "site-1", status: "up", certificate: { daysLeft: expect.any(Number) } });
  });

  it("history older than 120 days is dropped by the run", async () => {
    const { harness, store } = await bootSites();
    store.site_uptime_days = [{ id: "site-1:2026-05-01", site_id: "site-1", company_id: CO, day: "2026-05-01", checks: 5, failed: 0 }];
    await runSiteMonitor(harness.ctx, CO, { io: io(), now: () => T0 });
    expect(store.site_uptime_days!.map((row) => row.day)).toEqual(["2026-10-03"]);
  });
});

describe("closing a site issue looks again", () => {
  it("a site that is still down keeps its issue open; one that answers closes it, after a fresh check when the last is old", async () => {
    const { harness, store } = await bootSites();
    const mocks = io({ page: vi.fn(async () => down) });
    await runSiteMonitor(harness.ctx, CO, { io: mocks, now: () => T0 });
    await runSiteMonitor(harness.ctx, CO, { io: mocks, now: () => new Date(T0.getTime() + 5 * MIN) });
    const [outage] = await issuesWith(harness, "crm:site-down:");
    const still = await siteIssueResolved(harness.ctx, CO, outage!.originId!, mocks, new Date(T0.getTime() + 30 * MIN));
    expect(still).toMatchObject({ done: false });
    expect((still as { missing: string[] }).missing[0]).toMatch(/still does not answer/);
    const back = io();
    expect(await siteIssueResolved(harness.ctx, CO, outage!.originId!, back, new Date(T0.getTime() + 60 * MIN))).toEqual({ done: true });
    expect(back.page).toHaveBeenCalledTimes(1);
    expect(store.site_monitor![0]).toMatchObject({ status: "up" });
    // A recent check is trusted: no network.
    const none = io();
    await siteIssueResolved(harness.ctx, CO, outage!.originId!, none, new Date(T0.getTime() + 62 * MIN));
    expect(none.page).not.toHaveBeenCalled();
  });

  it("a certificate or domain issue closes only when the new expiry is far enough away", async () => {
    const { harness } = await bootSites();
    const soon = io({
      tls: vi.fn(async () => ({ expiresAt: new Date(T0.getTime() + 10 * DAY).toISOString(), error: null })),
      rdap: vi.fn(async () => ({ expiresAt: new Date(T0.getTime() + 20 * DAY).toISOString(), error: null })),
    });
    await runSiteMonitor(harness.ctx, CO, { io: soon, now: () => T0 });
    const [tls] = await issuesWith(harness, "crm:site-tls:");
    const [domain] = await issuesWith(harness, "crm:site-domain:");
    const later = new Date(T0.getTime() + 2 * DAY);
    expect(await siteIssueResolved(harness.ctx, CO, tls!.originId!, soon, later)).toMatchObject({ done: false });
    expect(await siteIssueResolved(harness.ctx, CO, domain!.originId!, soon, later)).toMatchObject({ done: false });
    // Checked the day before: the next look, over a day on, asks again and finds the renewal.
    const evenLater = new Date(T0.getTime() + 4 * DAY);
    const renewed = io({ tls: vi.fn(async () => ({ expiresAt: new Date(T0.getTime() + 90 * DAY).toISOString(), error: null })), rdap: vi.fn(async () => ({ expiresAt: new Date(T0.getTime() + 400 * DAY).toISOString(), error: null })) });
    expect(await siteIssueResolved(harness.ctx, CO, tls!.originId!, renewed, evenLater)).toEqual({ done: true });
    expect(await siteIssueResolved(harness.ctx, CO, domain!.originId!, renewed, evenLater)).toEqual({ done: true });
    // A site that no longer exists has nothing to look at.
    expect(await siteIssueResolved(harness.ctx, CO, "crm:site-down:gone:202601010000", renewed, evenLater)).toEqual({ done: true });
  });
});

describe("the registry lookup through the host's guarded fetch", () => {
  it("a 404 from rdap.org (no registry for .co.za) becomes the plain instruction, a 200 is read, anything else is named", async () => {
    const { harness } = await bootSites();
    const fetch = vi.spyOn(harness.ctx.http, "fetch");
    const answer = (status: number, body: unknown = {}) => fetch.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    const lookup = defaultIo(harness.ctx);
    answer(404, { errorCode: 404, title: "No RDAP service is available" });
    expect(await lookup.rdap("acme.co.za")).toEqual({ expiresAt: null, error: expect.stringMatching(/no data for \.co\.za domains.*set-site-monitoring/) });
    answer(200, { events: [{ eventAction: "expiration", eventDate: "2027-03-31T00:00:00Z" }] });
    expect(await lookup.rdap("acme.com")).toEqual({ expiresAt: "2027-03-31T00:00:00.000Z", error: null });
    answer(503);
    expect((await lookup.rdap("acme.com")).error).toBe("The registry lookup answered 503.");
    expect(String(fetch.mock.calls[0]![0])).toBe("https://rdap.org/domain/acme.co.za");
  });
});

describe("a company with no websites", () => {
  it("shows no monitoring checks at all", async () => {
    const { harness } = await bootCare();
    expect(await siteMonitorHealth(harness.ctx, CO)).toEqual([]);
    expect(await listMonitors(harness.ctx, CO)).toEqual([]);
  });

  it("deleting the client removes its monitoring rows", async () => {
    const { harness, store } = await bootSites();
    await runSiteMonitor(harness.ctx, CO, { io: io(), now: () => T0 });
    expect(store.site_monitor).toHaveLength(1);
    await harness.performAction("crm.delete-company", { companyRecordId: "acme", confirm: true }, { companyId: CO, actor: BOARD });
    expect(store.site_monitor).toHaveLength(0);
    expect(store.site_uptime_days).toHaveLength(0);
  });

  it("removing one website removes its monitoring too: left behind it would still be counted as a site that is down", async () => {
    const { harness, store } = await bootSites([site("site-1", "https://www.acme.co.za/"), site("site-2", "https://shop.acme.co.za/")]);
    await runSiteMonitor(harness.ctx, CO, { io: io({ page: vi.fn(async () => down) as never }), now: () => T0 });
    expect(store.site_monitor!.map((row) => row.site_id).sort()).toEqual(["site-1", "site-2"]);
    expect((await siteMonitorHealth(harness.ctx, CO)).length).toBeGreaterThan(0);
    const removed = await harness.performAction<Record<string, any>>("crm.delete-client-site", { siteId: "site-1" }, { companyId: CO, actor: BOARD });
    expect(removed.removed).toBe("site-1");
    expect(store.client_sites!.map((row) => row.id)).toEqual(["site-2"]);
    expect(store.site_monitor!.map((row) => row.site_id)).toEqual(["site-2"]);
    expect(store.site_uptime_days!.map((row) => row.site_id)).toEqual(["site-2"]);
    expect((await listMonitors(harness.ctx, CO)).map((m) => m.siteId)).toEqual(["site-2"]);
  });

  it("a day's count is bumped for this company's row only (the update names the company too)", async () => {
    const { harness, store } = await bootSites();
    store.site_uptime_days = [{ id: "site-1:2026-10-03", site_id: "site-1", company_id: "co-2", day: "2026-10-03", checks: 7, failed: 0 }];
    await runSiteMonitor(harness.ctx, CO, { io: io(), now: () => T0 });
    expect(store.site_uptime_days!.find((row) => row.company_id === "co-2")).toMatchObject({ checks: 7 });
  });

  it("the tool refuses a site the viewer cannot see, and a site of another company", async () => {
    const { harness } = await bootSites([site("other", "https://x.example/", { company_id: "co-2" })]);
    await expect(setSiteMonitoringTool(harness.ctx, { companyId: CO, userId: "local-board", agentId: null, role: "owner" }, { siteId: "other" })).rejects.toThrow(/not found/);
  });
});

function emptyRow(siteId: string): Record<string, unknown> {
  return { site_id: siteId, company_id: CO, enabled: true, status: "unknown", http_status: null, response_ms: null, last_error: null, last_checked_at: null, last_ok_at: null, down_since: null, failures: 0, tls_expires_at: null, tls_error: null, tls_checked_at: null, domain: null, domain_expires_at: null, domain_checked_at: null, domain_error: null, domain_manual: false };
}
