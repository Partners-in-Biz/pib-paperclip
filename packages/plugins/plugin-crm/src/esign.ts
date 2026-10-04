/**
 * E-sign acceptance (audit Q1b-11, Q10-14): a proposal, quote or simple agreement a client signs online.
 *
 * No new vendor and no legal advice. A signature here is a typed name given with explicit consent: a basic electronic
 * signature under the South African ECT Act, and the pages and copies say so and never claim an advanced one. The
 * templates are drafts nobody has had reviewed by a lawyer (`esign-templates.ts`), which is why e-sign refuses every
 * client but the canary until a person turns it on for that client.
 *
 * The life of a document:
 *   draft -> awaiting_approval -> sent -> viewed -> signed | declined | expired, or void at any point before a signature.
 * - `create-sign-document` freezes the text (Markdown) and its SHA-256, and records the exact consent wording.
 * - `send-for-signature` opens the usual client-email approval (the Reviewer, then a person). The email carries a
 *   placeholder: the private link is made only when a person approves, so the approval, the issues and every CRM tool result
 *   show a placeholder, never the link. The finished email does carry it: it is queued in the CRM's outbox (blanked once the Mailbox
 *   answers) and kept by the Mailbox as the sent message, so no agent may read, open, forward or sign from a signing email.
 *   A reminder is another approval; nothing is ever sent by itself.
 * - The client opens the page (`esign-link.ts`, `esign-public.ts`), types their name, ticks the consent box and signs.
 * - Signing records the typed name, time, a keyed hash of the network address, the browser and the text's SHA-256 in a
 *   hash-chained audit trail (`esign-audit.ts`), then: the signed copy is stored as an issue document and on the deal, the deal
 *   moves to won, `deal.accepted` (and `quote.accepted` for a quote) goes to Billing, and the signed copy is drafted as an
 *   email for approval.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { formatMoneyMinor, readConfig, type HealthCheck, type SetupItem } from "@partnersinbiz/pib-plugin-kit";
import { isCanaryId } from "./canary-flag.js";
import { approvalsOfSubject, type ApprovalRecord, type ClientKey } from "./care-store.js";
import { clientContacts, clientInfo, clientProjectOf, firstName, logOnClient, pickRecipient } from "./care-clients.js";
import { getDeal, insertActivityOnce, listStages, saveDeal, stageKind } from "./db.js";
import { CrmError, type Viewer } from "./domain.js";
import { appendEvent, loadTrail } from "./esign-audit.js";
import { generatePageId, pagesWritable } from "./esign-pages.js";
import {
  consentTextFor,
  dateLabel,
  dateTimeLabel,
  displayDraftText,
  markdownToHtml,
  markdownToText,
  normaliseContent,
  renderSignedHtml,
  renderSignedMarkdown,
  sha256Hex,
  SIGNING_LINK_TOKEN,
  VALID_UNTIL_TOKEN,
  brandOf,
} from "./esign-render.js";
import { docBrand, mintLink, NO_SIGN_ADDRESS_NOTE, publishPage, signedFactsOf, signUrls, SigningAddressUnknown, signingLink } from "./esign-link.js";
import {
  deleteEsignClient,
  docByIssue,
  docsByStatus,
  docsNeedingEffects,
  DOC_KINDS,
  DOC_STATUSES,
  getDoc,
  getEsignClient,
  insertDoc,
  listDocs,
  listEsignClients,
  moveDoc,
  patchDoc,
  putEsignClient,
  revokeTokens,
  revokeTokensOfApproval,
  tokenHash,
  type DocKind,
  type EsignClient,
  type SignDocument,
} from "./esign-store.js";
import { DEFAULT_VALID_DAYS, ESIGN_REMIND_AFTER_DAYS, MAX_CONTENT_CHARS, MAX_ESIGN_REMINDERS, MAX_VALID_DAYS, MIN_CONTENT_CHARS, renderTemplate, TEMPLATE_KEYS, TEMPLATE_NOTICE, TEMPLATE_VERSION, TEMPLATES, templateSource } from "./esign-templates.js";
import { moveDealTo, sendHandoff } from "./handoffs.js";
import { parseClientRef, requireClient, visibleClients } from "./lookup.js";
import { openIssueOnce } from "./mail.js";
import { originFor } from "./origins.js";
import { approvalLink, RecipientRefused, requestApproval, withdrawOpenApprovals, type MailApprovalHooks, type MailDraft } from "./outbound.js";
import { brandName, companyPrefix, crmLink, issueLink, refOf } from "./refs.js";
import { teamAssignee } from "./routing.js";
import { getClientProfile } from "./store.js";

const DAY_MS = 86_400_000;

export { ESIGN_REMIND_AFTER_DAYS, MAX_ESIGN_REMINDERS };

/** The issue document names. The agreement is the text a person reads before approving the email; the signed copy is the record. */
export const AGREEMENT_DOC_KEY = "agreement";
export const SIGNED_COPY_DOC_KEY = "signed-copy";

export const DEAL_ACCEPTED_EVENT = "deal.accepted";
export const QUOTE_ACCEPTED_BY_SIGNATURE_EVENT = "quote.accepted";

