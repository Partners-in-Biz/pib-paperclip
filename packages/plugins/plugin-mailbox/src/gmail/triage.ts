/**
 * Mail triage. Deterministic first (CRM contact by sender address, CRM
 * company by sender domain, reply to a message a plugin sent), then one Jev
 * call per new message with only: sender domain, subject, snippet (≤500
 * chars), attachment names/types and three flags. Without Jev (no key, or
 * the call fails) keyword rules pick the category.
 */
import {
  confidenceOf,
  decide,
  MAIL_CATEGORIES,
  RISK_THRESHOLDS,
  shouldAct,
  type DecisionClientConfig,
  type DecisionResult,
  type JevAnswer,
  type JevQuestions,
  type MailCategory,
} from "@partnersinbiz/pib-plugin-kit";
import type { GmailStore } from "../db.js";
import type { Env } from "./env.js";
import { emailDomain } from "./headers.js";
import type { CrmClientRow, MessageRow, SendContext, StoredTriage, TriageWrite } from "./types.js";

export const TRIAGE_PURPOSE = "mail-triage";
const NONE_OPTION = "none of these";

export const CATEGORY_RUBRICS: Record<MailCategory, string> = {
  lead: "A new prospect asking about our services, prices, a quote or a meeting. Not yet a client.",
  client: "An existing client writing about their project, account, deliverables or a change they want.",
  reply: "A person answering an email we sent (a quote, invoice, campaign or outreach) and continuing that conversation.",
  proof_of_payment: "Proof of payment, remittance advice or an EFT confirmation for money paid to us.",
  invoice_or_bill: "An invoice, bill, statement of account or quote from a supplier that we have to pay.",
  bank_statement: "A bank statement or a bank notice about activity on our own bank account.",
  support: "Someone needs help: a problem, bug, complaint or request for help with something we provide.",
  newsletter: "Newsletters, digests, promotions or other bulk marketing sent to a list.",
  notification: "Automated notices: receipts, sign-in or security alerts, shipping updates, calendar or app notifications.",
  spam: "Unwanted junk: irrelevant cold pitches, SEO or link-building offers, scams.",
  personal: "Personal mail from friends or family, not about business.",
  other: "Business mail that fits none of the other categories.",
};

export const CATEGORY_LABELS: Record<MailCategory, string | null> = {
  lead: "Lead",
  client: "Client",
  reply: "Reply",
  proof_of_payment: "POP",
  invoice_or_bill: "Bills",
  bank_statement: "Bank",
  support: "Support",
  newsletter: "Newsletters",
  notification: "Notifications",
  spam: "Spam",
  personal: "Personal",
  other: null,
};

export const URGENCY_LEVELS = [
  "Can wait: no action needed or no time pressure.",
  "Normal: should be handled within a few days.",
  "Soon: should be handled today or tomorrow (a deadline, an unhappy client, a payment problem).",
  "Urgent: needs attention within hours (an outage, a legal or payment deadline today, a security problem).",
];

/** Categories where a reply issue may be opened. */
export const REPLY_ISSUE_CATEGORIES = new Set<MailCategory>(["lead", "client", "support"]);

const FREE_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.net",
  "zoho.com",
  "yandex.com",
  "mweb.co.za",
  "telkomsa.net",
  "vodamail.co.za",
  "webmail.co.za",
  "absamail.co.za",
  "lantic.net",
  "iafrica.com",
]);

export function isFreeMailDomain(domain: string | null): boolean {
  return !domain || FREE_MAIL.has(domain.toLowerCase());
}

export function isCategory(value: unknown): value is MailCategory {
  return typeof value === "string" && (MAIL_CATEGORIES as readonly string[]).includes(value);
}

export interface TriageFacts {
  subject: string;
  snippet: string;
  fromEmail: string | null;
  bulk: boolean;
  attachments: Array<{ filename: string; mime: string }>;
  isReply: boolean;
  hasClient: boolean;
  /** A delivery failure notice. */
  bounce?: boolean;
}

const has = (text: string, re: RegExp) => re.test(text);

