/**
 * Sender domain health (Q10-7 and the critic's "outbound email authentication"
 * finding): does each domain the company sends from have SPF, a DKIM key,
 * DMARC and an MX?
 *
 * The live case that started it: partnersinbiz.online had no SPF record, DMARC
 * `p=none` with no report address, a DKIM key at `default` and `resend` but none
 * at `google`, and the first 12 outbound sends already produced a hard bounce.
 * Nothing checked it, and every client domain needs the same set-up.
 *
 * What this does:
 * - `checkDomain` reads MX, SPF (with the include tree, to count the 10 DNS
 *   lookups SPF allows), DKIM at the usual selectors and DMARC (falling back to
 *   the organisational domain) through DNS over HTTPS (`dns.ts`).
 * - `evaluateDomain` turns that into problems with a fix each, and one status:
 *   `bad` (no SPF, more than one SPF, no DKIM key, no MX), `warn` (DMARC missing
 *   or still `p=none` after 30 days, SPF that does not authorise Google, unreadable
 *   DNS) or `healthy`. DMARC `p=none` is the right first step, so it only counts
 *   as a problem once the domain has been sending for 30 days.
 * - `runDomainChecks` runs it for every sending domain of a company (the domains
 *   of its mailboxes plus domains a person or agent asked to watch), stores the
 *   result (`domain_checks`) and announces it (`mail.domain.health`).
 * - `senderDomainHealth` is the predicate other modules use: is this sender
 *   domain healthy? It blocks nothing by itself: the Mailbox still sends, and
 *   the caller decides (Campaigns refuses to launch from an unhealthy domain).
 * - `onboardingGuide` is the text for a new client domain: the exact records to
 *   add, in order, and what the agent does after.
 *
 * Nothing here edits DNS. A failed lookup is `unreadable`, never "missing".
 *
 * A domain registered at the email provider (0.6.0) is judged on what the provider needs, not on what Gmail needs:
 * its SPF is at the provider's return-path host (`send.<domain>`, an MX and a TXT), its DKIM key at the provider's
 * selector (`resend._domainkey.<domain>`), and DMARC is read as usual. A domain with no Gmail mailbox is not asked for
 * an MX or an SPF record of its own. The last 7 days of what the domain sent and what bounced or drew complaints are
 * merged into the stored report as problems (`esp_bounce_rate`, `esp_complaint_rate`, which hold marketing back), so
 * the Cockpit, `mail.domain.health` and the Mailbox's own sender check read one answer.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { type HealthCheck } from "@partnersinbiz/pib-plugin-kit";
import { digCommands, dohResolver, organizationalDomain, sendingDomain, type DnsResolver } from "./dns.js";
import type { GmailStore } from "./db.js";
import { errorMessage } from "./gmail/env.js";
import { isFreeMailDomain } from "./free-mail.js";
import type { AccountRow, DomainCheckRow, DomainStatus } from "./gmail/types.js";
import { isEspProvider, type ProviderDomainStatus } from "./esp/types.js";
import { clearanceOf, REPUTATION_WINDOW_DAYS, reputationOf, utcDay, DAY_MS, type ReputationReport } from "./esp/warmup.js";

export const DOMAIN_HEALTH_EVENT = "mail.domain.health";
/** DMARC `p=none` is a monitoring step; after this many days of sending it is a warning. */
export const DMARC_NONE_GRACE_DAYS = 30;
/** A stored check older than this is stale: the predicate says so. */
export const DOMAIN_CHECK_STALE_HOURS = 48;
/** The DKIM selectors tried when none is given. `google` is Google Workspace; the rest are common providers. */
export const DEFAULT_DKIM_SELECTORS = ["google", "default", "selector1", "selector2", "resend", "k1", "s1", "s2", "mail", "dkim", "smtp"] as const;

const SPF_QUERY_BUDGET = 12;
const SPF_LOOKUP_LIMIT = 10;
const GOOGLE_SPF = "_spf.google.com";

export type Severity = "bad" | "warn" | "info";

export interface DomainProblem {
  code: string;
  severity: Severity;
  message: string;
  /** What to do, one or two sentences. */
  fix: string;
  /** Set on a problem that holds MARKETING back from this domain (a bad reputation); the others, when `bad`, hold every send back. */
  blocks?: "marketing";
}

export interface MxReport {
  state: "ok" | "missing" | "unreadable";
  hosts: string[];
  provider: "google" | "microsoft" | "other" | null;
}

export interface SpfReport {
  state: "ok" | "missing" | "multiple" | "unreadable";
  record: string | null;
  all: "-all" | "~all" | "?all" | "+all" | "none" | null;
  /** Terms that cost a DNS lookup (SPF allows 10), counted through the include tree. */
  lookups: number;
  /** The tree was too big to read in full: `lookups` is a lower bound. */
  lookupsApprox: boolean;
  includes: string[];
  authorisesGoogle: boolean;
}

export interface DkimSelectorReport {
  selector: string;
  state: "found" | "revoked" | "cname" | "missing" | "unreadable";
  /** Approximate RSA key size from the public key length. */
  keyBits: number | null;
  cname?: string;
}

export interface DkimReport {
  state: "ok" | "missing" | "unreadable";
  found: string[];
  selectors: DkimSelectorReport[];
}

export interface DmarcReport {
  state: "enforced" | "monitor" | "missing" | "unreadable";
  record: string | null;
  policy: string | null;
  subdomainPolicy: string | null;
  pct: number | null;
  rua: string[];
  /** The organisational domain the policy came from, when the subdomain has none of its own. */
  inheritedFrom: string | null;
}

/** What the email provider needs of a domain, read from DNS. */
export interface EspReport {
  /** The provider's key (`resend`, `ses`). Reports stored before 0.7.0 have none: they are Resend's. */
  provider?: string;
  providerStatus: ProviderDomainStatus;
  /** The return-path host the provider's SPF and MX records are at. null (SES without a custom MAIL FROM): there is none to read. */
  returnPathHost: string | null;
  spf: SpfReport;
  /** The provider's include is in the SPF record. */
  spfAuthorisesProvider: boolean;
  mx: MxReport;
  dkim: DkimReport;
  selector: string;
}

/** What `checkDomain` needs to know about a provider domain. */
export interface EspCheck {
  /** The provider the domain row belongs to; default `resend`. */
  provider?: string | null;
  returnPathHost: string | null;
  dkimSelector: string | null;
  spfInclude: string | null;
  providerStatus: ProviderDomainStatus;
}

