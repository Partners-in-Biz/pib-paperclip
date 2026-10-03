/**
 * The Cockpit's own setup checklist (`GET /setup-status`) and its own
 * snapshot (`GET /cockpit`). Read-only and cheap.
 */
import {
  configSaved,
  emptySnapshot,
  jobHealth,
  pluginUiBase,
  readConfig,
  routineHealth,
  settingsItem,
  type CockpitSnapshot,
  type HealthCheck,
  type SetupItem,
  type SetupStatus,
} from "@partnersinbiz/pib-plugin-kit";
import { TEAM_SETUP_PATH, teamSetupPath, type TeamRoleKey } from "@partnersinbiz/pib-plugin-kit/team";
import { countActivitySince, recentActivity, toActivityItems } from "./activity.js";
import { acceptanceAgentId } from "./acceptance-role.js";
import { ASK_STALE_DAYS, staleAsks } from "./ask-model.js";
import { openAskViews } from "./asks.js";
import { extraChecks } from "./checks.js";
import { JOBS, PLUGIN_KEY, ROUTINES, ROUTINE_TITLES, VERSION } from "./constants.js";
import { goalCounts, listGoals } from "./goals.js";
import { GOALS_WANTED, goalLine } from "./goals-model.js";
import { attestationSetupItems, readAttestations } from "./security.js";
import { getRoles } from "./db.js";
import { message, type Env } from "./env.js";
import { memoryJevConfig } from "./memory/jev.js";
import { memoryStats } from "./memory/store.js";
import { cockpitFlowReports } from "./own-flows.js";
import { profileSetupItem, readProfile } from "./profile.js";
import { watchChecks } from "./watch.js";

const PLUGINS_PATH = "/company/settings/instance/plugins";
/** The team (Operator, Reviewer, owner) is staffed in Setup → Team. */
const TEAM_LABEL = "Open Team in Setup";
/** Setup → Team, at "Who gets the daily brief". */
export const OWNER_SETUP_PATH = `${TEAM_SETUP_PATH}#team-owner`;

function installationId(uiBase: string | null): string | null {
  return uiBase ? /\/_plugins\/([^/]+)\//.exec(uiBase)?.[1] ?? null : null;
}

type UsableAgent = { id: string; name: string; status: string };

/** The agent when it exists and is not terminated; `undefined` when the lookup itself failed. */
async function lookupAgent(env: Env, companyId: string, agentId: string): Promise<UsableAgent | null | undefined> {
  try {
    const agent = await env.ctx.agents.get(agentId, companyId);
    if (!agent || ["terminated", "archived", "deleted"].includes(String(agent.status))) return null;
    return { id: agent.id, name: String(agent.name), status: String(agent.status) };
  } catch {
    return undefined;
  }
}

async function agentUsable(env: Env, companyId: string, agentId: string | null): Promise<UsableAgent | null> {
  return agentId ? (await lookupAgent(env, companyId, agentId)) ?? null : null;
}

async function routineStates(env: Env, companyId: string): Promise<Array<{ key: string; title: string; status: string | null; assigneeAgentId: string | null }>> {
  const out: Array<{ key: string; title: string; status: string | null; assigneeAgentId: string | null }> = [];
  for (const key of [ROUTINES.daily, ROUTINES.weekly]) {
    try {
      const resolved = await env.ctx.routines.managed.get(key, companyId);
      out.push({ key, title: ROUTINE_TITLES[key], status: resolved.routine ? String(resolved.routine.status) : null, assigneeAgentId: resolved.routine?.assigneeAgentId ?? null });
    } catch (error) {
      env.ctx.logger.info("Cockpit routine lookup failed", { key, error: message(error) });
      out.push({ key, title: ROUTINE_TITLES[key], status: null, assigneeAgentId: null });
    }
  }
  return out;
}

