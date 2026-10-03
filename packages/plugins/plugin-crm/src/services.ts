/**
 * The services a client buys from us: a controlled vocabulary (audit Q1a-8).
 *
 * The client profile's `services` field used to be free text ("SEO retainer",
 * "social media"), so nothing could act on it. It now holds keys from
 * `SERVICES`; free text still arrives from older rows and from people, and is
 * mapped here (`normalizeServices`). What does not map is kept as text in
 * `servicesOther`, never dropped.
 *
 * This file is pure (no database, no host): the onboarding job and the hand-off
 * live in `service-onboarding.ts`.
 */
import type { TeamRoleKey } from "@partnersinbiz/pib-plugin-kit";

/** CRM -> the other plugins: a client's services changed (a hand-off, re-sent hourly for a day). */
export const CLIENT_SERVICES_EVENT = "client.services.changed";

export interface ServiceDef {
  key: string;
  label: string;
  /** The module that does the work, when one does (its client workspace shows the service running). */
  module: "seo" | "social" | "campaigns" | "billing" | "crm" | null;
  /** The team role that starts the service (kit `routeRole`: falls back to the Operator, then the owner). */
  role: TeamRoleKey;
  /** Free text that means this service. Tested in order, so a more specific service goes first. */
  aliases: RegExp;
  /** What starting it means, for the onboarding step. */
  start: readonly string[];
  /** What the step's closer logs on the client as proof. */
  evidence: string;
}

export const SERVICES = [
  {
    key: "seo",
    label: "SEO",
    module: "seo",
    role: "seo-specialist",
    aliases: /\bseo\b|search engine|\borganic\b|\bbacklinks?\b|\bkeywords?\b|\branking/i,
    start: [
      "Create the client's first 90-day sprint: `partnersinbiz.seo:create-sprint` with `client: <ref>` and the `businessType` that fits (local, professional, ecommerce or saas).",
      "Link the site and its repo project (`get-site-link`, `link-site`); Search Console access is one ask for the owner, batched with the other grants.",
    ],
    evidence: "the sprint (its id or link)",
  },
  {
    key: "ads",
    label: "Paid ads",
    module: null,
    role: "account-manager",
    aliases: /\bads?\b|\bppc\b|adwords|paid (media|social|search|advertising)|\badvertis/i,
    start: [
      "Agree the monthly ad budget and the goal with the client (a person approves any spend).",
      "Draft the first campaign plan and put the budget on Needs you as a judgement item.",
    ],
    evidence: "the campaign plan (a link) and the approved budget",
  },
  {
    key: "social",
    label: "Social media",
    module: "social",
    role: "social",
    aliases: /\bsocial\b|instagram|facebook|linkedin|tiktok|twitter|content calendar|community management/i,
    start: [
      "Ask for the social logins in ONE grant ask (Social, Accounts tab); never one ask per network.",
      "Once the accounts are connected, plan the first month in Social (`partnersinbiz.social` tools, `client: <ref>`).",
    ],
    evidence: "the first month's plan (a link) or the accounts waiting on the client",
  },
  {
    key: "campaigns",
    label: "Email campaigns",
    module: "campaigns",
    role: "account-manager",
    aliases: /\bcampaigns?\b|newsletter|email market|e-?mail (campaign|sequence)|mailchimp|\bdrip\b/i,
    start: [
      "Confirm the sending address and the client's own audience (never our contacts, never a bought list: POPIA).",
      "Draft the first campaign in Campaigns for approval; a person approves sending.",
    ],
    evidence: "the draft campaign (a link)",
  },
  {
    key: "lead-capture",
    label: "Lead capture",
    module: "crm",
    role: "account-manager",
    aliases: /lead (capture|gen|form)|enquiry form|contact form|landing page|lead magnet/i,
    start: [
      "Create the client's lead form: `create-lead-endpoint` with `client: <ref>` (it returns the snippet to install).",
      "The snippet goes on the client's site through its repo project (a PR into the work branch) or with the client's developer; then submit one test lead and confirm it shows on the client's page.",
    ],
    evidence: "the lead source (its label) and the test lead",
  },
  {
    key: "reporting",
    label: "Monthly reporting",
    module: "crm",
    role: "account-manager",
    aliases: /\breport(s|ing)?\b|dashboard|analytics/i,
    start: [
      "Agree who receives the monthly report and on which day of the month.",
      "Note it on the client so the Account Manager sends it every month (draft in the Mailbox for approval).",
    ],
    evidence: "who receives it and the day, logged on the client",
  },
  {
    key: "website",
    label: "Website",
    module: null,
    role: "operator",
    aliases: /\bweb ?(site|design|build|dev)|\bwordpress\b|\bshopify\b|\bwix\b|\bredesign\b|e-?commerce|online store|web store/i,
    start: [
      "Register the site (`save-client-site`) and link its project; a WordPress site is paired with the PiB Connector.",
      "Hand the build or care work to the Delivery Lead with the client's project and the `development` branch rule.",
    ],
    evidence: "the registered site and the hand-off issue",
  },
  {
    key: "development",
    label: "Software development",
    module: null,
    role: "operator",
    aliases: /\bsoftware\b|\bapps?\b|mobile|\bios\b|android|\bsaas\b|\bportal\b|\bapi\b|custom (dev|build)|\bdevelopment\b|\bdeveloper/i,
    start: [
      "Make sure the client has a Paperclip project with a git workspace (`start-new-client` lists what is missing).",
      "Hand the work to the Delivery Lead: project, `development` branch policy, staging and the agent guide.",
    ],
    evidence: "the project link and the hand-off issue",
  },
  {
    key: "bookkeeping",
    label: "Bookkeeping",
    module: "billing",
    role: "bookkeeper",
    aliases: /bookkeep|accounting|\bvat\b|\binvoicing\b|\bxero\b|management accounts/i,
    start: [
      "Open the client's books in Accounting and confirm the chart of accounts and the bank feed.",
      "Set the monthly close and VAT dates; a person approves anything posted to the ledger.",
    ],
    evidence: "the books opened (a link) and the monthly dates",
  },
  {
    key: "payroll",
    label: "Payroll",
    module: "billing",
    role: "payroll-clerk",
    aliases: /payroll|payslip|\bwages?\b/i,
    start: [
      "Collect the employees, pay dates and tax details in Payroll (personal data: only what the run needs).",
      "Prepare the first payroll run as a draft; a person approves it.",
    ],
    evidence: "the first draft run (a link)",
  },
  {
    key: "branding",
    label: "Branding and creative",
    module: "crm",
    role: "account-manager",
    aliases: /\bbrand(ing)?\b|\blogo\b|\bdesign\b|creative|\bvideo\b|photograph|copywrit/i,
    start: [
      "Fill the brand kit on the client profile (logo, colours, fonts, tone examples) with `update-client-profile`.",
      "Draft the creative brief and put the first deliverable up for approval.",
    ],
    evidence: "the brand kit filled in and the brief (a link)",
  },
  {
    key: "support",
    label: "Support and maintenance",
    module: null,
    role: "operator",
    aliases: /\bsupport\b|maintenance|\bhosting\b|\buptime\b|\bsla\b/i,
    start: [
      "Write down what is covered, the response times and who the client calls.",
      "Hand the care work to the Delivery Lead and note the monitoring (uptime, backups, updates).",
    ],
    evidence: "the agreed cover and the hand-off issue",
  },
] as const satisfies readonly ServiceDef[];

