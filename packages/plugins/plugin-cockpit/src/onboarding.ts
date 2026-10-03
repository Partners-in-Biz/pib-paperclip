/**
 * Hand-offs the Cockpit receives from other plugins:
 *
 * - CRM `deal.won`: recorded as activity; on the client's first win the
 *   Cockpit opens ONE onboarding issue (one per client, idempotent by the
 *   deal event's key and the client) for the Operator, falling back like kit
 *   `routeWork` (Operator, else the owner). It is the company operating
 *   manual's onboarding flow as a checklist with a deep link per module.
 * - Billing `invoice.paid`: recorded as activity.
 */
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { createWorkIssue, isModuleEnabled, parseClientParam, PIB_PLUGINS, type ClientKind, type DealWon, type InvoicePaid, type RolesPayload, type TeamRoleKey } from "@partnersinbiz/pib-plugin-kit";
import { formatAmount, recordActivity } from "./activity.js";
import { isCanaryClientRef } from "./acceptance-model.js";
import { crmClient } from "./clients.js";
import { recordPayment } from "./client-cost.js";
import { ORIGIN, ORIGIN_ID } from "./constants.js";
import { message, type Env } from "./env.js";
import { linkFor } from "./health.js";
import { NAMESPACE } from "./namespace.js";
import { currentRoles, routeFromRoles } from "./roles.js";

const TABLE = `${NAMESPACE}.onboarding`;

function text(value: unknown, max = 300): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

/** `company:<id>` from the event's `{ clientKind, clientRef }` (a bare id, or already `kind:id`). */
export function clientRefOf(kind: unknown, ref: unknown): string | null {
  const raw = text(ref, 200);
  if (!raw) return null;
  const parsed = parseClientParam(raw.includes(":") ? raw : `${kind === "contact" ? "contact" : "company"}:${raw}`);
  return parsed ? `${parsed.kind}:${parsed.id}` : null;
}

export interface OnboardingInput {
  clientRef: string;
  clientName: string;
  dealTitle: string;
  dealValue: string | null;
  wonAt: string;
  prefix: string | null;
  /** Modules switched on for the company. */
  modules: { crm: boolean; billing: boolean; social: boolean; seo: boolean };
  /** Agent names per role; null when the role is not staffed. */
  staff: Partial<Record<TeamRoleKey, string | null>>;
}

/** Title and checklist of the onboarding issue (pure). */
export function onboardingContent(input: OnboardingInput): { title: string; description: string } {
  const ref = input.clientRef;
  const link = (path: string) => linkFor(path, input.prefix);
  const at = (path: string, tab?: string) => link(`${path}?client=${ref}${tab ? `&tab=${tab}` : ""}`);
  const who = (role: TeamRoleKey, title: string) => (input.staff[role] ? `**${title}** (${input.staff[role]})` : `**${title}** (not staffed: do it yourself, or put the hire on the daily brief)`);
  const lines: string[] = [
    `${input.clientName} (\`${ref}\`) just became a customer: deal **${input.dealTitle}**${input.dealValue ? ` (${input.dealValue})` : ""} was won on ${input.wonAt.slice(0, 10)}. Onboard them so every module can work for them.`,
    "",
    "You (the Operator) hand off and track; the other agents do the work. Create one `Hand-off: <what> (" + ref + ")` issue per role below as a child of this issue (set its parentId), assigned to that role's agent.",
    "",
    "**Done when** every module shows the client in its client workspace and the first work is scheduled.",
    "",
    "## Checklist",
  ];
  if (input.modules.crm || input.modules.billing) {
    const work: string[] = [];
    const links: string[] = [];
    if (input.modules.crm) {
      work.push("fill the client profile (`partnersinbiz.crm:update-client-profile`: contacts, what they bought, brand voice)");
      links.push(`[Client workspace](${at("/crm")})`);
    }
    if (input.modules.billing) {
      work.push("set up the retainer or subscription in Billing");
      links.push(`[Billing](${at("/billing", "retainers")})`);
    }
    lines.push(`- [ ] ${who("account-manager", "Account Manager")}: ${work.join(", then ")}. ${links.join(" · ")}`);
  }
  const grants: string[] = [];
  if (input.modules.social) grants.push(`log in to their social accounts [Social accounts](${at("/social", "accounts")})`);
  if (input.modules.seo) grants.push(`give Search Console and site repo access [SEO](${at("/seo", "integrations")})`);
  if (grants.length) {
    lines.push(`- [ ] **One ask for every grant**: send ONE \`partnersinbiz.cockpit:ask-owner\` (kind \`grant\`, client \`${ref}\`) on this issue with every link and step: ${grants.join("; ")}. Not one ask per item.`);
  }
  if (input.modules.seo) lines.push(`- [ ] ${who("seo-specialist", "SEO Specialist")}: the first 90-day sprint (\`partnersinbiz.seo:create-sprint\` with \`client: ${ref}\` and the \`businessType\` that fits: local, professional, ecommerce or saas). [SEO](${at("/seo")})`);
  if (input.modules.social) lines.push(`- [ ] ${who("social", "Social agent")}: plan the first month once their accounts are connected. [Social](${at("/social")})`);
  lines.push(
    "- [ ] Close this issue with links to each module's client workspace as evidence, and **Learned:** lines for what you learned about the client.",
    "",
    `Every month after this, the Account Manager sends the client a report built from each module's client workspace.`,
  );
  return { title: `Onboard new client: ${input.clientName} (${ref})`, description: lines.join("\n") };
}

