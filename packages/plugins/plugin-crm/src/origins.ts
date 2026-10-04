/**
 * Origin ids of the issues the CRM opens (`originKind` `plugin:partnersinbiz.crm`).
 *
 * Every id starts with `crm:` and one prefix per kind of work. Done-checks
 * (kit `registerDoneChecks`) match issues by origin id prefix only, so the
 * namespace keeps another plugin's rule off our issues (Campaigns also opens
 * `reply:` and `send-failed:` issues) and ours off theirs.
 *
 * Issues opened before 0.5.0 carry the old ids (`LEGACY_ORIGINS`): they are
 * still deduped, adopted and listed, but never checked.
 */
export const CRM_ORIGINS = {
  /** `crm:lead-followup:<lead key>`: follow up a captured lead. */
  leadFollowUp: "crm:lead-followup:",
  /** `crm:reply:<Gmail message id>`: a contact in a running sequence replied. */
  reply: "crm:reply:",
  /** `crm:step:<enrollment id>:<step position>`: a due sequence step done by hand. */
  step: "crm:step:",
  /** `crm:send-failed:<enrollment id>:<step position>`: a sequence email the Mailbox could not send. */
  sendFailed: "crm:send-failed:",
  /** `crm:won-client:<deal id>`: a won deal with no company or contact. */
  wonClient: "crm:won-client:",
  /** `crm:quote-deal:<quote id>`: an accepted quote that names no deal, for a client with several open deals. */
  quoteDeal: "crm:quote-deal:",
  /** `crm:sequence-refused:<approval issue id>`: a person refused a sequence's email sending. */
  sequenceRefused: "crm:sequence-refused:",
  /** `crm:sequence-email:<sequence id>`: approve a sequence's email sending (a person decides; never checked). */
  sequenceEmail: "crm:sequence-email:",
  /** `crm:pipeline-check:<date>`: open deals gone quiet (Sales Lead). */
  pipelineCheck: "crm:pipeline-check:",
  /** `crm:pipeline-summary:<date>`: the Monday pipeline summary (Sales Lead; a report, never checked). */
  pipelineSummary: "crm:pipeline-summary:",
  /** `crm:duplicates:<date>`: contacts that share an email (CRM Data Steward). */
  duplicates: "crm:duplicates:",
  /** `crm:hygiene:<date>`: the Monday CRM hygiene report (CRM Data Steward; a report, never checked). */
  hygiene: "crm:hygiene:",
  /** `crm:client-lead:<lead key>`: a lead that came in on a client's own form (Inbound Qualifier hands it to the client). */
  clientLead: "crm:client-lead:",
  /** `crm:service-onboard:<kind>:<client id>:<service>:<yyyymmdd>`: start a service a customer bought (the role that owns it). */
  serviceOnboard: "crm:service-onboard:",
  /** `crm:client-report:<kind>:<client id>:<YYYY-MM>`: write and send the month's report for a client (Account Manager). */
  clientReport: "crm:client-report:",
  /** `crm:support-case:<case id>`: work a support case that did not come by mail (mail cases use the Mailbox's Reply-needed issue). */
  supportCase: "crm:support-case:",
  /** `crm:support-breach:<case id>:<first|resolution>`: a support SLA ran out (escalation for the Account Manager). */
  supportBreach: "crm:support-breach:",
  /** `crm:client-action-stale:<action id>`: a client has not answered a request after the reminders. */
  clientActionStale: "crm:client-action-stale:",
  /** `crm:churn-risk:<kind>:<client id>:<YYYY-MM>`: a customer's health score is in the risk band. */
  churnRisk: "crm:churn-risk:",
  /** `crm:msg-failed:<approval id>`: an approved email to a client could not be sent. */
  msgFailed: "crm:msg-failed:",
  /** `crm:site-down:<site id>:<episode>`: a client's website is down (Delivery Lead). */
  siteDown: "crm:site-down:",
  /** `crm:site-tls:<site id>:<expiry date>`: a certificate is about to expire (Delivery Lead). */
  siteTls: "crm:site-tls:",
  /** `crm:site-domain:<site id>:<expiry date>`: a domain is about to expire (Delivery Lead). */
  siteDomain: "crm:site-domain:",
  /** `crm:feedback-low:<feedback id>`: a client gave a low NPS or CSAT score (Account Manager). */
  feedbackLow: "crm:feedback-low:",
  /** `crm:approval:<approval id>`: an email to a client, or an erasure, that a person decides (never checked). */
  approval: "crm:approval:",
  /** `crm:esign:<document id>`: get a document signed by a client (Deal Desk; done when it is signed, declined or withdrawn). */
  esign: "crm:esign:",
  /** `crm:esign-stale:<document id>`: a client has not signed after the reminders (Account Manager). */
  esignStale: "crm:esign-stale:",
} as const;

