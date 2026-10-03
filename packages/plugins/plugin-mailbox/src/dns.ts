/**
 * DNS over HTTPS for the sender domain checks. The Mailbox has the
 * `http.outbound` capability, so it asks a public resolver (Google, then
 * Cloudflare) through the host's guarded `ctx.http.fetch`. Nothing here writes
 * DNS: records are added by a person at the domain's DNS provider.
 *
 * A failed lookup is never read as "the record is missing". `query` returns
 * `ok: false` with the reason, and the checks above it report `unreadable`
 * with the manual `dig` commands instead of raising a false alarm.
 */

export type DnsType = "TXT" | "MX" | "CNAME";

const TYPE_CODE: Record<DnsType, number> = { TXT: 16, MX: 15, CNAME: 5 };

export interface DnsAnswer {
  type: DnsType;
  name: string;
  /** TXT: the text with its chunks joined and no quotes. MX: `10 mail.example.com`. CNAME: the target. */
  data: string;
}

export interface DnsResult {
  /** The resolver gave an answer (even "no such record"). False: it could not be asked or did not answer. */
  ok: boolean;
  /** DNS response code: 0 NOERROR (an empty answer is "no record of that type"), 3 NXDOMAIN. */
  rcode: number | null;
  answers: DnsAnswer[];
  /** CNAME targets the name pointed through on the way to the answer (a DKIM key hosted by a provider is often one). */
  cnames: string[];
  /** Why it could not be read, when `ok` is false. */
  error?: string;
}

export interface DnsResolver {
  query(name: string, type: DnsType): Promise<DnsResult>;
}

/** The part of fetch the resolver needs (the host's `ctx.http.fetch` or a test double). */
export type DohFetch = (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export const DOH_ENDPOINTS: ReadonlyArray<{ name: string; url: string }> = [
  { name: "dns.google", url: "https://dns.google/resolve" },
  { name: "cloudflare-dns.com", url: "https://cloudflare-dns.com/dns-query" },
];

/** TXT data as the resolver returns it: Google joins the chunks, Cloudflare quotes each ("a" "b"). Both come back as one string. */
export function txtText(data: string): string {
  const trimmed = data.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  const chunks = [...trimmed.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\(.)/g, "$1"));
  return chunks.length ? chunks.join("") : trimmed;
}

function rowsOf(body: unknown, type: DnsType): DnsAnswer[] {
  const answers = body && typeof body === "object" ? (body as { Answer?: unknown }).Answer : null;
  if (!Array.isArray(answers)) return [];
  const out: DnsAnswer[] = [];
  for (const row of answers as Array<Record<string, unknown>>) {
    if (row?.type !== TYPE_CODE[type] || typeof row.data !== "string") continue;
    out.push({ type, name: String(row.name ?? "").replace(/\.$/, "").toLowerCase(), data: type === "TXT" ? txtText(row.data) : row.data.trim() });
  }
  return out;
}

/** One lookup gets this long per resolver before the next one is tried. */
export const DOH_TIMEOUT_MS = 8_000;
/** Lookups in a row that all failed, with none ever answered, before the resolver stops asking (a tool call must not wait on a dead network). */
const GIVE_UP_AFTER = 4;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * A resolver over the public DoH JSON APIs; tries the next endpoint when one cannot be reached, times out or says SERVFAIL.
 * One instance is for one check: after four lookups in a row that all failed with no answer at all, it stops asking.
 */
export function dohResolver(fetchImpl: DohFetch, endpoints: ReadonlyArray<{ name: string; url: string }> = DOH_ENDPOINTS, options: { timeoutMs?: number } = {}): DnsResolver {
  let answered = 0;
  let failedInARow = 0;
  const timeoutMs = options.timeoutMs ?? DOH_TIMEOUT_MS;
  return {
    async query(name, type) {
      const host = name.trim().toLowerCase().replace(/\.$/, "");
      if (!/^[a-z0-9_]([a-z0-9_.-]*[a-z0-9_])?$/.test(host) || host.length > 253) return { ok: false, rcode: null, answers: [], cnames: [], error: `"${name}" is not a valid DNS name` };
      if (answered === 0 && failedInARow >= GIVE_UP_AFTER) return { ok: false, rcode: null, answers: [], cnames: [], error: "the public DNS resolvers could not be reached" };
      const problems: string[] = [];
      for (const endpoint of endpoints) {
        try {
          const res = await withTimeout(fetchImpl(`${endpoint.url}?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: "application/dns-json" } }), timeoutMs);
          if (!res.ok) {
            problems.push(`${endpoint.name} answered HTTP ${res.status}`);
            continue;
          }
          const body = JSON.parse(await withTimeout(res.text(), timeoutMs)) as { Status?: unknown };
          const rcode = typeof body.Status === "number" ? body.Status : null;
          // SERVFAIL and friends say nothing about the record: ask the other resolver.
          if (rcode === null || (rcode !== 0 && rcode !== 3)) {
            problems.push(`${endpoint.name} answered DNS status ${rcode ?? "unknown"}`);
            continue;
          }
          answered += 1;
          failedInARow = 0;
          return { ok: true, rcode, answers: rowsOf(body, type), cnames: type === "CNAME" ? [] : rowsOf(body, "CNAME").map((row) => row.data.replace(/\.$/, "")) };
        } catch (error) {
          problems.push(`${endpoint.name}: ${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`);
        }
      }
      failedInARow += 1;
      return { ok: false, rcode: null, answers: [], cnames: [], error: problems.join("; ") || "no resolver answered" };
    },
  };
}

/** Public suffixes with two labels that the organisational-domain guess must keep together (an incomplete list: a heuristic, not the Public Suffix List). */
const TWO_LABEL_SUFFIXES = new Set([
  "co.za", "org.za", "net.za", "ac.za", "gov.za", "web.za",
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk",
  "com.au", "net.au", "org.au", "co.nz", "org.nz",
  "co.ke", "co.zw", "co.zm", "co.bw", "com.na", "com.ng", "com.gh",
  "com.br", "com.mx", "co.in", "co.jp", "com.sg",
]);

/** The registrable domain of a host: `mail.client.co.za` → `client.co.za`. DMARC falls back to it for a subdomain without its own policy. */
export function organizationalDomain(domain: string): string {
  const labels = domain.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  return labels.slice(TWO_LABEL_SUFFIXES.has(lastTwo) ? -3 : -2).join(".");
}

/** A normalised sending domain from an address or a host, or null. */
export function sendingDomain(value: string | null | undefined): string | null {
  const text = (value ?? "").trim().toLowerCase();
  if (!text) return null;
  const host = text.includes("@") ? text.slice(text.lastIndexOf("@") + 1) : text.replace(/^https?:\/\//, "").split(/[/?#]/)[0]!;
  const clean = host.replace(/^www\./, "").replace(/\.$/, "");
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(clean) && clean.length <= 253 ? clean : null;
}

/** `dig` commands a person can run when the checks could not read DNS (the manual route). */
export function digCommands(domain: string, selectors: string[]): string[] {
  return [
    `dig +short TXT ${domain}`,
    `dig +short MX ${domain}`,
    `dig +short TXT _dmarc.${domain}`,
    ...selectors.slice(0, 4).map((selector) => `dig +short TXT ${selector}._domainkey.${domain}`),
  ];
}
