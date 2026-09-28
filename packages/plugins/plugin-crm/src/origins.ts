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
export const WORK_ORIGIN_RE = /^(lead|reply|send-failed|handoff|won|quote|step):|^crm:(lead-followup|reply|step|send-failed|won-client|quote-deal|sequence-refused):/;

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
