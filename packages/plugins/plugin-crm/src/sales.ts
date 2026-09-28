/**
 * The sales team's scheduled work. Each job opens an issue only when there is
 * something to do, never a second one while the last is open, and routes it
 * to the role that owns it (the Account Manager covers an unstaffed role):
 *
 * - daily: open deals idle for 14 days (Sales Lead), and contacts that share
 *   an email (CRM Data Steward);
 * - Mondays: the weekly pipeline summary (Sales Lead) and the CRM hygiene
 *   report (CRM Data Steward), for companies with CRM records.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createWorkIssue, formatMoneyMinor, isModuleEnabled } from "@partnersinbiz/pib-plugin-kit";
import { DEAL_IDLE_DAYS } from "./cockpit.js";
import { findDuplicateContacts, table } from "./db.js";
import { duplicateGroups } from "./domain.js";
import { PLUGIN_ID } from "./namespace.js";
import { CRM_ORIGINS, originFor } from "./origins.js";
import { companyPrefix, crmLink, pagePath } from "./refs.js";
import { teamAssignee } from "./routing.js";
import { crmCompanyIds } from "./sync.js";
import type { CrmRoleKey } from "./agent.js";

const ORIGIN = `plugin:${PLUGIN_ID}` as const;
const OPEN_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;

export interface IdleDeal {
  id: string;
  title: string;
  amountMinor: number;
  currency: string;
  contactId: string | null;
  accountId: string | null;
  lastAt: string;
}

interface IdleDealRow {
  id: string;
  title: string;
  amount_minor: string | number;
  currency: string;
  contact_id: string | null;
  account_id: string | null;
  last_at: string;
}

/** Open deals with nothing logged on them, their contact or their company, and no change, for `DEAL_IDLE_DAYS` (the Cockpit's "stuck" rule). */
export async function idleDeals(ctx: PluginContext, companyId: string, limit = 25): Promise<IdleDeal[]> {
  const rows = await ctx.db.query<IdleDealRow>(
    `SELECT d.id, d.title, d.amount_minor, d.currency, d.contact_id, d.account_id,
            GREATEST(d.updated_at, COALESCE(a.last_at, d.updated_at))::text AS last_at
       FROM ${table(ctx, "deals")} d
       JOIN ${table(ctx, "pipeline_stages")} s ON s.id = d.stage_id
       LEFT JOIN LATERAL (
         SELECT max(x.created_at) AS last_at
           FROM ${table(ctx, "activities")} x
          WHERE x.company_id = d.company_id
            AND ((x.record_type = 'deal' AND x.record_id = d.id)
              OR (x.record_type = 'contact' AND x.record_id = d.contact_id)
              OR (x.record_type = 'company' AND x.record_id = d.account_id))
       ) a ON true
      WHERE d.company_id = $1 AND s.kind = 'open'
        AND GREATEST(d.updated_at, COALESCE(a.last_at, d.updated_at)) < now() - make_interval(days => $2::int)
      ORDER BY last_at ASC
      LIMIT $3`,
    [companyId, DEAL_IDLE_DAYS, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    contactId: row.contact_id,
    accountId: row.account_id,
    lastAt: row.last_at,
  }));
}

/** True when an issue of this kind (origin id prefix) is still open. */
async function openIssueOfKind(ctx: PluginContext, companyId: string, prefix: string): Promise<boolean> {
  for (const status of OPEN_STATUSES) {
    const issues = await ctx.issues.list({ companyId, originKind: ORIGIN, status, limit: 200 }).catch(() => []);
    if (issues.some((issue) => String(issue.originId ?? "").startsWith(prefix))) return true;
  }
  return false;
}

async function openOnce(
  ctx: PluginContext,
  input: { companyId: string; originId: string; title: string; description: string; role: CrmRoleKey; wakeReason: string },
): Promise<string | null> {
  const existing = await ctx.issues.list({ companyId: input.companyId, originKind: ORIGIN, originId: input.originId, limit: 1 }).catch(() => []);
  if (existing[0]) return null;
  const issue = await createWorkIssue(ctx, {
    companyId: input.companyId,
    title: input.title.slice(0, 200),
    description: input.description,
    originKind: ORIGIN,
    originId: input.originId,
    ...(await teamAssignee(ctx, input.companyId, input.role)),
    wakeReason: input.wakeReason,
  });
  return issue.id;
}

const day = (now: Date) => now.toISOString().slice(0, 10);

/** Opens today's pipeline check when deals are idle and the last check is closed. */
export async function openPipelineCheck(ctx: PluginContext, companyId: string, now = new Date()): Promise<string | null> {
  const deals = await idleDeals(ctx, companyId);
  if (!deals.length || (await openIssueOfKind(ctx, companyId, CRM_ORIGINS.pipelineCheck))) return null;
  const prefix = await companyPrefix(ctx, companyId);
  const lines = deals.map((deal) => {
    const value = deal.amountMinor > 0 ? formatMoneyMinor(deal.amountMinor, deal.currency) : "no amount";
    const client = deal.accountId ? crmLink(prefix, "company", deal.accountId) : deal.contactId ? crmLink(prefix, "contact", deal.contactId) : "no client";
    return `- \`${deal.id}\` ${deal.title} (${value}), quiet since ${deal.lastAt.slice(0, 10)}: ${client}`;
  });
  return openOnce(ctx, {
    companyId,
    originId: originFor.pipelineCheck(day(now)),
    title: `Pipeline: ${deals.length} deal${deals.length === 1 ? "" : "s"} with no activity for ${DEAL_IDLE_DAYS} days`,
    description: [
      `These open deals have had nothing logged on them, their contact or their company for ${DEAL_IDLE_DAYS} days or more (the **pib-sales-lead** skill):`,
      "",
      ...lines,
      "",
      "For each: revive it (set the contact's next step and hand the follow-up to the right teammate, then `log-activity`) or close it (`move-deal` to `lost`, and `log-activity` why).",
      "",
      `**Done when** no open deal has been quiet for ${DEAL_IDLE_DAYS} days. Closing checks it.`,
      `Pipeline: ${pagePath(prefix, "/crm?tab=deals")}`,
    ].join("\n"),
    role: "sales-lead",
    wakeReason: "Open deals have gone quiet",
  });
}