function actorOf(viewer: Viewer): string {
  return viewer.agentId ? `agent:${viewer.agentId}` : viewer.userId ? `user:${viewer.userId}` : "system";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clamp(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim().slice(0, max) : null;
}

// ---------------------------------------------------------------------------
// Who may use it
// ---------------------------------------------------------------------------

export interface EsignAccess {
  /** The canary client: always allowed, and everything about it is a dry run. */
  canary: boolean;
  /** The owner turned it on for this client. */
  enabled: EsignClient | null;
  allowed: boolean;
}

export async function esignAccess(ctx: PluginContext, companyId: string, client: ClientKey): Promise<EsignAccess> {
  const canary = isCanaryId(client.id);
  const enabled = await getEsignClient(ctx, companyId, client);
  return { canary, enabled, allowed: canary || Boolean(enabled) };
}

export const OFF_NOTE = (name: string) =>
  `E-sign is only on for the canary client until the owner turns it on for ${name}. The templates are drafts nobody has had reviewed by a lawyer, so the owner decides per client. Put a Needs-you item on the client (CRM, open the client, Agreements, "Turn on e-sign"; the steps are in Setup, CRM, E-sign acceptance) and carry on with the rest of the work.`;

/** Turns e-sign on for a client. A person only (the board action `crm.enable-esign`): it is the owner's gate, so an agent cannot open it. */
export async function enableEsign(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>, source: "agent" | "human") {
  if (source !== "human" || viewer.agentId || !viewer.userId) throw new CrmError("Only a person can turn e-sign on for a client: it is the owner's decision. Put a Needs-you item on the client.");
  const client = parseClientRef(params.client);
  const name = await requireClient(ctx, viewer, client);
  if (isCanaryId(client.id)) return { client: refOf(client.kind, client.id), enabled: true, note: "The canary client always has e-sign; nothing to turn on." };
  if (params.confirm !== true) throw new CrmError(`Turning on e-sign lets agents prepare documents for ${name} to sign. Pass confirm true to turn it on.`);
  const existing = await getEsignClient(ctx, viewer.companyId, client);
  if (existing) return { client: refOf(client.kind, client.id), enabled: true, enabledBy: existing.enabledBy, note: "E-sign was already on for this client." };
  await putEsignClient(ctx, viewer.companyId, client, { enabledBy: `user:${viewer.userId}`, templatesReviewed: params.templatesReviewed === true, note: clamp(params.note, 500) });
  await logOnClient(ctx, viewer.companyId, client, "note", `E-sign was turned on for ${name}. Documents are sent only through an approved email.`, `care:esign:enabled:${client.kind}:${client.id}`);
  return { client: refOf(client.kind, client.id), enabled: true, templatesReviewed: params.templatesReviewed === true, version: TEMPLATE_VERSION };
}

export async function disableEsign(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>, source: "agent" | "human") {
  if (source !== "human" || viewer.agentId || !viewer.userId) throw new CrmError("Only a person can turn e-sign off for a client.");
  const client = parseClientRef(params.client);
  await requireClient(ctx, viewer, client);
  const removed = await deleteEsignClient(ctx, viewer.companyId, client);
  return { client: refOf(client.kind, client.id), enabled: false, changed: removed, note: "Documents already sent stay as they are; no new document can be made or sent for this client." };
}

// ---------------------------------------------------------------------------
// Brand and wording
// ---------------------------------------------------------------------------

/** The sender's look for a document: the company's `documents` settings, or the client's own brand kit when asked. */
async function documentBrand(ctx: PluginContext, companyId: string, client: ClientKey, which: "sender" | "client"): Promise<Record<string, unknown>> {
  const config = await readConfig(ctx, companyId).catch(() => ({} as Record<string, unknown>));
  const docs = (config.documents && typeof config.documents === "object" ? config.documents : {}) as Record<string, unknown>;
  const name = (await brandName(ctx, companyId)) ?? "Partners in Biz";
  const profile = which === "client" ? await getClientProfile(ctx, companyId, client.kind, client.id).catch(() => null) : null;
  const brand = brandOf({
    name,
    primary: profile?.primaryColor ?? docs.primaryColor,
    accent: profile?.accentColor ?? profile?.secondaryColor ?? docs.accentColor,
    logoUrl: docs.logoUrl,
    footer: docs.footer,
  });
  return { ...brand };
}

export interface EmailInput {
  kind: "request" | "reminder" | "copy";
  title: string;
  recipientName: string;
  brand: string | null;
  /** 1 or 2 for the reminders. */
  reminder?: number;
  signedAt?: string | null;
  signedCopyText?: string | null;
}

/** The email for each message. The request and the reminder carry two placeholders (the link and its date), filled when the approved email is sent. */
export function esignEmail(input: EmailInput): { subject: string; text: string } {
  const first = firstName(input.recipientName);
  const from = input.brand ?? "The team";
  if (input.kind === "copy") {
    return {
      subject: `Signed: ${input.title}`,
      text: [
        `Hi ${first || "there"},`,
        "",
        `Thank you for signing "${input.title}"${input.signedAt ? ` on ${dateLabel(input.signedAt)}` : ""}. A copy of the signed document is below. Please keep this email for your records.`,
        "",
        "---",
        "",
        input.signedCopyText ?? "",
        "",
        "---",
        "",
        "Kind regards,",
        from,
      ].join("\n"),
    };
  }
  const lead = input.kind === "reminder" ? `A friendly reminder: "${input.title}" is still waiting for your signature.` : `${from} has prepared "${input.title}" for you to read and sign online.`;
  return {
    subject: input.kind === "reminder" ? `Reminder: please sign ${input.title}` : `Please read and sign: ${input.title}`,
    text: [
      `Hi ${first || "there"},`,
      "",
      lead,
      "",
      `Open it here: ${SIGNING_LINK_TOKEN}`,
      "",
      `You can read the whole document first, then sign by typing your name and ticking the box. The link is private to you and works until ${VALID_UNTIL_TOKEN}. Please do not forward it: anyone who has the whole link can sign.`,
      "",
      "If anything is not right, reply to this email instead of signing and we will change it.",
      "",
      "Kind regards,",
      from,
    ].join("\n"),
  };
}

const CHECKS = [
  "The text below is what the client will be asked to sign. Read it (the full text is the agreement document on the work issue): the scope, the price and the terms are right for this client, and nothing in it is about another client.",
  "The email is short, friendly and clear about what the client has to do. The link is added by the system when a person approves; it is not in this draft.",
  "The recipient is the right person at this client and can sign for them.",
  "No promise of results, no legal claim beyond the document, and nothing that calls this anything but an electronic signature with a typed name.",
];

// ---------------------------------------------------------------------------
// The status line
// ---------------------------------------------------------------------------

/** One plain sentence on where a document is, for the page, the tools and the issue. */
export function statusLine(doc: Pick<SignDocument, "status" | "recipientName" | "sentAt" | "viewCount" | "lastViewedAt" | "expiresAt" | "signedAt" | "signerName" | "declinedAt" | "declineReason" | "expiredAt" | "voidedAt" | "voidReason" | "reminders">): string {
  const who = doc.recipientName ?? "the client";
  const expires = doc.expiresAt ? ` Link works until ${dateLabel(doc.expiresAt)}.` : "";
  const reminders = doc.reminders > 0 ? ` ${doc.reminders} reminder${doc.reminders === 1 ? "" : "s"} sent.` : "";
  switch (doc.status) {
    case "draft":
      return "Draft: not sent. Nothing has gone to the client.";
    case "awaiting_approval":
      return "Waiting for a person to approve the email that sends the signing link. Nothing has gone to the client yet.";
    case "sent":
      return `Sent to ${who}${doc.sentAt ? ` on ${dateLabel(doc.sentAt)}` : ""}, not opened yet.${expires}${reminders}`;
    case "viewed":
      return `Opened ${doc.viewCount} time${doc.viewCount === 1 ? "" : "s"}${doc.lastViewedAt ? `, last on ${dateLabel(doc.lastViewedAt)}` : ""}. Not signed yet.${expires}${reminders}`;
    case "signed":
      return `Signed by ${doc.signerName ?? who}${doc.signedAt ? ` on ${dateTimeLabel(doc.signedAt)}` : ""}.`;
    case "declined":
      return `Declined${doc.declinedAt ? ` on ${dateLabel(doc.declinedAt)}` : ""}${doc.declineReason ? `: ${doc.declineReason}` : ""}.`;
    case "expired":
      return `Expired${doc.expiredAt ? ` on ${dateLabel(doc.expiredAt)}` : ""} without a signature. Send it again to give it a new link.`;
    case "void":
      return `Withdrawn${doc.voidedAt ? ` on ${dateLabel(doc.voidedAt)}` : ""}${doc.voidReason ? `: ${doc.voidReason}` : ""}.`;
  }
}

// ---------------------------------------------------------------------------
// Making a document
// ---------------------------------------------------------------------------

function parseValidDays(value: unknown): number {
  if (value == null || value === "") return DEFAULT_VALID_DAYS;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_VALID_DAYS) throw new CrmError(`validDays must be a whole number from 1 to ${MAX_VALID_DAYS}`);
  return n;
}

/** The deal must belong to this company and this client (its company or one of its people): a document never attaches to someone else's deal. */
async function checkDeal(ctx: PluginContext, companyId: string, client: ClientKey, dealId: string): Promise<{ title: string; amountMinor: number; currency: string }> {
  const deal = await getDeal(ctx, dealId);
  if (!deal || deal.companyId !== companyId) throw new CrmError("That deal was not found (list-deals shows them)");
  const ours = client.kind === "company" ? deal.accountId === client.id : deal.contactId === client.id;
  if (!ours) {
    const people = client.kind === "company" ? await clientPeopleIds(ctx, companyId, client) : new Set<string>();
    if (!(deal.accountId == null && deal.contactId != null && people.has(deal.contactId))) throw new CrmError("That deal belongs to another client. A document can only be attached to its own client's deal.");
  }
  return { title: deal.title, amountMinor: deal.amountMinor, currency: deal.currency };
}

async function clientPeopleIds(ctx: PluginContext, companyId: string, client: ClientKey): Promise<Set<string>> {
  return new Set((await clientContacts(ctx, companyId, client)).map((person) => person.id));
}

