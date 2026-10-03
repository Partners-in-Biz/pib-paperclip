import { describe, expect, it, vi } from "vitest";
import { digCommands, dohResolver, organizationalDomain, sendingDomain, txtText, type DohFetch } from "../src/dns.js";
import {
  checkDomain,
  DOMAIN_HEALTH_EVENT,
  dkimKeyBits,
  domainHealthChecks,
  evaluateDomain,
  onboardingGuide,
  reannounceDomainChecks,
  runDomainChecks,
  senderDomainHealth,
  sendingDomains,
  type DomainRunEnv,
} from "../src/domain-health.js";
import { CO, MemoryStore } from "./helpers/memory.js";
import { fakeDns, PIB_DNS_AFTER, PIB_DNS_BEFORE } from "./helpers/dns.js";
import { setup } from "./helpers/setup.js";

const NOW = Date.parse("2026-10-03T10:00:00Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const codes = (report: { problems: Array<{ code: string }> }) => report.problems.map((p) => p.code);

describe("DNS over HTTPS", () => {
  const google = JSON.stringify({ Status: 0, Answer: [{ name: "partnersinbiz.online.", type: 16, TTL: 3600, data: "v=DMARC1; p=none;" }] });
  const cloudflare = JSON.stringify({ Status: 0, Answer: [{ name: "default._domainkey.partnersinbiz.online", type: 16, TTL: 1, data: '"v=DKIM1; k=rsa; p=AAAA" "BBBB"' }] });
  const response = (body: string, status = 200) => ({ ok: status < 400, status, text: async () => body });

  it("reads Google's unquoted answers and Cloudflare's quoted chunks as one string", async () => {
    expect(txtText('"v=DKIM1; p=AAAA" "BBBB"')).toBe("v=DKIM1; p=AAAABBBB");
    expect(txtText("v=DMARC1; p=none;")).toBe("v=DMARC1; p=none;");
    const dns = dohResolver(async (url) => response(url.includes("dns.google") ? google : cloudflare));
    expect(await dns.query("partnersinbiz.online", "TXT")).toMatchObject({ ok: true, rcode: 0, answers: [{ type: "TXT", name: "partnersinbiz.online", data: "v=DMARC1; p=none;" }] });
    const second = dohResolver(async () => response(cloudflare));
    expect((await second.query("default._domainkey.partnersinbiz.online", "TXT")).answers[0]!.data).toBe("v=DKIM1; k=rsa; p=AAAABBBB");
  });

  it("says NXDOMAIN is a real 'no record' but a failed lookup is not", async () => {
    const nx = dohResolver(async () => response(JSON.stringify({ Status: 3 })));
    expect(await nx.query("google._domainkey.partnersinbiz.online", "TXT")).toMatchObject({ ok: true, rcode: 3, answers: [] });
    const down = dohResolver(async () => response("", 503));
    const result = await down.query("partnersinbiz.online", "TXT");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/dns\.google answered HTTP 503; cloudflare-dns\.com answered HTTP 503/);
  });

  it("asks the next resolver on SERVFAIL, and refuses a bad name without a request", async () => {
    const calls: string[] = [];
    const fetchImpl: DohFetch = async (url) => {
      calls.push(url);
      return response(url.includes("dns.google") ? JSON.stringify({ Status: 2 }) : cloudflare);
    };
    const dns = dohResolver(fetchImpl);
    expect((await dns.query("a.example.com", "TXT")).ok).toBe(true);
    expect(calls.map((url) => new URL(url).host)).toEqual(["dns.google", "cloudflare-dns.com"]);
    const none = vi.fn();
    expect((await dohResolver(none as unknown as DohFetch).query("bad name!", "TXT")).ok).toBe(false);
    expect(none).not.toHaveBeenCalled();
  });

  it("gives up on a resolver that does not answer in time, and stops asking when the network is down", async () => {
    vi.useFakeTimers();
    try {
      const slow: DohFetch = () => new Promise(() => undefined);
      const dns = dohResolver(slow, undefined, { timeoutMs: 1000 });
      const pending = dns.query("a.example.com", "TXT");
      await vi.advanceTimersByTimeAsync(2100);
      const result = await pending;
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/dns\.google: timed out after 1s; cloudflare-dns\.com: timed out after 1s/);
    } finally {
      vi.useRealTimers();
    }
    let calls = 0;
    const down = dohResolver(async () => {
      calls += 1;
      throw new Error("ENETUNREACH");
    });
    for (let i = 0; i < 8; i += 1) expect((await down.query(`s${i}.example.com`, "TXT")).ok).toBe(false);
    // 4 lookups x 2 resolvers, then no more requests.
    expect(calls).toBe(8);
    expect((await down.query("x.example.com", "TXT")).error).toBe("the public DNS resolvers could not be reached");
    // A resolver that has answered once keeps trying: one bad lookup is not a dead network.
    let n = 0;
    const flaky = dohResolver(async () => {
      n += 1;
      if (n === 1) return { ok: true, status: 200, text: async () => JSON.stringify({ Status: 0, Answer: [] }) };
      throw new Error("blip");
    });
    expect((await flaky.query("a.example.com", "TXT")).ok).toBe(true);
    for (let i = 0; i < 6; i += 1) await flaky.query(`b${i}.example.com`, "TXT");
    expect(n).toBe(1 + 12);
  });

  it("knows the organisational domain and a sending domain", () => {
    expect(organizationalDomain("mail.client.co.za")).toBe("client.co.za");
    expect(organizationalDomain("a.b.example.com")).toBe("example.com");
    expect(organizationalDomain("example.com")).toBe("example.com");
    expect(sendingDomain("Ann <ann@WWW.Client.co.za>".replace(/.*</, "").replace(">", ""))).toBe("client.co.za");
    expect(sendingDomain("https://www.ahslaw.co.za/contact")).toBe("ahslaw.co.za");
    expect(sendingDomain("not a domain")).toBeNull();
    expect(digCommands("client.co.za", ["google", "default"])).toEqual(["dig +short TXT client.co.za", "dig +short MX client.co.za", "dig +short TXT _dmarc.client.co.za", "dig +short TXT google._domainkey.client.co.za", "dig +short TXT default._domainkey.client.co.za"]);
  });
});