export interface DomainReport {
  domain: string;
  checkedAt: string;
  mx: MxReport;
  spf: SpfReport;
  dkim: DkimReport;
  dmarc: DmarcReport;
  status: DomainStatus;
  /** SPF ok, a DKIM key found and a DMARC record present: the domain can send marketing mail with a fair chance of the inbox. */
  sendReady: boolean;
  problems: DomainProblem[];
  /** A DNS lookup could not be read, so part of this report is "unknown", not "missing". */
  unreadable: boolean;
  /** `dig` commands to run by hand when part of the DNS could not be read. */
  manual: string[];
  /** Present for a domain registered at the email provider. */
  esp?: EspReport | null;
  /** True for a domain only the email provider sends from (no Gmail mailbox on it): the whole report is about provider sending. */
  espOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function tagsOf(record: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const part of record.split(";")) {
    const at = part.indexOf("=");
    if (at < 1) continue;
    const name = part.slice(0, at).trim().toLowerCase();
    if (name && !tags.has(name)) tags.set(name, part.slice(at + 1).trim());
  }
  return tags;
}

/** Approximate RSA key size from a DKIM `p=` value (the base64 of the public key). */
export function dkimKeyBits(publicKey: string): number | null {
  const clean = publicKey.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(clean) || clean.length < 40) return null;
  const bytes = Math.floor((clean.length * 3) / 4);
  return bytes < 200 ? 1024 : bytes < 400 ? 2048 : 4096;
}

function mxProvider(hosts: string[]): MxReport["provider"] {
  if (hosts.length === 0) return null;
  const names = hosts.map((host) => host.toLowerCase().replace(/\.$/, ""));
  if (names.some((name) => /(^|\.)(google|googlemail)\.com$/.test(name))) return "google";
  if (names.some((name) => /\.mail\.protection\.outlook\.com$|(^|\.)outlook\.com$/.test(name))) return "microsoft";
  return "other";
}

async function readMx(resolver: DnsResolver, domain: string): Promise<MxReport> {
  const result = await resolver.query(domain, "MX");
  if (!result.ok) return { state: "unreadable", hosts: [], provider: null };
  const hosts = result.answers
    .map((answer) => answer.data.trim().split(/\s+/).pop() ?? "")
    .map((host) => host.replace(/\.$/, "").toLowerCase())
    .filter((host) => host && host !== ".");
  // A null MX (RFC 7505) is one "." host: the domain says it takes no mail.
  return hosts.length === 0 ? { state: "missing", hosts: [], provider: null } : { state: "ok", hosts, provider: mxProvider(hosts) };
}

function spfRecords(texts: string[]): string[] {
  return texts.filter((text) => /^v=spf1(\s|$)/i.test(text.trim()));
}

interface SpfWalk {
  queries: number;
  lookups: number;
  approx: boolean;
  includes: string[];
  seen: Set<string>;
  failed: boolean;
}

async function walkSpf(resolver: DnsResolver, record: string, walk: SpfWalk, depth: number): Promise<void> {
  for (const raw of record.trim().split(/\s+/).slice(1)) {
    const term = raw.replace(/^[+\-~?]/, "");
    const name = term.split(/[:=/]/)[0]!.toLowerCase();
    if (name === "include" || name === "redirect") {
      walk.lookups += 1;
      const target = term.split(/[:=]/)[1]?.toLowerCase().replace(/\.$/, "");
      if (!target) continue;
      walk.includes.push(target);
      if (walk.seen.has(target)) continue;
      walk.seen.add(target);
      if (depth >= 5 || walk.queries >= SPF_QUERY_BUDGET) {
        walk.approx = true;
        continue;
      }
      walk.queries += 1;
      const result = await resolver.query(target, "TXT");
      if (!result.ok) {
        walk.failed = true;
        continue;
      }
      const nested = spfRecords(result.answers.map((answer) => answer.data))[0];
      if (nested) await walkSpf(resolver, nested, walk, depth + 1);
    } else if (name === "a" || name === "mx" || name === "ptr" || name === "exists") {
      walk.lookups += 1;
    }
  }
}

async function readSpf(resolver: DnsResolver, domain: string): Promise<SpfReport> {
  const result = await resolver.query(domain, "TXT");
  const empty: SpfReport = { state: "missing", record: null, all: null, lookups: 0, lookupsApprox: false, includes: [], authorisesGoogle: false };
  if (!result.ok) return { ...empty, state: "unreadable" };
  const records = spfRecords(result.answers.map((answer) => answer.data));
  if (records.length === 0) return empty;
  const record = records[0]!.trim();
  const walk: SpfWalk = { queries: 0, lookups: 0, approx: false, includes: [], seen: new Set(), failed: false };
  await walkSpf(resolver, record, walk, 0);
  const all = /(?:^|\s)([+\-~?]?)all(?:\s|$)/i.exec(record);
  const qualifier = all ? (all[1] || "+") : null;
  return {
    state: records.length > 1 ? "multiple" : "ok",
    record,
    all: qualifier ? (`${qualifier}all` as SpfReport["all"]) : "none",
    lookups: walk.lookups,
    lookupsApprox: walk.approx || walk.failed,
    includes: [...new Set(walk.includes)],
    authorisesGoogle: walk.includes.some((target) => target === GOOGLE_SPF),
  };
}

async function readDkim(resolver: DnsResolver, domain: string, selectors: string[]): Promise<DkimReport> {
  const reports: DkimSelectorReport[] = [];
  let next = 0;
  const worker = async () => {
    while (next < selectors.length) {
      const index = next++;
      const selector = selectors[index]!;
      const result = await resolver.query(`${selector}._domainkey.${domain}`, "TXT");
      if (!result.ok) {
        reports[index] = { selector, state: "unreadable", keyBits: null };
        continue;
      }
      const keyRecord = result.answers.map((answer) => answer.data).find((text) => /(^|;)\s*p=/i.test(text) || /^v=DKIM1/i.test(text));
      if (keyRecord) {
        const key = tagsOf(keyRecord).get("p") ?? "";
        reports[index] = key ? { selector, state: "found", keyBits: dkimKeyBits(key), ...(result.cnames[0] ? { cname: result.cnames[0] } : {}) } : { selector, state: "revoked", keyBits: null };
      } else if (result.cnames.length > 0) {
        reports[index] = { selector, state: "cname", keyBits: null, cname: result.cnames[0] };
      } else {
        reports[index] = { selector, state: "missing", keyBits: null };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, selectors.length) }, worker));
  const found = reports.filter((report) => report.state === "found").map((report) => report.selector);
  // Nothing found is "missing" only when every selector was actually answered: one that could not be read may be the very key.
  const unreadable = reports.some((report) => report.state === "unreadable");
  return { state: found.length > 0 ? "ok" : unreadable ? "unreadable" : "missing", found, selectors: reports };
}