export async function createSignDocumentTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const client = parseClientRef(params.client);
  const name = await requireClient(ctx, viewer, client);
  const access = await esignAccess(ctx, viewer.companyId, client);
  if (!access.allowed) throw new CrmError(OFF_NOTE(name));

  const templateKey = clamp(params.template, 40);
  if (templateKey && !TEMPLATE_KEYS.includes(templateKey)) throw new CrmError(`template must be one of ${TEMPLATE_KEYS.join(", ")} (sign-templates shows what each is for)`);
  const bodyMarkdown = typeof params.bodyMarkdown === "string" ? params.bodyMarkdown : null;
  if (!templateKey && !bodyMarkdown) throw new CrmError("Give a template (proposal, quote or service-agreement) or the text yourself as bodyMarkdown");
  if (templateKey && bodyMarkdown) throw new CrmError("Give a template or bodyMarkdown, not both");
  const kindParam = clamp(params.kind, 20);
  if (kindParam && !(DOC_KINDS as readonly string[]).includes(kindParam)) throw new CrmError(`kind must be one of ${DOC_KINDS.join(", ")}`);
  const validDays = parseValidDays(params.validDays);
  const dealId = clamp(params.dealId, 80);
  const deal = dealId ? await checkDeal(ctx, viewer.companyId, client, dealId) : null;
  const { contact, email } = await pickRecipient(ctx, viewer.companyId, client, {
    contactId: typeof params.contactId === "string" ? params.contactId : null,
    toEmail: typeof params.toEmail === "string" ? params.toEmail : null,
  });

  const company = (await brandName(ctx, viewer.companyId)) ?? "Partners in Biz";
  const config = await readConfig(ctx, viewer.companyId).catch(() => ({} as Record<string, unknown>));
  const currencyRaw = clamp(params.currency, 3)?.toUpperCase() ?? deal?.currency ?? (typeof config.defaultCurrency === "string" ? config.defaultCurrency : "ZAR");
  if (!/^[A-Z]{3}$/.test(currencyRaw)) throw new CrmError("currency must be a 3-letter code, e.g. ZAR");

  let markdown: string;
  let kind: DocKind;
  let title = clamp(params.title, 160);
  let totalMinor: number | null = null;
  if (templateKey) {
    const vars = params.variables && typeof params.variables === "object" && !Array.isArray(params.variables) ? (params.variables as Record<string, unknown>) : {};
    const rendered = renderTemplate(templateKey, {
      title: title ?? deal?.title ?? `Services for ${name}`,
      clientName: name,
      companyName: company,
      currency: currencyRaw,
      validLine: `Valid for ${validDays} days from the day it is sent.`,
      vars,
      money: formatMoneyMinor,
    });
    markdown = rendered.markdown;
    title = rendered.docTitle;
    kind = rendered.kind;
    totalMinor = rendered.totalMinor;
  } else {
    if (!kindParam) throw new CrmError(`kind is required with bodyMarkdown (${DOC_KINDS.join(", ")})`);
    if (!title) throw new CrmError("title is required with bodyMarkdown");
    kind = kindParam as DocKind;
    if (bodyMarkdown!.length > MAX_CONTENT_CHARS) throw new CrmError(`The document is too long (${MAX_CONTENT_CHARS} characters at most)`);
    markdown = /^\s*#\s/.test(bodyMarkdown!) ? bodyMarkdown! : `# ${title}\n\n${bodyMarkdown}`;
  }
  const content = normaliseContent(markdown);
  if (content.length < MIN_CONTENT_CHARS) throw new CrmError("The document is too short to sign: write what the client is agreeing to");
  if (content.length > MAX_CONTENT_CHARS) throw new CrmError(`The document is too long (${MAX_CONTENT_CHARS} characters at most)`);
  if (/\{\{[a-z_]+\}\}/.test(content)) throw new CrmError("The document still has {{placeholders}} in it: fill every one before it can be signed");

  const valueMinor = Number.isInteger(Number(params.valueMinor)) && Number(params.valueMinor) >= 0 && params.valueMinor != null ? Number(params.valueMinor) : totalMinor ?? deal?.amountMinor ?? null;
  const brand = await documentBrand(ctx, viewer.companyId, client, params.brand === "client" ? "client" : "sender");
  const id = randomUUID();
  const consentText = consentTextFor({ title: title!, companyName: company });
  const doc = {
    id,
    companyId: viewer.companyId,
    clientKind: client.kind,
    clientRef: client.id,
    dealId: dealId ?? null,
    quoteId: clamp(params.quoteId, 120),
    quoteNumber: clamp(params.quoteNumber, 60),
    kind,
    title: title!,
    templateKey: templateKey ?? null,
    templateVersion: templateKey ? TEMPLATE_VERSION : null,
    templateReviewed: access.enabled?.templatesReviewed === true,
    content,
    contentSha256: sha256Hex(content),
    consentText,
    consentSha256: sha256Hex(consentText),
    valueMinor,
    currency: valueMinor == null ? null : currencyRaw,
    brand,
    pageId: generatePageId(),
    recipientContactId: contact.id,
    recipientName: contact.name,
    recipientEmail: email,
    validDays,
    createdBy: actorOf(viewer),
  };
  await insertDoc(ctx, doc);
  await appendEvent(ctx, doc, { kind: "created", actor: actorOf(viewer), detail: { documentKind: kind, template: templateKey ?? null, templateVersion: doc.templateVersion, contentSha256: doc.contentSha256, valueMinor, currency: doc.currency, dealId: doc.dealId, quoteId: doc.quoteId } });
  await logOnClient(ctx, viewer.companyId, client, "note", `Prepared "${title}" for ${name} to sign. It has not been sent.`, `care:esign:${id}:created`);
  const prefix = await companyPrefix(ctx, viewer.companyId);
  return {
    documentId: id,
    client: refOf(client.kind, client.id),
    kind,
    title,
    status: "draft" as const,
    statusLine: statusLine({ ...blankView(), status: "draft" }),
    to: `${contact.name} <${email}>`,
    contentSha256: doc.contentSha256,
    characters: content.length,
    templateVersion: doc.templateVersion,
    templateReviewed: doc.templateReviewed,
    ...(templateKey && !doc.templateReviewed ? { templateNote: "No lawyer has marked these templates as reviewed for this client. The owner accepted that when e-sign was turned on; do not describe the document as legally checked." } : {}),
    preview: content.slice(0, 600),
    ...(access.canary ? { canary: true } : {}),
    clientPage: crmLink(prefix, client.kind, client.id),
    next: "Read the whole text (get-sign-document with includeContent true). The text is frozen when it is sent. When it is right, send-for-signature opens the email for approval.",
  };
}

function blankView() {
  return { recipientName: null, sentAt: null, viewCount: 0, lastViewedAt: null, expiresAt: null, signedAt: null, signerName: null, declinedAt: null, declineReason: null, expiredAt: null, voidedAt: null, voidReason: null, reminders: 0 };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

async function requireDoc(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>): Promise<{ doc: SignDocument; name: string }> {
  const id = clamp(params.documentId, 80);
  if (!id) throw new CrmError("documentId is required (list-sign-documents shows the ids)");
  const doc = await getDoc(ctx, viewer.companyId, id);
  if (!doc) throw new CrmError("That document was not found (list-sign-documents shows the ids)");
  const name = await requireClient(ctx, viewer, { kind: doc.clientKind, id: doc.clientRef });
  return { doc, name };
}

/** The issue that holds the document: opened once (origin `crm:esign:<id>`), in the client's own project. */
async function ensureWorkIssue(ctx: PluginContext, doc: SignDocument, clientName: string): Promise<string> {
  if (doc.issueId) return doc.issueId;
  const client = { kind: doc.clientKind, id: doc.clientRef };
  const prefix = await companyPrefix(ctx, doc.companyId);
  const issueId = await openIssueOnce(ctx, {
    companyId: doc.companyId,
    originId: originFor.esign(doc.id),
    title: `Get "${doc.title}" signed by ${clientName}`.slice(0, 200),
    description: [
      `"${doc.title}" was prepared for ${clientName} to sign online (document \`${doc.id}\`, ${doc.kind}).`,
      "",
      "A person approves the email that sends the signing link; nothing goes to the client before that. After it is sent the status is on this issue and in `get-sign-document`. Reminders are drafted for approval after " + ESIGN_REMIND_AFTER_DAYS + " days, up to " + MAX_ESIGN_REMINDERS + ".",
      "",
      "- **Never** copy, paste or ask for the signing link, and never open, forward or sign from the signing email: the link is made when a person approves the email, no CRM tool shows it, but the email itself carries it (the client's inbox, and the Mailbox's record of what it sent).",
      "- When it is signed this issue gets the signed copy (document `" + SIGNED_COPY_DOC_KEY + "`), the deal moves to won, and Billing is told so it can draft the invoice.",
      "- If the client replies, answer from the Mailbox (a person approves sending).",
      "",
      "**Done when** the document is signed, declined or withdrawn (`void-sign-document`). Closing checks it.",
      `Client: ${crmLink(prefix, client.kind, client.id)}`,
    ].join("\n"),
    assignee: await teamAssignee(ctx, doc.companyId, "deal-desk"),
    wakeReason: "A document needs signing",
    projectId: await clientProjectOf(ctx, doc.companyId, client),
  });
  await patchDoc(ctx, doc.companyId, doc.id, { issueId });
  return issueId;
}

/** Puts the text on the work issue where a person can read all of it before approving. Never fails the caller: the approval carries an excerpt too. */
async function writeIssueDocument(ctx: PluginContext, doc: SignDocument, issueId: string, key: string, title: string, markdown: string): Promise<boolean> {
  try {
    await ctx.issues.documents.delete(issueId, key, doc.companyId);
    await ctx.issues.documents.upsert({ issueId, companyId: doc.companyId, key, title, format: "markdown", body: markdown, changeSummary: key === AGREEMENT_DOC_KEY ? "The text the client is asked to sign" : "The signed copy" });
    return true;
  } catch (error) {
    ctx.logger.info("CRM e-sign issue document not saved", { documentId: doc.id, key, error: message(error) });
    return false;
  }
}

export async function sendForSignatureTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>, source: "agent" | "human") {
  const { doc, name } = await requireDoc(ctx, viewer, params);
  const client = { kind: doc.clientKind, id: doc.clientRef };
  const access = await esignAccess(ctx, viewer.companyId, client);
  if (!access.allowed) throw new CrmError(OFF_NOTE(name));
  // No approval for a link that cannot open: the plugin must know its public address first (the same rule as the lead form and the event snippet).
  if (!(await signUrls(ctx, viewer.companyId))) throw new CrmError(NO_SIGN_ADDRESS_NOTE);
  if (doc.status !== "draft" && doc.status !== "expired") {
    throw new CrmError(doc.status === "awaiting_approval" ? "This document is already waiting for the email to be approved." : `This document is ${doc.status}: ${statusLine(doc)} Only a draft, or an expired document, can be sent.`);
  }
  const { contact, email } = await pickRecipient(ctx, viewer.companyId, client, { contactId: doc.recipientContactId, toEmail: doc.recipientEmail });
  const won = await moveDoc(ctx, doc.companyId, doc.id, ["draft", "expired"], { status: "awaiting_approval", expiresAt: null, recipientContactId: contact.id, recipientName: contact.name, recipientEmail: email });
  if (!won) throw new CrmError("The document changed while you were sending it. Look at it again with get-sign-document.");
  const fresh = (await getDoc(ctx, doc.companyId, doc.id)) ?? doc;
  const issueId = await ensureWorkIssue(ctx, fresh, name);
  const saved = await writeIssueDocument(ctx, fresh, issueId, AGREEMENT_DOC_KEY, `${fresh.title} (the text to be signed)`, fresh.content);
  const mail = esignEmail({ kind: "request", title: fresh.title, recipientName: contact.name, brand: await brandName(ctx, doc.companyId) });
  const earlier = await approvalsOfSubject(ctx, doc.companyId, "esign_request", doc.id);
  const excerpt = fresh.content.length > 2_500 ? `${fresh.content.slice(0, 2_500)}\n\n[the rest is in the agreement document on the work issue]` : fresh.content;
  const opened = await requestApproval(ctx, {
    companyId: doc.companyId,
    kind: "esign_request",
    client,
    subjectId: doc.id,
    seq: earlier.length + 1,
    title: `Approve signing link for ${name}: ${fresh.title}`,
    intro: [
      `${source === "agent" ? "An agent" : "A person"} wants to send ${name} the ${fresh.kind} **${fresh.title}** to sign online. Approving sends ONE email with a private signing link that is made at that moment. The link is not in this draft and no CRM tool shows it, but the email that goes out carries it: no agent should open, forward or sign from it.`,
      `Document fingerprint (SHA-256): \`${fresh.contentSha256}\`. ${fresh.templateKey ? `Made from the ${fresh.templateKey} template, version ${fresh.templateVersion}. ${fresh.templateReviewed ? "" : "**Not reviewed by a lawyer.** "}` : "Written by hand, not from a template. "}A signature is a typed name with consent (a basic electronic signature). ${saved ? "" : "(The full text could not be saved on the work issue, so read the excerpt below.)"}`,
      "",
      "**The text the client will be asked to sign:**",
      "",
      excerpt,
      "",
      "**The email:**",
    ],
    draft: { to: [{ email, name: contact.name }], subject: mail.subject, text: mail.text, contactId: contact.id },
    checks: CHECKS,
    outward: true,
    actorUserId: viewer.userId,
    projectId: await clientProjectOf(ctx, doc.companyId, client),
    wakeReason: "A document's signing email needs checking",
  });
  await appendEvent(ctx, fresh, { kind: "send_requested", actor: actorOf(viewer), detail: { approvalId: opened.approvalId } });
  return {
    documentId: doc.id,
    status: "awaiting_approval" as const,
    statusLine: statusLine({ ...fresh, status: "awaiting_approval" }),
    to: `${contact.name} <${email}>`,
    approvalIssueId: opened.issueId,
    approvalLink: await approvalLink(ctx, doc.companyId, opened.issueId),
    workIssueId: issueId,
    next: "A person approves the email by marking the approval issue done. You cannot approve it and no CRM tool will give you the link. Once it is sent the status moves to sent; the work issue tells you when it is signed. Never read, open, forward or sign from the signing email itself.",
  };
}