export async function ownSetupStatus(env: Env, companyId: string): Promise<SetupStatus> {
  const [saved, roles, uiBase] = await Promise.all([configSaved(env.ctx, companyId), getRoles(env.ctx, companyId).catch(() => null), pluginUiBase(env.ctx)]);
  const id = installationId(uiBase);
  const settings: SetupItem = {
    ...settingsItem({ saved, pluginId: id ?? "", detail: "The hourly System health check, role updates, answers to agents' questions, client onboarding and memory's CRM client list need them. Open the Cockpit settings and click Save once.", agentNext: "The Cockpit acts for this company on its own: health checks, role updates, questions, onboarding and memory." }),
    href: id ? `${PLUGINS_PATH}/${id}` : "/cockpit",
    hrefLabel: id ? "Open settings" : "Open the Cockpit",
    action: null,
  };
  const operator = await agentUsable(env, companyId, roles?.operatorAgentId ?? null);
  const reviewer = await agentUsable(env, companyId, roles?.reviewerAgentId ?? null);
  const acceptance = await agentUsable(env, companyId, await acceptanceAgentId(env, companyId));
  const routines = operator ? await routineStates(env, companyId) : [];
  const routinesOk = operator && routines.length > 0 && routines.every((r) => r.status === "active" && r.assigneeAgentId === operator.id);
  const items: SetupItem[] = [
    settings,
    {
      key: "owner",
      title: "Choose who the Cockpit reports to",
      status: roles?.ownerUserId ? "done" : "missing",
      required: true,
      detail: roles?.ownerUserId ? "The owner gets the daily brief and approvals by default." : "The owner gets the daily brief and approvals by default. Saving the team sets it to you.",
      href: teamSetupPath(),
      hrefLabel: TEAM_LABEL,
      steps: roles?.ownerUserId ? undefined : ["Open Setup → Team.", "Pick the owner (it defaults to you) and save the team."],
      agentNext: "The Operator posts the daily brief to the owner.",
    },
    {
      key: "operator_agent",
      title: "Link the Operator agent",
      status: operator ? "done" : "missing",
      required: true,
      detail: operator
        ? `${operator.name} is the Operator${operator.status === "paused" ? " (paused: resume it once its model key works)" : ""}.`
        : "The Operator reviews every module each morning, keeps agents unblocked and sends one daily brief. Hire one, or pick an existing agent.",
      href: teamSetupPath("operator"),
      hrefLabel: TEAM_LABEL,
      steps: operator ? undefined : ["Open Setup → Team → Operator.", "Hire an Operator (opens a hire task), or pick an existing agent."],
      agentNext: "Runs the Daily operations review at 07:00 and the Weekly retro on Mondays.",
      blockedBy: saved ? undefined : ["settings"],
    },
    {
      key: "reviewer_agent",
      title: "Link a Reviewer agent",
      status: reviewer ? "done" : "optional",
      required: false,
      detail: reviewer
        ? `${reviewer.name} reviews outward-facing work${roles?.reviewOutward ? " before you approve it" : " (switch on \"Review outward-facing work before I approve\" to use it)"}.`
        : "Optional. The Reviewer checks posts, campaign emails, invoice and quote emails and SEO pull requests before you approve them.",
      href: teamSetupPath("reviewer"),
      hrefLabel: TEAM_LABEL,
      agentNext: "Comments PASS or CHANGES NEEDED on approval issues, then hands them to you.",
    },
    {
      key: "acceptance_agent",
      title: "Link an Acceptance agent (optional)",
      status: acceptance ? "done" : "optional",
      required: false,
      detail: acceptance
        ? `${acceptance.name} uses the product like a customer on a test client: every night, after each plugin release and when asked${acceptance.status === "paused" ? " (paused: resume it once its model key works)" : ""}.`
        : "Optional. The Acceptance agent uses the product the way a customer would (a lead captured, a quote, an invoice, an email sequence, a social draft, an SEO sprint, a client report) on a test client, so a release that passes its tests but does not work is found before a client finds it.",
      href: teamSetupPath("acceptance" as TeamRoleKey),
      hrefLabel: TEAM_LABEL,
      agentNext: "Works the customer journeys every night and after each plugin release and files a pass or fail report; a failure opens an issue for the role that owns the step.",
    },
    {
      key: "routines",
      title: "Operator routines active",
      status: !operator ? "blocked" : routinesOk ? "done" : "missing",
      required: true,
      detail: !operator
        ? "Created when the Operator is linked."
        : routinesOk
          ? "\"Daily operations review\" (07:00 SAST) and \"Weekly retro\" (Mondays 08:00 SAST) are active."
          : `Check the routines are active and assigned to ${operator.name}: ${routines.map((r) => `${r.title} (${r.status ?? "missing"})`).join(", ")}. Save the Operator again in Setup → Team to re-create them.`,
      href: teamSetupPath("operator"),
      hrefLabel: TEAM_LABEL,
      agentNext: "The Operator is woken every morning and every Monday.",
      blockedBy: ["operator_agent"],
    },
  ];
  const profile = await readProfile(env.ctx, companyId).catch(() => null);
  items.push(profileSetupItem(profile?.profile ?? {}));
  // Business goals (Q10-3): the weekly business review needs them. Optional: they never hold up the Finish setup count.
  const goals = await goalCounts(env.ctx, companyId).catch(() => null);
  if (goals) {
    const enough = goals.active >= GOALS_WANTED;
    // The button adopts every proposal, so the item lists each one: nothing is confirmed unseen.
    const proposals = goals.proposed > 0 ? (await listGoals(env.ctx, companyId, ["proposed"]).catch(() => [])).map(goalLine) : [];
    items.push({
      key: "goals",
      title: `Set ${GOALS_WANTED} company goals`,
      status: enough ? "done" : "optional",
      required: false,
      detail: enough
        ? `${goals.active} goals are active; every Monday the Operator reviews the numbers against them.${goals.proposed ? ` ${goals.proposed} more waiting for your yes: ${proposals.join("; ")}.` : ""}`
        : `${goals.active} of ${GOALS_WANTED} goals are active${goals.proposed ? `, ${goals.proposed} waiting for your yes: ${proposals.join("; ")}` : ""}. Without goals the weekly review looks at the agents, not the business: how many leads, which rank, how many posts, how much revenue.`,
      href: "/cockpit",
      hrefLabel: "Open the Cockpit",
      steps: enough ? undefined : [goals.proposed ? "Confirm the proposed goals (one question covers them all)." : "The Operator proposes goals from the numbers the modules report; you confirm them once, in one question.", "Or tell the Operator the targets you want."],
      agentNext: "The Operator proposes goals from the modules' numbers (leads, keyword rank, posts, revenue), the Cockpit asks you once, and every Monday it opens a business review comparing the week to the targets.",
      action: goals.proposed > 0 ? { plugin: PLUGIN_KEY, key: "goals.confirm", params: {}, label: `Confirm ${goals.proposed === 1 ? "the proposed goal" : `the ${goals.proposed} proposed goals`}` } : null,
    });
  }
  // Owner confirmations the Cockpit cannot see for itself (sign-up closed, backup key custody, a second admin, a backup of the Mac).
  try {
    items.push(...attestationSetupItems(await readAttestations(env.ctx, companyId), env.now()));
  } catch (error) {
    env.ctx.logger.info("Cockpit confirmations unreadable", { error: message(error) });
  }
  // The credentials register works from the recorded expiry dates; a company secret per provider also lets the daily check ask the provider.
  try {
    const checks = ((await readConfig(env.ctx, companyId)).credentialChecks ?? {}) as Record<string, unknown>;
    const set = Object.values(checks).filter(Boolean).length;
    items.push({
      key: "credential_checks",
      title: "Let the Cockpit check credentials daily (optional)",
      status: set > 0 ? "done" : "optional",
      required: false,
      detail: set > 0 ? `${set} ${set === 1 ? "credential check is" : "credential checks are"} set up: the daily job asks each provider whether its credential is still accepted.` : "The register already warns 30 and 7 days before an expiry you recorded. With a company secret per provider (GitHub, Cloudflare, Resend) the daily job also asks the provider whether the credential still works, and learns GitHub's and Cloudflare's own expiry date.",
      href: id ? `${PLUGINS_PATH}/${id}` : "/cockpit",
      hrefLabel: id ? "Open settings" : "Open the Cockpit",
      steps: set > 0 ? undefined : ["Open the Cockpit settings.", "Under Credential checks, pick the company secret that holds each token (the same secrets agents already use).", "Click Save Configuration."],
      agentNext: "Once a day the Cockpit calls each provider once (never storing or showing the value) and raises a health alert if a credential is refused or about to expire.",
    });
  } catch (error) {
    env.ctx.logger.info("Cockpit credential check settings unreadable", { error: message(error) });
  }
  const jev = await memoryJevConfig(env.ctx, companyId).catch(() => null);
  items.push({
    key: "memory_jev",
    title: "Smart matching for memory (optional)",
    status: jev ? "done" : "optional",
    required: false,
    detail: jev
      ? "Every agent's memory brief is picked by smart matching: only the facts the task needs, at most 12."
      : "Company memory already works: each task gets up to 12 remembered facts matched by keywords. Smart matching (an optional AI service) picks only the facts each task needs, so briefs are shorter and more relevant.",
    href: id ? `${PLUGINS_PATH}/${id}` : "/cockpit?tab=memory",
    hrefLabel: id ? "Open settings" : "Open Memory",
    steps: jev ? undefined : ["Open the Cockpit settings.", "Under **Smart matching for company memory**, pick the API key secret (the same one the other PiB plugins use).", "Click **Save Configuration**."],
    agentNext: "Briefs switch to smart matching on the next task; the Memory tab shows how often it and keyword matching would have differed.",
  });
  return { plugin: PLUGIN_KEY, module: null, title: "Cockpit", version: VERSION, items, checkedAt: env.now().toISOString() };
}