/** Opens a duplicates issue when contacts share an email and the last one is closed. */
export async function openDuplicateCheck(ctx: PluginContext, companyId: string, now = new Date()): Promise<string | null> {
  const groups = duplicateGroups(await findDuplicateContacts(ctx, companyId));
  if (!groups.length || (await openIssueOfKind(ctx, companyId, CRM_ORIGINS.duplicates))) return null;
  const prefix = await companyPrefix(ctx, companyId);
  const lines = groups.slice(0, 25).map((group) => `- ${group.email}: ${group.contacts.map((c) => `${c.name} (${crmLink(prefix, "contact", c.id)})`).join(", ")}`);
  return openOnce(ctx, {
    companyId,
    originId: originFor.duplicates(day(now)),
    title: `Duplicate contacts: ${groups.length} email${groups.length === 1 ? "" : "s"} on more than one contact`,
    description: [
      "These contacts share an email address, so they are the same person (the **pib-data-steward** skill):",
      "",
      ...lines,
      "",
      "Merge each group with `merge-contacts`: keep the oldest as the primary, fill its empty fields from the others first, and `log-activity` the merge. Contacts that only look alike are not on this list; ask a person about those.",
      "",
      "**Done when** no two contacts share an email. Closing checks it.",
    ].join("\n"),
    role: "crm-data-steward",
    wakeReason: "Duplicate contacts found",
  });
}

async function hasRecords(ctx: PluginContext, companyId: string): Promise<boolean> {
  const rows = await ctx.db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table(ctx, "contacts")} WHERE company_id = $1`,
    [companyId],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/** Monday: the weekly pipeline summary for the owner. */
export async function openPipelineSummary(ctx: PluginContext, companyId: string, now = new Date()): Promise<string | null> {
  if (!(await hasRecords(ctx, companyId))) return null;
  const prefix = await companyPrefix(ctx, companyId);
  return openOnce(ctx, {
    companyId,
    originId: originFor.pipelineSummary(day(now)),
    title: `Weekly pipeline summary (week of ${day(now)})`,
    description: [
      "Write the owner's weekly pipeline summary (the **pib-sales-lead** skill): use `list-deals` and `pipeline-forecast`.",
      "",
      "Comment 5-8 plain lines: new leads, deals moved, won and lost (with reasons), the forecast, and what needs the owner. Link every deal you name. Then mark this issue done.",
      "",
      `Pipeline: ${pagePath(prefix, "/crm?tab=deals")}`,
    ].join("\n"),
    role: "sales-lead",
    wakeReason: "Weekly pipeline summary",
  });
}

/** Monday: the CRM hygiene report. */
export async function openHygieneReport(ctx: PluginContext, companyId: string, now = new Date()): Promise<string | null> {
  if (!(await hasRecords(ctx, companyId))) return null;
  const prefix = await companyPrefix(ctx, companyId);
  return openOnce(ctx, {
    companyId,
    originId: originFor.hygiene(day(now)),
    title: `CRM hygiene (week of ${day(now)})`,
    description: [
      "Check the CRM's data and comment a short report (the **pib-data-steward** skill):",
      "",
      "- duplicates merged this week, and likely pairs waiting for a person;",
      "- contacts with no email and no phone;",
      "- open deals with no client or no value (`list-deals`);",
      "- bounced emails.",
      "",
      "Fix what you can (`update-deal`, `update-contact`), then mark this issue done.",
      "",
      `Contacts: ${pagePath(prefix, "/crm?tab=contacts")}`,
    ].join("\n"),
    role: "crm-data-steward",
    wakeReason: "Weekly CRM hygiene",
  });
}

async function forEachCompany(ctx: PluginContext, job: string, run: (companyId: string) => Promise<unknown>): Promise<number> {
  let opened = 0;
  for (const companyId of await crmCompanyIds(ctx)) {
    try {
      if (!(await isModuleEnabled(ctx, companyId, PLUGIN_ID))) continue;
      if (await run(companyId)) opened += 1;
    } catch (error) {
      ctx.logger.info(`CRM ${job} skipped a company`, { companyId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return opened;
}

export async function runSalesDaily(ctx: PluginContext, now = new Date()): Promise<{ pipeline: number; duplicates: number }> {
  return {
    pipeline: await forEachCompany(ctx, "pipeline check", (c) => openPipelineCheck(ctx, c, now)),
    duplicates: await forEachCompany(ctx, "duplicate check", (c) => openDuplicateCheck(ctx, c, now)),
  };
}

export async function runSalesWeekly(ctx: PluginContext, now = new Date()): Promise<{ summaries: number; hygiene: number }> {
  return {
    summaries: await forEachCompany(ctx, "pipeline summary", (c) => openPipelineSummary(ctx, c, now)),
    hygiene: await forEachCompany(ctx, "hygiene report", (c) => openHygieneReport(ctx, c, now)),
  };
}
