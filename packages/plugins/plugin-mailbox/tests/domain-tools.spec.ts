import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { NAMESPACE } from "../src/namespace.js";
import plugin from "../src/worker.js";
import { CO } from "./helpers/memory.js";
import { dohFetchFrom, PIB_DNS_AFTER, PIB_DNS_BEFORE } from "./helpers/dns.js";
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

const DKIM_KEY = "v=DKIM1; k=rsa; p=" + "A".repeat(392);

type Row = Record<string, unknown>;

/**
 * A harness whose database keeps the few tables these tools use (all statements pass the
 * host guard) and whose `ctx.http.fetch` answers DNS over HTTPS from a records table.
 */
async function boot(records: Record<string, string[]>, tables: { accounts?: Row[]; domain_checks?: Row[]; crm_companies?: Row[]; client_mail_maps?: Row[] } = {}) {
  const harness = createTestHarness({ manifest, config: { publicBaseUrl: "https://paperclip.example.com", encryptionKey: "x".repeat(20) } });
  const data = { accounts: [] as Row[], domain_checks: [] as Row[], crm_companies: [] as Row[], client_mail_maps: [] as Row[], ...tables };
  const executed: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    namespace: NAMESPACE,
    async query(sql: string, params: unknown[] = []) {
      validateRuntimeQuery(sql, NAMESPACE);
      validateParams(sql, params);
      if (sql.includes(`FROM ${NAMESPACE}.accounts WHERE company_id = $1 ORDER BY address`)) return data.accounts;
      if (sql.includes(`FROM ${NAMESPACE}.domain_checks WHERE company_id = $1 AND domain = $2`)) return data.domain_checks.filter((r) => r.domain === params[1]);
      if (sql.includes(`FROM ${NAMESPACE}.domain_checks WHERE company_id = $1 ORDER BY domain`)) return data.domain_checks;
      if (sql.includes(`FROM ${NAMESPACE}.crm_companies WHERE company_id = $1 AND id = $2`)) return data.crm_companies.filter((r) => r.id === params[1]);
      if (sql.includes(`FROM ${NAMESPACE}.client_mail_maps WHERE company_id = $1 ORDER BY created_at`)) return data.client_mail_maps;
      if (sql.includes(`FROM ${NAMESPACE}.client_mail_maps WHERE company_id = $1 AND id = $2`)) return data.client_mail_maps.filter((r) => r.id === params[1]);
      return [];
    },
    async execute(sql: string, params: unknown[] = []) {
      validateRuntimeExecute(sql, NAMESPACE);
      validateParams(sql, params);
      executed.push({ sql, params });
      if (sql.includes(`INSERT INTO ${NAMESPACE}.domain_checks`)) {
        const [company_id, domain, status, result, source, client_kind, client_ref, checked_at, first_checked_at, status_since, dmarc_none_since] = params;
        data.domain_checks = data.domain_checks.filter((r) => r.domain !== domain);
        data.domain_checks.push({ company_id, domain, status, result: JSON.parse(String(result)), source, client_kind, client_ref, checked_at, first_checked_at, status_since, dmarc_none_since });
      }
      if (sql.includes(`INSERT INTO ${NAMESPACE}.client_mail_maps`)) {
        const [id, company_id, match_type, pattern, client_kind, client_ref, client_name, note, created_by] = params;
        data.client_mail_maps.push({ id, company_id, match_type, pattern, client_kind, client_ref, client_name, note, created_by, created_at: new Date().toISOString() });
      }
      return { rowCount: 1 };
    },
  };
  (harness.ctx as unknown as { db: typeof db }).db = db;
  const doh = dohFetchFrom(records);
  (harness.ctx as unknown as { http: unknown }).http = { fetch: doh.fetch };
  await plugin.definition.setup(harness.ctx);
  const run = <T = Record<string, any>>(name: string, params: Record<string, unknown>, agentId = "agent-am") => harness.executeTool<{ data?: T; error?: string; content?: string }>(name, params, { agentId, companyId: CO });
  return { harness, run, data, executed, doh };
}

const account = (address: string, over: Row = {}): Row => ({ id: "acc-1", company_id: CO, provider: "gmail", address, status: "connected", token_sealed: "sealed", is_default: true, client_kind: null, client_ref: null, from_name: null, connected_at: "2026-09-26T08:00:00.000Z", created_at: "2026-09-26T08:00:00.000Z", ...over });