// ---------------------------------------------------------------------------
// The approval hooks (what the approved email does)
// ---------------------------------------------------------------------------

/**
 * Called when a person approved an esign email, just before it is queued: makes the private link (token stored as a hash, page
 * written) and puts it in the email. The link exists only in the returned draft, which goes to the Mailbox outbox and nowhere else;
 * that outbox row is blanked once the Mailbox answers (`scrubSettledBody`).
 */
export async function prepareEsignDraft(ctx: PluginContext, approval: ApprovalRecord): Promise<MailDraft> {
  const draft = approval.payload.draft as MailDraft | undefined;
  if (!draft) throw new Error("This approval has no email to send.");
  if (approval.kind === "esign_copy") return draft;
  const doc = await getDoc(ctx, approval.companyId, approval.subjectId);
  if (!doc) throw new RecipientRefused("The document this email belongs to no longer exists.");
  const now = Date.now();
  let expiresAt = doc.expiresAt;
  if (approval.kind === "esign_request") {
    expiresAt = new Date(now + doc.validDays * DAY_MS).toISOString();
    await patchDoc(ctx, doc.companyId, doc.id, { expiresAt });
  }
  if (!expiresAt || Date.parse(expiresAt) <= now) throw new RecipientRefused("The document has already expired, so there is nothing to sign. Send it again for a new link.");
  const minted = await mintLink(ctx, { ...doc, expiresAt }, { approvalId: approval.id, expiresAt }).catch((error) => {
    // The plugin's public address is not known (state was lost): nothing is made and the email is not sent; whoever opens the CRM page fixes it.
    if (error instanceof SigningAddressUnknown) throw new RecipientRefused(error.message);
    throw error;
  });
  if (isCanaryId(doc.clientRef)) await patchDoc(ctx, doc.companyId, doc.id, { canaryToken: minted.token });
  await appendEvent(ctx, doc, { kind: "link_issued", actor: "system", detail: { approvalId: approval.id, fingerprint: tokenHash(minted.token).slice(0, 8), expiresAt } });
  const text = draft.text.split(SIGNING_LINK_TOKEN).join(minted.link).split(VALID_UNTIL_TOKEN).join(dateLabel(expiresAt));
  return { ...draft, text, html: null };
}

/** Why an approved esign email must not go out after all, or null. The email was written for one state of the document. */
export async function esignEmailProblem(ctx: PluginContext, approval: ApprovalRecord): Promise<string | null> {
  if (approval.kind !== "esign_request" && approval.kind !== "esign_reminder" && approval.kind !== "esign_copy") return null;
  const doc = await getDoc(ctx, approval.companyId, approval.subjectId);
  if (!doc) return "The document this email belongs to no longer exists.";
  if (approval.kind === "esign_request") return doc.status === "awaiting_approval" ? null : `The document is already ${doc.status}, so the signing email must not be sent.`;
  if (approval.kind === "esign_reminder") return doc.status === "sent" || doc.status === "viewed" ? null : `The document is ${doc.status}, so a reminder would be wrong.`;
  return doc.status === "signed" ? null : "The document is not signed, so there is no signed copy to send.";
}

async function onSent(ctx: PluginContext, approval: ApprovalRecord, info: { dryRun: boolean }): Promise<void> {
  const doc = await getDoc(ctx, approval.companyId, approval.subjectId);
  if (!doc) return;
  const client = { kind: doc.clientKind, id: doc.clientRef };
  const now = new Date();
  const dry = info.dryRun ? " (canary dry run: not really sent)" : "";
  if (approval.kind === "esign_request") {
    const next = new Date(now.getTime() + ESIGN_REMIND_AFTER_DAYS * DAY_MS).toISOString();
    const moved = await moveDoc(ctx, doc.companyId, doc.id, ["awaiting_approval"], { status: "sent", sentAt: now.toISOString(), nextReminderAt: next });
    if (!moved) {
      // The link works as soon as the email is approved, so a client can open or sign it before the Mailbox confirms the send: only the send time is recorded.
      if (doc.status === "viewed" || doc.status === "signed") await patchDoc(ctx, doc.companyId, doc.id, { sentAt: doc.sentAt ?? now.toISOString(), ...(doc.status === "viewed" ? { nextReminderAt: next } : {}) });
      else return;
    }
    await appendEvent(ctx, doc, { kind: "sent", actor: "system", detail: { approvalId: approval.id, dryRun: info.dryRun } });
    await logOnClient(ctx, doc.companyId, client, "email_sent", `Sent "${doc.title}" to the client to sign.${dry}`, `care:esign:${doc.id}:sent:${approval.id}`, approval.issueId);
    // The page was written when the link was made; writing it again from the record keeps it right whatever state the document is in now.
    const fresh = await getDoc(ctx, doc.companyId, doc.id);
    if (fresh) publishPage(fresh);
    return;
  }
  if (approval.kind === "esign_reminder") {
    const after = Math.min(doc.reminders + 1, MAX_ESIGN_REMINDERS);
    await patchDoc(ctx, doc.companyId, doc.id, { reminders: doc.reminders + 1, lastReminderAt: now.toISOString(), nextReminderAt: new Date(now.getTime() + ESIGN_REMIND_AFTER_DAYS * DAY_MS).toISOString() });
    await appendEvent(ctx, doc, { kind: "reminder_sent", actor: "system", detail: { approvalId: approval.id, reminder: after, dryRun: info.dryRun } });
    await logOnClient(ctx, doc.companyId, client, "email_sent", `Reminder sent about "${doc.title}".${dry}`, `care:esign:${doc.id}:reminder:${approval.id}`, approval.issueId);
    return;
  }
  await appendEvent(ctx, doc, { kind: "copy_sent", actor: "system", detail: { approvalId: approval.id, dryRun: info.dryRun } });
  await logOnClient(ctx, doc.companyId, client, "email_sent", `Sent the signed copy of "${doc.title}" to the client.${dry}`, `care:esign:${doc.id}:copy:${approval.id}`, approval.issueId);
}

