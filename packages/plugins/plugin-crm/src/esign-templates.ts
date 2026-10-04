/**
 * The document templates a signable proposal, quote or simple agreement starts from (audit Q1b-11, Q10-14).
 *
 * Plain Markdown with `{{placeholders}}`, so a person (and a lawyer) can read exactly what a client will be
 * asked to sign. THESE ARE DRAFTS, NOT LEGAL ADVICE: nobody has had them reviewed by a lawyer yet, which is why
 * the e-sign feature is off for every client but the canary until the owner turns it on for a client. Change
 * the wording only together with `TEMPLATE_VERSION`: a document records the version it was made from.
 *
 * Pure: no database, no host call. The text of a document is frozen when it is made (`esign.ts`); a later change
 * here never touches a document already sent.
 */
import { CrmError } from "./domain.js";

/** How long a signing link works once the email is sent, and the limits on what a document may hold. */
export const DEFAULT_VALID_DAYS = 14;
export const MAX_VALID_DAYS = 60;
export const MIN_CONTENT_CHARS = 40;
export const MAX_CONTENT_CHARS = 60_000;

/** Reminders drafted after the first email, how far apart, how long a signed copy stays online, and the least time a person needs on the page. */
export const MAX_ESIGN_REMINDERS = 2;
export const ESIGN_REMIND_AFTER_DAYS = 3;
export const SIGNED_PAGE_DAYS = 90;
export const MIN_SIGN_MS = 2_000;

/** Bump with every wording change. A document keeps the version it was made from. */
export const TEMPLATE_VERSION = "2026-10-v1";

/** What each template is for, and which variables it needs. Everything else has a default. */
export interface TemplateInfo {
  key: string;
  kind: "proposal" | "quote" | "contract";
  label: string;
  description: string;
  /** Variables the caller must give (besides the ones the CRM fills from the client and the company). */
  required: string[];
  optional: string[];
}

export const TEMPLATES: TemplateInfo[] = [
  {
    key: "proposal",
    kind: "proposal",
    label: "Proposal",
    description: "A proposal for the services a client may buy: summary, scope, deliverables, timeline, price, payment and what accepting means.",
    required: ["scope"],
    optional: ["summary", "deliverables", "timeline", "price", "payment_terms", "assumptions", "start_date"],
  },
  {
    key: "quote",
    kind: "quote",
    label: "Quote",
    description: "A priced list of what is offered. Give lines (description, quantity, unit price) and the totals are worked out here, or the Billing quote number and total.",
    required: [],
    optional: ["lines", "quote_number", "total", "notes", "payment_terms", "vat_percent"],
  },
  {
    key: "service-agreement",
    kind: "contract",
    label: "Simple service agreement",
    description: "A short plain-language agreement for a recurring or once-off service: services, fees, term and cancellation, confidentiality, personal information, liability and governing law.",
    required: ["scope"],
    optional: ["fees", "payment_terms", "term", "notice_days", "start_date", "client_responsibilities"],
  },
];

export const TEMPLATE_KEYS = TEMPLATES.map((template) => template.key);

/** Said to the person who approves the email, and in the lawyer review checklist: never client-facing. */
export const TEMPLATE_NOTICE =
  "These templates are drafts, not legal advice, and no lawyer has reviewed them. They are written so that a signature is a basic electronic signature under the South African Electronic Communications and Transactions Act (a typed name with the signer's explicit consent); they are NOT an advanced electronic signature and make no claim to be one.";

const PROPOSAL = `# Proposal: {{title}}

Prepared for **{{client_name}}** by **{{company_name}}**. {{valid_line}}

## Summary
{{summary}}

## What we will do
{{scope}}

## What you get
{{deliverables}}

## Timeline
{{timeline}}

## Investment
{{price}}

## Payment
{{payment_terms}}

## Assumptions
{{assumptions}}

## Accepting this proposal
Signing below means {{client_name}} accepts this proposal as written and asks {{company_name}} to start. If anything here is not right, do not sign: reply to the email this came with and we will change it.
`;

const QUOTE = `# Quote{{quote_number_suffix}}

Prepared for **{{client_name}}** by **{{company_name}}**. {{valid_line}}

## What is quoted
{{lines_table}}

## Total
{{total_line}}

## Payment
{{payment_terms}}

## Notes
{{notes}}

## Accepting this quote
Signing below means {{client_name}} accepts this quote as written. {{company_name}} will then invoice as set out above.
`;