describe("the live partnersinbiz.online case", () => {
  it("is bad today: no SPF, no DKIM at google, DMARC only reports, a 1024-bit Resend key", async () => {
    const report = await checkDomain(fakeDns(PIB_DNS_BEFORE), "partnersinbiz.online", { now: NOW, hasMailbox: true, gmail: true, sendingSince: iso(NOW - 7 * DAY) });
    expect(report.status).toBe("bad");
    expect(codes(report)).toEqual(["spf_missing", "dmarc_no_reports"]);
    expect(report.spf).toMatchObject({ state: "missing", record: null });
    expect(report.dkim).toMatchObject({ state: "ok", found: ["default", "resend"] });
    expect(report.dkim.selectors.find((s) => s.selector === "google")).toMatchObject({ state: "missing" });
    expect(report.dkim.selectors.find((s) => s.selector === "default")!.keyBits).toBe(2048);
    expect(report.dkim.selectors.find((s) => s.selector === "resend")!.keyBits).toBe(1024);
    expect(report.dmarc).toMatchObject({ state: "monitor", policy: "none", rua: [] });
    expect(report.mx).toMatchObject({ state: "ok", provider: "google" });
    expect(report.sendReady).toBe(false);
    // p=none is the right first step: not a problem yet, 7 days in.
    expect(codes(report)).not.toContain("dmarc_none_aged");
  });

  it("is healthy once the owner adds SPF and a report address, and counts SPF's lookups through the includes", async () => {
    const dns = fakeDns(PIB_DNS_AFTER);
    const report = await checkDomain(dns, "partnersinbiz.online", { now: NOW, hasMailbox: true, gmail: true, sendingSince: iso(NOW - 7 * DAY) });
    expect(report.spf).toMatchObject({ state: "ok", all: "~all", authorisesGoogle: true, lookups: 4, lookupsApprox: false, includes: ["_spf.google.com", "_netblocks.google.com", "_netblocks2.google.com", "_netblocks3.google.com"] });
    expect(report.status).toBe("healthy");
    expect(report.sendReady).toBe(true);
    expect(report.problems).toEqual([]);
    expect(dns.queries).toContain("TXT _dmarc.partnersinbiz.online");
  });

  it("p=none becomes a warning after 30 days of sending, counted from the older of when we first saw it and when sending began", async () => {
    const at = (sendingSince: string | null, dmarcNoneSince: string | null) => checkDomain(fakeDns(PIB_DNS_AFTER), "partnersinbiz.online", { now: NOW, hasMailbox: true, gmail: true, sendingSince, dmarcNoneSince });
    expect((await at(iso(NOW - 29 * DAY), null)).status).toBe("healthy");
    const aged = await at(iso(NOW - 31 * DAY), null);
    expect(aged.status).toBe("warn");
    expect(codes(aged)).toEqual(["dmarc_none_aged"]);
    expect(aged.problems[0]!.message).toMatch(/p=none for 31 days/);
    // First seen as p=none 40 days ago, sending only began 10 days ago: the older date counts.
    expect((await at(iso(NOW - 10 * DAY), iso(NOW - 40 * DAY))).status).toBe("warn");
    // Enforcing policy is never aged.
    const enforced = await checkDomain(fakeDns({ ...PIB_DNS_AFTER, "TXT _dmarc.partnersinbiz.online": ["v=DMARC1; p=quarantine; rua=mailto:d@partnersinbiz.online; pct=50"] }), "partnersinbiz.online", { now: NOW, gmail: true, sendingSince: iso(NOW - 90 * DAY) });
    expect(enforced.dmarc.state).toBe("enforced");
    expect(codes(enforced)).toEqual(["dmarc_pct"]);
    expect(enforced.status).toBe("healthy");
  });
});