/** What to do about a role's agent that is not working, or null when it works. */
function agentFix(agent: UsableAgent): string | null {
  if (agent.status === "paused") return "Check its adapter has a working model key, then resume it.";
  if (agent.status === "pending_approval") return "Approve the hire in Approvals, then resume the agent once its model key works.";
  if (agent.status === "error") return "Open the agent, read the error on its last run, fix the cause (often the model key), then resume it.";
  return null;
}

/**
 * The Operator check. Empty, paused, waiting for approval or in error link to
 * Setup → Team ("Fix in Setup" on the page). An error stays a warning here:
 * the System health issue already lists agents in error.
 */
export function operatorCheck(operator: UsableAgent | null): HealthCheck {
  if (!operator) return { key: "operator", title: "Operator", status: "warn", detail: "No Operator yet, so nobody reviews the company each morning.", href: teamSetupPath("operator"), fix: "Hire an Operator or pick an existing agent in Setup → Team." };
  const fix = agentFix(operator);
  return fix
    ? { key: "operator", title: "Operator", status: "warn", detail: `${operator.name} (${operator.status.replace(/_/g, " ")}), so the company is not reviewed each morning.`, href: teamSetupPath("operator"), fix }
    : { key: "operator", title: "Operator", status: "ok", detail: `${operator.name} (${operator.status}).`, href: `/agents/${operator.id}`, fix: null };
}