/** Keyword rules used when Jev is not configured or does not answer. */
export function ruleCategory(facts: TriageFacts): MailCategory {
  const text = `${facts.subject} ${facts.snippet}`.toLowerCase();
  const files = facts.attachments.map((a) => a.filename.toLowerCase()).join(" ");
  const local = (facts.fromEmail ?? "").split("@")[0] ?? "";
  if (facts.bounce) return "notification";
  if (has(text, /\b(proof of payment|pop attached|remittance|payment (confirmation|notification|advice)|eft (confirmation|notification)|paid (the )?invoice)\b/) || has(files, /\b(pop|proof[ _-]?of[ _-]?payment|remittance)\b/)) {
    return "proof_of_payment";
  }
  if (has(text, /\bbank statement\b|\bstatement (is )?(available|attached) for (your )?account\b/)) return "bank_statement";
  if (has(text, /\b(invoice|tax invoice|statement of account|amount due|payment due|bill)\b/) && !facts.isReply) return "invoice_or_bill";
  if (facts.isReply) return "reply";
  if (facts.hasClient && !facts.bulk) return "client";
  if (facts.bulk) {
    if (has(text, /\b(receipt|order|shipped|delivered|sign[- ]?in|security alert|verification code|password|invitation|reminder)\b/) || /^(no-?reply|notifications?)/.test(local)) {
      return "notification";
    }
    return "newsletter";
  }
  if (has(text, /\b(quote|quotation|pricing|price list|proposal|interested in|enquiry|inquiry|looking for (a|an|someone)|can you help us)\b/)) return "lead";
  if (has(text, /\b(not working|broken|error|issue with|problem with|urgent help|can't log ?in|cannot log ?in|down)\b/)) return "support";
  return "other";
}

/** Rough needs-reply probability for the rules path. */
export function ruleNeedsReply(category: MailCategory, facts: TriageFacts): number {
  if (facts.bulk) return 0.05;
  if (["lead", "client", "reply", "support"].includes(category)) return 0.6;
  if (/\?/.test(facts.subject) || /\?/.test(facts.snippet)) return 0.5;
  return 0.2;
}

// ---------------------------------------------------------------------------
// Client candidates
// ---------------------------------------------------------------------------

const NAME_STOPWORDS = new Set([
  "the", "and", "pty", "ltd", "inc", "llc", "cc", "co", "npc", "group", "company", "services", "solutions",
  "consulting", "holdings", "trust", "sa", "za", "africa", "south", "international", "studio", "agency",
]);

function normaliseText(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9@.\s-]/g, " ").replace(/\s+/g, " ").trim();
}

function nameTokens(name: string): string[] {
  return normaliseText(name)
    .split(/[\s.-]+/)
    .filter((token) => token.length >= 4 && !NAME_STOPWORDS.has(token));
}

function cleanDomain(domain: string | null): string | null {
  if (!domain) return null;
  return domain.toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, "").split("/")[0] || null;
}

function domainRoot(domain: string | null): string | null {
  if (!domain) return null;
  const clean = domain.toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, "").split("/")[0]!;
  return clean.split(".")[0] || null;
}

/** Clients whose name or domain shows up in the mail. Used to decide whether a client question is worth asking. */
export function plausibleClients(clients: CrmClientRow[], facts: { subject: string; snippet: string; fromDomain: string | null }): CrmClientRow[] {
  const text = ` ${normaliseText(`${facts.subject} ${facts.snippet}`)} `;
  const fromRoot = domainRoot(facts.fromDomain);
  const out: CrmClientRow[] = [];
  for (const client of clients) {
    const full = normaliseText(client.name);
    const root = domainRoot(client.domain);
    const tokenHit = nameTokens(client.name).some((token) => text.includes(` ${token} `) || (fromRoot !== null && fromRoot.includes(token)));
    if ((full.length >= 3 && text.includes(` ${full} `)) || tokenHit || (root && fromRoot && root === fromRoot)) out.push(client);
  }
  return out;
}

export interface ClientOptions {
  criteria: Record<string, string | null>;
  byOption: Map<string, CrmClientRow>;
}