export const esignHooks: MailApprovalHooks = {
  onSent: (ctx, approval, info) => onSent(ctx, approval, info),
  async onRefused(ctx, approval, by) {
    const doc = await getDoc(ctx, approval.companyId, approval.subjectId);
    if (!doc) return;
    if (approval.kind === "esign_request") {
      await moveDoc(ctx, doc.companyId, doc.id, ["awaiting_approval"], { status: "draft", expiresAt: null });
      await appendEvent(ctx, doc, { kind: "send_refused", actor: by, detail: { approvalId: approval.id } });
      await logOnClient(ctx, doc.companyId, { kind: doc.clientKind, id: doc.clientRef }, "note", `The email that would have sent "${doc.title}" to sign was refused. The document is a draft again.`, `care:esign:${doc.id}:refused:${approval.id}`, approval.issueId);
    } else if (approval.kind === "esign_reminder" && (doc.status === "sent" || doc.status === "viewed")) {
      // A refused reminder is "do not chase yet": wait the interval again.
      await patchDoc(ctx, doc.companyId, doc.id, { nextReminderAt: new Date(Date.now() + ESIGN_REMIND_AFTER_DAYS * DAY_MS).toISOString() });
    }
  },
  async onFailed(ctx, approval, error) {
    const doc = await getDoc(ctx, approval.companyId, approval.subjectId);
    if (!doc) return;
    // The email never went out: the links made for it are dead, and a request goes back to a draft so it can be sent again.
    await revokeTokensOfApproval(ctx, approval.companyId, approval.id);
    if (approval.kind === "esign_request") {
      await moveDoc(ctx, doc.companyId, doc.id, ["awaiting_approval"], { status: "draft", expiresAt: null, canaryToken: null });
      await appendEvent(ctx, doc, { kind: "send_failed", actor: "system", detail: { approvalId: approval.id, error: error.slice(0, 200) } });
      const fresh = await getDoc(ctx, doc.companyId, doc.id);
      if (fresh) publishPage(fresh);
    } else if (approval.kind === "esign_reminder" && (doc.status === "sent" || doc.status === "viewed")) {
      await patchDoc(ctx, doc.companyId, doc.id, { nextReminderAt: new Date(Date.now() + ESIGN_REMIND_AFTER_DAYS * DAY_MS).toISOString() });
    }
  },
};

/** The client wrote back to a signing email: reminders stop and the work issue says so. */
export async function onEsignReply(ctx: PluginContext, companyId: string, docId: string, receivedAt: string | null): Promise<boolean> {
  const doc = await getDoc(ctx, companyId, docId);
  if (!doc) return false;
  if (doc.status === "sent" || doc.status === "viewed") await patchDoc(ctx, companyId, doc.id, { nextReminderAt: null });
  await withdrawOpenApprovals(ctx, companyId, ["esign_reminder"], doc.id, "client-replied", "The client has already replied, so a reminder is not needed.");
  await appendEvent(ctx, doc, { kind: "replied", actor: "client", at: receivedAt ?? undefined, detail: {} });
  await logOnClient(ctx, companyId, { kind: doc.clientKind, id: doc.clientRef }, "note", `The client replied about "${doc.title}". Read it and answer from the Mailbox.`, `care:esign:${doc.id}:replied`);
  if (doc.issueId) await ctx.issues.createComment(doc.issueId, `The client replied to the email about "${doc.title}". Read their reply in the Mailbox and answer it (a person approves sending). The signing link is still open.`, companyId).catch(() => undefined);
  return true;
}

// ---------------------------------------------------------------------------
// Finishing a signature (and a decline, an expiry, a withdrawal)
// ---------------------------------------------------------------------------

/**
 * Appends the consent and signed rows of a signature, once. The signature row is written by the request that won the
 * signing; if the worker stopped before that, this runs again from the care job and writes the same rows from what the document
 * recorded (flagged `late`), so a signed document never lacks its trail.
 */
export async function ensureSignedAudit(ctx: PluginContext, doc: SignDocument): Promise<SignDocument> {
  if (doc.status !== "signed" || doc.auditHead) return doc;
  const late = doc.signedAt ? Date.now() - Date.parse(doc.signedAt) > 120_000 : false;
  const at = doc.signedAt ?? new Date().toISOString();
  await appendEvent(ctx, doc, { kind: "consent_given", actor: "signer", at, ipHash: doc.signerIpHash, userAgent: doc.signerUserAgent, detail: { consentSha256: doc.consentSha256, ...(late ? { late: true } : {}) } });
  const signed = await appendEvent(ctx, doc, {
    kind: "signed",
    actor: "signer",
    at,
    ipHash: doc.signerIpHash,
    userAgent: doc.signerUserAgent,
    detail: { typedName: doc.signerName, contentSha256: doc.contentSha256, consentSha256: doc.consentSha256, nameMatchesRecipient: doc.nameMatches, ...(late ? { late: true } : {}) },
  });
  await patchDoc(ctx, doc.companyId, doc.id, { auditHead: signed.hash });
  return { ...doc, auditHead: signed.hash };
}

/** Builds the signed copy (Markdown for the issue document, a standalone page for the record) and stores it on the document. */
async function buildSignedCopy(ctx: PluginContext, doc: SignDocument): Promise<SignDocument> {
  const facts = signedFactsOf(doc);
  if (!facts) return doc;
  const company = docBrand(doc).name;
  const md = renderSignedMarkdown({ content: doc.content, contentSha256: doc.contentSha256, signed: facts, companyName: company, consentText: doc.consentText });
  const html = renderSignedHtml({ title: doc.title, brand: docBrand(doc), recipientName: doc.recipientName, bodyHtml: markdownToHtml(doc.content), contentSha256: doc.contentSha256, consentText: doc.consentText, consentSha256: doc.consentSha256, validUntil: null, signed: facts });
  const copySha = sha256Hex(md);
  await patchDoc(ctx, doc.companyId, doc.id, { signedCopyMd: md, signedCopyHtml: html, signedCopySha256: copySha });
  return { ...doc, signedCopyMd: md, signedCopyHtml: html, signedCopySha256: copySha };
}

async function markDealAccepted(ctx: PluginContext, doc: SignDocument): Promise<{ moved: boolean }> {
  if (!doc.dealId) return { moved: false };
  const deal = await getDeal(ctx, doc.dealId);
  if (!deal || deal.companyId !== doc.companyId) return { moved: false };
  const linked = { ...deal, custom: { ...deal.custom, signedDocumentId: doc.id, signedDocumentTitle: doc.title, signedDocumentSha256: doc.contentSha256, signedAt: doc.signedAt, ...(doc.quoteId ? { quoteId: doc.quoteId, ...(doc.quoteNumber ? { quoteNumber: doc.quoteNumber } : {}) } : {}) } };
  const stages = await listStages(ctx, deal.pipelineId);
  const open = stageKind(stages.find((stage) => stage.id === deal.stageId)?.kind ?? "open") === "open";
  const won = stages.find((stage) => stageKind(stage.kind) === "won");
  if (!open || !won) {
    await saveDeal(ctx, linked);
    return { moved: false };
  }
  await moveDealTo(ctx, linked, won, `when ${doc.signerName ?? "the client"} signed "${doc.title}"`);
  return { moved: true };
}

/**
 * Everything that follows a signature, each step on its own and safe to repeat, so a failure in one never undoes the
 * signature or blocks the rest; the care job runs the whole thing again until it all went through.
 * Returns the steps that failed (empty: all done).
 */