/**
 * The Reviewer check, only for a linked Reviewer that is gone, paused,
 * waiting for approval or in error (it is optional, so none linked is fine).
 */
export function reviewerCheck(reviewer: UsableAgent | null, reviewOutward: boolean): HealthCheck | null {
  const waits = reviewOutward ? " Outward-facing work waits for its review." : "";
  if (!reviewer) return { key: "reviewer", title: "Reviewer", status: "warn", detail: `The Reviewer agent was terminated or removed.${waits}`, href: teamSetupPath("reviewer"), fix: "Pick another Reviewer in Setup → Team, or remove it." };
  const fix = agentFix(reviewer);
  return fix ? { key: "reviewer", title: "Reviewer", status: "warn", detail: `${reviewer.name} (${reviewer.status.replace(/_/g, " ")}).${waits}`, href: teamSetupPath("reviewer"), fix } : null;
}

/**
 * Nobody to report to: agents' questions have nowhere to go and the daily
 * brief has no reader. Refused questions in the last week make it urgent.
 */
export function ownerCheck(ownerUserId: string | null | undefined, refusedAsks7d: number): HealthCheck | null {
  if (ownerUserId) return null;
  return {
    key: "owner",
    title: "Nobody gets the daily brief",
    status: "warn",
    detail: refusedAsks7d > 0
      ? `Agents asked ${refusedAsks7d} ${refusedAsks7d === 1 ? "question" : "questions"} this week that could not reach anyone, and the daily brief has no reader.`
      : "Questions from agents have nowhere to go, and the daily brief has no reader.",
    href: OWNER_SETUP_PATH,
    fix: "Choose who gets the daily brief in Setup → Team.",
  };
}