function dmarcFrom(texts: string[], inheritedFrom: string | null): DmarcReport {
  const records = texts.filter((text) => /^v=DMARC1\b/i.test(text.trim()));
  const record = records[0]?.trim() ?? null;
  if (!record) return { state: "missing", record: null, policy: null, subdomainPolicy: null, pct: null, rua: [], inheritedFrom: null };
  const tags = tagsOf(record);
  const pct = tags.has("pct") ? Number(tags.get("pct")) : null;
  const rua = (tags.get("rua") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  // Without a p tag a record that names a report address counts as p=none (RFC 7489 6.6.3); one with neither is ignored by receivers.
  const policy = (tags.get("p") ?? "").toLowerCase() || (rua.length > 0 ? "none" : null);
  if (!policy) return { state: "missing", record: null, policy: null, subdomainPolicy: null, pct: null, rua: [], inheritedFrom: null };
  return {
    state: policy === "quarantine" || policy === "reject" ? "enforced" : "monitor",
    record,
    policy,
    subdomainPolicy: (tags.get("sp") ?? "").toLowerCase() || null,
    pct: pct !== null && Number.isFinite(pct) ? pct : null,
    rua,
    inheritedFrom,
  };
}

async function readDmarc(resolver: DnsResolver, domain: string): Promise<DmarcReport> {
  const own = await resolver.query(`_dmarc.${domain}`, "TXT");
  if (!own.ok) return { state: "unreadable", record: null, policy: null, subdomainPolicy: null, pct: null, rua: [], inheritedFrom: null };
  const found = dmarcFrom(own.answers.map((answer) => answer.data), null);
  if (found.state !== "missing") return found;
  const org = organizationalDomain(domain);
  if (org === domain) return found;
  const parent = await resolver.query(`_dmarc.${org}`, "TXT");
  // A domain with no DMARC of its own inherits its organisational domain's: when that cannot be read, "missing" would be a guess.
  return parent.ok ? dmarcFrom(parent.answers.map((answer) => answer.data), org) : { ...found, state: "unreadable" };
}

export interface CheckOptions {
  /** The domain is registered at the email provider: judge it on the provider's records. */
  esp?: EspCheck | null;
  /** The last 7 days of what the domain sent (merged in as problems). */
  reputation?: ReputationReport | null;
  selectors?: string[];
  now?: number;
  /** Whether a mailbox receives mail at this domain (a missing MX is then bad, not only a warning). */
  hasMailbox?: boolean;
  /** Gmail sends for this domain: its SPF should authorise Google. */
  gmail?: boolean;
  /** When this domain first looked like p=none to us, and when sending from it began. The older of the two starts the 30 days. */
  dmarcNoneSince?: string | null;
  sendingSince?: string | null;
}

/**
 * SES signs with three CNAMEs (`<token>._domainkey.<domain>` → `<token>.dkim.amazonses.com`). A resolver that does not follow the CNAME
 * returns no TXT, so what the DNS shows says nothing about whether SES signs: SES's own `DkimAttributes.Status` (the provider status) is the
 * truth, and the DNS read of its key is informational only.
 */
const dkimIsInformational = (esp: Pick<EspReport, "provider">): boolean => esp.provider === "ses";

/** Reads the DNS of one domain and judges it. Never throws: a failed lookup is `unreadable`. */
export async function checkDomain(resolver: DnsResolver, domain: string, options: CheckOptions = {}): Promise<DomainReport> {
  const esp = options.esp ?? null;
  const espOnly = esp !== null && options.gmail !== true;
  const espProvider = esp?.provider ?? "resend";
  const espSelector = esp?.dkimSelector ?? (espProvider === "resend" ? "resend" : "default");
  // A domain only the provider sends for has one DKIM selector worth reading; the usual list is for a domain with a mail provider of its own.
  const selectors = espOnly ? [espSelector] : options.selectors?.length ? options.selectors : [...DEFAULT_DKIM_SELECTORS];
  const unreadableSpf = (): SpfReport => ({ state: "unreadable", record: null, all: null, lookups: 0, lookupsApprox: false, includes: [], authorisesGoogle: false });
  // Resend always has a return-path host (`send.<domain>`); SES has one only when a custom MAIL FROM is set.
  const returnPathHost = esp ? esp.returnPathHost ?? (espProvider === "resend" ? `send.${domain}` : null) : null;
  const [mx, spf, dkim, dmarc, espReads] = await Promise.all([
    readMx(resolver, domain).catch((): MxReport => ({ state: "unreadable", hosts: [], provider: null })),
    readSpf(resolver, domain).catch(unreadableSpf),
    readDkim(resolver, domain, selectors).catch((): DkimReport => ({ state: "unreadable", found: [], selectors: [] })),
    readDmarc(resolver, domain).catch((): DmarcReport => ({ state: "unreadable", record: null, policy: null, subdomainPolicy: null, pct: null, rua: [], inheritedFrom: null })),
    esp
      ? Promise.all([
        returnPathHost ? readSpf(resolver, returnPathHost).catch(unreadableSpf) : Promise.resolve(unreadableSpf()),
        returnPathHost ? readMx(resolver, returnPathHost).catch((): MxReport => ({ state: "unreadable", hosts: [], provider: null })) : Promise.resolve<MxReport>({ state: "unreadable", hosts: [], provider: null }),
        espOnly ? Promise.resolve(null) : readDkim(resolver, domain, [espSelector]).catch((): DkimReport => ({ state: "unreadable", found: [], selectors: [] })),
      ])
      : Promise.resolve(null),
  ]);
  const espParts = esp && espReads
    ? {
      provider: espProvider,
      providerStatus: esp.providerStatus,
      returnPathHost,
      spf: espReads[0],
      spfAuthorisesProvider: esp.spfInclude ? espReads[0].includes.includes(esp.spfInclude) : espReads[0].state === "ok",
      mx: espReads[1],
      // When only the provider sends for the domain the one DKIM read above is the provider's.
      dkim: espReads[2] ?? dkim,
      selector: espSelector,
    } satisfies EspReport
    : null;
  return evaluateDomain({ domain, mx, spf, dkim, dmarc, selectors, esp: espParts }, options);
}

// ---------------------------------------------------------------------------
// Judging
// ---------------------------------------------------------------------------

function daysBetween(fromIso: string | null | undefined, now: number): number | null {
  const from = Date.parse(fromIso ?? "");
  return Number.isFinite(from) ? Math.max(0, (now - from) / 86_400_000) : null;
}

/** The older of two moments (ISO), or null. */
function earliest(...values: Array<string | null | undefined>): string | null {
  const times = values.map((value) => Date.parse(value ?? "")).filter((time) => Number.isFinite(time));
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

export function evaluateDomain(parts: { domain: string; mx: MxReport; spf: SpfReport; dkim: DkimReport; dmarc: DmarcReport; selectors: string[]; esp?: EspReport | null }, options: CheckOptions = {}): DomainReport {
  const now = options.now ?? Date.now();
  const { domain, mx, spf, dkim, dmarc } = parts;
  const esp = parts.esp ?? null;
  // Only the email provider sends for this domain: Gmail's records (an MX, SPF with Google, a DKIM key at the usual selectors) are not asked of it.
  const espOnly = esp !== null && options.gmail !== true;
  const problems: DomainProblem[] = [];
  const add = (code: string, severity: Severity, message: string, fix: string, blocks?: "marketing") => problems.push({ code, severity, message, fix, ...(blocks ? { blocks } : {}) });

  if (esp) addEspProblems(esp, domain, add);

  if (espOnly) {
    // nothing of Gmail's is asked of a domain only the provider sends for
  } else if (mx.state === "missing") {
    add("mx_missing", options.hasMailbox ? "bad" : "warn", `${domain} has no MX record, so mail to it (replies, bounces) has nowhere to go.`, `Add the mail provider's MX records at the domain's DNS provider (Google Workspace: ASPMX.L.GOOGLE.COM and its alternates, or the single SMTP.GOOGLE.COM record).`);
  }

  if (espOnly) {
    // the provider's SPF is at its return-path host, judged above
  } else if (spf.state === "missing") {
    add("spf_missing", "bad", `${domain} has no SPF record: receivers cannot tell that Google may send for it, and mail is more likely to land in spam or bounce.`, options.gmail === false ? "Add a TXT record at the domain: v=spf1 include:<your provider> ~all." : "Add a TXT record at the domain (host @): v=spf1 include:_spf.google.com ~all. Keep exactly one SPF record.");
  } else if (spf.state === "multiple") {
    add("spf_multiple", "bad", `${domain} has more than one SPF record. Receivers treat that as an error and ignore all of them.`, "Merge them into one record: one v=spf1 line with every include, ending in ~all or -all.");
  } else if (spf.state === "ok") {
    if (spf.all === "+all") add("spf_plus_all", "bad", "The SPF record ends in +all, which lets anyone send as this domain.", "Change +all to ~all (or -all once every sender is listed).");
    // A record that ends in redirect= takes the other domain's policy: no all-mechanism of its own is right.
    else if (spf.all === "?all" || (spf.all === "none" && !/(?:^|\s)redirect=/i.test(spf.record ?? ""))) add("spf_no_policy", "warn", "The SPF record does not say what to do with other senders (no ~all or -all).", "End the record with ~all (or -all once every sender is listed).");
    if (spf.lookups > SPF_LOOKUP_LIMIT) {
      add("spf_lookups", "bad", `The SPF record needs ${spf.lookupsApprox ? "more than " : ""}${spf.lookups} DNS lookups; SPF allows 10, so receivers fail it.`, "Remove includes you no longer use, or replace some with ip4: ranges.");
    }
    if (options.gmail && !spf.authorisesGoogle) {
      add("spf_not_google", "warn", "Gmail sends for this domain but the SPF record does not include _spf.google.com.", "Add include:_spf.google.com to the existing SPF record (do not add a second one).");
    }
  }

  if (espOnly) {
    // the provider's DKIM key is judged above
  } else if (dkim.state === "missing") {
    add("dkim_missing", "bad", `No DKIM key was found at the usual selectors (${parts.selectors.slice(0, 6).join(", ")}…), so mail from ${domain} is not signed as the domain.`, "Google Workspace: Admin console → Apps → Google Workspace → Gmail → Authenticate email → pick the domain → Generate new record (2048-bit) → add the TXT record it shows → Start authentication. If a provider already signs with another selector, pass it as a selector when you check.");
  } else if (dkim.state === "ok") {
    const weak = dkim.selectors.filter((selector) => selector.state === "found" && selector.keyBits !== null && selector.keyBits < 2048);
    if (weak.length > 0 && weak.length === dkim.found.length) add("dkim_weak_key", "info", `The DKIM key at ${weak.map((s) => s.selector).join(", ")} looks like 1024-bit RSA; 2048-bit is the current recommendation.`, "Generate a 2048-bit key at your provider and publish it at a new selector.");
  }

  const sendingFor = earliest(options.dmarcNoneSince, options.sendingSince);
  const sendingDays = daysBetween(sendingFor, now);
  if (dmarc.state === "missing") {
    const old = (daysBetween(options.sendingSince, now) ?? 0) >= DMARC_NONE_GRACE_DAYS;
    add("dmarc_missing", old ? "bad" : "warn", `${domain} has no DMARC record${old ? ` and has been sending for over ${DMARC_NONE_GRACE_DAYS} days` : ""}: mail that fails SPF and DKIM is not reported or rejected, and Gmail and Yahoo expect one.`, `Add a TXT record at _dmarc.${domain}: v=DMARC1; p=none; rua=mailto:<a mailbox you read>. Raise it to p=quarantine after two weeks of clean reports.`);
  } else if (dmarc.state === "monitor") {
    if (dmarc.policy === "none" && sendingDays !== null && sendingDays >= DMARC_NONE_GRACE_DAYS) {
      add("dmarc_none_aged", "warn", `DMARC has been p=none for ${Math.floor(sendingDays)} days: it reports, but does not stop anyone spoofing ${domain}.`, "If the reports are clean, raise the policy to p=quarantine (then p=reject): edit the _dmarc TXT record.");
    }
    if (dmarc.rua.length === 0) add("dmarc_no_reports", "info", "DMARC has no rua address, so nobody receives the reports that show who sends as this domain.", "Add rua=mailto:<a mailbox you read> to the _dmarc record.");
  } else if (dmarc.state === "enforced" && dmarc.pct !== null && dmarc.pct < 100) {
    add("dmarc_pct", "info", `DMARC enforces for only ${dmarc.pct}% of mail.`, "Raise pct to 100 once the reports are clean.");
  }

  for (const problem of options.reputation?.problems ?? []) add(problem.code, problem.severity, problem.message, problem.fix, problem.blocks);

  const espSpfRead = esp !== null && esp.returnPathHost !== null;
  const espDkimCounts = esp !== null && !dkimIsInformational(esp);
  const espUnreadable = esp !== null && ((espSpfRead && esp.spf.state === "unreadable") || (espDkimCounts && esp.dkim.state === "unreadable"));
  const unreadable = espOnly
    ? dmarc.state === "unreadable" || espUnreadable
    : mx.state === "unreadable" || spf.state === "unreadable" || dkim.state === "unreadable" || dmarc.state === "unreadable" || espUnreadable;
  if (unreadable) {
    add("dns_unreadable", "warn", `Part of ${domain}'s DNS could not be read (the resolver did not answer), so those checks say nothing either way.`, "It is retried on the next daily run. To check by hand, run the dig commands in this report.");
  }

  const allUnreadable = espOnly
    ? (!espSpfRead || esp!.spf.state === "unreadable") && (!espDkimCounts || esp!.dkim.state === "unreadable") && dmarc.state === "unreadable"
    : mx.state === "unreadable" && spf.state === "unreadable" && dkim.state === "unreadable" && dmarc.state === "unreadable";
  const status: DomainStatus = allUnreadable ? "unknown" : problems.some((p) => p.severity === "bad") ? "bad" : problems.some((p) => p.severity === "warn") ? "warn" : "healthy";
  const dmarcPresent = dmarc.state === "monitor" || dmarc.state === "enforced";
  // The provider's own records: its SPF at the return-path host (when it has one) and its DKIM key (read for the status only when the provider says so).
  const espRecordsOk = esp ? (!espSpfRead || (esp.spf.state === "ok" && esp.spfAuthorisesProvider)) && (!espDkimCounts || esp.dkim.state === "ok") && esp.providerStatus === "verified" : true;
  const sendReady = espOnly
    ? espRecordsOk && dmarcPresent
    : spf.state === "ok" && dkim.state === "ok" && dmarcPresent && (esp ? espRecordsOk && (!espSpfRead || esp.spf.state === "ok") : true);
  return {
    domain,
    checkedAt: new Date(now).toISOString(),
    mx,
    spf,
    dkim,
    dmarc,
    status,
    sendReady,
    problems,
    unreadable,
    manual: unreadable ? [...digCommands(domain, parts.selectors), ...(esp?.returnPathHost ? [`dig +short TXT ${esp.returnPathHost}`, `dig +short MX ${esp.returnPathHost}`] : [])] : [],
    ...(esp ? { esp, espOnly } : {}),
  };
}

/** The problems of a provider domain: not verified yet, SPF and MX at the return-path host, the DKIM key. */
function addEspProblems(esp: EspReport, domain: string, add: (code: string, severity: Severity, message: string, fix: string, blocks?: "marketing") => void): void {
  if (esp.providerStatus === "failed") {
    add("esp_verification_failed", "bad", `The email provider could not verify ${domain}: the DNS records it asked for are missing or wrong.`, "Compare the records at the DNS host with the ones the Mailbox lists for this domain (list-sending-domains), fix them, then check the domain again.");
  } else if (esp.providerStatus !== "verified" && esp.providerStatus !== "unknown") {
    add("esp_waiting_for_dns", "warn", `The email provider has not verified ${domain} yet: it is waiting for its DNS records.`, "Add the records the Mailbox lists for this domain (list-sending-domains) at the DNS host. DNS can take a few hours; the Mailbox asks the provider to look again every hour.");
  }
  // A provider with no return-path host of its own to read (SES on its default MAIL FROM) has no SPF or MX of its own to judge.
  const hasReturnPath = esp.returnPathHost !== null;
  if (!hasReturnPath) {
    // nothing at a return-path host
  } else if (esp.spf.state === "missing") {
    add("esp_spf_missing", "bad", `${esp.returnPathHost} has no SPF record: mail from the email provider would fail SPF for ${domain}.`, `Add the provider's SPF TXT record at ${esp.returnPathHost} (list-sending-domains shows its value).`);
  } else if (esp.spf.state === "multiple") {
    add("esp_spf_multiple", "bad", `${esp.returnPathHost} has more than one SPF record, which receivers treat as an error.`, "Merge them into one record.");
  } else if (esp.spf.state === "ok" && !esp.spfAuthorisesProvider) {
    add("esp_spf_wrong", "bad", `The SPF record at ${esp.returnPathHost} does not include the email provider.`, "Replace it with the value the provider gave (list-sending-domains).");
  }
  if (hasReturnPath && esp.mx.state === "missing") {
    add("esp_return_mx_missing", "warn", `${esp.returnPathHost} has no MX record, so bounces cannot come back to the provider and SPF will not align with ${domain}.`, `Add the provider's MX record at ${esp.returnPathHost} (list-sending-domains shows it).`);
  }
  if (dkimIsInformational(esp)) {
    // The DNS read of an SES key never holds a send (see dkimIsInformational): at most a note, and only when the provider itself is not verified.
    if (esp.dkim.state === "missing" && esp.providerStatus === "verified") add("esp_dkim_not_visible", "info", `${esp.selector}._domainkey.${domain} showed no DKIM key to this DNS lookup. SES's DKIM records are CNAMEs to amazonses.com and a resolver that does not follow them shows nothing; SES itself reports DKIM as verified, which is what counts.`, "Nothing to do while SES reports the domain verified.");
  } else if (esp.dkim.state === "missing") {
    add("esp_dkim_missing", "bad", `No DKIM key was found at ${esp.selector}._domainkey.${domain}, so the provider's mail is not signed as ${domain}.`, `Add the provider's DKIM TXT record at ${esp.selector}._domainkey.${domain} (list-sending-domains shows its value).`);
  }
}

// ---------------------------------------------------------------------------
// The predicate other modules use
// ---------------------------------------------------------------------------

export interface SenderDomainHealth {
  domain: string;
  /** The Mailbox has checked this domain. */
  known: boolean;
  status: DomainStatus;
  /** Status `healthy`. */
  healthy: boolean;
  /** SPF, a DKIM key and DMARC are all in place (the bar for launching a campaign). */
  sendReady: boolean;
  /** One line per problem, worst first. */
  reasons: string[];
  /** The problems themselves (a send-side caller needs to tell what holds marketing back from what holds every send back). */
  problems: Array<{ code: string; severity: Severity; message: string; blocks?: "marketing" }>;
  checkedAt: string | null;
  /** The last check is older than 48 hours. */
  stale: boolean;
}

const SEVERITY_ORDER: Record<Severity, number> = { bad: 0, warn: 1, info: 2 };

function reportOf(row: DomainCheckRow): DomainReport | null {
  const result = row.result as Partial<DomainReport> | null;
  return result && Array.isArray(result.problems) ? (result as DomainReport) : null;
}

/**
 * Is this sender domain healthy? Takes a domain or an address. Reads the last
 * stored check, so it is cheap and needs no DNS. Blocks nothing: a caller that
 * wants a gate (Campaigns before launch) applies it.
 */
export async function senderDomainHealth(store: Pick<GmailStore, "getDomainCheck">, companyId: string, addressOrDomain: string, now: number = Date.now()): Promise<SenderDomainHealth> {
  const domain = sendingDomain(addressOrDomain) ?? addressOrDomain.trim().toLowerCase();
  const row = await store.getDomainCheck(companyId, domain);
  const report = row ? reportOf(row) : null;
  if (!row || !report) return { domain, known: false, status: "unknown", healthy: false, sendReady: false, reasons: ["This domain has not been checked yet."], problems: [], checkedAt: null, stale: true };
  const checked = Date.parse(row.checked_at);
  const stale = !Number.isFinite(checked) || now - checked > DOMAIN_CHECK_STALE_HOURS * 3_600_000;
  const sorted = [...report.problems].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const reasons = sorted.map((problem) => problem.message);
  const problems = sorted.map((problem) => ({ code: problem.code, severity: problem.severity, message: problem.message, ...(problem.blocks ? { blocks: problem.blocks } : {}) }));
  return { domain, known: true, status: row.status, healthy: row.status === "healthy", sendReady: Boolean(report.sendReady), reasons, problems, checkedAt: row.checked_at, stale };
}

/** Problems of a domain's Gmail side (its own MX, its SPF with Google, a DKIM key at the usual selectors). They say nothing about mail the email provider signs and sends with its own records. */
const GMAIL_SIDE_CODES: ReadonlySet<string> = new Set(["mx_missing", "spf_missing", "spf_multiple", "spf_plus_all", "spf_no_policy", "spf_lookups", "spf_not_google", "dkim_missing", "dkim_weak_key"]);

/**
 * Whether this problem holds back a send through the email provider: a bad DNS record of the provider's own (or DMARC) holds every
 * send back, a bad bounce or complaint record holds only marketing back, and a Gmail-side problem of a domain that Gmail also uses
 * (PiB's own domain has no Google SPF yet) holds nothing back, because the provider signs with its own records.
 */
export function holdsProviderSend(problem: Pick<SenderDomainHealth["problems"][number], "code" | "severity" | "blocks">, marketing: boolean): boolean {
  return problem.severity === "bad" && !GMAIL_SIDE_CODES.has(problem.code) && (problem.blocks === "marketing" ? marketing : true);
}

/** The event other modules project (`plugin.partnersinbiz.mailbox.mail.domain.health`): ids and statuses, no mail content. */
export interface DomainHealthEvent {
  /** `domain:<domain>:<checkedAt>`; re-sent hourly while the check is current. */
  key: string;
  domain: string;
  status: DomainStatus;
  healthy: boolean;
  sendReady: boolean;
  problems: Array<{ code: string; severity: Severity; message: string }>;
  checkedAt: string;
  mailboxes: string[];
  clientKind?: string | null;
  clientRef?: string | null;
  /**
   * The provider's key (`resend`, `ses`) when only the email provider sends from this domain (no Gmail mailbox on it): then every problem here is one that holds a send from it
   * back, and a sender may refuse to launch from it. null for a domain with a Gmail mailbox: the Mailbox still sends from it, so a problem is a warning.
   */
  provider?: string | null;
}

export function domainHealthEvent(row: DomainCheckRow, mailboxes: string[]): DomainHealthEvent | null {
  const report = reportOf(row);
  if (!report) return null;
  return {
    key: `domain:${row.domain}:${row.checked_at}`,
    domain: row.domain,
    status: row.status,
    healthy: row.status === "healthy",
    sendReady: Boolean(report.sendReady),
    problems: report.problems.map((problem) => ({ code: problem.code, severity: problem.severity, message: problem.message })),
    checkedAt: row.checked_at,
    mailboxes,
    clientKind: row.client_kind,
    clientRef: row.client_ref,
    provider: report.esp && report.espOnly ? report.esp.provider ?? "resend" : null,
  };
}

// ---------------------------------------------------------------------------
// Running the checks for a company
// ---------------------------------------------------------------------------

export interface SendingDomain {
  domain: string;
  /** Addresses at this domain mail is sent from: Gmail mailboxes and the provider's send-only accounts. */
  mailboxes: string[];
  /** A Gmail mailbox receives mail at this domain (a send-only account does not). */
  receives?: boolean;
  /** Registered at the email provider: judged on the provider's records. */
  esp?: EspCheck | null;
  gmail: boolean;
  sendingSince: string | null;
  source: "account" | "manual";
  clientKind: string | null;
  clientRef: string | null;
}

/** The domains a company sends from: its mailboxes' (never a free-mail domain) plus the ones watched on purpose. */
export async function sendingDomains(store: Pick<GmailStore, "listAccounts" | "listDomainChecks"> & Partial<Pick<GmailStore, "listEspDomains">>, companyId: string): Promise<SendingDomain[]> {
  const byDomain = new Map<string, SendingDomain>();
  for (const account of (await store.listAccounts(companyId)) as AccountRow[]) {
    if (account.status === "disconnected") continue;
    const domain = sendingDomain(account.address);
    if (!domain || isFreeMailDomain(domain)) continue;
    const entry = byDomain.get(domain) ?? { domain, mailboxes: [], receives: false, gmail: false, sendingSince: null, source: "account" as const, clientKind: null, clientRef: null };
    entry.mailboxes.push(account.address);
    // A send-only account has no inbox: it does not make the domain one that receives mail.
    const sendOnly = isEspProvider(account.provider);
    entry.receives = Boolean(entry.receives) || !sendOnly;
    entry.gmail = entry.gmail || account.provider === "gmail";
    entry.sendingSince = earliest(entry.sendingSince, account.connected_at, account.created_at);
    entry.clientKind = entry.clientKind ?? account.client_kind;
    entry.clientRef = entry.clientRef ?? account.client_ref;
    byDomain.set(domain, entry);
  }
  for (const row of await store.listDomainChecks(companyId)) {
    if (row.source !== "manual" || byDomain.has(row.domain)) continue;
    byDomain.set(row.domain, { domain: row.domain, mailboxes: [], receives: false, gmail: false, sendingSince: null, source: "manual", clientKind: row.client_kind, clientRef: row.client_ref });
  }
  // A domain registered at the email provider is judged on the provider's records, whether or not a Gmail mailbox is on it too.
  for (const row of store.listEspDomains ? await store.listEspDomains(companyId) : []) {
    const entry = byDomain.get(row.domain) ?? { domain: row.domain, mailboxes: [], receives: false, gmail: false, sendingSince: row.created_at, source: "account" as const, clientKind: row.client_kind, clientRef: row.client_ref };
    entry.esp = { provider: row.provider, returnPathHost: row.return_path_host, dkimSelector: row.dkim_selector, spfInclude: row.spf_include, providerStatus: row.status };
    entry.sendingSince = earliest(entry.sendingSince, row.first_sent_at, row.created_at);
    entry.clientKind = entry.clientKind ?? row.client_kind;
    entry.clientRef = entry.clientRef ?? row.client_ref;
    byDomain.set(row.domain, entry);
  }
  return [...byDomain.values()].sort((a, b) => a.domain.localeCompare(b.domain));
}

export interface DomainRunEnv {
  ctx: PluginContext;
  store: GmailStore;
  dns: DnsResolver;
  now: () => number;
}

/** Checks one domain, stores the result and announces it. Returns the report. */
export async function checkAndStore(env: DomainRunEnv, companyId: string, target: SendingDomain, options: { selectors?: string[]; announce?: boolean } = {}): Promise<DomainReport> {
  const existing = await env.store.getDomainCheck(companyId, target.domain);
  const now = env.now();
  // A provider domain also carries the last 7 days of what it sent and what came back.
  const reputation = target.esp ? await judgeReputation(env.store, companyId, target.domain, now) : null;
  const report = await checkDomain(env.dns, target.domain, {
    selectors: options.selectors,
    now,
    hasMailbox: target.receives ?? target.mailboxes.length > 0,
    gmail: target.gmail,
    esp: target.esp ?? null,
    reputation,
    dmarcNoneSince: existing?.dmarc_none_since ?? null,
    sendingSince: target.sendingSince,
  });
  if (reputation) await env.store.patchEspDomain(companyId, target.domain, { reputation: reputation as unknown as Record<string, unknown> }).catch(() => undefined);
  const nowIso = new Date(now).toISOString();
  const row: DomainCheckRow = {
    company_id: companyId,
    domain: target.domain,
    status: report.status,
    result: report as unknown as Record<string, unknown>,
    source: existing?.source === "manual" && target.source === "account" ? "account" : target.source,
    client_kind: target.clientKind ?? existing?.client_kind ?? null,
    client_ref: target.clientRef ?? existing?.client_ref ?? null,
    checked_at: nowIso,
    first_checked_at: existing?.first_checked_at ?? nowIso,
    status_since: existing && existing.status === report.status ? existing.status_since : nowIso,
    // The 30 days of DMARC p=none start when we first saw it (or when sending began, whichever is older).
    dmarc_none_since: report.dmarc.state === "monitor" && report.dmarc.policy === "none" ? existing?.dmarc_none_since ?? nowIso : null,
  };
  await env.store.upsertDomainCheck(row);
  if (options.announce !== false) {
    const event = domainHealthEvent(row, target.mailboxes);
    if (event) {
      try {
        await env.ctx.events.emit(DOMAIN_HEALTH_EVENT, companyId, event as unknown as Record<string, unknown>);
      } catch (error) {
        env.ctx.logger.info("mail.domain.health emit failed", { domain: target.domain, error: errorMessage(error) });
      }
    }
  }
  return report;
}

/**
 * A provider domain's last 7 days judged against the limits, counting only what came after the day a person lifted a hold (if one did).
 * Every place that judges reputation goes through here, so a lifted hold is lifted everywhere.
 */
export async function judgeReputation(store: Pick<GmailStore, "espDayRows" | "getEspDomain">, companyId: string, domain: string, now: number): Promise<ReputationReport> {
  const [rows, row] = await Promise.all([store.espDayRows(companyId, domain, utcDay(now - (REPUTATION_WINDOW_DAYS - 1) * DAY_MS)), store.getEspDomain(companyId, domain)]);
  return reputationOf(rows, domain, now, clearanceOf(row));
}

/** Problem codes that come from a domain's sending record rather than its DNS. */
export const REPUTATION_CODES: ReadonlySet<string> = new Set(["esp_bounce_rate", "esp_complaint_rate"]);

/**
 * Re-judges a provider domain's last 7 days (no DNS) and merges the result into its stored check. Called after each hard
 * bounce or complaint, so a domain that has just crossed a limit is held back at once, not at tomorrow's daily check, and
 * again when the daily job runs. When the set of reputation problems changes the check gets a new time (so the
 * `mail.domain.health` event is new to the projections that keep the newest) and is announced.
 */
export async function applyReputation(env: DomainRunEnv, companyId: string, domain: string): Promise<{ reputation: ReputationReport; changed: boolean }> {
  const now = env.now();
  const reputation = await judgeReputation(env.store, companyId, domain, now);
  await env.store.patchEspDomain(companyId, domain, { reputation: reputation as unknown as Record<string, unknown> });
  const row = await env.store.getDomainCheck(companyId, domain);
  const report = row ? reportOf(row) : null;
  if (!row || !report) return { reputation, changed: false };
  const before = report.problems.filter((problem) => REPUTATION_CODES.has(problem.code)).map((problem) => problem.code).sort().join(",");
  const after = reputation.problems.map((problem) => problem.code).sort().join(",");
  if (before === after) return { reputation, changed: false };
  const problems: DomainProblem[] = [...report.problems.filter((problem) => !REPUTATION_CODES.has(problem.code)), ...reputation.problems];
  const status: DomainStatus = row.status === "unknown" ? "unknown" : problems.some((p) => p.severity === "bad") ? "bad" : problems.some((p) => p.severity === "warn") ? "warn" : "healthy";
  const nowIso = new Date(now).toISOString();
  const next: DomainCheckRow = { ...row, status, result: { ...report, problems, status } as unknown as Record<string, unknown>, checked_at: nowIso, status_since: status === row.status ? row.status_since : nowIso };
  await env.store.upsertDomainCheck(next);
  const target = (await sendingDomains(env.store, companyId)).find((entry) => entry.domain === domain);
  const event = domainHealthEvent(next, target?.mailboxes ?? []);
  if (event) {
    try {
      await env.ctx.events.emit(DOMAIN_HEALTH_EVENT, companyId, event as unknown as Record<string, unknown>);
    } catch (error) {
      env.ctx.logger.info("mail.domain.health emit failed", { domain, error: errorMessage(error) });
    }
  }
  return { reputation, changed: true };
}

/** Daily job body for one company: every sending domain. A failing domain never stops the others. */
export async function runDomainChecks(env: DomainRunEnv, companyId: string, options: { selectors?: string[] } = {}): Promise<{ checked: number; bad: number; warn: number; unreadable: number }> {
  const summary = { checked: 0, bad: 0, warn: 0, unreadable: 0 };
  for (const target of await sendingDomains(env.store, companyId)) {
    try {
      const report = await checkAndStore(env, companyId, target, options);
      summary.checked += 1;
      if (report.status === "bad") summary.bad += 1;
      if (report.status === "warn") summary.warn += 1;
      if (report.unreadable) summary.unreadable += 1;
    } catch (error) {
      env.ctx.logger.info("Sender domain check failed", { companyId, domain: target.domain, error: errorMessage(error) });
    }
  }
  return summary;
}

/** The default resolver: public DoH through the host's guarded fetch. */
export function defaultResolver(ctx: PluginContext): DnsResolver {
  return dohResolver((url, init) => ctx.http.fetch(url, init as RequestInit));
}

/** Hourly: announce the stored checks again (events are at-most-once), so another module's projection recovers. */
export async function reannounceDomainChecks(env: DomainRunEnv, companyId: string): Promise<number> {
  let sent = 0;
  const domains = await sendingDomains(env.store, companyId);
  for (const row of await env.store.listDomainChecks(companyId)) {
    const target = domains.find((entry) => entry.domain === row.domain);
    const event = domainHealthEvent(row, target?.mailboxes ?? []);
    if (!event) continue;
    try {
      await env.ctx.events.emit(DOMAIN_HEALTH_EVENT, companyId, event as unknown as Record<string, unknown>);
      sent += 1;
    } catch {
      // the next hour tries again
    }
  }
  return sent;
}

// ---------------------------------------------------------------------------
// The Cockpit and the onboarding text
// ---------------------------------------------------------------------------

const DOMAIN_HREF = "/mailbox?tab=mailboxes";

/** One Cockpit health check per sending domain (key `mailbox:domain:<domain>`). */
export function domainHealthChecks(rows: DomainCheckRow[], now: number = Date.now()): HealthCheck[] {
  return rows.map((row) => {
    const report = reportOf(row);
    const key = `mailbox:domain:${row.domain}`;
    const title = `Sender domain: ${row.domain}`;
    const checked = Date.parse(row.checked_at);
    const stale = !Number.isFinite(checked) || now - checked > 3 * 86_400_000;
    const worst = [...(report?.problems ?? [])].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]).filter((p) => p.severity !== "info");
    if (row.status === "healthy" && !stale) return { key, title, status: "ok" as const };
    if (stale) {
      return { key, title, status: "warn" as const, detail: "The daily domain check has not run for over three days.", href: DOMAIN_HREF, fix: "Check the Mailbox daily domain job is on (Settings → Plugins → Mailbox), or run check-sender-domain.", since: row.checked_at };
    }
    if (row.status === "unknown") return { key, title, status: "warn" as const, detail: "The domain's DNS could not be read, so nothing is known yet.", href: DOMAIN_HREF, fix: worst[0]?.fix ?? "It is retried daily.", since: row.status_since };
    return {
      key,
      title,
      status: row.status === "bad" ? ("bad" as const) : ("warn" as const),
      detail: worst.map((problem) => problem.message).slice(0, 3).join(" "),
      href: DOMAIN_HREF,
      fix: worst[0]?.fix ?? "Open the Mailbox page, Sender domains, for the exact records to add.",
      since: row.status_since,
    };
  });
}