async function staffNames(env: Env, companyId: string, roles: RolesPayload | null): Promise<Partial<Record<TeamRoleKey, string | null>>> {
  const out: Partial<Record<TeamRoleKey, string | null>> = {};
  for (const role of ["account-manager", "seo-specialist", "social"] as const) {
    const member = roles?.team?.[role];
    const agent = member?.agentId ? await env.ctx.agents.get(member.agentId, companyId).catch(() => null) : null;
    out[role] = agent && !["terminated", "archived", "deleted"].includes(String(agent.status)) ? String(agent.name) : null;
  }
  return out;
}

export type OnboardingResult = { action: "opened"; issueId: string } | { action: "exists" | "skipped"; reason: string } | { action: "failed"; reason: string };

/** Opens the client's onboarding issue once (first win). */
export async function openOnboarding(env: Env, companyId: string, deal: { key: string; dealId: string | null; clientRef: string; clientName: string; title: string; valueMinor: number | null; currency: string; wonAt: string }): Promise<OnboardingResult> {
  // Claim the client first: re-sent events and a second "first" win never open a second issue.
  const claim = await env.ctx.db.execute(
    `INSERT INTO ${TABLE} (company_id, client_ref, deal_key, deal_id, client_name) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (company_id, client_ref) DO NOTHING`,
    [companyId, deal.clientRef, deal.key, deal.dealId, deal.clientName],
  );
  if ((claim.rowCount ?? 0) === 0) return { action: "exists", reason: "This client already has an onboarding issue." };
  try {
    const roles = await currentRoles(env, companyId);
    const route = routeFromRoles(roles, ["operator"]);
    const prefix = (await env.ctx.companies.get(companyId).catch(() => null))?.issuePrefix ?? null;
    const enabled = async (key: string) => isModuleEnabled(env.ctx, companyId, key);
    const content = onboardingContent({
      clientRef: deal.clientRef,
      clientName: deal.clientName,
      dealTitle: deal.title,
      dealValue: deal.valueMinor != null && deal.valueMinor > 0 ? formatAmount(deal.valueMinor, deal.currency) : null,
      wonAt: deal.wonAt,
      prefix,
      modules: { crm: await enabled(PIB_PLUGINS.crm), billing: await enabled(PIB_PLUGINS.billing), social: await enabled(PIB_PLUGINS.social), seo: await enabled(PIB_PLUGINS.seo) },
      staff: await staffNames(env, companyId, roles),
    });
    const issue = await createWorkIssue(env.ctx, {
      companyId,
      title: content.title,
      description: content.description,
      priority: "high",
      originKind: ORIGIN.onboarding as `plugin:${string}`,
      originId: `${ORIGIN_ID.onboarding}${deal.clientRef}`,
      ...(route.assigneeAgentId ? { assigneeAgentId: route.assigneeAgentId } : route.assigneeUserId ? { assigneeUserId: route.assigneeUserId } : {}),
      wakeReason: `New client won: onboard ${deal.clientName}`,
    });
    await env.ctx.db.execute(`UPDATE ${TABLE} SET issue_id = $3 WHERE company_id = $1 AND client_ref = $2`, [companyId, deal.clientRef, issue.id]);
    const created = await env.ctx.issues.get(issue.id, companyId).catch(() => null);
    await recordActivity(env.ctx, companyId, {
      key: `onboarding:${deal.clientRef}`,
      kind: "onboarding",
      at: env.now().toISOString(),
      text: `Opened onboarding for ${deal.clientName}${route.via === "operator" ? " (Operator)" : route.via === "owner" ? " (no Operator: assigned to the owner)" : " (nobody to assign it to)"}`,
      href: `/issues/${created?.identifier ?? issue.id}`,
      agentId: route.assigneeAgentId,
    }).catch(() => false);
    return { action: "opened", issueId: issue.id };
  } catch (error) {
    // Let a re-sent event try again.
    await env.ctx.db.execute(`DELETE FROM ${TABLE} WHERE company_id = $1 AND client_ref = $2 AND issue_id IS NULL`, [companyId, deal.clientRef]).catch(() => undefined);
    return { action: "failed", reason: message(error) };
  }
}