const SERVICE_AGREEMENT = `# Service agreement

This agreement is between **{{company_name}}** (we, us) and **{{client_name}}** (you). {{valid_line}}

## 1. The services
{{scope}}

## 2. Fees and payment
{{fees}}

{{payment_terms}}

## 3. Term and cancellation
{{term}} Either of us may end this agreement by giving the other {{notice_days}} days' written notice (an email is enough). Fees for work already done, and for the notice period, remain payable.

## 4. What we need from you
{{client_responsibilities}}

## 5. Confidentiality
Each of us will keep the other's confidential information private and use it only for this agreement, unless the law requires it to be shared. This continues after the agreement ends.

## 6. Personal information
Each of us will follow the Protection of Personal Information Act (POPIA). Where we handle personal information on your behalf, we do it only on your instructions, keep it secure, and tell you promptly if we learn it was lost or accessed without permission.

## 7. Ownership
You keep what is yours. What we create specifically for you becomes yours once you have paid for it, except for our tools, templates and general know-how, which stay ours.

## 8. Liability
We will do the work with reasonable care and skill. We do not promise particular results (for example a search ranking, a number of enquiries or sales). Our total liability under this agreement is limited to the fees you paid us in the three months before the claim, to the extent the law allows.

## 9. General
This agreement is the whole agreement between us on these services and may only be changed in writing by both of us. South African law governs it. We may sign it electronically, and an electronic signature is as binding between us as an ink signature.

## Signing
Signing below means {{client_name}} has read this agreement and accepts it.
`;

const SOURCES: Record<string, string> = { proposal: PROPOSAL, quote: QUOTE, "service-agreement": SERVICE_AGREEMENT };

/** The Markdown source of a template, for the review tool and the lawyer review pack. */
export function templateSource(key: string): string | null {
  return SOURCES[key] ?? null;
}

export interface QuoteLine {
  description: string;
  quantity?: number;
  unitMinor: number;
}

export interface TemplateContext {
  /** The document's own title (`Proposal: <title>`). */
  title: string;
  clientName: string;
  companyName: string;
  currency: string;
  /** "Valid until 17 Oct 2026." or empty. */
  validLine: string;
  /** Free values the caller supplies (see `TemplateInfo`). Text, numbers or lists. */
  vars: Record<string, unknown>;
  /** Formats an amount in minor units (`R 1,500.00`). */
  money: (minor: number, currency: string) => string;
}

const DEFAULTS: Record<string, string> = {
  summary: "We have set out below what we propose to do for you, how long it takes and what it costs.",
  deliverables: "- The work described above, delivered as agreed.",
  timeline: "We start once this is accepted. We will confirm dates with you in writing.",
  price: "The price for this work will be confirmed in writing before we start.",
  payment_terms: "Invoices are payable within 7 days of the invoice date, by EFT to the bank account on the invoice.",
  assumptions: "- You give us the access, content and decisions we ask for in good time.\n- Anything outside the scope above is quoted separately before we do it.",
  notes: "None.",
  fees: "The fees are set out in this agreement or in the quote it refers to.",
  term: "This agreement starts on the date it is signed and continues month to month.",
  notice_days: "30",
  client_responsibilities: "You give us the information, access and approvals we reasonably ask for, in good time, and pay our invoices when due.",
};

const MAX_VALUE = 8_000;

function textOf(value: unknown, max = MAX_VALUE): string {
  if (typeof value === "string") return value.replace(/\r\n?/g, "\n").trim().slice(0, max);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string" && item.trim()).map((item) => `- ${String(item).trim()}`).join("\n").slice(0, max);
  return "";
}

/** A single-line value (a name, a number): no line breaks, so it cannot start a heading or a list. */
function lineOf(value: unknown, max = 200): string {
  return textOf(value, max).replace(/\s*\n+\s*/g, " ").trim();
}

export function quoteLines(value: unknown): QuoteLine[] {
  if (!Array.isArray(value)) return [];
  const out: QuoteLine[] = [];
  for (const raw of value.slice(0, 60)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const description = lineOf(item.description, 200);
    const unitMinor = Number(item.unitMinor);
    const quantity = item.quantity == null || item.quantity === "" ? 1 : Number(item.quantity);
    if (!description) throw new CrmError("Each quote line needs a description");
    if (!Number.isInteger(unitMinor) || unitMinor < 0) throw new CrmError(`Quote line "${description}": unitMinor must be a whole number of cents (150000 is R 1,500.00)`);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100_000) throw new CrmError(`Quote line "${description}": quantity must be above 0`);
    out.push({ description, quantity, unitMinor });
  }
  return out;
}

/** Cents for a line: quantity may be fractional (hours), so the line total is rounded to the cent. */
export function lineTotalMinor(line: QuoteLine): number {
  return Math.round((line.quantity ?? 1) * line.unitMinor);
}

function cell(text: string): string {
  return text.replace(/\|/g, "/");
}

function linesTable(lines: QuoteLine[], currency: string, money: TemplateContext["money"]): { table: string; subtotal: number } {
  const rows = lines.map((line) => `| ${cell(line.description)} | ${line.quantity ?? 1} | ${money(line.unitMinor, currency)} | ${money(lineTotalMinor(line), currency)} |`);
  const subtotal = lines.reduce((sum, line) => sum + lineTotalMinor(line), 0);
  return { table: ["| Item | Qty | Unit price | Amount |", "|---|---|---|---|", ...rows].join("\n"), subtotal };
}