describe("check-sender-domain", () => {
  it("reads a new client's domain through the host's guarded fetch, keeps it, and returns the exact records to add", async () => {
    const { run, data, executed, doh } = await boot({ "MX newclient.co.za": ["1 smtp.google.com."] });
    const result = await run("check-sender-domain", { domain: "NewClient.co.za", clientKind: "company", clientRef: "crm-1" });
    expect(result.error).toBeUndefined();
    expect(result.content).toBe("newclient.co.za: bad");
    expect(result.data).toMatchObject({ domain: "newclient.co.za", applicable: true, status: "bad", healthy: false, sendReady: false, watched: true, mx: { state: "ok", provider: "google" } });
    expect(result.data!.problems.map((p: { code: string }) => p.code)).toEqual(["spf_missing", "dkim_missing", "dmarc_missing"]);
    expect(result.data!.onboarding.records.map((r: { type: string; host: string }) => `${r.type} ${r.host}`)).toEqual(["TXT @", "TXT _dmarc"]);
    expect(result.data!.onboarding.steps.at(-1)).toMatch(/run check-sender-domain again/);
    expect(doh.urls.every((url) => url.startsWith("https://dns.google/resolve?name="))).toBe(true);
    // Watched from now on, with the client it belongs to; the daily job picks it up.
    expect(data.domain_checks).toEqual([expect.objectContaining({ domain: "newclient.co.za", source: "manual", client_kind: "company", client_ref: "crm-1", status: "bad" })]);
    expect(executed.some((e) => e.sql.includes(`INSERT INTO ${NAMESPACE}.domain_checks`))).toBe(true);
  });

  it("checks the live partnersinbiz.online before and after the owner adds SPF, using the stored account domain and its sending date", async () => {
    const before = await boot(PIB_DNS_BEFORE, { accounts: [account("peet@partnersinbiz.online")] });
    const bad = await before.run("check-sender-domain", { address: "peet@partnersinbiz.online" });
    expect(bad.data).toMatchObject({ status: "bad", sendReady: false, dkim: { state: "ok", found: ["default", "resend"] }, dmarc: { state: "monitor", policy: "none" } });
    expect(bad.data!.problems.map((p: { code: string }) => p.code)).toContain("spf_missing");
    expect(before.data.domain_checks[0]).toMatchObject({ source: "account", dmarc_none_since: expect.any(String) });
    const after = await boot(PIB_DNS_AFTER, { accounts: [account("peet@partnersinbiz.online", { connected_at: new Date().toISOString() })] });
    const ok = await after.run("check-sender-domain", { domain: "partnersinbiz.online" });
    expect(ok.data).toMatchObject({ status: "healthy", healthy: true, sendReady: true, spf: { authorisesGoogle: true, lookups: 4 } });
    expect(ok.data!.onboarding.alreadyDone).toEqual(expect.arrayContaining(["SPF record"]));
  });

  it("a free-mail domain needs no check and costs no lookup; bad input is an error; watch false looks without keeping", async () => {
    const { run, data, doh } = await boot({ "MX x.co.za": ["1 a.example.net."], "TXT google._domainkey.x.co.za": [DKIM_KEY] });
    expect((await run("check-sender-domain", { address: "someone@gmail.com" })).data).toMatchObject({ applicable: false, status: "unknown", note: expect.stringMatching(/free mail service/) });
    expect(doh.urls).toHaveLength(0);
    expect((await run("check-sender-domain", {})).error).toBe("domain is required, e.g. client.co.za");
    expect((await run("check-sender-domain", { domain: "x.co.za", watch: false })).data).toMatchObject({ domain: "x.co.za", watched: false });
    expect(data.domain_checks).toEqual([]);
  });

  it("refuses to watch more than 25 domains on purpose, but still re-checks one it already watches", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ company_id: CO, domain: `d${i}.co.za`, status: "unknown", result: {}, source: "manual", client_kind: null, client_ref: null, checked_at: "2026-10-01T00:00:00.000Z", first_checked_at: "2026-10-01T00:00:00.000Z", status_since: "2026-10-01T00:00:00.000Z", dmarc_none_since: null }));
    const { run } = await boot({}, { domain_checks: rows });
    expect((await run("check-sender-domain", { domain: "new.co.za" })).error).toMatch(/25 domains are already watched/);
    expect((await run("check-sender-domain", { domain: "d3.co.za" })).error).toBeUndefined();
  });

  it("extra DKIM selectors from the caller are tried on top of the usual ones", async () => {
    const { run, doh } = await boot({ "TXT brevo._domainkey.x.co.za": [DKIM_KEY] });
    const result = await run("check-sender-domain", { domain: "x.co.za", selectors: "brevo, Mailer-1; evil$selector, -bad" });
    expect(result.data!.dkim).toEqual({ state: "ok", found: ["brevo"] });
    const names = doh.urls.map((u) => new URL(u).searchParams.get("name"));
    expect(names).toEqual(expect.arrayContaining(["google._domainkey.x.co.za", "brevo._domainkey.x.co.za", "mailer-1._domainkey.x.co.za"]));
    expect(names.some((n) => n?.startsWith("evil") || n?.startsWith("-"))).toBe(false);
  });
});

