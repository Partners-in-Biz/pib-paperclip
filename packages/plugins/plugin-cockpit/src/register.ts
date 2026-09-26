import type { PluginApiRequestInput, PluginApiResponse, PluginContext, PluginEvent, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import {
  COCKPIT_EVENTS,
  configSaved,
  createSkillSyncer,
  hireTaskDraft,
  listCompanyAgents,
  normalizeToolResult,
  PIB_PLUGINS,
  pluginEvent,
  registerHireWatch,
  registerModuleWatch,
  rememberPluginUiBase,
  SETUP_EVENTS,
  startHire,
  trackJob,
  type SetupStatus,
} from "@partnersinbiz/pib-plugin-kit";
import { runTool } from "./brief.js";
import { assignableUser, JOBS, PLUGIN_KEY, type RoleKind } from "./constants.js";
import { getHealthIssue, getRoles, listSnapshots, upsertSnapshot } from "./db.js";
import { CockpitError, message, readInstalled, rememberInstalled, type Env } from "./env.js";
import { healthAlerts, refreshHealthIssue } from "./health.js";
import { HIRE_ROLES } from "./hire.js";
import { parseSnapshot } from "./merge.js";
import { ownSetupStatus, ownSnapshot } from "./own.js";
import { onLinkedFor, parseTeamInput, reemitRoles, roleViews, rolesPayload, saveTeam } from "./roles.js";
import { SKILLS } from "./skills.js";
import { COCKPIT_TOOLS } from "./tools.js";

/** Plugins whose reports the Cockpit keeps (everyone but itself). */
export const REPORTING_PLUGINS: string[] = Object.values(PIB_PLUGINS).filter((key) => key !== PLUGIN_KEY);

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/** Store the newest `CockpitSnapshot` a plugin pushed. The subscription says who sent it. */
export async function onSnapshotEvent(env: Env, pluginKey: string, event: Pick<PluginEvent, "companyId" | "payload">): Promise<boolean> {
  const companyId = event.companyId;
  if (!companyId) return false;
  const snapshot = parseSnapshot(event.payload, pluginKey);
  if (!snapshot) return false;
  await upsertSnapshot(env.ctx, { companyId, pluginKey, kind: "cockpit", payload: snapshot, checkedAt: snapshot.checkedAt, receivedAt: env.now().toISOString() });
  return true;
}

/** Keep the newest `SetupStatus` too, for "Finish setup" on Waiting on you. */
export async function onSetupStatusEvent(env: Env, pluginKey: string, event: Pick<PluginEvent, "companyId" | "payload">): Promise<boolean> {
  const companyId = event.companyId;
  const payload = event.payload as Partial<SetupStatus> | null;
  if (!companyId || !payload || typeof payload !== "object" || !Array.isArray(payload.items)) return false;
  const checkedAt = typeof payload.checkedAt === "string" && !Number.isNaN(Date.parse(payload.checkedAt)) ? payload.checkedAt : env.now().toISOString();
  const items = payload.items
    .filter((item) => item && typeof item === "object" && typeof item.key === "string")
    .map((item) => ({ key: item.key, title: String(item.title ?? item.key), status: item.status, required: item.required === true }));
  const status = { plugin: pluginKey, module: payload.module ?? null, title: String(payload.title ?? pluginKey), items, checkedAt };
  await upsertSnapshot(env.ctx, { companyId, pluginKey, kind: "setup", payload: status, checkedAt, receivedAt: env.now().toISOString() });
  return true;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function requiredCompany(context: PluginPerformActionContext): string {
  if (!context.companyId) throw new CockpitError("Company is required");
  return context.companyId;
}

function requireUser(context: PluginPerformActionContext): string | null {
  if (context.actor.type !== "user") throw new CockpitError("Only a board user can change the team");
  return assignableUser(context.actor.userId ?? null);
}

function roleKind(value: unknown): RoleKind {
  if (value === "operator" || value === "reviewer") return value;
  throw new CockpitError("role must be operator or reviewer");
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

export function createEnv(ctx: PluginContext, now: () => Date = () => new Date()): Env {
  return { ctx, skills: createSkillSyncer(ctx, SKILLS), now };
}

/** Registers everything; exported for tests. */
export function registerCockpit(ctx: PluginContext, env: Env = createEnv(ctx)): Env {
  registerModuleWatch(ctx);
  registerHireWatch(ctx, (["operator", "reviewer"] as const).map((kind) => ({ role: HIRE_ROLES[kind], onLinked: onLinkedFor(env, kind) })));

  for (const pluginKey of REPORTING_PLUGINS) {
    ctx.events.on(pluginEvent(pluginKey, COCKPIT_EVENTS.snapshot), async (event) => {
      try {
        await onSnapshotEvent(env, pluginKey, event);
      } catch (error) {
        ctx.logger.info("Cockpit snapshot projection failed", { pluginKey, error: message(error) });
      }
    });
    ctx.events.on(pluginEvent(pluginKey, SETUP_EVENTS.status), async (event) => {
      try {
        await onSetupStatusEvent(env, pluginKey, event);
      } catch (error) {
        ctx.logger.info("Cockpit setup projection failed", { pluginKey, error: message(error) });
      }
    });
  }

  ctx.actions.register("cockpit.load", async (params, context) => {
    const companyId = requiredCompany(context);
    if (params.installed) await rememberInstalled(ctx, params.installed);
    if (params.uiBase) await rememberPluginUiBase(ctx, params.uiBase);
    void env.skills.ensure(companyId).catch(() => undefined);
    const [roles, saved, snapshots, setup, own, health, installed] = await Promise.all([
      getRoles(ctx, companyId),
      configSaved(ctx, companyId),
      listSnapshots(ctx, companyId, "cockpit"),
      listSnapshots(ctx, companyId, "setup"),
      ownSnapshot(env, companyId),
      getHealthIssue(ctx, companyId),
      readInstalled(ctx),
    ]);
    const team = params.team === false ? null : await roleViews(env, companyId);
    return {
      roles: roles ? rolesPayload(roles) : null,
      rolesSavedAt: roles?.createdAt ?? null,
      settingsSaved: saved,
      snapshots: Object.fromEntries(snapshots.map((row) => [row.pluginKey, { snapshot: row.payload, receivedAt: row.receivedAt }])),
      setupStatuses: Object.fromEntries(setup.map((row) => [row.pluginKey, row.payload])),
      own,
      team,
      healthIssueId: health?.issueId ?? null,
      installed,
    };
  });

  ctx.actions.register("cockpit.save-team", async (params, context) => {
    const companyId = requiredCompany(context);
    const userId = requireUser(context);
    const result = await saveTeam(env, companyId, parseTeamInput(params), userId);
    let health: string | null = null;
    try {
      health = (await refreshHealthIssue(env, companyId)).action;
    } catch (error) {
      ctx.logger.info("Health refresh after team save failed", { error: message(error) });
    }
    return { ...result, health };
  });

  ctx.actions.register("cockpit.hire-options", async (params, context) => {
    const companyId = requiredCompany(context);
    requireUser(context);
    const kind = roleKind(params.role);
    const agents = await listCompanyAgents(ctx, companyId);
    return { draft: hireTaskDraft(HIRE_ROLES[kind]), agents, defaultAssigneeAgentId: agents.find((a) => a.role === "ceo")?.id ?? null };
  });

  ctx.actions.register("cockpit.start-hire", async (params, context) => {
    const companyId = requiredCompany(context);
    const userId = requireUser(context);
    const kind = roleKind(params.role);
    const assigneeAgentId = text(params.assigneeAgentId, 100) ?? null;
    if (assigneeAgentId && !(await ctx.agents.get(assigneeAgentId, companyId).catch(() => null))) throw new CockpitError("That assignee is not an agent in this company");
    const hire = await startHire(ctx, companyId, HIRE_ROLES[kind], {
      title: text(params.title, 250),
      description: text(params.description, 50_000),
      assigneeAgentId,
      assigneeUserId: assigneeAgentId ? null : assignableUser(text(params.assigneeUserId, 200) ?? null),
      actorUserId: userId,
    });
    return { hire };
  });

  ctx.actions.register("cockpit.agents", async (_params, context) => {
    const companyId = requiredCompany(context);
    return { agents: await listCompanyAgents(ctx, companyId) };
  });

  ctx.actions.register("cockpit.refresh-health", async (_params, context) => refreshHealthIssue(env, requiredCompany(context)));

  ctx.jobs.register(JOBS.reemitRoles, async () => {
    const result = await trackJob(ctx, JOBS.reemitRoles, () => reemitRoles(env));
    if (result.emitted || result.failed) ctx.logger.info("Cockpit roles re-sent", result);
  });
  ctx.jobs.register(JOBS.healthAlerts, async () => {
    ctx.logger.info("Cockpit health alerts", await trackJob(ctx, JOBS.healthAlerts, () => healthAlerts(env)));
  });

  for (const tool of COCKPIT_TOOLS) {
    ctx.tools.register(tool.name, tool, async (params, run) => {
      void env.skills.ensure(run.companyId).catch(() => undefined);
      return normalizeToolResult(await runTool(env, tool.name, params, run));
    });
  }
  return env;
}

export async function handleApiRoute(env: Env, input: PluginApiRequestInput): Promise<PluginApiResponse> {
  try {
    if (input.routeKey === "cockpit") return { status: 200, body: await ownSnapshot(env, input.companyId) };
    if (input.routeKey === "setup-status") return { status: 200, body: await ownSetupStatus(env, input.companyId) };
    return { status: 404, body: { error: "Not found" } };
  } catch (error) {
    env.ctx.logger.info("Cockpit route failed", { routeKey: input.routeKey, error: message(error) });
    return { status: 500, body: { error: message(error) } };
  }
}
