/**
 * Done-checks for the work the CRM hands to agents (kit `registerDoneChecks`).
 *
 * When an agent marks one of these issues done, its rule reads the CRM's own
 * data (never Jev or the network). Unfinished work is reopened with what is
 * missing; a person's close is never checked. Each rule also passes when the
 * work was finished another way (the contact opted out, the sequence stopped,
 * the deal was moved), so an agent is never trapped.
 *
 * No rule: the sequence email approval (only a person decides; an agent's
 * close is reopened for the approver) and the refused-sequence hand-off (a
 * judgement call).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { DoneCheckIssue, DoneCheckResult, DoneCheckRule } from "@partnersinbiz/pib-plugin-kit";
import { asRecord, contactCompanyLinks, enrollmentById, getContact, getDeal, listDeals, listSteps, stageKind, table } from "./db.js";
import { ACTIVITY_KINDS, type ContactDraft, type DealDraft } from "./domain.js";
import { clientDeals } from "./handoffs.js";
import { CRM_ORIGINS, parseStepRef } from "./origins.js";

/** Timeline entries that show someone worked the client: logged with `log-activity`, a sequence email sent, a deal moved or won. */
export const WORK_KINDS: string[] = [...ACTIVITY_KINDS, "email_sent", "deal_moved", "deal_won"];

const DONE: DoneCheckResult = { done: true };

/** When the issue opened (everything before it is not evidence). */
function openedAt(issue: DoneCheckIssue): string {
  return issue.createdAt ?? new Date(0).toISOString();
}

function who(contact: ContactDraft): string {
  return `${contact.name} (\`contact:${contact.id}\`)`;
}

function optedOut(contact: ContactDraft): boolean {
  return contact.emailStatus === "unsubscribed" || contact.emailStatus === "bounced";
}

function hasNextAction(contact: ContactDraft): boolean {
  return Boolean(contact.nextActionKind || contact.nextActionDueAt);
}

/** The contact an intake activity (source key `lead:<key>`, `mail:<id>`, `reply:<id>`) was logged on, in this company. */
async function contactBySource(ctx: PluginContext, companyId: string, sourceKeys: string[]): Promise<ContactDraft | null> {
  for (const key of sourceKeys) {
    const rows = await ctx.db.query<{ record_id: string }>(
      `SELECT record_id FROM ${table(ctx, "activities")} WHERE company_id = $1 AND source_key = $2 AND record_type = 'contact' LIMIT 1`,
      [companyId, key],
    );
    const id = rows[0]?.record_id;
    if (!id) continue;
    const contact = await getContact(ctx, id);
    if (contact && contact.companyId === companyId) return contact;
  }
  return null;
}

/** The contact, the companies they work at and their deals (their own or their company's): where work on them is logged. */
async function contactScope(ctx: PluginContext, companyId: string, contact: ContactDraft): Promise<{ recordIds: string[]; deals: DealDraft[] }> {
  const links = await contactCompanyLinks(ctx, contact.id).catch(() => []);
  const accountIds = new Set(links.map((link) => link.accountId));
  const deals = (await listDeals(ctx, companyId)).filter(
    (deal) => deal.companyId === companyId && (deal.contactId === contact.id || (deal.accountId != null && accountIds.has(deal.accountId))),
  );
  return { recordIds: [contact.id, ...accountIds, ...deals.map((deal) => deal.id)], deals };
}

/** True when work (`WORK_KINDS`) was logged on any of these records at or after `since`. */
export async function workLoggedSince(ctx: PluginContext, companyId: string, recordIds: string[], since: string): Promise<boolean> {
  if (recordIds.length === 0) return false;
  const rows = await ctx.db.query<{ id: string }>(
    `SELECT id FROM ${table(ctx, "activities")}
      WHERE company_id = $1 AND record_id = ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb)))
        AND kind = ANY(ARRAY(SELECT jsonb_array_elements_text($3::jsonb))) AND created_at >= $4::timestamptz
      LIMIT 1`,
    [companyId, JSON.stringify(recordIds), JSON.stringify(WORK_KINDS), since],
  );
  return rows.length > 0;
}