export interface OnboardingRecord {
  type: "TXT" | "MX";
  host: string;
  value: string;
  purpose: string;
}

export interface OnboardingGuide {
  domain: string;
  /** Records to add; where a record already exists the step says to edit it, never to add a second. */
  records: OnboardingRecord[];
  steps: string[];
  dig: string[];
  /** What is already right, so nobody redoes it. */
  alreadyDone: string[];
}

/**
 * The checklist for a (client) sending domain: exactly what to add at the DNS
 * provider, in order, and what happens after. DNS is not agent-editable, so the
 * agent hands this to the person who controls the domain (for a client, the
 * client or their web host) through one ask, then re-checks with
 * `check-sender-domain` once they say it is done.
 */
export function onboardingGuide(domain: string, report: DomainReport | null, options: { gmail?: boolean; reportsMailbox?: string | null } = {}): OnboardingGuide {
  const gmail = options.gmail !== false;
  const records: OnboardingRecord[] = [];
  const steps: string[] = [];
  const alreadyDone: string[] = [];
  const reports = options.reportsMailbox ?? `dmarc@${domain}`;
  const spfOk = report?.spf.state === "ok";

  if (report?.mx.state === "missing") {
    records.push({ type: "MX", host: "@", value: gmail ? "1 SMTP.GOOGLE.COM." : "<your mail provider's MX records>", purpose: "Lets the domain receive mail (replies, bounces)." });
  } else if (report?.mx.state === "ok") alreadyDone.push(`MX: ${report.mx.hosts.slice(0, 2).join(", ")}${report.mx.provider ? ` (${report.mx.provider})` : ""}`);

  if (!spfOk || (gmail && !report?.spf.authorisesGoogle)) {
    const record = report?.spf.record;
    const merged = record && gmail && !report?.spf.authorisesGoogle ? record.replace(/\s([+\-~?]?all)\s*$/i, " include:_spf.google.com $1") : null;
    records.push({
      type: "TXT",
      host: "@",
      value: merged ?? (gmail ? "v=spf1 include:_spf.google.com ~all" : "v=spf1 include:<your provider> ~all"),
      purpose: record ? "Edit the existing SPF record (a domain may have only one): add Google's include before the ~all." : "SPF: says which servers may send for the domain.",
    });
  } else alreadyDone.push("SPF record");

  if (report?.dkim.state !== "ok") {
    steps.push(gmail
      ? `DKIM (Google Workspace): Admin console → Apps → Google Workspace → Gmail → Authenticate email → choose ${domain} → Generate new record (2048-bit, selector google) → add the TXT record it shows at google._domainkey.${domain} → click Start authentication. A domain on a personal Gmail account cannot be signed: use a Workspace mailbox for client mail.`
      : "DKIM: ask the mail provider for the DKIM TXT record and add it where it says.");
  } else alreadyDone.push(`DKIM key at ${report.dkim.found.join(", ")}`);

  if (report?.dmarc.state === "missing" || !report) {
    records.push({ type: "TXT", host: "_dmarc", value: `v=DMARC1; p=none; rua=mailto:${reports}; adkim=r; aspf=r`, purpose: "DMARC: asks receivers for reports and ties SPF and DKIM to the From address. Start at p=none." });
    steps.push(`Read the DMARC reports sent to ${reports} for about two weeks, then change p=none to p=quarantine (and later p=reject) when only your own mail shows up.`);
  } else if (report.dmarc.state !== "unreadable") {
    alreadyDone.push(`DMARC (${report.dmarc.policy ?? "present"})`);
  }

  steps.unshift(...records.map((record) => `Add a ${record.type} record at ${record.host === "@" ? domain : `${record.host}.${domain}`}: ${record.value}`));
  steps.push("DNS changes can take up to a few hours to show. Then run check-sender-domain again: it must say healthy before a campaign is sent from this domain.");
  return { domain, records, steps, dig: digCommands(domain, [...DEFAULT_DKIM_SELECTORS]), alreadyDone };
}