/** Choice options: every client name when there are ≤254, else only the plausible ones, plus "none". */
export function clientOptions(clients: CrmClientRow[], candidates: CrmClientRow[]): ClientOptions | null {
  if (candidates.length === 0) return null;
  const pool = clients.length <= 254 ? clients : candidates.slice(0, 254);
  const criteria: Record<string, string | null> = {};
  const byOption = new Map<string, CrmClientRow>();
  for (const client of pool) {
    let key = client.name.trim().slice(0, 120) || client.id;
    if (key.toLowerCase() === NONE_OPTION || byOption.has(key)) key = `${key} (${client.kind === "company" ? "company" : "person"})`;
    if (byOption.has(key)) key = `${key} ${client.id.slice(0, 6)}`;
    byOption.set(key, client);
    const domain = cleanDomain(client.domain);
    criteria[key] = client.kind === "company" ? (domain ? `Company (${domain})` : "Company") : "Person";
  }
  criteria[NONE_OPTION] = "The mail is not from or about any of these clients.";
  return { criteria, byOption };
}

// ---------------------------------------------------------------------------
// Jev
// ---------------------------------------------------------------------------

export function triageQuestions(options: ClientOptions | null): JevQuestions {
  const questions: JevQuestions = {
    category: {
      type: "choice",
      instructions: "What kind of email is this, for a small digital agency's shared inbox?",
      criteria: { ...CATEGORY_RUBRICS },
    },
    urgency: {
      type: "score",
      instructions: "How soon does this email need attention from the agency?",
      criteria: URGENCY_LEVELS,
    },
    needs_reply: {
      type: "noul",
      instructions: "Does this email need a written reply from us?",
      criteria: {
        true: "A person asks a question, asks for something, or expects an answer.",
        false: "Automated, bulk or informational mail, or a thank-you that needs no answer.",
      },
    },
    phishing: {
      type: "noul",
      instructions: "Is this email likely phishing or a scam?",
      criteria: {
        true: "Asks for passwords, codes or changed bank details, pushes an urgent payment, or links to a lookalike login page; the sender domain does not match who it claims to be.",
        false: "Ordinary mail from a plausible sender.",
      },
    },
  };
  if (options) {
    questions.client = {
      type: "choice",
      instructions: "Which of our clients is this email from or about?",
      criteria: options.criteria,
    };
  }
  return questions;
}

/** The only data Jev sees. */
export function triageState(row: MessageRow, flags: { isReply: boolean; knownClient: boolean }) {
  return {
    fromDomain: emailDomain(row.from_addr?.email ?? null),
    subject: (row.subject ?? "").slice(0, 300),
    snippet: (row.snippet ?? "").slice(0, 500),
    attachments: (row.attachments ?? []).slice(0, 10).map((a) => ({ name: a.filename.slice(0, 120), type: a.mime })),
    bulk: Boolean(row.bulk),
    repliesToOurMail: flags.isReply,
    fromKnownClient: flags.knownClient,
  };
}

function round(value: number | null): number | null {
  return value == null || !Number.isFinite(value) ? null : Math.round(value * 1000) / 1000;
}

function numberOf(answer: JevAnswer | undefined, type: "noul" | "score"): number | null {
  if (!answer || answer.type !== type) return null;
  return round(type === "noul" ? (answer as { noul: number }).noul : (answer as { score: number }).score);
}

export interface Deterministic {
  client: (CrmClientRow & { source: "email" | "domain" | "reply" }) | null;
  replyTo: SendContext | null;
}