export async function applySignedEffects(ctx: PluginContext, input: SignDocument): Promise<string[]> {
  const failed: string[] = [];
  const step = async (label: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      failed.push(label);
      ctx.logger.info("CRM e-sign step failed", { documentId: input.id, step: label, error: message(error) });
    }
  };
  let doc = input;
  await step("audit trail", async () => {
    doc = await ensureSignedAudit(ctx, doc);
  });
  if (!doc.auditHead) return failed;
  await step("signed copy", async () => {
    doc = await buildSignedCopy(ctx, doc);
  });
  await step("page", async () => {
    const written = publishPage(doc);
    if (!written.ok) throw new Error(written.reason);
  });
  const client = { kind: doc.clientKind, id: doc.clientRef };
  const info = await clientInfo(ctx, doc.companyId, client).catch(() => null);
  await step("issue document", async () => {
    if (!doc.issueId || !doc.signedCopyMd) return;
    await writeIssueDocument(ctx, doc, doc.issueId, SIGNED_COPY_DOC_KEY, `${doc.title} (signed copy)`, doc.signedCopyMd);
  });
  await step("timeline", async () => {
    await insertActivityOnce(ctx, {
      companyId: doc.companyId,
      recordType: doc.dealId ? "deal" : client.kind,
      recordId: doc.dealId ?? client.id,
      kind: "document_signed",
      body: `"${doc.title}" was signed by ${doc.signerName ?? "the client"} on ${dateTimeLabel(doc.signedAt)}. Document fingerprint ${doc.contentSha256.slice(0, 16)}.`,
      meta: { documentId: doc.id, contentSha256: doc.contentSha256, auditHead: doc.auditHead },
      sourceKey: `esign:${doc.id}:signed`,
      issueId: doc.issueId,
    });
    if (doc.dealId) await insertActivityOnce(ctx, { companyId: doc.companyId, recordType: client.kind, recordId: client.id, kind: "document_signed", body: `"${doc.title}" was signed by ${doc.signerName ?? "the client"}.`, meta: { documentId: doc.id }, sourceKey: `esign:${doc.id}:signed:client` });
  });
  await step("deal", async () => {
    await markDealAccepted(ctx, doc);
  });
  await step("hand-offs", async () => {
    const base = { documentId: doc.id, kind: doc.kind, title: doc.title, dealId: doc.dealId, quoteId: doc.quoteId, quoteNumber: doc.quoteNumber, clientKind: doc.clientKind, clientRef: doc.clientRef, clientName: info?.name ?? null, valueMinor: doc.valueMinor, currency: doc.currency ?? "ZAR", signerName: doc.signerName, signedAt: doc.signedAt, contentSha256: doc.contentSha256, auditHead: doc.auditHead };
    await sendHandoff(ctx, doc.companyId, DEAL_ACCEPTED_EVENT, { key: `crm:esign:${doc.id}:accepted`, ...base });
    if (doc.quoteId) {
      // The shape Billing already reads for `quote.accepted`, plus the signature's proof.
      await sendHandoff(ctx, doc.companyId, QUOTE_ACCEPTED_BY_SIGNATURE_EVENT, {
        key: `crm:esign:${doc.id}:quote-accepted`,
        quoteId: doc.quoteId,
        number: doc.quoteNumber ?? "quote",
        dealId: doc.dealId,
        clientKind: doc.clientKind,
        clientRef: doc.clientRef,
        totalMinor: doc.valueMinor ?? 0,
        currency: doc.currency ?? "ZAR",
        acceptedAt: doc.signedAt,
        documentId: doc.id,
        contentSha256: doc.contentSha256,
        auditHead: doc.auditHead,
        signerName: doc.signerName,
      });
    }
  });
  await step("copy email", async () => {
    if (!doc.recipientEmail || !doc.signedCopyMd) return;
    const mail = esignEmail({ kind: "copy", title: doc.title, recipientName: doc.signerName ?? doc.recipientName ?? "", brand: docBrand(doc).name, signedAt: doc.signedAt, signedCopyText: markdownToText(doc.signedCopyMd) });
    await requestApproval(ctx, {
      companyId: doc.companyId,
      kind: "esign_copy",
      client,
      subjectId: doc.id,
      seq: 1,
      title: `Approve the signed copy to ${info?.name ?? "the client"}: ${doc.title}`,
      intro: [`${doc.signerName ?? "The client"} signed "${doc.title}". Approving sends them the signed copy so they have it for their records. Nothing is sent until a person approves.`],
      draft: { to: [{ email: doc.recipientEmail, name: doc.recipientName }], subject: mail.subject, text: mail.text, contactId: doc.recipientContactId },
      checks: ["The copy below is the signed text with the signature details after it.", "It goes to the person who signed, at the address the link was sent to."],
      outward: true,
      projectId: await clientProjectOf(ctx, doc.companyId, client),
      wakeReason: "A signed copy needs checking before it is sent",
    });
  });
  await step("work issue", async () => {
    if (!doc.issueId) return;
    const found = await ctx.issues.get(doc.issueId, doc.companyId).catch(() => null);
    if (found && !found.originId?.startsWith("crm:esign:")) return;
    await ctx.issues.createComment(doc.issueId, `Signed by ${doc.signerName ?? "the client"} on ${dateTimeLabel(doc.signedAt)}.${doc.nameMatches === false ? ` The typed name does not match the person we sent it to (${doc.recipientName}): check that the right person signed.` : ""} The signed copy is on this issue (document \`${SIGNED_COPY_DOC_KEY}\`)${doc.dealId ? " and linked on the deal, which moved to won" : ""}. Billing was told${doc.quoteId ? " (quote accepted)" : ""}, so the invoice can be drafted. The signed copy is drafted as an email for a person to approve.`, doc.companyId);
  });
  if (failed.length === 0) await patchDoc(ctx, doc.companyId, doc.id, { effectsDoneAt: { now: true } });
  return failed;
}

/** A client declined, from the page. Records it and tells the work issue; nothing else moves. */
export async function applyDeclinedEffects(ctx: PluginContext, doc: SignDocument): Promise<void> {
  const client = { kind: doc.clientKind, id: doc.clientRef };
  await logOnClient(ctx, doc.companyId, client, "note", `The client declined "${doc.title}"${doc.declineReason ? `: ${doc.declineReason}` : ""}.`, `care:esign:${doc.id}:declined`, doc.issueId);
  if (doc.issueId) await ctx.issues.createComment(doc.issueId, `The client declined "${doc.title}"${doc.declineReason ? `: ${doc.declineReason}` : ""}. Find out why (a call or a Mailbox draft a person approves), then change the document and send a new one, or close this issue.`, doc.companyId).catch(() => undefined);
}

/** A document ran out of time unsigned: its links die, its page becomes a note, its reminders are withdrawn, and the work issue says so. */
export async function expireDoc(ctx: PluginContext, doc: SignDocument): Promise<boolean> {
  const now = new Date().toISOString();
  const moved = await moveDoc(ctx, doc.companyId, doc.id, ["sent", "viewed"], { status: "expired", expiredAt: now, nextReminderAt: null });
  if (!moved) return false;
  await revokeTokens(ctx, doc.companyId, doc.id);
  await appendEvent(ctx, doc, { kind: "expired", actor: "system", at: now, detail: { expiresAt: doc.expiresAt } });
  const fresh = await getDoc(ctx, doc.companyId, doc.id);
  if (fresh) publishPage(fresh);
  await withdrawOpenApprovals(ctx, doc.companyId, ["esign_reminder"], doc.id, "doc-expired", "The document expired, so a reminder is not needed.");
  await logOnClient(ctx, doc.companyId, { kind: doc.clientKind, id: doc.clientRef }, "note", `"${doc.title}" expired without a signature.`, `care:esign:${doc.id}:expired`, doc.issueId);
  if (doc.issueId) await ctx.issues.createComment(doc.issueId, `"${doc.title}" expired on ${dateLabel(now)} without a signature (${doc.reminders} reminder${doc.reminders === 1 ? "" : "s"} sent). Reach the client another way. If they still want it, \`send-for-signature\` again gives it a new link (the text does not change); if not, \`void-sign-document\`.`, doc.companyId).catch(() => undefined);
  return true;
}

export async function voidSignDocumentTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const { doc } = await requireDoc(ctx, viewer, params);
  const reason = clamp(params.reason, 300);
  if (!reason || reason.length < 5) throw new CrmError("reason is required: say why the document is withdrawn");
  if (doc.status === "signed") throw new CrmError("A signed document cannot be withdrawn: it is the record. If it was wrong, make a new document and say so in it.");
  if (doc.status === "void") return { documentId: doc.id, status: "void" as const, note: "It was already withdrawn." };
  const now = new Date().toISOString();
  const moved = await moveDoc(ctx, doc.companyId, doc.id, ["draft", "awaiting_approval", "sent", "viewed", "declined", "expired"], { status: "void", voidedAt: now, voidReason: reason, nextReminderAt: null });
  if (!moved) throw new CrmError("The document changed while you were withdrawing it. Look at it again with get-sign-document.");
  await revokeTokens(ctx, doc.companyId, doc.id);
  await appendEvent(ctx, doc, { kind: "voided", actor: actorOf(viewer), at: now, detail: { reason } });
  const fresh = await getDoc(ctx, doc.companyId, doc.id);
  if (fresh) publishPage(fresh);
  const withdrawn = await withdrawOpenApprovals(ctx, doc.companyId, ["esign_request", "esign_reminder"], doc.id, "doc-voided", `The document was withdrawn: ${reason}`);
  return { documentId: doc.id, status: "void" as const, emailsWithdrawn: withdrawn, note: "Its link no longer works. An email that was already sent cannot be called back, but the page now says the document was withdrawn." };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function nameOf(doc: SignDocument): string {
  return doc.recipientName ? `${doc.recipientName}${doc.recipientEmail ? ` <${doc.recipientEmail}>` : ""}` : (doc.recipientEmail ?? "");
}