export type ServiceKey = (typeof SERVICES)[number]["key"];
export const SERVICE_KEYS: ServiceKey[] = SERVICES.map((service) => service.key);

export function isServiceKey(value: unknown): value is ServiceKey {
  return typeof value === "string" && (SERVICE_KEYS as string[]).includes(value);
}

export function serviceDef(key: string): ServiceDef | null {
  return (SERVICES as readonly ServiceDef[]).find((service) => service.key === key) ?? null;
}

export function serviceLabel(key: string): string {
  return serviceDef(key)?.label ?? key;
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

/** One piece of free text (no list separators) to a service key, or null. */
function serviceOfPart(part: string): ServiceKey | null {
  const text = part.trim();
  if (!text) return null;
  const direct = slug(text);
  for (const service of SERVICES) {
    if (service.key === direct || slug(service.label) === direct) return service.key;
  }
  for (const service of SERVICES) {
    if (service.aliases.test(text)) return service.key;
  }
  return null;
}

/**
 * Maps what people and older rows wrote to the vocabulary. An item that
 * already is a key (or a label) maps to it; other text maps by its aliases
 * ("SEO retainer" is seo, "Facebook ads" is ads, "SEO and social" is both).
 * Text that matches nothing stays in `other`, as it was written, so nothing a
 * person typed is lost. Order follows the vocabulary, not the input.
 */
export function normalizeServices(input: readonly unknown[] | null | undefined): { services: ServiceKey[]; other: string[] } {
  const found = new Set<ServiceKey>();
  const other: string[] = [];
  for (const raw of input ?? []) {
    if (typeof raw !== "string") continue;
    const item = raw.trim();
    if (!item) continue;
    // "SEO and social" is two services; a plain phrase is one.
    const parts = item.split(/\s*(?:,|;|\/|&|\+|\band\b)\s*/i).filter(Boolean);
    const hits = parts.map(serviceOfPart);
    if (hits.every((hit) => hit == null)) {
      if (!other.some((have) => have.toLowerCase() === item.toLowerCase())) other.push(item);
      continue;
    }
    for (const hit of hits) if (hit) found.add(hit);
  }
  return { services: SERVICE_KEYS.filter((key) => found.has(key)), other };
}

export interface ServicesDiff {
  added: ServiceKey[];
  removed: ServiceKey[];
}

export function diffServices(before: readonly string[], after: readonly string[]): ServicesDiff {
  const had = new Set(before);
  const has = new Set(after);
  return {
    added: SERVICE_KEYS.filter((key) => has.has(key) && !had.has(key)),
    removed: SERVICE_KEYS.filter((key) => had.has(key) && !has.has(key)),
  };
}

/** `crm:service-onboard:<kind>:<id>:<service>:<yyyymmdd>`: the day lets a service that was removed and added again open a new step. */
export function serviceStepOrigin(kind: string, clientId: string, service: string, day: string): string {
  return `${SERVICE_STEP_PREFIX}${kind}:${clientId}:${service}:${day}`;
}

export const SERVICE_STEP_PREFIX = "crm:service-onboard:";

/** The parts of a service step's origin id, or null. */
export function parseServiceStep(originId: string | null | undefined): { kind: "company" | "contact"; clientId: string; service: string; day: string } | null {
  if (typeof originId !== "string" || !originId.startsWith(SERVICE_STEP_PREFIX)) return null;
  const parts = originId.slice(SERVICE_STEP_PREFIX.length).split(":");
  if (parts.length !== 4) return null;
  const [kind, clientId, service, day] = parts as [string, string, string, string];
  if ((kind !== "company" && kind !== "contact") || !clientId || !service || !day) return null;
  return { kind, clientId, service, day };
}