/** Combines deterministic facts, the Jev answers (or null) and the rules into what is stored. */
export function combineTriage(input: {
  facts: TriageFacts;
  deterministic: Deterministic;
  result: DecisionResult | null;
  options: ClientOptions | null;
  labelPrefix: string;
}): StoredTriage {
  const { facts, deterministic, result, options } = input;
  const answers = result?.answers ?? {};
  const rules = ruleCategory(facts);
  let category: MailCategory = rules;
  let confidence: number | null = null;
  let source: StoredTriage["source"] = deterministic.replyTo && rules === "reply" ? "reply" : "rules";
  const categoryAnswer = answers.category;
  if (categoryAnswer?.type === "choice" && isCategory(categoryAnswer.choice) && shouldAct(categoryAnswer, "read")) {
    category = categoryAnswer.choice;
    confidence = round(confidenceOf(categoryAnswer));
    source = "jev";
  } else if (deterministic.replyTo && rules === "reply") {
    confidence = 1;
  }

  let client: StoredTriage["clientKind"] = deterministic.client?.kind ?? null;
  let clientRef = deterministic.client?.id ?? null;
  let clientName = deterministic.client?.name ?? null;
  let clientSource: StoredTriage["clientSource"] = deterministic.client?.source ?? null;
  const clientAnswer = answers.client;
  if (!clientRef && options && clientAnswer?.type === "choice" && clientAnswer.choice !== NONE_OPTION && shouldAct(clientAnswer, "update")) {
    const picked = options.byOption.get(clientAnswer.choice);
    if (picked) {
      client = picked.kind;
      clientRef = picked.id;
      clientName = picked.name;
      clientSource = "jev";
    }
  }

  const needsReply = result ? numberOf(answers.needs_reply, "noul") : ruleNeedsReply(category, facts);
  const urgency = result ? numberOf(answers.urgency, "score") : null;
  const phishing = result ? numberOf(answers.phishing, "noul") : null;
  const triage: StoredTriage = {
    category,
    urgency,
    needsReply,
    phishing,
    confidence,
    clientKind: client,
    clientRef,
    clientName,
    source,
    clientSource,
    decisionIds: result?.ids ?? {},
    model: result?.model ?? null,
    labels: [],
  };
  triage.labels = triageLabels(input.labelPrefix, triage);
  return triage;
}

/** Gmail label names for a triage: category, needs reply, suspicious. */
export function triageLabels(prefix: string, triage: Pick<StoredTriage, "category" | "needsReply" | "phishing">): string[] {
  const labels: string[] = [];
  const name = triage.category ? CATEGORY_LABELS[triage.category] : null;
  if (name) labels.push(`${prefix}/${name}`);
  if (triage.needsReply != null && triage.needsReply >= RISK_THRESHOLDS.update && triage.category !== "spam") labels.push(`${prefix}/Needs reply`);
  if (triage.phishing != null && triage.phishing >= 0.9) labels.push(`${prefix}/Suspicious`);
  return labels;
}

/** Every label name the triage can apply, so a correction can remove the old ones. */
export function allTriageLabels(prefix: string): string[] {
  return [
    ...Object.values(CATEGORY_LABELS).filter((v): v is string => Boolean(v)).map((name) => `${prefix}/${name}`),
    `${prefix}/Needs reply`,
    `${prefix}/Suspicious`,
  ];
}

// ---------------------------------------------------------------------------
// Deterministic lookups
// ---------------------------------------------------------------------------

export async function clientFromSender(store: GmailStore, companyId: string, fromEmail: string | null): Promise<Deterministic["client"]> {
  if (!fromEmail) return null;
  const contacts = await store.crmContactsByEmail(companyId, fromEmail);
  const contact = contacts[0];
  if (contact) {
    for (const accountId of contact.accountIds) {
      const company = await store.crmCompany(companyId, accountId);
      if (company) return { ...company, source: "email" };
    }
    return { ...contact, source: "email" };
  }
  const domain = emailDomain(fromEmail);
  if (!isFreeMailDomain(domain)) {
    const companies = await store.crmCompaniesByDomain(companyId, domain!);
    if (companies[0]) return { ...companies[0], source: "domain" };
  }
  return null;
}

/**
 * The context of the message this one answers (or bounced): by In-Reply-To /
 * References / the bounced Message-ID, then by thread, then (bounces) by the
 * failed recipient.
 */
