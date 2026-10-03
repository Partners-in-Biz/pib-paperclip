/**
 * A new company (Q2-8): the Cockpit used to have no `company.created` handler,
 * so a company created after the plugins were installed was invisible to every
 * Cockpit nudge until the owner happened to open Setup (Partners in Apps ran
 * for days with no review loop, no grants and no memory use).
 *
 * The kit's `registerCompanyBootstrap` does the common part (remember the
 * company, sync this plugin's skills, and the same again lazily on the first
 * rare event for a company that missed `company.created`). Here it also opens
 * ONE owner issue "Set up <company>" with the Setup -> Team deep link, once.
 *
 * It never staffs, hires or configures anything: roles are staffed only in
 * Setup -> Team (owner rule), and a company's settings can only be saved by a
 * person. Everything here runs inside the event's own scope, so it works for a
 * company whose Cockpit settings were never saved; the Cockpit's hourly jobs
 * still act only for companies with saved settings.
 */
import { companySetupIssueText, createWorkIssue, ownerUserFor } from "@partnersinbiz/pib-plugin-kit";
import { ORIGIN } from "./constants.js";
import type { Env } from "./env.js";
import { message } from "./env.js";

/** The origin id every PiB plugin's "Set up" issue uses (kit `openCompanySetupIssue`), so one plugin can see another's. */
export const SETUP_ISSUE_ORIGIN_ID = "company-setup";

/** How long the Cockpit waits before opening it, so a plugin that opens the same issue first (Setup) is seen and not doubled. */
export const SETUP_ISSUE_DELAY_MS = 4_000;

const marker = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "cockpit", stateKey: "company-setup-issue" });

type SetupIssueResult = { action: "opened"; issueId: string } | { action: "exists"; issueId: string | null } | { action: "failed"; reason: string };

/** An issue any PiB plugin opened as the company's setup issue (any status), or null. */
async function existingSetupIssue(env: Env, companyId: string): Promise<string | null> {
  try {
    const found = (await env.ctx.issues.list({ companyId, originKindPrefix: "plugin:partnersinbiz.", originId: SETUP_ISSUE_ORIGIN_ID, limit: 5 })) as Array<{ id: string }>;
    return found[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Opens the owner's "Set up <company>" issue unless this plugin or another PiB
 * plugin already did. Checks twice, with a short wait between: both plugins
 * hear `company.created` at the same moment.
 */
export async function ensureSetupIssue(env: Env, companyId: string): Promise<SetupIssueResult> {
  try {
    const stored = (await env.ctx.state.get(marker(companyId))) as { issueId?: string } | null;
    if (stored?.issueId) return { action: "exists", issueId: stored.issueId };
  } catch {
    // fall through to the issue list
  }
  let found = await existingSetupIssue(env, companyId);
  if (!found) {
    await (env.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(SETUP_ISSUE_DELAY_MS);
    found = await existingSetupIssue(env, companyId);
  }
  if (found) {
    await env.ctx.state.set(marker(companyId), { issueId: found, at: env.now().toISOString(), by: "other" }).catch(() => undefined);
    return { action: "exists", issueId: found };
  }
  try {
    const company = await env.ctx.companies.get(companyId).catch(() => null);
    const text = companySetupIssueText({ name: company?.name ?? "the company", prefix: company?.issuePrefix ?? null });
    const owner = await ownerUserFor(env.ctx, companyId);
    const created = await createWorkIssue(env.ctx, {
      companyId,
      title: text.title,
      description: text.description,
      originKind: ORIGIN.setup as `plugin:${string}`,
      originId: SETUP_ISSUE_ORIGIN_ID,
      ...(owner.userId ? { assigneeUserId: owner.userId } : {}),
      wake: false,
    });
    await env.ctx.state.set(marker(companyId), { issueId: created.id, at: env.now().toISOString(), by: "cockpit" }).catch(() => undefined);
    return { action: "opened", issueId: created.id };
  } catch (error) {
    env.ctx.logger.info("Cockpit: the Set up issue was not opened", { companyId, error: message(error) });
    return { action: "failed", reason: message(error) };
  }
}