export function docSummary(doc: SignDocument) {
  return {
    documentId: doc.id,
    client: refOf(doc.clientKind, doc.clientRef),
    kind: doc.kind,
    title: doc.title,
    status: doc.status,
    statusLine: statusLine(doc),
    to: nameOf(doc),
    dealId: doc.dealId,
    quoteId: doc.quoteId,
    valueMinor: doc.valueMinor,
    currency: doc.currency,
    createdAt: doc.createdAt,
    sentAt: doc.sentAt,
    viewedAt: doc.viewedAt,
    expiresAt: doc.expiresAt,
    signedAt: doc.signedAt,
    signerName: doc.signerName,
  };
}

export async function listSignDocumentsTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const client = params.client == null || params.client === "" ? null : parseClientRef(params.client);
  if (client) await requireClient(ctx, viewer, client);
  const status = clamp(params.status, 20);
  if (status && status !== "open" && status !== "all" && !(DOC_STATUSES as readonly string[]).includes(status)) throw new CrmError(`status must be open, all or one of ${DOC_STATUSES.join(", ")}`);
  const seen = client ? null : await visibleClients(ctx, viewer);
  const all = (await listDocs(ctx, viewer.companyId, client, 200)).filter((doc) => !seen || seen.has(doc.clientKind, doc.clientRef));
  const filter = status ?? "open";
  const rows = all.filter((doc) => (filter === "all" ? true : filter === "open" ? ["draft", "awaiting_approval", "sent", "viewed"].includes(doc.status) : doc.status === filter));
  return {
    count: rows.length,
    documents: rows.slice(0, 50).map(docSummary),
    ...(client ? { esign: await esignAccess(ctx, viewer.companyId, client).then((a) => ({ allowed: a.allowed, canary: a.canary, turnedOnBy: a.enabled?.enabledBy ?? null })) } : {}),
  };
}

export async function getSignDocumentTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const { doc } = await requireDoc(ctx, viewer, params);
  const { events, check } = await loadTrail(ctx, doc);
  const prefix = await companyPrefix(ctx, doc.companyId);
  let canaryLink: string | null = null;
  let canaryNote: string | null = null;
  if (doc.canaryToken && isCanaryId(doc.clientRef) && (doc.status === "sent" || doc.status === "viewed")) {
    const urls = await signUrls(ctx, doc.companyId);
    if (urls) canaryLink = signingLink(urls.pageBase, doc.pageId, doc.canaryToken);
    else canaryNote = NO_SIGN_ADDRESS_NOTE;
  }
  return {
    ...docSummary(doc),
    contentSha256: doc.contentSha256,
    templateKey: doc.templateKey,
    templateVersion: doc.templateVersion,
    templateReviewed: doc.templateReviewed,
    consentText: doc.consentText,
    views: doc.viewCount,
    reminders: doc.reminders,
    nameMatchesRecipient: doc.nameMatches,
    auditFingerprint: doc.auditHead,
    trailIntact: check.ok,
    ...(check.ok ? {} : { trailProblems: check.problems }),
    trail: events.map((event) => ({ seq: event.seq, at: event.at, kind: event.kind, actor: event.actor })),
    workIssue: doc.issueId ? issueLink(prefix, doc.issueId) : null,
    ...(params.includeContent === true ? { content: doc.content } : {}),
    ...(canaryLink ? { canaryLink, canaryNote: "The canary's own link, so the journey can be run end to end. A real client's link is never shown by any tool." } : canaryNote ? { canaryNote } : {}),
    next: nextStep(doc),
  };
}

function nextStep(doc: SignDocument): string {
  switch (doc.status) {
    case "draft": return "send-for-signature opens the email for approval.";
    case "awaiting_approval": return "A person must approve the email. Leave it.";
    case "sent":
    case "viewed": return "Waiting on the client. Reminders are drafted for approval; a reply stops them.";
    case "signed": return "Done. Billing was told; the signed copy is on the work issue and the deal.";
    case "declined": return "Find out why, then change the text in a new document or close the issue.";
    case "expired": return "send-for-signature gives it a new link, or void-sign-document.";
    case "void": return "Nothing more to do.";
  }
}

/** `verify-sign-document`: recomputes the text hash, the consent hash, the signed copy and the whole audit chain. */
export async function verifySignDocumentTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const { doc } = await requireDoc(ctx, viewer, params);
  const problems: string[] = [];
  if (sha256Hex(doc.content) !== doc.contentSha256) problems.push("The text of the document does not match its recorded SHA-256: it was changed after it was made.");
  if (sha256Hex(doc.consentText) !== doc.consentSha256) problems.push("The consent wording does not match its recorded SHA-256.");
  const { events, check } = await loadTrail(ctx, doc);
  problems.push(...check.problems);
  if (events.length === 0) problems.push("The document has no audit trail.");
  const signed = events.find((event) => event.kind === "signed");
  if (doc.status === "signed") {
    if (!signed) problems.push("The document is signed but its trail has no signature row.");
    else {
      if (signed.detail.contentSha256 !== doc.contentSha256) problems.push("The signature row names a different text than the document holds.");
      if (doc.auditHead && signed.hash !== doc.auditHead) problems.push("The audit fingerprint on the document does not match the signature row.");
      if (signed.detail.typedName !== doc.signerName) problems.push("The signer name on the document differs from the signature row.");
    }
    if (doc.signedCopyMd && doc.signedCopySha256 && sha256Hex(doc.signedCopyMd) !== doc.signedCopySha256) problems.push("The signed copy does not match its recorded SHA-256.");
    if (doc.signedCopyMd && !doc.signedCopyMd.startsWith(doc.content.trimEnd())) problems.push("The signed copy does not start with the signed text.");
  }
  return { documentId: doc.id, status: doc.status, ok: problems.length === 0, problems, events: events.length, auditFingerprint: doc.auditHead, contentSha256: doc.contentSha256 };
}

export function signTemplatesTool(params: Record<string, unknown>) {
  const withText = params.includeText === true;
  return {
    version: TEMPLATE_VERSION,
    notice: TEMPLATE_NOTICE,
    templates: TEMPLATES.map((template) => ({ key: template.key, kind: template.kind, label: template.label, description: template.description, requiredVariables: template.required, optionalVariables: template.optional, ...(withText ? { source: templateSource(template.key) } : {}) })),
    next: "create-sign-document with template and variables (scope, price, lines...), or write the text yourself as bodyMarkdown. Anything beyond these drafts goes to a lawyer first.",
  };
}

// ---------------------------------------------------------------------------
// The care job: expiry, reminders, unfinished work, pages
// ---------------------------------------------------------------------------

export interface EsignCareRun {
  expired: number;
  reminders: number;
  escalated: number;
  effects: number;
  pages: number;
}