export async function replyContextFor(store: GmailStore, companyId: string, row: MessageRow): Promise<SendContext | null> {
  const ids = [...new Set([row.in_reply_to, ...(row.refs ?? []), ...(row.bounce?.rfcIds ?? [])].filter((v): v is string => Boolean(v)))];
  if (ids.length > 0) {
    const sends = await store.sendsByRfcIds(companyId, ids);
    if (sends[0]?.context) return sends[0].context;
    const outbound = await store.outboundByRfcIds(companyId, ids);
    const withContext = outbound.find((m) => m.sent_context);
    if (withContext?.sent_context) return withContext.sent_context;
  }
  if (row.gmail_thread_id) {
    const send = await store.sendByThread(companyId, row.gmail_thread_id);
    if (send?.context) return send.context;
    const outbound = await store.outboundInThread(companyId, row.gmail_thread_id);
    if (outbound?.sent_context) return outbound.sent_context;
  }
  for (const email of row.bounce?.recipients ?? []) {
    const send = await store.sendToRecipient(companyId, email);
    if (send?.context) return send.context;
  }
  return null;
}

export interface TriageRunContext {
  jev: DecisionClientConfig | null;
  labelPrefix: string;
  /** Loaded once per run per company. */
  clients: () => Promise<CrmClientRow[]>;
}

/** Triage one stored inbound message and save the result. */
export async function triageMessage(env: Env, run: TriageRunContext, row: MessageRow): Promise<StoredTriage> {
  const companyId = row.company_id;
  const fromEmail = row.from_addr?.email ?? null;
  const replyTo = await replyContextFor(env.store, companyId, row);
  let client = await clientFromSender(env.store, companyId, fromEmail);
  if (!client && replyTo?.clientRef) {
    client = {
      kind: replyTo.clientKind === "contact" ? "contact" : "company",
      id: replyTo.clientRef,
      name: "",
      domain: null,
      emails: [],
      accountIds: [],
      source: "reply",
    };
  }
  const facts: TriageFacts = {
    subject: row.subject ?? "",
    snippet: row.snippet ?? "",
    fromEmail,
    bulk: Boolean(row.bulk),
    attachments: (row.attachments ?? []).map((a) => ({ filename: a.filename, mime: a.mime })),
    isReply: Boolean(replyTo),
    hasClient: Boolean(client),
    bounce: Boolean(row.bounce),
  };
  let options: ClientOptions | null = null;
  if (!client && run.jev) {
    try {
      const clients = await run.clients();
      options = clientOptions(clients, plausibleClients(clients, { subject: facts.subject, snippet: facts.snippet, fromDomain: emailDomain(fromEmail) }));
    } catch (error) {
      env.ctx.logger.info("CRM client list unavailable for triage", { error: error instanceof Error ? error.message : String(error) });
    }
  }
  const result = run.jev
    ? await decide(env.ctx, companyId, {
        config: run.jev,
        purpose: TRIAGE_PURPOSE,
        subject: { kind: "message", id: row.id },
        state: triageState(row, { isReply: facts.isReply, knownClient: facts.hasClient }),
        questions: triageQuestions(options),
        acting: options ? ["category", "client"] : ["category"],
        fetchImpl: env.jevFetch,
      })
    : null;
  const triage = combineTriage({ facts, deterministic: { client, replyTo }, result, options, labelPrefix: run.labelPrefix });
  if (triage.clientRef && !triage.clientName && triage.clientKind === "company") {
    triage.clientName = (await env.store.crmCompany(companyId, triage.clientRef))?.name ?? null;
  }
  const write: TriageWrite = {
    triage,
    category: triage.category,
    urgency: triage.urgency,
    needsReply: triage.needsReply,
    phishing: triage.phishing,
    clientKind: triage.clientKind,
    clientRef: triage.clientRef,
    replyTo,
  };
  await env.store.setTriage(companyId, row.id, write);
  Object.assign(row, {
    triage,
    triaged_at: new Date(env.now()).toISOString(),
    category: triage.category,
    urgency: triage.urgency,
    needs_reply: triage.needsReply,
    phishing: triage.phishing,
    client_kind: triage.clientKind,
    client_ref: triage.clientRef,
    reply_to: replyTo,
  });
  return triage;
}
