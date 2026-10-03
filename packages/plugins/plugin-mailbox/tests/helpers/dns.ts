import type { DnsAnswer, DnsResolver, DnsResult, DnsType } from "../../src/dns.js";

/**
 * A DNS stand-in: records by `TYPE name` (`TXT example.com`, `MX example.com`).
 * A name with no record answers NXDOMAIN (a real "missing"); a name in `down`
 * cannot be read at all (`ok: false`, like a resolver that did not answer).
 */
export function fakeDns(records: Record<string, string[]>, options: { down?: string[]; cnames?: Record<string, string> } = {}): DnsResolver & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async query(name: string, type: DnsType): Promise<DnsResult> {
      const host = name.toLowerCase();
      queries.push(`${type} ${host}`);
      if ((options.down ?? []).some((entry) => entry === host || entry === `${type} ${host}`)) return { ok: false, rcode: null, answers: [], cnames: [], error: "resolver did not answer" };
      const rows = records[`${type} ${host}`] ?? [];
      const answers: DnsAnswer[] = rows.map((data) => ({ type, name: host, data }));
      const cname = options.cnames?.[host];
      return { ok: true, rcode: rows.length || cname ? 0 : 3, answers, cnames: cname ? [cname] : [] };
    },
  };
}

/** The live partnersinbiz.online DNS on 2026-10-03: no SPF, DMARC p=none with no report address, DKIM at default and resend, none at google, one legacy Google MX. */
export const PIB_DNS_BEFORE: Record<string, string[]> = {
  "TXT partnersinbiz.online": ["google-site-verification=cV9Xqoax9mYtrqZo0Izxje9q-8TiG20nQMOpa0GV_9Q", "tiktok-developers-site-verification=rQeSqbnYB7P9yOElBW5NwH206YD4jYlE"],
  "TXT _dmarc.partnersinbiz.online": ["v=DMARC1; p=none;"],
  "TXT default._domainkey.partnersinbiz.online": ["v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6OkPDFJlHezVQRZVEru5cLavwooQ++QjRXZfpxCM7wQR9Yn6E0/mqGhvp4t9YgI3Z6ZElKITW1LTCOjbsx6epazXvRcRExUQf7SMQ8ItvI5OLiiTwY1N+nBw/MhxCHfVVey3MTBh4bNTn6kaNQk84Tn0pHIfDCRyfQPbUUncLTlhYD7H3Zp5aQpjMr5wrCDtWQ6EHaYR0tMcBYhPzRGZ6BPpGv+BBgiw5wLxqAkOeDansnJJMBiVpa3cs36eTP8z24CunD7UJhQ4ZL0JWclGbO9CekGjVJfkXimi9pq82Fa9AiT9N631D3AX5e8N2piLkDTZ7O+tHh3Ai2tPJGVK3QIDAQAB"],
  "TXT resend._domainkey.partnersinbiz.online": ["p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDbgXucCFadiSSjgqUpns3YSnF15G6VUXcN1FEIet8g+fyARgyiyHQSVPAyX1x4Z5wH9dYfggE8kWF7kufF3I7UPo4+gC04FXzzXzodhXRCywyH2/symmTZwiWaNfrZ6qzMBAL2qxUI3ItR/lmnNXyVratS8JMyOW0K9oddm3LrwQIDAQAB"],
  "MX partnersinbiz.online": ["1 smtp.google.com."],
};

/** The same domain after an owner adds the SPF record and a DMARC reporting address. */
export const PIB_DNS_AFTER: Record<string, string[]> = {
  ...PIB_DNS_BEFORE,
  "TXT partnersinbiz.online": [...PIB_DNS_BEFORE["TXT partnersinbiz.online"]!, "v=spf1 include:_spf.google.com ~all"],
  "TXT _dmarc.partnersinbiz.online": ["v=DMARC1; p=none; rua=mailto:dmarc@partnersinbiz.online"],
  "TXT _spf.google.com": ["v=spf1 include:_netblocks.google.com include:_netblocks2.google.com include:_netblocks3.google.com ~all"],
  "TXT _netblocks.google.com": ["v=spf1 ip4:35.190.247.0/24 ip4:64.233.160.0/19 ~all"],
  "TXT _netblocks2.google.com": ["v=spf1 ip6:2001:4860:4000::/36 ~all"],
  "TXT _netblocks3.google.com": ["v=spf1 ip4:172.217.0.0/19 ~all"],
};

/** The host's `ctx.http.fetch` answering the public DoH JSON API from a records table (Google's shape). */
export function dohFetchFrom(records: Record<string, string[]>) {
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    const parsed = new URL(url);
    const name = (parsed.searchParams.get("name") ?? "").toLowerCase();
    const type = parsed.searchParams.get("type") ?? "TXT";
    const rows = records[`${type} ${name}`] ?? [];
    const code = type === "MX" ? 15 : type === "CNAME" ? 5 : 16;
    const body = rows.length ? { Status: 0, Answer: rows.map((data) => ({ name: `${name}.`, type: code, TTL: 300, data })) } : { Status: 3 };
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  };
  return { fetch, urls };
}