/** Questions to the owner waiting more than three days. */
export function staleAsksCheck(asks: Array<{ identifier: string | null; issueId: string; askedAt: string }>, now: Date): HealthCheck | null {
  const stale = staleAsks(asks, now);
  if (stale.length === 0) return null;
  const refs = stale.slice(0, 3).map((a) => a.identifier ?? "an issue").join(", ");
  return {
    key: "asks",
    title: `${stale.length} ${stale.length === 1 ? "question waits" : "questions wait"} on the owner for more than ${ASK_STALE_DAYS} days`,
    status: "warn",
    detail: `${refs}${stale.length > 3 ? " and more" : ""}: the agents wait on these answers.`,
    href: stale.length === 1 ? `/issues/${stale[0]!.identifier ?? stale[0]!.issueId}` : "/cockpit",
    fix: "Answer each on its issue (Cockpit → Waiting on you); the reply goes straight back to the agent.",
    since: stale[0]!.askedAt,
  };
}

export async function ownSnapshot(env: Env, companyId: string): Promise<CockpitSnapshot> {
  const snapshot = emptySnapshot(PLUGIN_KEY, "Cockpit");
  snapshot.checkedAt = env.now().toISOString();
  const health: HealthCheck[] = [];
  try {
    health.push(await jobHealth(env.ctx, JOBS.healthAlerts, "Hourly health check", 60));
    health.push(await jobHealth(env.ctx, JOBS.reemitRoles, "Hourly role updates", 60));
    // The 0.5.0 jobs: one that stops (or fails for every company) leaves reviews unopened, improvements unmeasured, credential expiries unwatched and goals unreviewed, and nothing else would say so.
    health.push(await jobHealth(env.ctx, JOBS.closeoutSweep, "Daily close-out reviews", 24 * 60));
    health.push(await jobHealth(env.ctx, JOBS.improvementsRecheck, "Daily improvements re-check", 24 * 60));
    health.push(await jobHealth(env.ctx, JOBS.credentialsCheck, "Daily credentials check", 24 * 60));
    health.push(await jobHealth(env.ctx, JOBS.businessReview, "Weekly business review", 7 * 24 * 60));
    health.push(await jobHealth(env.ctx, JOBS.acceptanceNightly, "Nightly acceptance request", 24 * 60));
  } catch (error) {
    env.ctx.logger.info("Cockpit job health failed", { error: message(error) });
  }
  // The Cockpit's own routines, like every plugin reports its own (the kit adds them to what the others publish).
  health.push(...(await routineHealth(env.ctx, companyId)));
  // Run failure rate, repeated errors, retry storms, blocked and stalled issues (watch.ts).
  try {
    health.push(...(await watchChecks(env, companyId)));
  } catch (error) {
    env.ctx.logger.info("Cockpit watch failed", { error: message(error) });
  }
  try {
    const stats = await memoryStats(env.ctx, companyId);
    snapshot.kpis.push(
      { key: "memory_facts", label: "Memory facts", value: String(stats.facts.active), raw: stats.facts.active, delta: stats.added7d ? `+${stats.added7d} this week` : null, href: "/cockpit?tab=memory", group: "other" },
      { key: "memory_briefs", label: "Memory briefs (7 days)", value: String(stats.briefs7d.total), raw: stats.briefs7d.total, delta: stats.briefs7d.total ? `avg ${stats.briefs7d.avgFacts} facts` : null, href: "/cockpit?tab=memory", group: "other" },
    );
    const noted = stats.feedback30d.missing + stats.feedback30d.noise;
    if (noted > 0) {
      snapshot.quality.push({ key: "memory_feedback", label: "Memory brief feedback (30 days)", value: `${stats.feedback30d.missing} missing, ${stats.feedback30d.noise} noise`, raw: noted, tone: stats.feedback30d.missing > stats.briefs7d.total ? "warn" : "neutral" });
    }
    if (stats.facts.active > 0) health.push(await jobHealth(env.ctx, JOBS.memoryUpkeep, "Daily memory upkeep", 24 * 60));
  } catch (error) {
    env.ctx.logger.info("Cockpit memory stats failed", { error: message(error) });
  }
  try {
    const roles = await getRoles(env.ctx, companyId);
    const operator = await agentUsable(env, companyId, roles?.operatorAgentId ?? null);
    health.push(operatorCheck(operator));
    const reviewer = roles?.reviewerAgentId ? await lookupAgent(env, companyId, roles.reviewerAgentId) : undefined;
    // Only a linked Reviewer that could be looked up: a failed lookup says nothing.
    const reviewerHealth = reviewer !== undefined ? reviewerCheck(reviewer, roles?.reviewOutward ?? false) : null;
    if (reviewerHealth) health.push(reviewerHealth);
    const weekAgo = new Date(env.now().getTime() - 7 * 86_400_000).toISOString();
    const owner = ownerCheck(roles?.ownerUserId, roles?.ownerUserId ? 0 : await countActivitySince(env.ctx, companyId, "ask_refused", weekAgo).catch(() => 0));
    if (owner) health.push(owner);
    // The roles the Cockpit staffs, like every plugin reports its own (kit CockpitSnapshot.team).
    const team = [];
    if (roles?.operatorAgentId) team.push({ role: "operator" as const, agentId: roles.operatorAgentId, status: (await lookupAgent(env, companyId, roles.operatorAgentId))?.status ?? null });
    if (roles?.reviewerAgentId) team.push({ role: "reviewer" as const, agentId: roles.reviewerAgentId, status: reviewer?.status ?? null });
    // The Acceptance agent is linked in the kit's hire state, not in the roles table; reported like any role (the kit's registry names it once Setup lists it).
    const acceptanceId = await acceptanceAgentId(env, companyId);
    if (acceptanceId) team.push({ role: "acceptance" as TeamRoleKey, agentId: acceptanceId, status: (await lookupAgent(env, companyId, acceptanceId))?.status ?? null });
    if (team.length) snapshot.team = team;
  } catch (error) {
    env.ctx.logger.info("Cockpit roles check failed", { error: message(error) });
  }
  try {
    const asks = staleAsksCheck(await openAskViews(env, companyId), env.now());
    if (asks) health.push(asks);
  } catch (error) {
    env.ctx.logger.info("Cockpit question check failed", { error: message(error) });
  }
  // The kit's drift, grant and approval checks, the measurement alerts, the registers and confirmations, the improvements, goals and what waits on the owner (checks.ts).
  try {
    const extra = await extraChecks(env, companyId);
    health.push(...extra.health);
    snapshot.kpis.push(...extra.kpis);
    snapshot.quality.push(...extra.quality);
    snapshot.waiting.push(...extra.waiting);
  } catch (error) {
    env.ctx.logger.info("Cockpit extra checks failed", { error: message(error) });
  }
  try {
    snapshot.activity = toActivityItems(await recentActivity(env.ctx, companyId, 10));
  } catch (error) {
    env.ctx.logger.info("Cockpit activity read failed", { error: message(error) });
  }
  // The Cockpit's own stages of the company graph (onboarding), like every plugin reports its own.
  snapshot.flows = await cockpitFlowReports(env, companyId);
  snapshot.health = health;
  return snapshot;
}
