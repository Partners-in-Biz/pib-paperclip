import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { ACTION_KINDS, ACTION_STATUSES, CASE_SEVERITIES, CASE_SOURCES, CASE_STATUSES, FEEDBACK_KINDS, SENSITIVITY_LEVELS } from "./care-store.js";
import { REPORT_MODULES } from "./client-signals.js";

/**
 * The client care tools: the monthly report, support cases and feedback, client
 * requests (sign-offs and grants), the health score, site monitoring and privacy.
 * Every parameter has a description; results are JSON with ids, refs and links.
 */

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

const text = (description: string): JsonSchema => ({ type: "string", description });
const textList = (description: string): JsonSchema => ({ type: "array", items: { type: "string" }, description });
const oneOf = (values: readonly string[], description: string): JsonSchema => ({ type: "string", enum: [...values], description });
const int = (description: string, extra: Record<string, unknown> = {}): JsonSchema => ({ type: "integer", description, ...extra });
const bool = (description: string): JsonSchema => ({ type: "boolean", description });

const P = {
  client: text("The client: company:<id> or contact:<id> (from find-records)."),
  period: text("The month as YYYY-MM, e.g. 2026-09. Default: last month."),
  contact: text("A person at the client (contact id or contact:<id> from get-company). Default: the client's first person with a working email."),
  toEmail: text("Or the address of one of the client's people. An address that is not on the client is refused."),
};

const headline = {
  type: "array",
  description: "The headline numbers, up to 10: each a label and a value, optionally a change against last month.",
  items: {
    type: "object",
    properties: { label: text("What it is, e.g. Clicks."), value: text("The number as the client reads it, e.g. 1,240."), delta: text("The change, e.g. +18% on August.") },
    required: ["label", "value"],
  },
} as JsonSchema;

