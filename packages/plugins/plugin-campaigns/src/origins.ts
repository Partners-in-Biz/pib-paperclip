/**
 * Origin ids of the Paperclip issues Campaigns opens: `campaigns:<kind>:…`,
 * one prefix per kind of work. They are stable (one issue per step, failed
 * send, refusal and reply) and namespaced, so a done check never matches
 * another module's issue (the kit matches rules by origin id prefix only; the
 * CRM also uses `reply:` and `send-failed:`).
 */

export const CAMPAIGN_ORIGINS = {
  /** A due step for one contact: `campaigns:step:<enrollmentId>:<position>`. */
  step: "campaigns:step:",
  /** A step email the Mailbox could not send: `campaigns:send-failed:<enrollmentId>:<position>`. */
  sendFailed: "campaigns:send-failed:",
  /** A person refused the launch: `campaigns:revise:<campaignId>:<refused approval issue id>`. */
  revise: "campaigns:revise:",
  /** A reply to a campaign email: `campaigns:reply:<enrollmentId>:<Mailbox message id>`. */
  reply: "campaigns:reply:",
  /** The launch approval, a person's decision (never done-checked): `campaigns:approval:<campaignId>`. */
  approval: "campaigns:approval:",
} as const;

export const stepOrigin = (enrollmentId: string, position: number) => `${CAMPAIGN_ORIGINS.step}${enrollmentId}:${position}`;
export const sendFailedOrigin = (enrollmentId: string, position: number) => `${CAMPAIGN_ORIGINS.sendFailed}${enrollmentId}:${position}`;
export const reviseOrigin = (campaignId: string, approvalIssueId: string) => `${CAMPAIGN_ORIGINS.revise}${campaignId}:${approvalIssueId}`;
export const replyOrigin = (enrollmentId: string, messageId: string) => `${CAMPAIGN_ORIGINS.reply}${enrollmentId}:${messageId}`;
export const approvalOrigin = (campaignId: string) => `${CAMPAIGN_ORIGINS.approval}${campaignId}`;

/** `<prefix><enrollmentId>:<position>` → its parts, or null. */
export function parseStepOrigin(originId: string | null | undefined, prefix: string): { enrollmentId: string; position: number } | null {
  if (!originId?.startsWith(prefix)) return null;
  const rest = originId.slice(prefix.length);
  const colon = rest.lastIndexOf(":");
  if (colon <= 0) return null;
  const position = Number(rest.slice(colon + 1));
  return Number.isInteger(position) && position > 0 ? { enrollmentId: rest.slice(0, colon), position } : null;
}

/** `<prefix><id>:<rest>` (the first id has no colon) → both parts, or null. */
export function parsePairOrigin(originId: string | null | undefined, prefix: string): { id: string; rest: string } | null {
  if (!originId?.startsWith(prefix)) return null;
  const tail = originId.slice(prefix.length);
  const colon = tail.indexOf(":");
  if (colon <= 0 || colon === tail.length - 1) return null;
  return { id: tail.slice(0, colon), rest: tail.slice(colon + 1) };
}