export const originFor = {
  leadFollowUp: (leadKey: string) => `${CRM_ORIGINS.leadFollowUp}${leadKey}`,
  reply: (messageId: string) => `${CRM_ORIGINS.reply}${messageId}`,
  step: (enrollmentId: string, position: number) => `${CRM_ORIGINS.step}${enrollmentId}:${position}`,
  sendFailed: (enrollmentId: string, position: number) => `${CRM_ORIGINS.sendFailed}${enrollmentId}:${position}`,
  wonClient: (dealId: string) => `${CRM_ORIGINS.wonClient}${dealId}`,
  quoteDeal: (quoteRef: string) => `${CRM_ORIGINS.quoteDeal}${quoteRef}`,
  sequenceRefused: (approvalIssueId: string) => `${CRM_ORIGINS.sequenceRefused}${approvalIssueId}`,
  sequenceEmail: (sequenceId: string) => `${CRM_ORIGINS.sequenceEmail}${sequenceId}`,
  pipelineCheck: (date: string) => `${CRM_ORIGINS.pipelineCheck}${date}`,
  pipelineSummary: (date: string) => `${CRM_ORIGINS.pipelineSummary}${date}`,
  duplicates: (date: string) => `${CRM_ORIGINS.duplicates}${date}`,
  hygiene: (date: string) => `${CRM_ORIGINS.hygiene}${date}`,
  clientLead: (leadKey: string) => `${CRM_ORIGINS.clientLead}${leadKey}`,
  clientReport: (kind: string, clientId: string, period: string) => `${CRM_ORIGINS.clientReport}${kind}:${clientId}:${period}`,
  supportCase: (caseId: string) => `${CRM_ORIGINS.supportCase}${caseId}`,
  supportBreach: (caseId: string, which: "first" | "resolution") => `${CRM_ORIGINS.supportBreach}${caseId}:${which}`,
  clientActionStale: (actionId: string) => `${CRM_ORIGINS.clientActionStale}${actionId}`,
  churnRisk: (kind: string, clientId: string, period: string) => `${CRM_ORIGINS.churnRisk}${kind}:${clientId}:${period}`,
  msgFailed: (approvalId: string) => `${CRM_ORIGINS.msgFailed}${approvalId}`,
  feedbackLow: (feedbackId: string) => `${CRM_ORIGINS.feedbackLow}${feedbackId}`,
  esign: (documentId: string) => `${CRM_ORIGINS.esign}${documentId}`,
  esignStale: (documentId: string) => `${CRM_ORIGINS.esignStale}${documentId}`,
  siteDown: (siteId: string, episode: string) => `${CRM_ORIGINS.siteDown}${siteId}:${episode}`,
  siteTls: (siteId: string, expiry: string) => `${CRM_ORIGINS.siteTls}${siteId}:${expiry}`,
  siteDomain: (siteId: string, expiry: string) => `${CRM_ORIGINS.siteDomain}${siteId}:${expiry}`,
};

/** The ids issues had before 0.5.0 (a step issue's was the bare enrollment id). */
export const LEGACY_ORIGINS = {
  leadFollowUp: (leadKey: string) => `lead:${leadKey}`,
  reply: (messageId: string) => `reply:${messageId}`,
  sendFailed: (sendingKeyOrEnrollmentId: string) => `send-failed:${sendingKeyOrEnrollmentId}`,
  wonClient: (dealId: string) => `won:${dealId}`,
  quoteDeal: (quoteRef: string) => `quote:${quoteRef}`,
  sequenceRefused: (approvalIssueId: string) => `handoff:sequence-refused:${approvalIssueId}`,
};

/** Work the CRM hands to agents (not approvals or hires), old and new ids. */
export const WORK_ORIGIN_RE = /^(lead|reply|send-failed|handoff|won|quote|step):|^crm:(lead-followup|reply|step|send-failed|won-client|quote-deal|sequence-refused|pipeline-check|pipeline-summary|duplicates|hygiene|client-lead|service-onboard|client-report|support-case|support-breach|client-action-stale|churn-risk|msg-failed|feedback-low|site-down|site-tls|site-domain|esign|esign-stale):/;

/** Lead follow-ups, old and new ids. */
export function isLeadFollowUp(originId: string | null | undefined): boolean {
  return typeof originId === "string" && (originId.startsWith(CRM_ORIGINS.leadFollowUp) || originId.startsWith("lead:"));
}

/** Contact replies, old and new ids. */
export function isReplyWork(originId: string | null | undefined): boolean {
  return typeof originId === "string" && (originId.startsWith(CRM_ORIGINS.reply) || originId.startsWith("reply:"));
}

/** `<enrollment id>:<position>` after a step or send-failed prefix, or null. */
export function parseStepRef(originId: string | null | undefined, prefix: string): { enrollmentId: string; position: number } | null {
  if (typeof originId !== "string" || !originId.startsWith(prefix)) return null;
  const rest = originId.slice(prefix.length);
  const cut = rest.lastIndexOf(":");
  if (cut <= 0) return null;
  const position = Number(rest.slice(cut + 1));
  return Number.isInteger(position) ? { enrollmentId: rest.slice(0, cut), position } : null;
}