/** True when an agent or a person set any of these contact fields at or after `since` (update-contact records each field it writes). */
export async function contactFieldsSetSince(ctx: PluginContext, companyId: string, contactId: string, fields: string[], since: string): Promise<boolean> {
  const rows = await ctx.db.query<{ field_key: string }>(
    `SELECT field_key FROM ${table(ctx, "facts")}
      WHERE company_id = $1 AND record_type = 'contact' AND record_id = $2
        AND field_key = ANY(ARRAY(SELECT jsonb_array_elements_text($3::jsonb))) AND refused = false AND created_at >= $4::timestamptz
      LIMIT 1`,
    [companyId, contactId, JSON.stringify(fields), since],
  );
  return rows.length > 0;
}

async function stageKinds(ctx: PluginContext, companyId: string): Promise<Map<string, string>> {
  const rows = await ctx.db.query<{ id: string; kind: string }>(`SELECT id, kind FROM ${table(ctx, "pipeline_stages")} WHERE company_id = $1`, [companyId]);
  return new Map(rows.map((row) => [row.id, stageKind(row.kind)]));
}

async function wonDealIdsSince(ctx: PluginContext, companyId: string, since: string): Promise<Set<string>> {
  const rows = await ctx.db.query<{ id: string }>(`SELECT id FROM ${table(ctx, "deals")} WHERE company_id = $1 AND won_at >= $2::timestamptz`, [companyId, since]);
  return new Set(rows.map((row) => row.id));
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/** Lead follow-up: work logged since the lead came in, plus a next step (a deal, a next action, or a lifecycle decision). */
export async function checkLeadFollowUp(ctx: PluginContext, issue: DoneCheckIssue): Promise<DoneCheckResult> {
  const leadKey = (issue.originId ?? "").slice(CRM_ORIGINS.leadFollowUp.length);
  const contact = await contactBySource(ctx, issue.companyId, [`lead:${leadKey}`]);
  // Gone (merged away or deleted) or opted out: nothing left to follow up.
  if (!contact || optedOut(contact)) return DONE;
  const scope = await contactScope(ctx, issue.companyId, contact);
  const logged = await workLoggedSince(ctx, issue.companyId, scope.recordIds, openedAt(issue));
  const decided = scope.deals.length > 0 || hasNextAction(contact) || contact.lifecycle !== "lead";
  if (logged && decided) return DONE;
  const missing: string[] = [];
  if (!logged) missing.push(`Nothing is logged on ${who(contact)} since the lead came in: log what you learned with \`log-activity\`.`);
  if (!decided) {
    missing.push(`${contact.name} has no next step: set a next action (\`update-contact\` nextActionKind and nextActionDueAt), create a deal (\`create-deal\`), or set lifecycle prospect (qualified) or churned (not a fit).`);
  }
  return { done: false, missing };
}

/** Contact reply: answered and logged, or a decision recorded since the reply came in. */
export async function checkReply(ctx: PluginContext, issue: DoneCheckIssue): Promise<DoneCheckResult> {
  const messageId = (issue.originId ?? "").slice(CRM_ORIGINS.reply.length);
  const contact = await contactBySource(ctx, issue.companyId, [`mail:${messageId}`, `reply:${messageId}`]);
  if (!contact || optedOut(contact)) return DONE;
  const since = openedAt(issue);
  const scope = await contactScope(ctx, issue.companyId, contact);
  if (await workLoggedSince(ctx, issue.companyId, scope.recordIds, since)) return DONE;
  if (await contactFieldsSetSince(ctx, issue.companyId, contact.id, ["nextActionKind", "nextActionDueAt", "lifecycle"], since)) return DONE;
  return {
    done: false,
    missing: [`Nothing shows on ${who(contact)} since the reply came in: answer it from the Mailbox and log it (\`log-activity\`), or record what you decided (a next action, a deal move, or \`set-email-status\` when they opted out).`],
  };
}

/** The enrollment still waiting at this step, with its contact; null when nothing is left to do there. */
async function waitingStep(ctx: PluginContext, companyId: string, ref: { enrollmentId: string; position: number }): Promise<{ contact: ContactDraft; title: string } | null> {
  const enrollment = await enrollmentById(ctx, ref.enrollmentId);
  if (!enrollment || enrollment.companyId !== companyId) return null;
  // Stopped (a reply, a won or lost deal, an opt-out, churn), finished, or already past this step.
  if (enrollment.status !== "running" || enrollment.stepPosition !== ref.position) return null;
  const contact = await getContact(ctx, enrollment.contactId);
  if (!contact || contact.companyId !== companyId) return null;
  const step = (await listSteps(ctx, enrollment.sequenceId)).find((row) => row.position === ref.position);
  return { contact, title: step?.title ?? `step ${ref.position}` };
}

/** Sequence step done by hand: the step's work is logged on the contact. */
export async function checkStep(ctx: PluginContext, issue: DoneCheckIssue): Promise<DoneCheckResult> {
  const ref = parseStepRef(issue.originId, CRM_ORIGINS.step);
  const step = ref ? await waitingStep(ctx, issue.companyId, ref) : null;
  if (!step) return DONE;
  const scope = await contactScope(ctx, issue.companyId, step.contact);
  if (await workLoggedSince(ctx, issue.companyId, scope.recordIds, openedAt(issue))) return DONE;
  return { done: false, missing: [`Nothing is logged on ${who(step.contact)} since step "${step.title}" opened: do the step, log it with \`log-activity\`, then close this issue.`] };
}

/** Sequence email not sent: the address is fixed, the contact was reached another way, or the address is marked dead. */
export async function checkSendFailed(ctx: PluginContext, issue: DoneCheckIssue): Promise<DoneCheckResult> {
  const ref = parseStepRef(issue.originId, CRM_ORIGINS.sendFailed);
  const step = ref ? await waitingStep(ctx, issue.companyId, ref) : null;
  if (!step || optedOut(step.contact)) return DONE;
  const since = openedAt(issue);
  const scope = await contactScope(ctx, issue.companyId, step.contact);
  if (await workLoggedSince(ctx, issue.companyId, scope.recordIds, since)) return DONE;
  if (await contactFieldsSetSince(ctx, issue.companyId, step.contact.id, ["emails"], since)) return DONE;
  return {
    done: false,
    missing: [`The email for step "${step.title}" never reached ${who(step.contact)}: fix the address (\`update-contact\` emails) or reach them another way and log it (\`log-activity\`). A dead address: \`set-email-status\` bounced.`],
  };
}

/** Won deal without a client: the deal has a company or contact (or is no longer won, or is gone). */
export async function checkWonClient(ctx: PluginContext, issue: DoneCheckIssue): Promise<DoneCheckResult> {
  const deal = await getDeal(ctx, (issue.originId ?? "").slice(CRM_ORIGINS.wonClient.length));
  if (!deal || deal.companyId !== issue.companyId || deal.accountId || deal.contactId) return DONE;
  if ((await stageKinds(ctx, issue.companyId)).get(deal.stageId) !== "won") return DONE;
  return { done: false, missing: [`The won deal "${deal.title}" (\`${deal.id}\`) still has no client: link it with \`update-deal\` (dealId, companyRecordId or contactId).`] };
}

/** Accepted quote with no deal: a deal carries the quote, or one of the client's deals was won since the quote came in. */
export async function checkQuoteDeal(ctx: PluginContext, issue: DoneCheckIssue): Promise<DoneCheckResult> {
  const quoteRef = (issue.originId ?? "").slice(CRM_ORIGINS.quoteDeal.length);
  const companyId = issue.companyId;
  if ((await listDeals(ctx, companyId)).some((deal) => deal.companyId === companyId && deal.custom.quoteId === quoteRef)) return DONE;
  const rows = await ctx.db.query<{ record_type: string; record_id: string; meta: unknown }>(
    `SELECT record_type, record_id, meta FROM ${table(ctx, "activities")} WHERE company_id = $1 AND issue_id = $2 AND kind = 'quote_accepted' LIMIT 1`,
    [companyId, issue.id],
  );
  const pick = rows[0];
  // Without the quote's client there is no way to tell which deals it could close: never trap the agent.
  if (!pick || (pick.record_type !== "company" && pick.record_type !== "contact")) return DONE;
  const deals = await clientDeals(ctx, companyId, pick.record_type, pick.record_id);
  const won = await wonDealIdsSince(ctx, companyId, openedAt(issue));
  if (deals.some((deal) => won.has(deal.id))) return DONE;
  const kinds = await stageKinds(ctx, companyId);
  // No open deal left to pick (a person closed them another way).
  if (!deals.some((deal) => (kinds.get(deal.stageId) ?? "open") === "open")) return DONE;
  const number = asRecord(pick.meta).number;
  return {
    done: false,
    missing: [`Quote ${typeof number === "string" && number ? number : quoteRef} is not linked to a deal yet: move the deal it closes to won with \`move-deal\` (dealId, stageId won, quoteId \`${quoteRef}\`).`],
  };
}

/** One rule per kind of work the CRM hands to agents. */
export const CRM_DONE_CHECKS: DoneCheckRule[] = [
  { originPrefix: CRM_ORIGINS.leadFollowUp, label: "Lead follow-up", check: (issue, ctx) => checkLeadFollowUp(ctx, issue) },
  { originPrefix: CRM_ORIGINS.reply, label: "Contact reply", check: (issue, ctx) => checkReply(ctx, issue) },
  { originPrefix: CRM_ORIGINS.step, label: "Sequence step", check: (issue, ctx) => checkStep(ctx, issue) },
  { originPrefix: CRM_ORIGINS.sendFailed, label: "Sequence email not sent", check: (issue, ctx) => checkSendFailed(ctx, issue) },
  { originPrefix: CRM_ORIGINS.wonClient, label: "Won deal without a client", check: (issue, ctx) => checkWonClient(ctx, issue) },
  { originPrefix: CRM_ORIGINS.quoteDeal, label: "Deal for an accepted quote", check: (issue, ctx) => checkQuoteDeal(ctx, issue) },
];

/** The host issue as the kit's done-check sees it. */
export function doneCheckIssue(
  raw: { id: string; title: string; originId?: string | null; assigneeAgentId?: string | null; createdAt?: unknown; identifier?: string | null },
  companyId: string,
): DoneCheckIssue {
  const created = raw.createdAt ? new Date(raw.createdAt as string) : null;
  return {
    id: raw.id,
    companyId,
    identifier: raw.identifier ?? null,
    title: raw.title,
    originId: raw.originId ?? null,
    assigneeAgentId: raw.assigneeAgentId ?? null,
    createdAt: created && Number.isFinite(created.getTime()) ? created.toISOString() : null,
  };
}

/**
 * Whether an agent's close of this issue stands: its rule passed, no rule
 * covers it, or the check failed to run (a broken check never holds work up).
 * The step issue handler uses it so a contact moves on only when the step is done.
 */
export async function closeStands(ctx: PluginContext, issue: DoneCheckIssue): Promise<boolean> {
  const rule = CRM_DONE_CHECKS.find((row) => issue.originId?.startsWith(row.originPrefix));
  if (!rule) return true;
  try {
    return (await rule.check(issue, ctx)).done;
  } catch (error) {
    ctx.logger.info("CRM done check could not run; the close stands", { issueId: issue.id, error: error instanceof Error ? error.message : String(error) });
    return true;
  }
}