describe("sender-domain-health", () => {
  it("answers from the last stored check with no DNS lookup, and says so for a domain nobody checked", async () => {
    const stored = { company_id: CO, domain: "ahslaw.co.za", status: "warn", source: "account", client_kind: "company", client_ref: "crm-ahs", checked_at: new Date().toISOString(), first_checked_at: new Date().toISOString(), status_since: new Date().toISOString(), dmarc_none_since: null, result: { sendReady: true, problems: [{ code: "dmarc_none_aged", severity: "warn", message: "DMARC has been p=none for 31 days.", fix: "Raise it." }] } };
    const { run, doh } = await boot({}, { domain_checks: [stored] });
    const all = await run("sender-domain-health", {});
    expect(all.data!.domains).toEqual([expect.objectContaining({ domain: "ahslaw.co.za", known: true, status: "warn", healthy: false, sendReady: true, reasons: ["DMARC has been p=none for 31 days."], stale: false })]);
    expect(all.data!.note).toMatch(/blocks nothing/);
    expect((await run("sender-domain-health", { domain: "AHSLAW.co.za" })).data!.domains).toHaveLength(1);
    expect((await run("sender-domain-health", { domain: "unknown.co.za" })).data!.domains).toEqual([expect.objectContaining({ domain: "unknown.co.za", known: false, healthy: false, stale: true })]);
    expect(doh.urls).toHaveLength(0);
  });
});

describe("the client mail tools", () => {
  const ahs = { id: "crm-ahs", name: "AHS Law", domain: "ahslaw.co.za" };

  it("map-client-mail checks the client exists, stores the rule and tells the agent how to undo it", async () => {
    const { run, data, executed } = await boot({}, { accounts: [account("peet@partnersinbiz.online")], crm_companies: [ahs] });
    const added = await run("map-client-mail", { matchType: "sender_domain", pattern: "WWW.AHSLaw.co.za", clientKind: "company", clientRef: "crm-ahs", note: "Website form" });
    expect(added.error).toBeUndefined();
    expect(added.content).toBe("Mapped sender domain ahslaw.co.za to AHS Law");
    expect(data.client_mail_maps).toEqual([expect.objectContaining({ match_type: "sender_domain", pattern: "ahslaw.co.za", client_ref: "crm-ahs", client_name: "AHS Law", created_by: "agent:agent-am" })]);
    expect(executed.some((e) => e.sql.includes(`INSERT INTO ${NAMESPACE}.client_mail_maps`))).toBe(true);
    expect((await run("map-client-mail", { matchType: "sender_domain", pattern: "x.co.za", clientKind: "company", clientRef: "crm-made-up" })).error).toMatch(/The CRM has no company crm-made-up/);
    expect((await run("map-client-mail", { matchType: "sender_domain", pattern: "partnersinbiz.online", clientKind: "company", clientRef: "crm-ahs" })).error).toMatch(/the company's own domain/);
    expect((await run("map-client-mail", { matchType: "nonsense", pattern: "x.co.za", clientKind: "company", clientRef: "crm-ahs" })).error).toMatch(/matchType must be one of/);
    const list = await run("list-client-mail-maps", {});
    expect(list.data!.maps).toEqual([expect.objectContaining({ pattern: "ahslaw.co.za", clientName: "AHS Law" })]);
    expect(list.content).toBe("1 mapping(s); 0 sender domain(s) of unmapped client-looking mail");
    const removed = await run("remove-client-mail-map", { mapId: data.client_mail_maps[0]!.id });
    expect(removed.data).toEqual({ removed: true });
    expect(executed.some((e) => e.sql.includes(`DELETE FROM ${NAMESPACE}.client_mail_maps`))).toBe(true);
  });
});