describe("judging a domain", () => {
  const spfOk = { "TXT d.co": ["v=spf1 include:_spf.google.com ~all"], "TXT _spf.google.com": ["v=spf1 ip4:1.2.3.4 ~all"], "MX d.co": ["1 aspmx.l.google.com."], "TXT google._domainkey.d.co": ["v=DKIM1; k=rsa; p=" + "A".repeat(392)], "TXT _dmarc.d.co": ["v=DMARC1; p=reject; rua=mailto:r@d.co"] };
  const run = (records: Record<string, string[]>, options = {}) => checkDomain(fakeDns(records), "d.co", { now: NOW, hasMailbox: true, gmail: true, sendingSince: iso(NOW - 100 * DAY), ...options });

  it("a complete, enforcing domain is healthy and ready", async () => {
    const report = await run(spfOk);
    expect(report).toMatchObject({ status: "healthy", sendReady: true, unreadable: false, manual: [] });
    expect(report.dmarc.state).toBe("enforced");
  });

  it("two SPF records are bad: receivers ignore both", async () => {
    const report = await run({ ...spfOk, "TXT d.co": ["v=spf1 include:_spf.google.com ~all", "v=spf1 include:mailgun.org ~all"] });
    expect(report.spf.state).toBe("multiple");
    expect(codes(report)).toContain("spf_multiple");
    expect(report.status).toBe("bad");
  });

  it("+all is bad, no all-mechanism is a warning, and SPF without Google's include warns a Gmail domain", async () => {
    expect(codes(await run({ ...spfOk, "TXT d.co": ["v=spf1 include:_spf.google.com +all"] }))).toContain("spf_plus_all");
    const open = await run({ ...spfOk, "TXT d.co": ["v=spf1 include:_spf.google.com"] });
    expect(codes(open)).toEqual(["spf_no_policy"]);
    expect(open.status).toBe("warn");
    const notGoogle = await run({ ...spfOk, "TXT d.co": ["v=spf1 include:mailgun.org ~all"], "TXT mailgun.org": ["v=spf1 ip4:5.6.7.8 ~all"] });
    expect(codes(notGoogle)).toEqual(["spf_not_google"]);
    // A domain that does not send through Gmail is not warned about Google.
    expect(codes(await run({ ...spfOk, "TXT d.co": ["v=spf1 include:mailgun.org ~all"], "TXT mailgun.org": ["v=spf1 ip4:5.6.7.8 ~all"] }, { gmail: false }))).toEqual([]);
  });

  it("a redirect= record takes the other domain's policy; a DMARC record with no p counts as p=none only when it names a report address", async () => {
    const redirect = await run({ ...spfOk, "TXT d.co": ["v=spf1 redirect=_spf.d.co"], "TXT _spf.d.co": ["v=spf1 include:_spf.google.com ~all"] });
    expect(codes(redirect)).toEqual([]);
    expect(redirect.spf.lookups).toBeGreaterThanOrEqual(2);
    const noP = await run({ ...spfOk, "TXT _dmarc.d.co": ["v=DMARC1; rua=mailto:r@d.co"] });
    expect(noP.dmarc).toMatchObject({ state: "monitor", policy: "none", rua: ["mailto:r@d.co"] });
    const empty = await run({ ...spfOk, "TXT _dmarc.d.co": ["v=DMARC1"] });
    expect(empty.dmarc.state).toBe("missing");
    expect(codes(empty)).toContain("dmarc_missing");
  });

  it("more than 10 DNS lookups through the includes is bad", async () => {
    const includes = Array.from({ length: 14 }, (_, i) => `include:s${i}.example.net`).join(" ");
    const records: Record<string, string[]> = { ...spfOk, "TXT d.co": [`v=spf1 include:_spf.google.com ${includes} ~all`] };
    for (let i = 0; i < 14; i += 1) records[`TXT s${i}.example.net`] = ["v=spf1 ip4:9.9.9.9 ~all"];
    const report = await run(records);
    // 15 includes: the walk reads at most 12 records, so the count is a lower bound and says so.
    expect(report.spf.lookups).toBe(15);
    expect(report.spf.lookupsApprox).toBe(true);
    expect(codes(report)).toContain("spf_lookups");
    expect(report.status).toBe("bad");
  });

  it("no DKIM key at any selector is bad, a revoked key does not count, a provider CNAME is noted", async () => {
    const none = await run({ ...spfOk, "TXT google._domainkey.d.co": [] });
    expect(none.dkim.state).toBe("missing");
    expect(codes(none)).toContain("dkim_missing");
    expect(none.status).toBe("bad");
    const revoked = await run({ ...spfOk, "TXT google._domainkey.d.co": ["v=DKIM1; k=rsa; p="] });
    expect(revoked.dkim.selectors.find((s) => s.selector === "google")).toMatchObject({ state: "revoked" });
    expect(revoked.dkim.state).toBe("missing");
    const cname = await checkDomain(fakeDns({ ...spfOk, "TXT google._domainkey.d.co": [] }, { cnames: { "selector1._domainkey.d.co": "selector1-d-co._domainkey.example.onmicrosoft.com" } }), "d.co", { now: NOW, gmail: true });
    expect(cname.dkim.selectors.find((s) => s.selector === "selector1")).toMatchObject({ state: "cname", cname: "selector1-d-co._domainkey.example.onmicrosoft.com" });
    expect(cname.dkim.state).toBe("missing");
  });

  it("a key of 1024 bits is a note, not a problem; the size comes from the key length", () => {
    expect(dkimKeyBits("A".repeat(216))).toBe(1024);
    expect(dkimKeyBits("A".repeat(392))).toBe(2048);
    expect(dkimKeyBits("A".repeat(736))).toBe(4096);
    expect(dkimKeyBits("short")).toBeNull();
  });

  it("no MX is bad for a domain with a mailbox and a warning otherwise; a null MX counts as none", async () => {
    expect(codes(await run({ ...spfOk, "MX d.co": [] }))).toEqual(["mx_missing"]);
    expect((await run({ ...spfOk, "MX d.co": [] })).status).toBe("bad");
    expect((await run({ ...spfOk, "MX d.co": [] }, { hasMailbox: false })).status).toBe("warn");
    expect((await run({ ...spfOk, "MX d.co": ["0 ."] })).mx.state).toBe("missing");
  });

  it("a subdomain inherits the organisational domain's DMARC", async () => {
    const records = { ...spfOk, "TXT mail.d.co": ["v=spf1 include:_spf.google.com ~all"], "MX mail.d.co": ["1 aspmx.l.google.com."], "TXT google._domainkey.mail.d.co": ["v=DKIM1; p=" + "A".repeat(392)] };
    const report = await checkDomain(fakeDns(records), "mail.d.co", { now: NOW, gmail: true });
    expect(report.dmarc).toMatchObject({ state: "enforced", inheritedFrom: "d.co" });
  });

  it("DMARC missing is a warning at first and bad once the domain has sent for 30 days", async () => {
    const records = { ...spfOk, "TXT _dmarc.d.co": [] };
    expect((await run(records, { sendingSince: iso(NOW - 5 * DAY) })).problems.find((p) => p.code === "dmarc_missing")!.severity).toBe("warn");
    const late = await run(records, { sendingSince: iso(NOW - 45 * DAY) });
    expect(late.problems.find((p) => p.code === "dmarc_missing")!.severity).toBe("bad");
    expect(late.sendReady).toBe(false);
  });

  it("DNS that cannot be read is unreadable with the dig commands, never reported as missing", async () => {
    const dns = fakeDns(spfOk, { down: ["TXT d.co", "TXT _dmarc.d.co"] });
    const report = await checkDomain(dns, "d.co", { now: NOW, hasMailbox: true, gmail: true, sendingSince: iso(NOW - 100 * DAY) });
    expect(report.spf.state).toBe("unreadable");
    expect(report.dmarc.state).toBe("unreadable");
    expect(codes(report)).toEqual(["dns_unreadable"]);
    expect(codes(report)).not.toContain("spf_missing");
    expect(report.status).toBe("warn");
    expect(report.sendReady).toBe(false);
    expect(report.manual).toContain("dig +short TXT d.co");
    expect(report.manual).toContain("dig +short TXT _dmarc.d.co");
    const dead = await checkDomain(fakeDns({}, { down: ["MX d.co", "TXT d.co", "TXT _dmarc.d.co", ...["google", "default", "selector1", "selector2", "resend", "k1", "s1", "s2", "mail", "dkim", "smtp"].map((s) => `TXT ${s}._domainkey.d.co`)] }), "d.co", { now: NOW });
    expect(dead.status).toBe("unknown");
  });

  it("one DKIM selector that cannot be read, with none found, is unreadable: it may be the very key, so never a false 'bad'", async () => {
    const noDkim = { ...spfOk, "TXT google._domainkey.d.co": [] };
    const dns = fakeDns(noDkim, { down: ["TXT default._domainkey.d.co"] });
    const report = await checkDomain(dns, "d.co", { now: NOW, hasMailbox: true, gmail: true });
    expect(report.dkim.state).toBe("unreadable");
    expect(codes(report)).toContain("dns_unreadable");
    expect(codes(report)).not.toContain("dkim_missing");
    expect(report.status).not.toBe("bad");
    // Every selector answered with nothing: now it is missing.
    const answered = await checkDomain(fakeDns(noDkim), "d.co", { now: NOW, hasMailbox: true, gmail: true });
    expect(answered.dkim.state).toBe("missing");
    expect(codes(answered)).toContain("dkim_missing");
    // A key found at one selector still counts, whatever happened to the others.
    const found = await checkDomain(fakeDns(spfOk, { down: ["TXT default._domainkey.d.co"] }), "d.co", { now: NOW, hasMailbox: true, gmail: true });
    expect(found.dkim.state).toBe("ok");
  });

  it("a subdomain with no DMARC of its own whose organisational domain cannot be read is unreadable, not 'missing'", async () => {
    const records = { ...spfOk, "TXT mail.d.co": ["v=spf1 include:_spf.google.com ~all"], "TXT _dmarc.mail.d.co": [] };
    const down = await checkDomain(fakeDns(records, { down: ["TXT _dmarc.d.co"] }), "mail.d.co", { now: NOW, hasMailbox: true, gmail: true, sendingSince: iso(NOW - 100 * DAY) });
    expect(down.dmarc.state).toBe("unreadable");
    expect(codes(down)).not.toContain("dmarc_missing");
    // The parent answered with a policy: inherited as before.
    const inherited = await checkDomain(fakeDns({ ...records, "TXT _dmarc.d.co": ["v=DMARC1; p=reject; rua=mailto:r@d.co"] }), "mail.d.co", { now: NOW, hasMailbox: true, gmail: true });
    expect(inherited.dmarc).toMatchObject({ state: "enforced", inheritedFrom: "d.co" });
    // The parent answered with nothing: it really is missing.
    const none = await checkDomain(fakeDns({ ...records, "TXT _dmarc.d.co": [] }), "mail.d.co", { now: NOW, hasMailbox: true, gmail: true });
    expect(none.dmarc.state).toBe("missing");
  });

  it("a lookup that throws is unreadable, not a crash", async () => {
    const throwing = { query: async () => { throw new Error("boom"); } };
    const report = await checkDomain(throwing, "d.co", { now: NOW });
    expect(report.status).toBe("unknown");
    expect(report.unreadable).toBe(true);
  });

  it("evaluateDomain is pure: the same parts and time give the same report", () => {
    const parts = { domain: "d.co", mx: { state: "ok" as const, hosts: ["x"], provider: "other" as const }, spf: { state: "missing" as const, record: null, all: null, lookups: 0, lookupsApprox: false, includes: [], authorisesGoogle: false }, dkim: { state: "ok" as const, found: ["a"], selectors: [] }, dmarc: { state: "missing" as const, record: null, policy: null, subdomainPolicy: null, pct: null, rua: [], inheritedFrom: null }, selectors: ["a"] };
    expect(evaluateDomain(parts, { now: NOW })).toEqual(evaluateDomain(parts, { now: NOW }));
    expect(codes(evaluateDomain(parts, { now: NOW }))).toEqual(["spf_missing", "dmarc_missing"]);
  });
});