export interface RenderedTemplate {
  /** The words in the document's own heading. */
  title: string;
  /** What the document is called in lists and in the consent wording: `Proposal: SEO retainer`, `Quote Q-0007 for Acme`, `Service agreement: Acme`. */
  docTitle: string;
  markdown: string;
  kind: TemplateInfo["kind"];
  /** The total in minor units when the template works one out (a quote with lines), else null. */
  totalMinor: number | null;
}

/**
 * Fills a template. Throws a plain `CrmError` naming what is missing. Every value is flattened to text and capped,
 * and a one-line value cannot carry a line break, so a client's name or a quote line can never become a heading.
 */
export function renderTemplate(key: string, ctx: TemplateContext): RenderedTemplate {
  const info = TEMPLATES.find((template) => template.key === key);
  const source = SOURCES[key];
  if (!info || !source) throw new CrmError(`template must be one of ${TEMPLATE_KEYS.join(", ")}`);
  const vars = ctx.vars;
  const missing = info.required.filter((name) => !textOf(vars[name]));
  if (missing.length) throw new CrmError(`The ${info.label.toLowerCase()} template needs: ${missing.join(", ")}`);

  const values: Record<string, string> = {
    title: lineOf(ctx.title, 160) || info.label,
    client_name: lineOf(ctx.clientName, 160),
    company_name: lineOf(ctx.companyName, 160),
    valid_line: ctx.validLine,
  };
  for (const name of [...info.required, ...info.optional]) {
    const given = name === "start_date" || name === "term" || name === "notice_days" ? lineOf(vars[name]) : textOf(vars[name]);
    values[name] = given || DEFAULTS[name] || "";
  }
  let totalMinor: number | null = null;

  if (key === "quote") {
    const lines = quoteLines(vars.lines);
    const total = Number(vars.total);
    if (lines.length === 0 && !(Number.isInteger(total) && total > 0)) throw new CrmError("The quote template needs lines (description, quantity, unitMinor) or a total in cents");
    const vat = vars.vat_percent == null || vars.vat_percent === "" ? 0 : Number(vars.vat_percent);
    if (!Number.isFinite(vat) || vat < 0 || vat > 100) throw new CrmError("vat_percent must be between 0 and 100");
    if (lines.length) {
      const { table, subtotal } = linesTable(lines, ctx.currency, ctx.money);
      const vatMinor = Math.round((subtotal * vat) / 100);
      totalMinor = subtotal + vatMinor;
      values.lines_table = table;
      values.total_line = vat > 0 ? `${ctx.money(subtotal, ctx.currency)} excluding VAT, plus VAT at ${vat}% (${ctx.money(vatMinor, ctx.currency)}): **${ctx.money(totalMinor, ctx.currency)}**.` : `**${ctx.money(subtotal, ctx.currency)}**. ${vat === 0 && vars.vat_percent === 0 ? "VAT is not charged." : ""}`.trim();
    } else {
      totalMinor = total;
      values.lines_table = "As agreed in the accompanying description.";
      values.total_line = `**${ctx.money(total, ctx.currency)}**.`;
    }
    const number = lineOf(vars.quote_number, 40);
    values.quote_number_suffix = number ? ` ${number}` : "";
  }
  if (key === "proposal" && vars.price == null && vars.priceMinor == null) values.price = DEFAULTS.price!;
  if (key === "proposal" && Number.isInteger(Number(vars.priceMinor)) && Number(vars.priceMinor) > 0) {
    totalMinor = Number(vars.priceMinor);
    values.price = `${textOf(vars.price) || "Our fee for this work"}: **${ctx.money(totalMinor, ctx.currency)}**.`;
  }
  if (key === "service-agreement" && Number.isInteger(Number(vars.feesMinor)) && Number(vars.feesMinor) > 0) {
    totalMinor = Number(vars.feesMinor);
    values.fees = `${textOf(vars.fees) || "Our fee"}: **${ctx.money(totalMinor, ctx.currency)}**.`;
  }
  if (key === "service-agreement" && values.start_date) values.term = `This agreement starts on ${values.start_date} and continues month to month.`;

  const markdown = source.replace(/\{\{([a-z_]+)\}\}/g, (_whole, name: string) => {
    if (!(name in values)) throw new CrmError(`Template ${key} uses an unknown placeholder {{${name}}}`);
    return values[name]!;
  });
  // A placeholder written by the caller inside a value must not survive into the document.
  if (/\{\{[a-z_]+\}\}/.test(markdown)) throw new CrmError("A value contains {{ }} text, which is reserved for the templates: remove it");
  const docTitle = key === "proposal" ? `Proposal: ${values.title}` : key === "quote" ? `Quote${values.quote_number_suffix} for ${values.client_name}` : `Service agreement: ${values.client_name}`;
  return { title: values.title!, docTitle: docTitle.slice(0, 160), markdown: `${markdown.replace(/\n{3,}/g, "\n\n").trimEnd()}\n`, kind: info.kind, totalMinor };
}
