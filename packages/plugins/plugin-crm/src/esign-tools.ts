import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { DOC_KINDS, DOC_STATUSES } from "./esign-store.js";
import { DEFAULT_VALID_DAYS, MAX_VALID_DAYS, TEMPLATE_KEYS } from "./esign-templates.js";

/**
 * The e-sign tools: prepare a proposal, quote or agreement, send it for signature (an approved email), read where it is, withdraw it, and
 * check its record. Every parameter has a description; results are JSON with ids, refs and links. Nothing here sends anything by
 * itself, and no tool ever returns a signing link for a real client (the email that carries it is the Mailbox's, so an agent that can
 * read the sending mailbox could read one: the skill says never to open, forward or sign from a signing email).
 */

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

const text = (description: string): JsonSchema => ({ type: "string", description });
const oneOf = (values: readonly string[], description: string): JsonSchema => ({ type: "string", enum: [...values], description });
const int = (description: string, extra: Record<string, unknown> = {}): JsonSchema => ({ type: "integer", description, ...extra });
const bool = (description: string): JsonSchema => ({ type: "boolean", description });
const bag = (description: string): JsonSchema => ({ type: "object", additionalProperties: true, description });

const P = {
  client: text("The client: company:<id> or contact:<id> (from find-records)."),
  documentId: text("The document id (from create-sign-document or list-sign-documents)."),
};

export const ESIGN_TOOLS: PluginToolDeclaration[] = [
  {
    name: "sign-templates",
    displayName: "Document templates",
    description:
      "The templates a proposal, quote or simple service agreement starts from: what each is for and the variables it takes. They are DRAFTS, not legal advice: no lawyer has reviewed them, and a signature is a typed name with consent (a basic electronic signature), never an advanced one. includeText true returns the Markdown source.",
    parametersSchema: schema([], { includeText: bool("true: include each template's Markdown source.") }),
  },
  {
    name: "create-sign-document",
    displayName: "Create a document to sign",
    description:
      `Prepare a proposal, quote or simple agreement for a client to sign online, from a template or from text you write. The text is frozen when it is sent and its SHA-256 is what the client signs, so read it first (get-sign-document with includeContent). Nothing goes to the client: send-for-signature opens the email for approval. Only works for the canary client until the owner has turned e-sign on for that client (the answer says so and what to ask for). The recipient must be one of the client's own people. With a template, put the variables in variables: scope (proposal, service-agreement; Markdown), summary, deliverables (list), timeline, price, priceMinor (cents), payment_terms, assumptions, fees, feesMinor, term, notice_days, start_date; for a quote lines (description, quantity, unitMinor in cents), quote_number, total (cents, when there are no lines), vat_percent, notes. Link a deal (dealId) so signing moves it to won, and a Billing quote (quoteId, quoteNumber) so Billing is told it was accepted. Never write a legal promise the templates do not make.`,
    parametersSchema: schema(["client"], {
      client: P.client,
      template: oneOf(TEMPLATE_KEYS, "proposal, quote or service-agreement. Leave out to write the text yourself (bodyMarkdown)."),
      variables: bag("The values the template needs (see the description and sign-templates)."),
      bodyMarkdown: text("The document as Markdown, instead of a template: headings, paragraphs, lists, tables, bold, https links. At least 40 characters."),
      kind: oneOf(DOC_KINDS, "Required with bodyMarkdown: proposal, quote or contract."),
      title: text("The document's title (for a template, the proposal's subject). Required with bodyMarkdown."),
      dealId: text("The client's deal this document closes (from list-deals). Signing moves it to won and links the signed copy on it."),
      quoteId: text("The Billing quote this document accepts (from Billing). Signing tells Billing the quote was accepted."),
      quoteNumber: text("The Billing quote number, shown on the deal."),
      valueMinor: int("What the document is worth, in cents (R 1,500.00 is 150000). Default: the template's total or the deal's value.", { minimum: 0 }),
      currency: text("3-letter currency code. Default: the deal's, else ZAR."),
      contactId: text("The person at the client who signs (contact:<id> from get-company). Default: the client's first person with a working email."),
      toEmail: text("Or the address of one of the client's people. An address that is not on the client is refused."),
      validDays: int(`How many days the signing link works once sent, 1 to ${MAX_VALID_DAYS} (default ${DEFAULT_VALID_DAYS}).`, { minimum: 1, maximum: MAX_VALID_DAYS }),
      brand: oneOf(["sender", "client"], "sender (default): our look. client: the client's own colours from its profile."),
    }),
  },
  {
    name: "send-for-signature",
    displayName: "Send a document for signature",
    description:
      "Ask for the email that sends a document to the client to sign. It goes through the usual approval (the Reviewer, then a person, who read the exact text and email). The private signing link is made only when a person approves and goes in that email to the client. No tool or issue shows it and you must not ask for it; the email itself carries it, so never read, open, forward or sign from a signing email (not even from the Mailbox). After it is sent the document waits on the client; reminders are drafted for approval after 3 days, up to two. A draft, or an expired document (it gets a new link), can be sent.",
    parametersSchema: schema(["documentId"], { documentId: P.documentId }),
  },
  {
    name: "list-sign-documents",
    displayName: "List documents to sign",
    description: "A client's documents (or every client's you may see) with a plain status line: draft, waiting for approval, sent, opened, signed, declined, expired or withdrawn. Default: the ones still open. With a client it also says whether e-sign is on for that client.",
    parametersSchema: schema([], { client: text("Only this client: company:<id> or contact:<id>."), status: oneOf(["open", "all", ...DOC_STATUSES], "open (default), all, or one status.") }),
  },
  {
    name: "get-sign-document",
    displayName: "Get a document to sign",
    description: "One document: its status line, who it is for, the dates, the SHA-256 of the text, the consent wording, the audit trail (what happened and when, without addresses) and whether the trail is intact. includeContent true returns the exact text. For the canary client only, it also returns the canary's own link so the journey can be run.",
    parametersSchema: schema(["documentId"], { documentId: P.documentId, includeContent: bool("true: include the document text.") }),
  },
  {
    name: "void-sign-document",
    displayName: "Withdraw a document",
    description: "Withdraw a document that is not signed: its link stops working, its page says it was withdrawn and any email still waiting for approval is withdrawn. An email already sent cannot be called back. A signed document cannot be withdrawn: it is the record.",
    parametersSchema: schema(["documentId", "reason"], { documentId: P.documentId, reason: text("Why it is withdrawn, at least a sentence.") }),
  },
  {
    name: "verify-sign-document",
    displayName: "Check a document's record",
    description: "Recompute the SHA-256 of the text and the consent wording, the signed copy, and the whole hash-chained audit trail, and say what does not match. Run it before relying on a signed document, and tell the owner at once if it fails.",
    parametersSchema: schema(["documentId"], { documentId: P.documentId }),
  },
];
