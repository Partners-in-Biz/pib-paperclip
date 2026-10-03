/**
 * Starting what a client bought (audit Q1a-8).
 *
 * Onboarding used to start once, on a client's first won deal, and did not
 * depend on which services the client bought. Now:
 *
 * - Whenever a client's services change, the CRM tells the other modules
 *   (`client.services.changed`, a hand-off: `CLIENT_SERVICES_EVENT`).
 * - For a customer, each service added opens ONE step for the role that owns
 *   it (`crm:service-onboard:...`, in the client's own project when it has
 *   one). Closing it needs proof logged on the client (done-check).
 * - The daily `services-check` job does the same for customers whose services
 *   were set before this existed, and for any that were missed. It never
 *   opens a second step for a service (one row per client and service), and a
 *   step that was cancelled stays cancelled until the service is added again.
 *
 * A first win's onboarding stays the Cockpit's: while the Cockpit's
 * onboarding issue for the client is open, the services flagged then are
 * `covered`, not given a step of their own.
 *
 * What "running" means: the CRM does not read the other modules' data. A
 * service is started when its step was closed with proof. Where a module
 * already runs it (a sprint set up by hand), the step's first instruction is
 * to check the module's client workspace and close with a link.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isModuleEnabled, readConfig, routeRole, type TeamRoleKey } from "@partnersinbiz/pib-plugin-kit";
import { isCrmRoleKey } from "./agent.js";
import { getAccount, getContact, table } from "./db.js";
import { sendHandoff } from "./handoffs.js";
import { openIssueOnce } from "./mail.js";
import { PLUGIN_ID } from "./namespace.js";
import { companyPrefix, crmLink, refOf, workspaceLinks, type ClientKind } from "./refs.js";
import { teamAssignee, type Assignee } from "./routing.js";
import { clientProjectIds, deleteServiceSteps, getClientProfile, listClientProfiles, saveClientProfile } from "./store.js";
import { CLIENT_SERVICES_EVENT, serviceDef, serviceLabel, serviceStepOrigin, type ServiceDef, type ServicesDiff } from "./services.js";
import { crmCompanyIds } from "./sync.js";

/** The most new steps one company gets from one run of the daily job (a backlog is worked off over days, not dumped). */
export const MAX_NEW_STEPS_PER_RUN = 8;

/** The Cockpit's onboarding issue for a client (`plugin:partnersinbiz.cockpit:onboarding`, origin id `cockpit:onboarding:<ref>`). */
const COCKPIT_ONBOARDING_KIND = "plugin:partnersinbiz.cockpit:onboarding";
const COCKPIT_ONBOARDING_ORIGIN = "cockpit:onboarding:";