/** Per company, every 15 minutes (a step of the `client-care` job): expire, remind, escalate, finish what a signature started, repair pages. */
export async function runEsignCare(ctx: PluginContext, companyId: string, now = new Date()): Promise<EsignCareRun> {
  const run: EsignCareRun = { expired: 0, reminders: 0, escalated: 0, effects: 0, pages: 0 };
  const live = await docsByStatus(ctx, companyId, ["sent", "viewed"], 200);
  for (const doc of live) {
    if (doc.expiresAt && Date.parse(doc.expiresAt) <= now.getTime()) {
      if (await expireDoc(ctx, doc).catch(() => false)) run.expired += 1;
      continue;
    }
    if (!doc.nextReminderAt || Date.parse(doc.nextReminderAt) > now.getTime()) continue;
    const reminders = await approvalsOfSubject(ctx, companyId, "esign_reminder", doc.id);
    if (reminders.some((approval) => approval.status === "open" || approval.status === "approved")) continue;
    const declined = reminders.filter((approval) => approval.status === "refused" || approval.status === "failed").length;
    if (doc.reminders >= MAX_ESIGN_REMINDERS || declined >= MAX_ESIGN_REMINDERS) {
      if (!doc.escalatedAt && (await escalateStale(ctx, doc, now))) run.escalated += 1;
      continue;
    }
    const mail = esignEmail({ kind: "reminder", title: doc.title, recipientName: doc.recipientName ?? "", brand: docBrand(doc).name, reminder: doc.reminders + 1 });
    if (!doc.recipientEmail) continue;
    const info = await clientInfo(ctx, companyId, { kind: doc.clientKind, id: doc.clientRef });
    const opened = await requestApproval(ctx, {
      companyId,
      kind: "esign_reminder",
      client: { kind: doc.clientKind, id: doc.clientRef },
      subjectId: doc.id,
      seq: reminders.length + 1,
      title: `Approve reminder to ${info?.name ?? "the client"}: sign ${doc.title}`,
      intro: [`${info?.name ?? "The client"} has not signed "${doc.title}" (${statusLine(doc)}). Approving sends one short reminder with a fresh private link (reminder ${doc.reminders + 1} of ${MAX_ESIGN_REMINDERS}). Refusing waits another ${ESIGN_REMIND_AFTER_DAYS} days.`],
      draft: { to: [{ email: doc.recipientEmail, name: doc.recipientName }], subject: mail.subject, text: mail.text, contactId: doc.recipientContactId },
      checks: CHECKS.slice(1),
      outward: true,
      wakeReason: "A signing reminder needs checking",
    });
    if (opened.created) run.reminders += 1;
  }
  // A signature whose follow-up work did not all go through is finished here.
  for (const doc of await docsNeedingEffects(ctx, companyId, 20)) {
    if ((await applySignedEffects(ctx, doc)).length === 0) run.effects += 1;
  }
  return run;
}

async function escalateStale(ctx: PluginContext, doc: SignDocument, now: Date): Promise<boolean> {
  const info = await clientInfo(ctx, doc.companyId, { kind: doc.clientKind, id: doc.clientRef });
  const waiting = Math.max(1, Math.floor((now.getTime() - Date.parse(doc.sentAt ?? now.toISOString())) / DAY_MS));
  const issueId = await openIssueOnce(ctx, {
    companyId: doc.companyId,
    originId: originFor.esignStale(doc.id),
    title: `${info?.name ?? "A client"} has not signed: ${doc.title}`.slice(0, 200),
    description: [
      `"${doc.title}" was sent ${waiting} days ago and has not been signed after ${doc.reminders} reminder${doc.reminders === 1 ? "" : "s"}.`,
      "",
      "Reach them another way: a call, or a message to another person there. Then either wait for the signature, send it again if the link expires, or withdraw it (`void-sign-document`).",
      "",
      "**Done when** the document is signed, declined or withdrawn. Closing checks it.",
      `Document: \`${doc.id}\``,
    ].join("\n"),
    assignee: await teamAssignee(ctx, doc.companyId),
    wakeReason: "A client has not signed",
    projectId: await clientProjectOf(ctx, doc.companyId, { kind: doc.clientKind, id: doc.clientRef }),
  });
  await patchDoc(ctx, doc.companyId, doc.id, { escalatedAt: now.toISOString(), nextReminderAt: null });
  return Boolean(issueId);
}

/** Done-check for the work and stale issues: the document is signed, declined or withdrawn (an expired one needs a decision too). */
export async function esignIssueResolved(ctx: PluginContext, companyId: string, originId: string): Promise<{ done: true } | { done: false; missing: string[] }> {
  const id = originId.startsWith("crm:esign-stale:") ? originId.slice("crm:esign-stale:".length) : originId.slice("crm:esign:".length);
  const doc = (await getDoc(ctx, companyId, id)) ?? (await docByIssue(ctx, companyId, id));
  if (!doc || ["signed", "declined", "void"].includes(doc.status)) return { done: true };
  const left = doc.status === "expired" ? "It expired unsigned: send it again (`send-for-signature`) or withdraw it (`void-sign-document`)." : doc.status === "draft" ? "It was never sent: `send-for-signature`, or withdraw it (`void-sign-document`)." : `It is ${doc.status}: ${statusLine(doc)} Leave the issue open until it is signed, declined or withdrawn.`;
  return { done: false, missing: [`"${doc.title}" (\`${doc.id}\`) is not finished. ${left}`] };
}

// ---------------------------------------------------------------------------
// Cockpit and Setup
// ---------------------------------------------------------------------------

/** Pages are files: a read-only folder or a failed integrity check is found here, before a client is. Nothing for a company with no documents. */
export async function esignHealth(ctx: PluginContext, companyId: string): Promise<HealthCheck[]> {
  const docs = await listDocs(ctx, companyId, null, 200);
  if (docs.length === 0) return [];
  const out: HealthCheck[] = [];
  const open = docs.filter((doc) => doc.status === "sent" || doc.status === "viewed");
  const writable = open.length > 0 || docs.some((doc) => doc.status === "awaiting_approval") ? pagesWritable() : { ok: true as const };
  if (!writable.ok) {
    out.push({ key: "esign:pages", title: "Signing pages", status: "bad", detail: `Signing pages cannot be written: ${writable.reason}`, href: "/crm", fix: "The plugin folder on the server must be writable by the Paperclip user (dist/ui/s). Ask the Operator to check the folder's owner." });
  } else {
    out.push({ key: "esign:pages", title: "Signing pages", status: "ok", detail: open.length ? `${open.length} document${open.length === 1 ? " is" : "s are"} out for signature.` : "No document is out for signature." });
  }
  const signed = docs.filter((doc) => doc.status === "signed").slice(0, 25);
  const broken: string[] = [];
  for (const doc of signed) {
    const { events, check } = await loadTrail(ctx, doc);
    if (!check.ok || sha256Hex(doc.content) !== doc.contentSha256 || events.length === 0) broken.push(doc.title);
  }
  if (broken.length) {
    out.push({ key: "esign:integrity", title: "Signed documents", status: "bad", detail: `${broken.length} signed document${broken.length === 1 ? "" : "s"} failed the integrity check (${broken.slice(0, 3).join(", ")}). The record may have been changed.`, href: "/crm", fix: "Run verify-sign-document on each and tell the owner: a signed record that does not verify must not be relied on." });
  }
  const stuck = (await docsNeedingEffects(ctx, companyId, 20)).filter((doc) => doc.signedAt && Date.now() - Date.parse(doc.signedAt) > 3_600_000);
  if (stuck.length) out.push({ key: "esign:effects", title: "Signed documents: follow-up", status: "warn", detail: `${stuck.length} signed document${stuck.length === 1 ? " has" : "s have"} follow-up work that did not finish (the deal, Billing or the signed copy).`, href: "/crm", fix: "The care job retries every 15 minutes; if it persists, read the plugin log for the failing step." });
  return out;
}

export async function esignSetupItem(ctx: PluginContext, companyId: string): Promise<SetupItem> {
  const enabled = await listEsignClients(ctx, companyId).catch(() => [] as EsignClient[]);
  const docs = await listDocs(ctx, companyId, null, 200).catch(() => [] as SignDocument[]);
  const signed = docs.filter((doc) => doc.status === "signed").length;
  const reviewed = enabled.filter((client) => client.templatesReviewed).length;
  return {
    key: "esign",
    title: "E-sign acceptance (owner decision)",
    status: enabled.length > 0 ? "done" : "optional",
    required: false,
    detail: enabled.length > 0
      ? `Turned on for ${enabled.length} client${enabled.length === 1 ? "" : "s"} (${reviewed} with the templates marked as reviewed). ${signed} document${signed === 1 ? "" : "s"} signed so far.`
      : "Off for every client except the canary. The document templates are drafts nobody has had reviewed by a lawyer, so agents cannot prepare a document for a real client until you turn e-sign on for that client.",
    href: "/crm",
    hrefLabel: "Open CRM",
    steps: enabled.length > 0 ? undefined : [
      `Have a South African lawyer read the three templates (proposal, quote, service agreement, version ${TEMPLATE_VERSION}): ask the agent for them with the tool sign-templates (includeText true). What to check is in the lawyer review list in the plugin's docs (docs/esign-legal-review.md).`,
      "The signature is a typed name with consent, a basic electronic signature under the ECT Act. It is NOT an advanced electronic signature: a document that law requires to be signed in ink or with an advanced signature must not use this.",
      "Before the first real client: no agent should be able to read the mailbox the signing emails are sent from. The email that goes out carries the client's private link and the Mailbox keeps a copy of what it sent (the CRM blanks its own copy once it is sent). An agent must never read, open, forward or sign from one.",
      "Open the client's page in the CRM, find the Agreements card and press Turn on e-sign. Say whether the lawyer reviewed the templates.",
      "Optional: set the sender's look in the CRM settings (Documents: colours, a logo address that starts with https, a footer line).",
    ],
    agentNext: "Agents prepare proposals, quotes and agreements for that client, a person approves each signing email, the client signs on a private page, and the signed copy, the deal and Billing follow by themselves.",
  };
}