function runEnv(store: MemoryStore, dns: ReturnType<typeof fakeDns>, host = setup().host): DomainRunEnv {
  return { ctx: host.ctx, store, dns, now: () => NOW };
}

describe("running the checks for a company", () => {
  it("checks the domain of each mailbox (never a free-mail one), stores the result and announces it", async () => {
    const { store, host } = setup();
    store.accounts.get("acc-1")!.address = "peet@partnersinbiz.online";
    store.accounts.get("acc-1")!.connected_at = iso(NOW - 7 * DAY);
    store.addAccount({ id: "acc-2", company_id: CO, address: "someone@gmail.com", token_sealed: "x" });
    const env = runEnv(store, fakeDns(PIB_DNS_BEFORE), host);
    expect(await runDomainChecks(env, CO)).toEqual({ checked: 1, bad: 1, warn: 0, unreadable: 0 });
    const row = (await store.getDomainCheck(CO, "partnersinbiz.online"))!;
    expect(row).toMatchObject({ status: "bad", source: "account", checked_at: iso(NOW), first_checked_at: iso(NOW), status_since: iso(NOW), dmarc_none_since: iso(NOW) });
    expect(row.result).toMatchObject({ status: "bad", sendReady: false });
    const event = host.emitted.find((e) => e.name === DOMAIN_HEALTH_EVENT)!;
    expect(event.payload).toMatchObject({ key: `domain:partnersinbiz.online:${iso(NOW)}`, domain: "partnersinbiz.online", status: "bad", healthy: false, sendReady: false, mailboxes: ["peet@partnersinbiz.online"] });
    expect((event.payload.problems as Array<{ code: string }>).map((p) => p.code)).toContain("spf_missing");
    expect(JSON.stringify(event.payload)).not.toMatch(/p=MII/);
  });

  it("remembers when p=none was first seen and when the status last changed", async () => {
    const { store, host } = setup();
    store.accounts.get("acc-1")!.address = "peet@partnersinbiz.online";
    store.accounts.get("acc-1")!.connected_at = iso(NOW - 7 * DAY);
    let now = NOW - 40 * DAY;
    const env: DomainRunEnv = { ctx: host.ctx, store, dns: fakeDns(PIB_DNS_AFTER), now: () => now };
    await runDomainChecks(env, CO);
    expect((await store.getDomainCheck(CO, "partnersinbiz.online"))).toMatchObject({ status: "healthy", dmarc_none_since: iso(now), status_since: iso(now) });
    now = NOW;
    await runDomainChecks(env, CO);
    const later = (await store.getDomainCheck(CO, "partnersinbiz.online"))!;
    // Still p=none, now 40 days old: a warning, and the clock did not restart.
    expect(later).toMatchObject({ status: "warn", dmarc_none_since: iso(NOW - 40 * DAY), first_checked_at: iso(NOW - 40 * DAY), status_since: iso(NOW) });
    now = NOW + DAY;
    await runDomainChecks(env, CO);
    expect((await store.getDomainCheck(CO, "partnersinbiz.online"))!.status_since).toBe(iso(NOW));
  });

  it("includes domains watched on purpose (a client's) and a failing domain never stops the others", async () => {
    const { store, host } = setup();
    store.accounts.get("acc-1")!.address = "peet@partnersinbiz.online";
    await store.upsertDomainCheck({ company_id: CO, domain: "client.co.za", status: "unknown", result: {}, source: "manual", client_kind: "company", client_ref: "crm-1", checked_at: iso(NOW - DAY), first_checked_at: iso(NOW - DAY), status_since: iso(NOW - DAY), dmarc_none_since: null });
    expect((await sendingDomains(store, CO)).map((d) => [d.domain, d.source, d.clientRef])).toEqual([["client.co.za", "manual", "crm-1"], ["partnersinbiz.online", "account", null]]);
    const dns = fakeDns(PIB_DNS_BEFORE);
    const original = dns.query;
    dns.query = async (name, type) => {
      if (name.endsWith("client.co.za")) throw new Error("network down");
      return original(name, type);
    };
    const summary = await runDomainChecks(runEnv(store, dns, host), CO);
    // client.co.za could not be read at all (unknown); partnersinbiz.online was still checked.
    expect(summary.checked).toBe(2);
    expect((await store.getDomainCheck(CO, "partnersinbiz.online"))!.status).toBe("bad");
    expect((await store.getDomainCheck(CO, "client.co.za"))).toMatchObject({ status: "unknown", client_ref: "crm-1", source: "manual" });
  });

  it("announces the stored checks again, so another module's projection recovers", async () => {
    const { store, host } = setup();
    store.accounts.get("acc-1")!.address = "peet@partnersinbiz.online";
    await runDomainChecks(runEnv(store, fakeDns(PIB_DNS_AFTER), host), CO);
    host.emitted.length = 0;
    expect(await reannounceDomainChecks(runEnv(store, fakeDns({}), host), CO)).toBe(1);
    expect(host.emitted.map((e) => e.name)).toEqual([DOMAIN_HEALTH_EVENT]);
  });
});