export const STEP_STATUSES = ["open", "started", "covered", "dropped"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export interface ServiceStepRow {
  id: string;
  companyId: string;
  clientKind: ClientKind;
  clientRef: string;
  service: string;
  status: StepStatus;
  issueId: string | null;
  note: string | null;
  openedAt: string | null;
  completedAt: string | null;
}

interface StepDbRow {
  id: string;
  company_id: string;
  client_kind: string;
  client_ref: string;
  service: string;
  status: string;
  issue_id: string | null;
  note: string | null;
  opened_at: unknown;
  completed_at: unknown;
}

function iso(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function mapStep(row: StepDbRow): ServiceStepRow {
  return {
    id: row.id,
    companyId: row.company_id,
    clientKind: row.client_kind === "contact" ? "contact" : "company",
    clientRef: row.client_ref,
    service: row.service,
    status: (STEP_STATUSES as readonly string[]).includes(row.status) ? (row.status as StepStatus) : "open",
    issueId: row.issue_id ?? null,
    note: row.note ?? null,
    openedAt: iso(row.opened_at),
    completedAt: iso(row.completed_at),
  };
}

const STEP_COLUMNS = "id, company_id, client_kind, client_ref, service, status, issue_id, note, opened_at, completed_at";

export async function serviceSteps(ctx: PluginContext, companyId: string, kind: ClientKind, ref: string): Promise<ServiceStepRow[]> {
  const rows = await ctx.db.query<StepDbRow>(
    `SELECT ${STEP_COLUMNS} FROM ${table(ctx, "service_onboarding")} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3 ORDER BY opened_at LIMIT 50`,
    [companyId, kind, ref],
  );
  return rows.map(mapStep);
}

async function openSteps(ctx: PluginContext, companyId: string): Promise<ServiceStepRow[]> {
  const rows = await ctx.db.query<StepDbRow>(`SELECT ${STEP_COLUMNS} FROM ${table(ctx, "service_onboarding")} WHERE company_id = $1 AND status = 'open' ORDER BY opened_at LIMIT 500`, [companyId]);
  return rows.map(mapStep);
}

async function putStep(ctx: PluginContext, row: ServiceStepRow): Promise<void> {
  const existing = (await serviceSteps(ctx, row.companyId, row.clientKind, row.clientRef)).find((step) => step.service === row.service);
  if (existing) {
    await ctx.db.execute(
      `UPDATE ${table(ctx, "service_onboarding")}
          SET status = $2, issue_id = $3, note = $4, completed_at = $5::timestamptz, opened_at = $6::timestamptz, updated_at = now()
        WHERE id = $1`,
      [existing.id, row.status, row.issueId, row.note, row.completedAt, row.openedAt ?? new Date().toISOString()],
    );
    return;
  }
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "service_onboarding")} (id, company_id, client_kind, client_ref, service, status, issue_id, note, opened_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz)`,
    [row.id || randomUUID(), row.companyId, row.clientKind, row.clientRef, row.service, row.status, row.issueId, row.note, row.openedAt ?? new Date().toISOString(), row.completedAt],
  );
}

// Lives in store.ts (deleting a client calls it from handoffs.ts without an import cycle); kept exported here for its callers.
export { deleteServiceSteps };

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

interface ClientInfo {
  kind: ClientKind;
  id: string;
  name: string;
  lifecycle: string;
  canary: boolean;
}

/** A client that is a customer (the only kind that gets a step). Null when the record is gone. */
async function clientInfo(ctx: PluginContext, companyId: string, kind: ClientKind, id: string): Promise<ClientInfo | null> {
  if (kind === "company") {
    const account = await getAccount(ctx, id);
    if (!account || account.companyId !== companyId) return null;
    return { kind, id, name: account.name, lifecycle: account.lifecycle, canary: account.custom?.canary === true };
  }
  const contact = await getContact(ctx, id);
  if (!contact || contact.companyId !== companyId) return null;
  return { kind, id, name: contact.name, lifecycle: contact.lifecycle, canary: contact.custom?.canary === true };
}

/**
 * Whether the Cockpit has an onboarding issue for the client, and whether it is still open. Null when it cannot be
 * read. A plugin may not list another plugin's issues through the host (`ctx.issues.list` refuses an origin kind
 * that is not its own), so this reads the issue table, which the CRM may read (`coreReadTables`).
 */
async function cockpitOnboarding(ctx: PluginContext, companyId: string, kind: ClientKind, id: string): Promise<{ exists: boolean; open: boolean } | null> {
  try {
    const rows = await ctx.db.query<{ status: string }>(
      `SELECT i.status FROM public.issues i WHERE i.company_id::text = $1 AND i.origin_kind = $2 AND i.origin_id = $3 LIMIT 1`,
      [companyId, COCKPIT_ONBOARDING_KIND, `${COCKPIT_ONBOARDING_ORIGIN}${kind}:${id}`],
    );
    const issue = rows[0];
    if (!issue) return { exists: false, open: false };
    return { exists: true, open: issue.status !== "done" && issue.status !== "cancelled" };
  } catch {
    return null;
  }
}

async function assigneeForRole(ctx: PluginContext, companyId: string, role: TeamRoleKey): Promise<Assignee> {
  if (isCrmRoleKey(role)) return teamAssignee(ctx, companyId, role);
  const route = await routeRole(ctx, companyId, role);
  if (route.assigneeAgentId) return { assigneeAgentId: route.assigneeAgentId };
  if (route.assigneeUserId) return { assigneeUserId: route.assigneeUserId };
  return {};
}

const today = (now: Date) => now.toISOString().slice(0, 10).replace(/-/g, "");
/** To the second: a service that was removed and added again gets a step of its own (its old step is cancelled, and an origin id is never reused). */
const stamp = (now: Date) => now.toISOString().slice(0, 19).replace(/[-:T]/g, "");

/** Title and description of a service's step (pure). */
export function serviceStepContent(input: { def: ServiceDef; client: Pick<ClientInfo, "kind" | "id" | "name" | "canary">; prefix: string | null; missing: string[] }): { title: string; description: string } {
  const { def, client } = input;
  const ref = refOf(client.kind, client.id);
  const links = workspaceLinks(input.prefix, client.kind, client.id);
  const workspace = def.module ? links[def.module] : null;
  const lines = [
    `${client.name} (\`${ref}\`) bought **${def.label}**, but the CRM has no proof it is running yet.${client.canary ? " This is the CANARY client: a test. Everything outward stays a draft or a dry run." : ""}`,
    "",
    `**First check whether it already runs**${workspace ? ` (open [the client's ${def.label} workspace](${workspace}))` : ""}. If it does, log it on the client (\`log-activity\` on \`${ref}\`, with the link or id) and close this issue.`,
    "",
    "**What starting it means:**",
    ...def.start.map((line) => `- ${line}`),
    "",
    `Read the client's profile first (\`get-client-profile\`${input.missing.length ? `; still missing: ${input.missing.join(", ")}` : ""}). One ask for every grant the client must give, never one ask per item. Client work lives in the client's own project.`,
    "",
    `**Done when** proof is logged on \`${ref}\` since this issue opened: ${def.evidence}. Closing checks it.`,
    "",
    `Client: ${crmLink(input.prefix, client.kind, client.id)}`,
  ];
  return { title: `Start ${def.label} for ${client.name}`.slice(0, 200), description: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// Opening a step
// ---------------------------------------------------------------------------

export interface StepOutcome {
  service: string;
  status: "opened" | "covered" | "exists" | "skipped";
  issueId?: string | null;
  reason?: string;
}

/**
 * Gives one service its step: opens an issue (or records it as covered by the
 * Cockpit's first-win onboarding). Idempotent: a service with a row that is not
 * `dropped` is left alone. `covered` says the Cockpit's onboarding handles it.
 */
export async function ensureServiceStep(
  ctx: PluginContext,
  input: { companyId: string; client: ClientInfo; service: string; covered: boolean; now?: Date },
): Promise<StepOutcome> {
  const def = serviceDef(input.service);
  if (!def) return { service: input.service, status: "skipped", reason: "not a service in the vocabulary" };
  const { companyId, client } = input;
  const existing = (await serviceSteps(ctx, companyId, client.kind, client.id)).find((step) => step.service === def.key);
  if (existing && existing.status !== "dropped") return { service: def.key, status: "exists", issueId: existing.issueId };
  const now = input.now ?? new Date();
  const base: ServiceStepRow = { id: existing?.id ?? randomUUID(), companyId, clientKind: client.kind, clientRef: client.id, service: def.key, status: "open", issueId: null, note: null, openedAt: now.toISOString(), completedAt: null };
  if (input.covered) {
    await putStep(ctx, { ...base, status: "covered", note: "The first-win onboarding handles it." });
    return { service: def.key, status: "covered" };
  }
  const profile = await getClientProfile(ctx, companyId, client.kind, client.id).catch(() => null);
  const missing = profile ? (["brandVoice", "audience", "website"] as const).filter((field) => !profile[field]) : ["brandVoice", "audience", "website"];
  const prefix = await companyPrefix(ctx, companyId);
  const content = serviceStepContent({ def, client, prefix, missing });
  const projects = await clientProjectIds(ctx, companyId, client.kind, client.id).catch(() => [] as string[]);
  const issueId = await openIssueOnce(ctx, {
    companyId,
    originId: serviceStepOrigin(client.kind, client.id, def.key, existing ? stamp(now) : today(now)),
    title: content.title,
    description: content.description,
    assignee: await assigneeForRole(ctx, companyId, def.role),
    wakeReason: `A service was added for ${client.name}`,
    projectId: projects[0] ?? null,
  });
  await putStep(ctx, { ...base, issueId });
  return { service: def.key, status: "opened", issueId };
}

export interface ServicesChangeResult {
  handoff: boolean;
  opened: Array<{ service: string; issueId: string | null }>;
  covered: string[];
  dropped: string[];
}

/**
 * A client's services changed. Tell the other modules; stop the steps of what
 * was removed; and for a customer start what was added (covered while the
 * Cockpit's first-win onboarding is open). Never throws into the profile save
 * (the caller catches): a failed step is retried by the daily job.
 */
export async function onServicesChanged(
  ctx: PluginContext,
  input: { companyId: string; client: { kind: ClientKind; id: string }; name: string; services: string[]; diff: ServicesDiff; now?: Date },
): Promise<ServicesChangeResult> {
  const { companyId } = input;
  const now = input.now ?? new Date();
  const result: ServicesChangeResult = { handoff: false, opened: [], covered: [], dropped: [] };
  if (input.diff.added.length === 0 && input.diff.removed.length === 0) return result;
  result.handoff = await sendHandoff(ctx, companyId, CLIENT_SERVICES_EVENT, {
    key: `crm:services:${input.client.kind}:${input.client.id}:${now.getTime()}`,
    clientKind: input.client.kind,
    clientRef: input.client.id,
    clientName: input.name,
    services: input.services,
    added: input.diff.added,
    removed: input.diff.removed,
    changedAt: now.toISOString(),
  });

  for (const service of input.diff.removed) {
    const step = (await serviceSteps(ctx, companyId, input.client.kind, input.client.id)).find((row) => row.service === service);
    if (!step || step.status === "dropped") continue;
    await putStep(ctx, { ...step, status: "dropped", note: "The service was removed from the client profile.", completedAt: now.toISOString() });
    if (step.status === "open" && step.issueId) await cancelStepIssue(ctx, companyId, step.issueId, serviceLabel(service));
    result.dropped.push(service);
  }

  const client = await clientInfo(ctx, companyId, input.client.kind, input.client.id);
  // Only a customer has bought anything: a prospect's services are what the proposal covers.
  if (!client || client.lifecycle !== "customer" || input.diff.added.length === 0) return result;
  const onboarding = await cockpitOnboarding(ctx, companyId, client.kind, client.id);
  for (const service of input.diff.added) {
    const outcome = await ensureServiceStep(ctx, { companyId, client, service, covered: onboarding?.open === true, now });
    if (outcome.status === "opened") result.opened.push({ service, issueId: outcome.issueId ?? null });
    else if (outcome.status === "covered") result.covered.push(service);
  }
  return result;
}

async function cancelStepIssue(ctx: PluginContext, companyId: string, issueId: string, label: string): Promise<void> {
  try {
    const issue = await ctx.issues.get(issueId, companyId);
    if (!issue || issue.status === "done" || issue.status === "cancelled") return;
    await ctx.issues.update(issueId, { status: "cancelled" }, companyId);
    await ctx.issues.createComment(issueId, `${label} was removed from the client's services, so this step is cancelled.`, companyId);
  } catch (error) {
    ctx.logger.info("CRM service step not cancelled", { issueId, error: error instanceof Error ? error.message : String(error) });
  }
}

// ---------------------------------------------------------------------------
// Closing a step
// ---------------------------------------------------------------------------

/**
 * A step's issue changed: done means the service is started (an agent's close
 * counts only when the done-check passed: the caller runs it first), cancelled
 * means dropped. Returns true when the issue was a service step.
 */
export async function onServiceStepIssue(ctx: PluginContext, companyId: string, issue: { id: string; status: string; originId?: string | null }): Promise<boolean> {
  if (typeof issue.originId !== "string" || !issue.originId.startsWith("crm:service-onboard:")) return false;
  if (issue.status !== "done" && issue.status !== "cancelled") return true;
  const rows = await ctx.db.query<StepDbRow>(`SELECT ${STEP_COLUMNS} FROM ${table(ctx, "service_onboarding")} WHERE company_id = $1 AND issue_id = $2 LIMIT 1`, [companyId, issue.id]);
  const step = rows[0] ? mapStep(rows[0]) : null;
  if (!step || step.status !== "open") return true;
  await putStep(ctx, { ...step, status: issue.status === "done" ? "started" : "dropped", completedAt: new Date().toISOString(), note: issue.status === "done" ? "Closed with proof on the client." : "The step was cancelled." });
  return true;
}

// ---------------------------------------------------------------------------
// The daily job
// ---------------------------------------------------------------------------

/** Saves older free-text profiles in the services vocabulary. What maps stays; what does not is kept as text. */
export async function backfillServices(ctx: PluginContext, companyId: string): Promise<number> {
  let saved = 0;
  for (const profile of await listClientProfiles(ctx, companyId)) {
    if (profile.servicesNormalizedAt) continue;
    await saveClientProfile(ctx, { companyId, clientKind: profile.clientKind, clientRef: profile.clientRef, profile, humanOwned: profile.humanOwned, updatedBy: "system:crm-services" });
    saved += 1;
  }
  return saved;
}

export type ServicesCheckResult = {
  companies: number;
  backfilled: number;
  opened: number;
  covered: number;
  started: number;
};

async function refreshOpenSteps(ctx: PluginContext, companyId: string): Promise<number> {
  let started = 0;
  for (const step of await openSteps(ctx, companyId)) {
    if (!step.issueId) continue;
    const issue = await ctx.issues.get(step.issueId, companyId).catch(() => null);
    if (!issue) continue;
    if (issue.status === "done" || issue.status === "cancelled") {
      await onServiceStepIssue(ctx, companyId, { id: issue.id, status: issue.status, originId: issue.originId ?? null });
      if (issue.status === "done") started += 1;
    }
  }
  return started;
}

/**
 * Daily: for every customer whose profile lists a service that has no step
 * yet, open it (or record it as covered by the first-win onboarding). Max
 * `MAX_NEW_STEPS_PER_RUN` new steps per company per run.
 */
export async function runServicesCheck(ctx: PluginContext, now: Date = new Date(), only?: { companyId: string }): Promise<ServicesCheckResult> {
  const total: ServicesCheckResult = { companies: 0, backfilled: 0, opened: 0, covered: 0, started: 0 };
  const companyIds = only ? [only.companyId] : await crmCompanyIds(ctx).catch(() => [] as string[]);
  for (const companyId of companyIds) {
    try {
      if (!(await isModuleEnabled(ctx, companyId, PLUGIN_ID))) continue;
      // The host only allows a job's call for a company that has saved settings.
      if (Object.keys(await readConfig(ctx, companyId)).length === 0) continue;
      total.companies += 1;
      total.backfilled += await backfillServices(ctx, companyId);
      total.started += await refreshOpenSteps(ctx, companyId);
      let budget = MAX_NEW_STEPS_PER_RUN;
      for (const profile of await listClientProfiles(ctx, companyId)) {
        if (budget <= 0) break;
        if (profile.services.length === 0) continue;
        const client = await clientInfo(ctx, companyId, profile.clientKind, profile.clientRef);
        if (!client || client.lifecycle !== "customer") continue;
        // Any row counts, a dropped one too: a step that was cancelled is not opened again by the job (only adding the service again does that).
        const have = new Set((await serviceSteps(ctx, companyId, client.kind, client.id)).map((step) => step.service));
        const missing = profile.services.filter((service) => !have.has(service));
        if (missing.length === 0) continue;
        const onboarding = await cockpitOnboarding(ctx, companyId, client.kind, client.id);
        // Cannot read the Cockpit's issues: wait for the next run instead of opening steps that may duplicate it.
        if (!onboarding) continue;
        for (const service of missing) {
          if (budget <= 0) break;
          // An onboarding that exists (open or done) already covered what was flagged then; none at all: a customer that was never onboarded.
          const outcome = await ensureServiceStep(ctx, { companyId, client, service, covered: onboarding.exists, now });
          if (outcome.status === "opened") {
            total.opened += 1;
            budget -= 1;
          } else if (outcome.status === "covered") {
            total.covered += 1;
          }
        }
      }
    } catch (error) {
      ctx.logger.info("CRM services check skipped", { companyId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return total;
}

/** What each of a client's services is doing, for `start-new-client` and the client page. */
export function stepsView(steps: ServiceStepRow[], services: string[]): Array<{ service: string; label: string; state: "started" | "open" | "covered" | "not started"; issueId: string | null }> {
  return services.map((service) => {
    const step = steps.find((row) => row.service === service && row.status !== "dropped");
    return { service, label: serviceLabel(service), state: step && step.status !== "dropped" ? step.status : "not started", issueId: step?.issueId ?? null };
  });
}
