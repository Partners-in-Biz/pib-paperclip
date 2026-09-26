/**
 * The Cockpit's own setup checklist (`GET /setup-status`) and its own
 * snapshot (`GET /cockpit`). Read-only and cheap.
 */
import {
  configSaved,
  emptySnapshot,
  jobHealth,
  pluginUiBase,
  settingsItem,
  type CockpitSnapshot,
  type HealthCheck,
  type SetupItem,
  type SetupStatus,
} from "@partnersinbiz/pib-plugin-kit";
import { JOBS, PLUGIN_KEY, ROUTINES, ROUTINE_TITLES, VERSION } from "./constants.js";
import { getRoles } from "./db.js";
import { message, type Env } from "./env.js";

const PLUGINS_PATH = "/company/settings/instance/plugins";

function installationId(uiBase: string | null): string | null {
  return uiBase ? /\/_plugins\/([^/]+)\//.exec(uiBase)?.[1] ?? null : null;
}

async function agentUsable(env: Env, companyId: string, agentId: string | null): Promise<{ id: string; name: string; status: string } | null> {
  if (!agentId) return null;
  try {
    const agent = await env.ctx.agents.get(agentId, companyId);
    if (!agent || ["terminated", "archived", "deleted"].includes(String(agent.status))) return null;
    return { id: agent.id, name: String(agent.name), status: String(agent.status) };
  } catch {
    return null;
  }
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
    ...settingsItem({ saved, pluginId: id ?? "", detail: "The Cockpit saves these for you the first time you save the team. The hourly health check and role updates need them.", agentNext: "The hourly System health check and role updates start for this company." }),
    href: id ? `${PLUGINS_PATH}/${id}` : "/cockpit",
    hrefLabel: id ? "Open settings" : "Open the Cockpit",
    action: null,
  };
  const operator = await agentUsable(env, companyId, roles?.operatorAgentId ?? null);
  const reviewer = await agentUsable(env, companyId, roles?.reviewerAgentId ?? null);
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
      href: "/cockpit?tab=team",
      hrefLabel: "Open Team",
      steps: roles?.ownerUserId ? undefined : ["Open the Cockpit → Team.", "Pick the owner (defaults to you).", "Click Save team."],
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
      href: "/cockpit?tab=team",
      hrefLabel: "Open Team",
      steps: operator ? undefined : ["Open the Cockpit → Team.", "Click Hire Operator (opens a hire task), or pick an existing agent.", "Click Save team."],
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
      href: "/cockpit?tab=team",
      hrefLabel: "Open Team",
      agentNext: "Comments PASS or CHANGES NEEDED on approval issues, then hands them to you.",
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
          : `Check the routines are active and assigned to ${operator.name}: ${routines.map((r) => `${r.title} (${r.status ?? "missing"})`).join(", ")}. Save the team again to re-create them.`,
      href: "/routines",
      hrefLabel: "Open Routines",
      agentNext: "The Operator is woken every morning and every Monday.",
      blockedBy: ["operator_agent"],
    },
  ];
  return { plugin: PLUGIN_KEY, module: null, title: "Cockpit", version: VERSION, items, checkedAt: env.now().toISOString() };
}

export async function ownSnapshot(env: Env, companyId: string): Promise<CockpitSnapshot> {
  const snapshot = emptySnapshot(PLUGIN_KEY, "Cockpit");
  snapshot.checkedAt = env.now().toISOString();
  const health: HealthCheck[] = [];
  try {
    health.push(await jobHealth(env.ctx, JOBS.healthAlerts, "Hourly health check", 60));
    health.push(await jobHealth(env.ctx, JOBS.reemitRoles, "Hourly role updates", 60));
  } catch (error) {
    env.ctx.logger.info("Cockpit job health failed", { error: message(error) });
  }
  try {
    const roles = await getRoles(env.ctx, companyId);
    const operator = await agentUsable(env, companyId, roles?.operatorAgentId ?? null);
    health.push(operator
      ? { key: "operator", title: "Operator", status: operator.status === "paused" || operator.status === "pending_approval" ? "warn" : "ok", detail: `${operator.name} (${operator.status}).`, href: `/agents/${operator.id}`, fix: operator.status === "paused" ? "Check its adapter has a working model key, then resume it." : null }
      : { key: "operator", title: "Operator", status: "warn", detail: "No Operator yet, so nobody reviews the company each morning.", href: "/cockpit?tab=team", fix: "Open the Cockpit → Team and hire or pick an Operator." });
  } catch (error) {
    env.ctx.logger.info("Cockpit roles check failed", { error: message(error) });
  }
  snapshot.health = health;
  return snapshot;
}