describe("the predicate other modules use", () => {
  it("is false for a domain nobody checked, true for a healthy one, and says when it is stale; it blocks nothing", async () => {
    const { store, host } = setup();
    store.accounts.get("acc-1")!.address = "peet@partnersinbiz.online";
    expect(await senderDomainHealth(store, CO, "peet@partnersinbiz.online", NOW)).toMatchObject({ domain: "partnersinbiz.online", known: false, healthy: false, status: "unknown", stale: true });
    await runDomainChecks(runEnv(store, fakeDns(PIB_DNS_AFTER), host), CO);
    expect(await senderDomainHealth(store, CO, "Peet@PartnersInBiz.online", NOW)).toMatchObject({ known: true, healthy: true, sendReady: true, status: "healthy", reasons: [], stale: false, checkedAt: iso(NOW) });
    expect((await senderDomainHealth(store, CO, "partnersinbiz.online", NOW + 3 * DAY)).stale).toBe(true);
    await runDomainChecks(runEnv(store, fakeDns(PIB_DNS_BEFORE), host), CO);
    const bad = await senderDomainHealth(store, CO, "partnersinbiz.online", NOW);
    expect(bad).toMatchObject({ healthy: false, sendReady: false, status: "bad" });
    expect(bad.reasons[0]).toMatch(/no SPF record/);
  });
});