export const CARE_TOOLS: PluginToolDeclaration[] = [
  // -------------------------------------------------------------------------
  // The monthly client report
  // -------------------------------------------------------------------------
  {
    name: "build-client-report",
    displayName: "Build client report",
    description:
      "Build (or rebuild) one client's monthly report. The CRM already gathered its own numbers (support, the client's website leads, uptime, what we logged, invoices paid) and what the other modules sent; this stores the report as a record and as the report document on the monthly report issue (the document is replaced on every build, so never edit it; if the result carries a documentNote the document was not updated, and you work from this result). One report per client and month: running it again updates the numbers and keeps your summary; a report that was sent is never rewritten. dryRun shows what it would say and stores nothing. The result lists the modules whose numbers are missing and the tools to read them.",
    parametersSchema: schema(["client"], {
      client: P.client,
      period: P.period,
      dryRun: bool("true: show what the report would say and store nothing."),
    }),
  },
  {
    name: "record-client-signal",
    displayName: "Record client signal",
    description:
      "Put a module's numbers for one client in the monthly report (and, with no period, in the health score). Read them with that module's own tools first (the report issue names which), then record the headline numbers and a few plain bullets. Use period for a month's report; leave it out for the client's current state (SEO sprint health 0-100, overdue invoices).",
    parametersSchema: schema(["client", "module"], {
      client: P.client,
      module: oneOf([...REPORT_MODULES, "other"], "Which module the numbers are from."),
      period: text("The month the numbers are for, YYYY-MM. Leave out for the client's current state."),
      headline,
      bullets: textList("Up to 8 plain sentences the client would care about, e.g. 'Moved to position 4 for \"emergency plumber Ballito\".'"),
      health: {
        type: "object",
        description: "Health inputs for the score: seo sprint health score (0-100, 100 best), billing overdueCount and overdueMinor.",
        properties: { score: int("0 to 100, 100 best (SEO sprint health).", { minimum: 0, maximum: 100 }), overdueCount: int("Invoices overdue now.", { minimum: 0 }), overdueMinor: int("Amount overdue in minor units (cents).", { minimum: 0 }), currency: text("3-letter currency code."), note: text("One line of context.") },
      } as JsonSchema,
      note: text("One line shown under the section."),
    }),
  },
  {
    name: "set-report-narrative",
    displayName: "Write the report summary",
    description:
      "Write the words of the report: a summary of how the month went (3 to 5 plain, honest sentences), the highlights the client will care about, and what happens next month. Never paste internal ticket titles or costs. The report is re-rendered with it.",
    parametersSchema: schema(["client", "summary"], {
      client: P.client,
      period: P.period,
      summary: text("3 to 5 plain sentences on how the month went for the client. At least 40 characters."),
      highlights: textList("Up to 6 things that went well or mattered, each one sentence."),
      next: textList("Up to 6 things planned for next month, each one sentence."),
    }),
  },
  {
    name: "send-client-report",
    displayName: "Send client report",
    description:
      "Draft the email that sends the report (the report is its body) and ask for approval. It refreshes the numbers first and needs the summary written (set-report-narrative). A person approves by marking the approval issue done; then the Mailbox sends it. You cannot send it yourself. One send per client and month.",
    parametersSchema: schema(["client"], {
      client: P.client,
      period: P.period,
      contactId: P.contact,
      toEmail: P.toEmail,
      message: text("An optional personal line above the report."),
    }),
  },
  {
    name: "skip-client-report",
    displayName: "Skip client report",
    description: "There is genuinely nothing to report for this client this month (a new client, a paused service). Records the reason and lets the report issue close.",
    parametersSchema: schema(["client", "reason"], { client: P.client, period: P.period, reason: text("Why there is no report this month, at least a sentence.") }),
  },
  {
    name: "list-client-reports",
    displayName: "List client reports",
    description: "A client's monthly reports (or every client's) with their status: built, awaiting approval, sent, dry run or skipped.",
    parametersSchema: schema([], { client: P.client, period: text("Only this month, YYYY-MM.") }),
  },

  // -------------------------------------------------------------------------
  // Support, feedback and health
  // -------------------------------------------------------------------------
  {
    name: "open-support-case",
    displayName: "Open support case",
    description:
      "Open a support case for a client: what they need, how urgent, and the two SLA targets (first response and resolution, in calendar hours: urgent 1/8, high 4/24, normal 8/72, low 24/168). Support mail that the Mailbox sorts as support opens its own case; use this for a request that came another way (a call, a lead, an uptime problem) or to open one yourself for a thread. A case that did not come by mail opens a work issue for the Account Manager.",
    parametersSchema: schema(["client", "title"], {
      client: P.client,
      title: text("What the client needs, in a few words."),
      summary: text("Details: what happened, what they asked, what you know."),
      severity: oneOf(CASE_SEVERITIES, "urgent: the client cannot work or money is at risk. high: a key part is broken. normal (default). low: a question or a small request."),
      source: oneOf(CASE_SOURCES, "Where it came from (default manual). mail wraps the Mailbox's Reply-needed issue and opens no work issue."),
      contactId: P.contact,
      threadId: text("The Mailbox thread id, for a mail case."),
      messageId: text("The Mailbox message id, so the same mail never opens two cases."),
      firstResponseHours: int("Override the first-response target, in hours.", { minimum: 1, maximum: 1440 }),
      resolutionHours: int("Override the resolution target, in hours.", { minimum: 1, maximum: 1440 }),
    }),
  },
  {
    name: "update-support-case",
    displayName: "Update support case",
    description:
      "Keep a support case current. firstResponse true records that you answered the client (the Mailbox's Reply-needed issue closing does this for a mail case). Set waiting_client while the client owes you something (the resolution clock pauses). resolved needs resolution: what you did. Raising severity tightens the targets; lowering it never gives time back.",
    parametersSchema: schema(["caseId"], {
      caseId: text("The case id (from list-support-cases)."),
      status: oneOf(CASE_STATUSES, "new, open, waiting_client, resolved or closed."),
      severity: oneOf(CASE_SEVERITIES, "Change the severity."),
      firstResponse: bool("true: you answered the client now."),
      resolution: text("What resolved it, at least a sentence. Required with status resolved."),
      summary: text("Replace the summary."),
      note: text("One line for the client's timeline."),
    }),
  },
  {
    name: "list-support-cases",
    displayName: "List support cases",
    description: "Support cases with where each stands against its targets (met, ok, at risk, breached, paused). Default: open cases.",
    parametersSchema: schema([], { client: P.client, status: oneOf(["open", "breached", "all", ...CASE_STATUSES], "open (default), breached (past a target), all, or one status.") }),
  },
  {
    name: "request-feedback",
    displayName: "Request feedback (NPS or CSAT)",
    description:
      "Draft a feedback request to one person at the client and ask for approval; nothing is sent by itself. nps asks 0 to 10 how likely they are to recommend us (at most once in 90 days per person). csat asks 1 to 5 how satisfied they were with one resolved case (needs caseId). A reply that starts with a number is recorded; a low score opens an issue for the Account Manager.",
    parametersSchema: schema(["client", "kind"], {
      client: P.client,
      kind: oneOf(FEEDBACK_KINDS, "nps or csat."),
      caseId: text("For csat: the resolved case it is about."),
      contactId: P.contact,
      toEmail: P.toEmail,
    }),
  },
  {
    name: "record-feedback",
    displayName: "Record feedback",
    description: "Record a score the client gave another way (a call, a message). Give feedbackId for a request that was sent, or client and kind for a new one. A low score (NPS 6 or less, CSAT 2 or less) opens an issue for the Account Manager.",
    parametersSchema: schema(["score"], {
      feedbackId: text("The request's id (from request-feedback or the client page)."),
      client: P.client,
      kind: oneOf(FEEDBACK_KINDS, "nps (0-10) or csat (1-5). Needed without feedbackId."),
      score: int("0 to 10 for nps, 1 to 5 for csat.", { minimum: 0, maximum: 10 }),
      comment: text("What they said, short."),
    }),
  },
  {
    name: "client-health",
    displayName: "Client health score",
    description:
      "A customer's health score from 0 to 100 and what it is made of: support load, reply speed, overdue invoices, SEO health, website uptime, answers to our requests, recency. Parts without data are listed as not measured, never guessed. Give a client to score one now; without one you get every customer's stored score, weakest first (onlyAtRisk filters to the risk band).",
    parametersSchema: schema([], { client: P.client, onlyAtRisk: bool("true: only customers in the risk band (under 50).") }),
  },

  // -------------------------------------------------------------------------
  // Client requests: the waiting-on-client state
  // -------------------------------------------------------------------------
  {
    name: "create-client-action",
    displayName: "Ask a client to do something",
    description:
      "Ask a client to sign off, give access, approve or send something, with the exact link they must open. Records the request, drafts the email and asks for approval; a person approves by marking the approval issue done, then it is sent and the request waits on the client. After 3 days (remindAfterDays) a reminder is drafted for approval, up to two; a reply, or marking the request done or cancelled, withdraws a reminder still waiting for approval; then the Account Manager gets an issue to reach them another way. The link must be one the client can open (https; never a Paperclip board page): a preview link, a sign-in or consent page. You cannot send it yourself.",
    parametersSchema: schema(["client", "kind", "title"], {
      client: P.client,
      kind: oneOf(ACTION_KINDS, "sign_off (a preview or deliverable), grant (access or a login), approval (a decision), info (something we need from them)."),
      title: text("What they must do, in a few words, e.g. 'Approve the new homepage'."),
      instructions: text("What to click and what to expect, plain words."),
      link: text("The exact https link the client opens."),
      linkLabel: text("The words next to the link, e.g. 'See the preview'."),
      contactId: P.contact,
      toEmail: P.toEmail,
      dueInDays: int("A date to ask for, days from now (1 to 90).", { minimum: 1, maximum: 90 }),
      remindAfterDays: int("Days before a reminder is drafted (1 to 14, default 3).", { minimum: 1, maximum: 14 }),
      message: text("Your own opening paragraph instead of the standard one."),
      sourceRef: text("Where it came from, e.g. seo:preview:<id> or an issue id."),
    }),
  },
  {
    name: "update-client-action",
    displayName: "Update client request",
    description: "Record the outcome of a request to a client: done (they did it; say what they answered) or cancelled (no longer needed). A request whose email is still waiting for approval can only be cancelled.",
    parametersSchema: schema(["actionId", "status"], {
      actionId: text("The request's id (from list-client-actions)."),
      status: oneOf(["done", "cancelled"], "done or cancelled."),
      answer: text("What the client answered or did, short."),
    }),
  },
  {
    name: "list-client-actions",
    displayName: "List client requests",
    description: "What clients have been asked to do and where each stands: waiting, replied (read it), done, cancelled. Default: everything still open. waitingOnClient counts what is waiting on a client now.",
    parametersSchema: schema([], { client: P.client, status: oneOf(["open", "all", ...ACTION_STATUSES], "open (default: draft, waiting and replied), all, or one status.") }),
  },

  // -------------------------------------------------------------------------
  // Site monitoring
  // -------------------------------------------------------------------------
  {
    name: "site-monitoring",
    displayName: "Site monitoring status",
    description: "Uptime, certificate and domain status of a client's websites: up or down (and for how long), the last check, certificate days left, domain days left. Sites are checked every 5 minutes with one GET of their own address; certificates twice a day, domains once a day.",
    parametersSchema: schema(["client"], { client: P.client }),
  },
  {
    name: "set-site-monitoring",
    displayName: "Set site monitoring",
    description: "Pause or resume monitoring of one website, or set its domain expiry by hand when the registry lookup does not know the domain (it has no data for .co.za, so set the date for every .co.za site; an empty domainExpiresAt goes back to the lookup).",
    parametersSchema: schema(["siteId"], {
      siteId: text("The site's id (from list-client-sites)."),
      enabled: bool("false pauses monitoring, true resumes it."),
      domainExpiresAt: text("The domain's expiry date from the registrar, e.g. 2027-03-31. Empty to use the registry lookup."),
    }),
  },

  // -------------------------------------------------------------------------
  // Privacy
  // -------------------------------------------------------------------------
  {
    name: "record-consent",
    displayName: "Record consent or lawful basis",
    description:
      "Record why a person may be contacted, or that they no longer agree: the purpose, the lawful basis (consent, contract, legitimate interest, legal obligation), where it came from and the exact wording or evidence. Evidence is required (at least a sentence): what they wrote or saw, where and when. A withdrawal (granted false) also marks them unsubscribed and tells the other modules. Forms record their own consent; this is for a reply, an import or a conversation.",
    parametersSchema: schema([], {
      contactId: text("The contact (contact:<id> or id). Or give email."),
      email: text("The person's email address."),
      purpose: oneOf(["marketing_email", "marketing_sms", "newsletter", "profiling", "service_messages"], "What they agreed to (default marketing_email)."),
      basis: oneOf(["consent", "contract", "legitimate_interest", "legal_obligation"], "The lawful basis (default consent)."),
      granted: bool("false when they withdrew or refused (default true)."),
      source: oneOf(["manual", "reply", "import", "api"], "How it reached us (default manual)."),
      wording: text("What they wrote or saw, and where and when; or for another basis, why it applies (e.g. 'existing customer, similar services, offered an opt-out')."),
      url: text("The page it was given on, if any."),
      expiresInDays: int("Consent that lapses: days from now.", { minimum: 1, maximum: 3650 }),
      client: text("Only if this consent is for a client's own list: company:<id> or contact:<id>. Leave out for our own list."),
    }),
  },
  {
    name: "export-person-data",
    displayName: "Export one person's data",
    description: "Everything the CRM holds about one person (contact, notes, field history, sequences, consent, website enquiries, deals, cases, requests, feedback), for a data subject access request, with counts and which other modules to ask for the rest. Check the requester is the person first. To give them a copy, draft a Mailbox email to the address on file for a person to approve.",
    parametersSchema: schema([], { contactId: text("The contact (contact:<id> or id). Or give email."), email: text("The person's email address.") }),
  },
  {
    name: "request-erasure",
    displayName: "Request erasure of a person",
    description:
      "Ask for one person's data to be erased (a POPIA request). Erasure cannot be undone, so this only opens an approval for a person with exactly what will go; when they approve, the CRM erases and the Mailbox, Campaigns, Social, Billing and Accounting are asked to erase theirs (records the law makes us keep are kept and reported). Needs the evidence of the request and that you checked it is the person. scope marketing_only keeps the record but stops all marketing.",
    parametersSchema: schema(["evidence", "identityChecked"], {
      contactId: text("The contact (contact:<id> or id). Or give email."),
      email: text("The person's email address."),
      scope: oneOf(["all", "marketing_only"], "all (default): erase everything. marketing_only: stop marketing, keep the record."),
      reason: oneOf(["data_subject_request", "retention_expired", "client_offboarding", "withdrawn_consent"], "Why (default data_subject_request)."),
      evidence: text("How the request came and how you know it is the person: the email, its date and that it came from the address on file. At least a sentence."),
      identityChecked: bool("true: you checked the request is from the person themselves."),
    }),
  },
  {
    name: "list-data-processing",
    displayName: "Data-processing register",
    description: "The systems that hold personal data for us: what they get, where they are, how long they keep it, whether an agreement is on file, and whether a client flagged sensitive may be handled there. Read-only; `unverified` is a to-do for the owner.",
    parametersSchema: schema([], { forSensitiveClient: bool("true: only the systems a sensitive client's data must stay off.") }),
  },
  {
    name: "set-client-sensitivity",
    displayName: "Set client sensitivity",
    description: "Flag a client's data as sensitive (health, legal, financial or children's data, or a contract that limits where data goes) or standard. A sensitive client's data must stay off every system the register does not mark cleared; the Cockpit and routing read the flag. You may raise it to sensitive; only a person lowers it.",
    parametersSchema: schema(["client", "level"], {
      client: P.client,
      level: oneOf(SENSITIVITY_LEVELS, "standard or sensitive."),
      reason: text("Why it is sensitive, at least a sentence (required for sensitive)."),
    }),
  },
];