/** CRM `deal.won`: activity always; onboarding on the first win. */
export async function onDealWon(env: Env, event: Pick<PluginEvent, "companyId" | "payload">): Promise<{ recorded: boolean; onboarding: OnboardingResult | null }> {
  const companyId = event.companyId;
  const p = (event.payload ?? {}) as Partial<DealWon> & Record<string, unknown>;
  const clientRef = clientRefOf(p.clientKind as ClientKind, p.clientRef);
  const key = text(p.key, 200);
  if (!companyId || !key || !clientRef) return { recorded: false, onboarding: null };
  // The canary client's win is a rehearsal (the acceptance journeys): no onboarding issue, no line in the owner's feed.
  if (isCanaryClientRef(clientRef)) {
    env.ctx.logger.info("A won deal on the canary client was left out of onboarding and activity", { companyId });
    return { recorded: false, onboarding: null };
  }
  const known = await crmClient(env.ctx, companyId, clientRef).catch(() => null);
  const clientName = text(p.clientName, 200) ?? known?.name ?? clientRef;
  const title = text(p.title, 200) ?? "a deal";
  const valueMinor = typeof p.valueMinor === "number" && Number.isFinite(p.valueMinor) ? Math.round(p.valueMinor) : null;
  const currency = text(p.currency, 3)?.toUpperCase() ?? "ZAR";
  const wonAt = text(p.wonAt, 40) && Number.isFinite(Date.parse(String(p.wonAt))) ? new Date(Date.parse(String(p.wonAt))).toISOString() : env.now().toISOString();
  const recorded = await recordActivity(env.ctx, companyId, {
    key: `deal.won:${key}`,
    kind: "deal_won",
    at: wonAt,
    text: `Won ${title} for ${clientName}${valueMinor ? ` (${formatAmount(valueMinor, currency)})` : ""}${p.firstWin === true ? ": a new client" : ""}`,
    href: `/crm?client=${clientRef}`,
    agentId: text(p.ownerAgentId, 100),
  }).catch((error) => {
    env.ctx.logger.info("Won deal activity not recorded", { error: message(error) });
    return false;
  });
  if (p.firstWin !== true) return { recorded, onboarding: null };
  const onboarding = await openOnboarding(env, companyId, { key, dealId: text(p.dealId, 100), clientRef, clientName, title, valueMinor, currency, wonAt });
  if (onboarding.action === "failed") env.ctx.logger.info("Onboarding issue not opened", { companyId, clientRef, reason: onboarding.reason });
  return { recorded, onboarding };
}

/** Billing `invoice.paid`: one activity line. */
export async function onInvoicePaid(env: Env, event: Pick<PluginEvent, "companyId" | "payload">): Promise<boolean> {
  const companyId = event.companyId;
  const p = (event.payload ?? {}) as Partial<InvoicePaid> & Record<string, unknown>;
  const key = text(p.key, 200);
  if (!companyId || !key) return false;
  const clientRef = clientRefOf(p.clientKind, p.clientRef);
  // A test payment on the canary client is no revenue: it would count as what a customer paid.
  if (isCanaryClientRef(clientRef)) return false;
  const client = clientRef ? await crmClient(env.ctx, companyId, clientRef).catch(() => null) : null;
  const number = text(p.number, 60) ?? "An invoice";
  const total = typeof p.totalMinor === "number" && Number.isFinite(p.totalMinor) ? formatAmount(Math.round(p.totalMinor), text(p.currency, 3)?.toUpperCase() ?? "ZAR") : null;
  const paidAt = text(p.paidAt, 40) && Number.isFinite(Date.parse(String(p.paidAt))) ? new Date(Date.parse(String(p.paidAt))).toISOString() : env.now().toISOString();
  // What each client paid, kept for the effort-against-revenue check (one row per event key, so a re-sent event adds nothing).
  if (typeof p.totalMinor === "number" && Number.isFinite(p.totalMinor)) {
    await recordPayment(env.ctx, companyId, { key, clientRef, number: text(p.number, 60), totalMinor: Math.round(p.totalMinor), currency: text(p.currency, 3)?.toUpperCase() ?? "ZAR", paidAt }).catch((error) => {
      env.ctx.logger.info("Paid invoice not kept for client effort", { error: message(error) });
    });
  }
  return recordActivity(env.ctx, companyId, {
    key: `invoice.paid:${key}`,
    kind: "invoice_paid",
    at: paidAt,
    text: `${number} paid in full${total ? ` (${total})` : ""}${client?.name ? ` by ${client.name}` : ""}`,
    href: clientRef ? `/billing?client=${clientRef}&tab=invoices` : "/billing?tab=invoices",
    agentId: null,
  });
}