describe("the Cockpit checks", () => {
  it("one per domain: ok when healthy, the worst problem and its fix otherwise, a warning when the daily check stopped", async () => {
    const { store, host } = setup();
    store.accounts.get("acc-1")!.address = "peet@partnersinbiz.online";
    await runDomainChecks(runEnv(store, fakeDns(PIB_DNS_BEFORE), host), CO);
    const rows = await store.listDomainChecks(CO);
    const [bad] = domainHealthChecks(rows, NOW);
    expect(bad).toMatchObject({ key: "mailbox:domain:partnersinbiz.online", status: "bad", href: "/mailbox?tab=mailboxes", since: iso(NOW) });
    expect(bad!.detail).toMatch(/no SPF record/);
    expect(bad!.fix).toMatch(/include:_spf\.google\.com/);
    await runDomainChecks(runEnv(store, fakeDns(PIB_DNS_AFTER), host), CO);
    expect(domainHealthChecks(await store.listDomainChecks(CO), NOW)).toEqual([{ key: "mailbox:domain:partnersinbiz.online", title: "Sender domain: partnersinbiz.online", status: "ok" }]);
    expect(domainHealthChecks(await store.listDomainChecks(CO), NOW + 4 * DAY)[0]).toMatchObject({ status: "warn", detail: "The daily domain check has not run for over three days." });
  });
});

describe("onboarding a client's domain", () => {
  it("lists exactly the records to add, in order, and what already exists", async () => {
    const report = await checkDomain(fakeDns({}), "newclient.co.za", { now: NOW, gmail: true });
    const guide = onboardingGuide("newclient.co.za", report, { gmail: true, reportsMailbox: "ops@newclient.co.za" });
    expect(guide.records.map((r) => [r.type, r.host, r.value])).toEqual([
      ["MX", "@", "1 SMTP.GOOGLE.COM."],
      ["TXT", "@", "v=spf1 include:_spf.google.com ~all"],
      ["TXT", "_dmarc", "v=DMARC1; p=none; rua=mailto:ops@newclient.co.za; adkim=r; aspf=r"],
    ]);
    expect(guide.steps[0]).toBe("Add a MX record at newclient.co.za: 1 SMTP.GOOGLE.COM.");
    expect(guide.steps.join("\n")).toMatch(/DKIM \(Google Workspace\).*selector google.*google\._domainkey\.newclient\.co\.za.*Start authentication/);
    expect(guide.steps.join("\n")).toMatch(/two weeks.*p=quarantine/);
    expect(guide.steps.at(-1)).toMatch(/run check-sender-domain again.*healthy before a campaign/);
    expect(guide.dig).toContain("dig +short TXT _dmarc.newclient.co.za");
  });

  it("edits an existing SPF record instead of adding a second one, and skips what is already right", async () => {
    const report = await checkDomain(fakeDns({ "TXT x.co": ["v=spf1 include:mailgun.org ~all"], "TXT mailgun.org": ["v=spf1 ip4:1.1.1.1 ~all"], "MX x.co": ["1 smtp.google.com."], "TXT _dmarc.x.co": ["v=DMARC1; p=none; rua=mailto:r@x.co"], "TXT google._domainkey.x.co": ["v=DKIM1; p=" + "A".repeat(392)] }), "x.co", { now: NOW, gmail: true });
    const guide = onboardingGuide("x.co", report, { gmail: true });
    expect(guide.records).toEqual([expect.objectContaining({ type: "TXT", host: "@", value: "v=spf1 include:mailgun.org include:_spf.google.com ~all", purpose: expect.stringMatching(/Edit the existing SPF record/) })]);
    expect(guide.alreadyDone).toEqual(expect.arrayContaining(["DKIM key at google", "DMARC (none)", "MX: smtp.google.com (google)"]));
  });
});
