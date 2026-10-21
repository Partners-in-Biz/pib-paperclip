import type { PluginApiRequestInput, PluginApiResponse, PluginContext, PluginEvent, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import {
  COCKPIT_EVENTS,
  configSaved,
  createSkillSyncer,
  HANDOFF_EVENTS,
  hireTaskDraft,
  linkAgent,
  listCompanyAgents,
  normalizeToolResult,
  PIB_PLUGINS,
  pluginEvent,
  registerAskEffectResults,
  registerClientProjectWatch,
  registerCompanyBootstrap,
  registerCrmProjection,
  registerHireWatch,
  registerModuleWatch,
  rememberPluginUiBase,
  SETUP_EVENTS,
  startHire,
  trackJob,
  unlinkAgent,
  type SetupStatus,
} from "@partnersinbiz/pib-plugin-kit";
import { ACCEPTANCE_MATCH_ROLE, ACCEPTANCE_ROLE, ACCEPTANCE_ROLE_KEY, acceptanceAgentId, linkPendingAcceptance, onAcceptanceLinked } from "./acceptance-role.js";
import { AcceptanceError } from "./acceptance-model.js";
import { nightlyAcceptance, onPluginVersion, requestAcceptanceNow } from "./acceptance.js";
import { ACCEPTANCE_TOOL_SET, runAcceptanceTool } from "./acceptance-tools.js";
import { EVAL_TOOL_SET, runEvalTool } from "./eval-tools.js";
import { buildSkillPolicy, isReflectionCoach } from "./skill-policy.js";
import { AGENT_TOOL_NAMES, runAgentTool } from "./agent-tools.js";
import { AGENT_READ_TOOL_NAMES, runAgentReadTool } from "./agent-read-tools.js";
import { onAskComment, onAskIssueUpdated, onEffectResult, openAskViews } from "./asks.js";
import { ensureSetupIssue } from "./bootstrap.js";
import { forgetChecks } from "./checks.js";
import { closeoutSweep, onIssueClosed, onProjectUpdated } from "./closeout.js";
import { credentialsCheck } from "./credentials.js";
import { registerCockpitEffects, resolveOpenCockpitAsks } from "./effects.js";
import { activateGoals, businessReviews } from "./goals.js";
import { ACTIVATE_GOALS_EFFECT } from "./goals-model.js";
import { recheckImprovements } from "./improvements.js";
import { GROWTH_VERDICT_EVENT, GROWTH_VERDICT_SOURCES, onGrowthVerdictEvent } from "./growth-ledger.js";
import { GROWTH_TOOL_SET, runGrowthTool } from "./growth-tools.js";
import { OWN_METRICS_EVENT, onOwnMetricsEvent } from "./growth-own-metrics.js";
import { OPS_TOOL_SET, runOpsTool } from "./ops-tools.js";
import { confirmAttestation } from "./security.js";
import { listUnassigned, onSetupSummary, runTool } from "./brief.js";
import { assignableUser, JOBS, PLUGIN_KEY, type RoleKind } from "./constants.js";
import { getHealthIssue, getRoles, listRoles, listSnapshots, upsertSnapshot } from "./db.js";
import { doneCheckFor } from "./done-checks.js";
import { outwardGateFor } from "./outward-gate.js";
import { CockpitError, message, readInstalled, rememberInstalled, type Env } from "./env.js";
import { governCompany, type GovernorConfig } from "./governor.js";
import { rehearseGovernor } from "./governor-rehearse.js";
import { healthAlerts, refreshHealthIssue, warningSince } from "./health.js";
import { HIRE_MATCH_ROLES, HIRE_ROLES } from "./hire.js";
import { parseSnapshot, teamSignature } from "./merge.js";
import { NAMESPACE } from "./namespace.js";
import { onDealWon, onInvoicePaid } from "./onboarding.js";
import { ownSetupStatus, ownSnapshot } from "./own.js";
import { readProfile, saveProfileEdit } from "./profile.js";
import { ProfileError } from "./profile-model.js";
import { onLinkedFor, parseTeamInput, rebroadcastRoles, reemitRoles, roleViews, rolesPayload, saveTeam } from "./roles.js";
import { registerMemoryActions } from "./memory/actions.js";
import { onCommentCreated, upkeep } from "./memory/service.js";
import { MEMORY_TOOL_NAMES, runMemoryTool } from "./memory/tools.js";
import { SKILLS } from "./skills.js";
import { COCKPIT_TOOLS } from "./tools.js";
import { devices, mute, publicKey, subscribe, test, unsubscribe } from "./push/actions.js";
import { onIssueNeedsYou } from "./push/triggers-needs-you.js";
import { handleOwnerPush } from "./push/owner-push-route.js";
import { runPushDigest } from "./push/digest.js";
import { registerW1cEdge } from "./register-w1c-edge.js";
import { riskTierCloseCheck } from "./register-w1c-done.js";

/** The Setup plugin's event carrying its one setup count (`setup.summary`). */
export const SETUP_SUMMARY_EVENT = "setup.summary";

/** Plugins whose reports the Cockpit keeps (everyone but itself). */
export const REPORTING_PLUGINS: string[] = Object.values(PIB_PLUGINS).filter((key) => key !== PLUGIN_KEY);

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Store the newest `CockpitSnapshot` a plugin pushed. The subscription says
 * who sent it. When it changes a role's agent or status, the roles are sent
 * again so every plugin routes work to the right agent at once.
 */
export async function onSnapshotEvent(env: Env, pluginKey: string, event: Pick<PluginEvent, "companyId" | "payload">): Promise<boolean> {
  const companyId = event.companyId;
  if (!companyId) return false;
  const snapshot = parseSnapshot(event.payload, pluginKey);
  if (!snapshot) return false;
  const before = (await listSnapshots(env.ctx, companyId, "cockpit")).find((row) => row.pluginKey === pluginKey);
  const previous = before ? parseSnapshot(before.payload, pluginKey) : null;
  await upsertSnapshot(env.ctx, { companyId, pluginKey, kind: "cockpit", payload: snapshot, checkedAt: snapshot.checkedAt, receivedAt: env.now().toISOString() });
  const newer = !previous || Date.parse(snapshot.checkedAt) >= Date.parse(previous.checkedAt);
  if (newer && teamSignature(previous?.team) !== teamSignature(snapshot.team)) {
    await rebroadcastRoles(env, companyId).catch((error) => env.ctx.logger.info("Roles re-send after a team change failed", { companyId, error: message(error) }));
  }
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
  // A plugin that reports a different version than the one last seen was released: the journeys that exercise it get an acceptance request (it never blocks the projection).
  try {
    await onPluginVersion(env, companyId, pluginKey, payload.version);
  } catch (error) {
    env.ctx.logger.info("Acceptance release check failed", { companyId, pluginKey, error: message(error) });
  }
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

/** `goals.confirm` ids: a list of goal ids, or none for every proposed goal. */
function idList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((v): v is string => typeof v === "string" && /^goal[a-f0-9]{12}$/.test(v));
  return ids.length ? ids : null;
}

/** Iterates all companies: reads config, calls governCompany for trigger + pause path. */
export async function governorTick(env: Env): Promise<{ tried: number; disabled: number; idle: number; paused: number; errors: number; failed: number; waiting: number; canary_started: number; resumed: number; cleared: number; stuck: number }> {
  const results = { tried: 0, disabled: 0, idle: 0, paused: 0, errors: 0, failed: 0, waiting: 0, canary_started: 0, resumed: 0, cleared: 0, stuck: 0 };
  for (const row of await listRoles(env.ctx)) {
    results.tried += 1;
    try {
      const config = (await env.ctx.config.get(row.companyId)) as Record<string, unknown> | undefined;
      const governorConfig = config?.governor as GovernorConfig | undefined;
      const result = await governCompany(env, row.companyId, governorConfig);
      // `paused` counts agents paused this tick.
      if (result.outcome === "paused") results.paused += result.paused;
      else results[result.outcome] += 1;
      results.errors += result.errors;
    } catch (e) {
      results.failed += 1;
      env.ctx.logger.warn("Governor tick failed for company", { companyId: row.companyId, error: message(e) });
    }
  }
  return results;
}

/** Registers everything; exported for tests. */
export function registerCockpit(ctx: PluginContext, env: Env = createEnv(ctx)): Env {
  registerModuleWatch(ctx);
  // Every CRM client (name, domain) for company memory, asks and onboarding.
  registerCrmProjection(ctx, NAMESPACE);
  // Which Paperclip projects the CRM linked to each client, for effort against revenue (Q1b-14).
  registerClientProjectWatch(ctx);
  // The effects the Cockpit handles itself, and the results other plugins send back for answered asks (RC5).
  registerCockpitEffects(env);
  registerAskEffectResults(ctx, async (companyId, result) => {
    await onEffectResult(env, companyId, result);
  });
  // A new company (Q2-8): remember it, sync the Cockpit's skills, open the owner's "Set up" issue. Replaces a hand-written company.created handler (kit contract: one per plugin).
  registerCompanyBootstrap(ctx, {
    syncer: env.skills,
    ownerIssue: false,
    onBootstrap: async (companyId, source) => {
      if (source !== "lazy") await ensureSetupIssue(env, companyId);
    },
  });
  // One registration for every role the Cockpit staffs (the kit's contract: one handler per core event).
  registerHireWatch(ctx, [
    ...(["operator", "reviewer"] as const).map((kind) => ({ role: HIRE_MATCH_ROLES[kind], onLinked: onLinkedFor(env, kind) })),
    { role: ACCEPTANCE_MATCH_ROLE, onLinked: onAcceptanceLinked(env) },
  ]);
  // Edge watch: announce when new blocker edges are created.
  registerW1cEdge(env);

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

  // The Setup plugin's one setup count, so Waiting on you and the daily brief say the same number as Setup.
  ctx.events.on(pluginEvent(PIB_PLUGINS.setup, SETUP_SUMMARY_EVENT), async (event) => {
    try {
      await onSetupSummary(env, event.companyId ?? ((event.payload as { companyId?: string } | null)?.companyId ?? null), event.payload);
    } catch (error) {
      ctx.logger.info("Cockpit setup count update failed", { error: message(error) });
    }
  });

  // Hand-offs: a first won deal opens onboarding; won deals and paid invoices are activity.
  ctx.events.on(pluginEvent(PIB_PLUGINS.crm, HANDOFF_EVENTS.dealWon), async (event) => {
    try {
      await onDealWon(env, event);
    } catch (error) {
      ctx.logger.info("Cockpit deal.won handling failed", { error: message(error) });
    }
  });
  ctx.events.on(pluginEvent(PIB_PLUGINS.billing, HANDOFF_EVENTS.invoicePaid), async (event) => {
    try {
      await onInvoicePaid(env, event);
    } catch (error) {
      ctx.logger.info("Cockpit invoice.paid handling failed", { error: message(error) });
    }
  });

  // Growth verdicts from every channel into the ledger (best effort: the weekly review reconciles through ledger-upsert).
  for (const pluginKey of GROWTH_VERDICT_SOURCES) {
    ctx.events.on(pluginEvent(pluginKey, GROWTH_VERDICT_EVENT), async (event) => {
      try {
        await onGrowthVerdictEvent(env, pluginKey, event);
      } catch (error) {
        ctx.logger.info("Cockpit growth verdict handling failed", { pluginKey, error: message(error) });
      }
    });
  }

  // CRM's own metrics into growth_metrics (website and revenue channels).
  ctx.events.on(pluginEvent(PIB_PLUGINS.crm, OWN_METRICS_EVENT), async (event) => {
    try {
      await onOwnMetricsEvent(env, event);
    } catch (error) {
      ctx.logger.info("Cockpit own metrics handling failed", { error: message(error) });
    }
  });

  ctx.actions.register("cockpit.load", async (params, context) => {
    const companyId = requiredCompany(context);
    if (params.installed) await rememberInstalled(ctx, params.installed);
    if (params.uiBase) await rememberPluginUiBase(ctx, params.uiBase);
    await env.skills.ensure(companyId).catch(() => undefined);
    const [roles, saved, snapshots, setup, own, health, installed, asks, unassigned, warnings] = await Promise.all([
      getRoles(ctx, companyId),
      configSaved(ctx, companyId),
      listSnapshots(ctx, companyId, "cockpit"),
      listSnapshots(ctx, companyId, "setup"),
      ownSnapshot(env, companyId),
      getHealthIssue(ctx, companyId),
      readInstalled(ctx),
      openAskViews(env, companyId).catch(() => []),
      listUnassigned(ctx, companyId),
      warningSince(env, companyId),
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
      asks,
      unassigned,
      warningSince: warnings,
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
    const agents = await listCompanyAgents(ctx, companyId);
    const hire = params.role === ACCEPTANCE_ROLE_KEY ? ACCEPTANCE_ROLE : HIRE_ROLES[roleKind(params.role)];
    return { draft: hireTaskDraft(hire), agents, defaultAssigneeAgentId: agents.find((a) => a.role === "ceo")?.id ?? null };
  });

  ctx.actions.register("cockpit.start-hire", async (params, context) => {
    const companyId = requiredCompany(context);
    const userId = requireUser(context);
    const acceptance = params.role === ACCEPTANCE_ROLE_KEY;
    const kind = acceptance ? null : roleKind(params.role);
    const assigneeAgentId = text(params.assigneeAgentId, 100) ?? null;
    if (assigneeAgentId && !(await ctx.agents.get(assigneeAgentId, companyId).catch(() => null))) throw new CockpitError("That assignee is not an agent in this company");
    // The task lists every skill to attach (HIRE_ROLES); the link itself matches on the role's own skill.
    const draft = hireTaskDraft(acceptance ? ACCEPTANCE_ROLE : HIRE_ROLES[kind!]);
    const hire = await startHire(ctx, companyId, acceptance ? ACCEPTANCE_MATCH_ROLE : HIRE_MATCH_ROLES[kind!], {
      title: text(params.title, 250) ?? draft.title,
      description: text(params.description, 50_000) ?? draft.description,
      assigneeAgentId,
      assigneeUserId: assigneeAgentId ? null : assignableUser(text(params.assigneeUserId, 200) ?? null),
      actorUserId: userId,
    });
    return { hire };
  });

  // The Acceptance agent is linked like a plugin role (Setup → Team calls these with role "acceptance"); the Operator and Reviewer are saved with cockpit.save-team.
  const acceptanceOnly = (params: Record<string, unknown>) => {
    if (params.role !== ACCEPTANCE_ROLE_KEY) throw new CockpitError("The Operator and the Reviewer are linked with cockpit.save-team; this is for the Acceptance agent (role: acceptance)");
  };
  ctx.actions.register("cockpit.link-agent", async (params, context) => {
    const companyId = requiredCompany(context);
    const userId = requireUser(context);
    acceptanceOnly(params);
    const agentId = text(params.agentId, 100);
    if (!agentId) throw new CockpitError("agentId is required");
    const { agent, steps } = await linkAgent(ctx, companyId, ACCEPTANCE_MATCH_ROLE, agentId, { by: "manual", userId, onLinked: onAcceptanceLinked(env) });
    return { agent, steps };
  });
  ctx.actions.register("cockpit.unlink-agent", async (params, context) => {
    const companyId = requiredCompany(context);
    requireUser(context);
    acceptanceOnly(params);
    await unlinkAgent(ctx, companyId, ACCEPTANCE_MATCH_ROLE);
    return { ok: true };
  });
  ctx.actions.register("cockpit.resync-agent", async (params, context) => {
    const companyId = requiredCompany(context);
    const userId = requireUser(context);
    acceptanceOnly(params);
    const agentId = await acceptanceAgentId(env, companyId);
    if (!agentId) throw new CockpitError("No Acceptance agent is linked yet. Hire one or pick an existing agent in Setup → Team.");
    return { steps: await onAcceptanceLinked(env)(companyId, agentId, { userId }) };
  });
  // A person asks for an acceptance check now (all journeys, or the named ones).
  ctx.actions.register("acceptance.request", async (params, context) => {
    const companyId = requiredCompany(context);
    requireUser(context);
    const keys = Array.isArray(params.journeys) ? params.journeys.filter((k): k is string => typeof k === "string") : null;
    try {
      return await requestAcceptanceNow(env, companyId, keys);
    } catch (error) {
      if (error instanceof AcceptanceError) throw new CockpitError(error.message);
      throw error;
    }
  });
  // The exact skill-policy body for the board to apply (Q2-10): a plugin cannot write the policy itself.
  ctx.actions.register("cockpit.skill-policy-plan", async (params, context) => {
    const companyId = requiredCompany(context);
    requireUser(context);
    const agents = (await ctx.agents.list({ companyId, limit: 200 })) as unknown as Array<Record<string, unknown>>;
    const coach = agents.find((a) => isReflectionCoach(a) && !["terminated", "archived", "deleted"].includes(String(a.status)));
    const keys = Array.isArray(params.managedSkillKeys) ? params.managedSkillKeys.filter((k): k is string => typeof k === "string") : [];
    const plan = buildSkillPolicy({ expectedRevision: typeof params.expectedRevision === "number" ? params.expectedRevision : 0, operatorAgentId: (await getRoles(ctx, companyId))?.operatorAgentId ?? null, coachAgentId: coach ? String(coach.id) : null, managedSkillKeys: keys });
    return { ...plan, coach: coach ? { id: String(coach.id), name: String(coach.name ?? "") } : null, apply: `PUT /api/companies/${companyId}/skill-policy with this body (a board action). Read the current revision first: GET /api/companies/${companyId}/skill-policy. Check that the coach id is the agent you provisioned.` };
  });

  ctx.actions.register("cockpit.agents", async (_params, context) => {
    const companyId = requiredCompany(context);
    return { agents: await listCompanyAgents(ctx, companyId) };
  });

  ctx.actions.register("cockpit.refresh-health", async (_params, context) => refreshHealthIssue(env, requiredCompany(context)));

  // The company profile (Cockpit → Profile).
  ctx.actions.register("profile.load", async (_params, context) => readProfile(ctx, requiredCompany(context)));
  ctx.actions.register("profile.save", async (params, context) => {
    const companyId = requiredCompany(context);
    if (context.actor.type !== "user") throw new CockpitError("Only a board user can edit the company profile here");
    const input = params.profile && typeof params.profile === "object" && !Array.isArray(params.profile) ? (params.profile as Record<string, unknown>) : {};
    try {
      return await saveProfileEdit(ctx, companyId, input, assignableUser(context.actor.userId ?? null) ?? context.actor.userId ?? null, env.now().toISOString());
    } catch (error) {
      if (error instanceof ProfileError) throw new CockpitError(error.message);
      throw error;
    }
  });

  // Things only the owner can confirm (Setup's Confirm buttons call these; an agent never can).
  ctx.actions.register("cockpit.attest", async (params, context) => {
    const companyId = requiredCompany(context);
    if (context.actor.type !== "user") throw new CockpitError("Only a board user can confirm this");
    const userId = assignableUser(context.actor.userId ?? null) ?? context.actor.userId ?? null;
    if (!userId) throw new CockpitError("Sign in as a board user to confirm this");
    const row = await confirmAttestation(env, companyId, text(params.key, 60) ?? "", userId, text(params.note, 300) ?? null);
    forgetChecks(env, companyId);
    return { confirmed: row };
  });
  ctx.actions.register("goals.confirm", async (params, context) => {
    const companyId = requiredCompany(context);
    if (context.actor.type !== "user") throw new CockpitError("Only a board user can confirm goals");
    const userId = assignableUser(context.actor.userId ?? null) ?? context.actor.userId ?? null;
    if (!userId) throw new CockpitError("Sign in as a board user to confirm goals");
    const done = await activateGoals(env, companyId, idList(params.ids), userId);
    // The owner confirmed here, so the Cockpit's own question about them is done.
    await resolveOpenCockpitAsks(env, companyId, ACTIVATE_GOALS_EFFECT, "The goals were confirmed in Setup.");
    forgetChecks(env, companyId);
    return { activated: done.map((g) => ({ id: g.id, title: g.title })) };
  });

  // Push page actions
  ctx.actions.register("cockpit.push.publicKey", async (_params, context) => {
    requireUser(context);
    try {
      return await publicKey(ctx);
    } catch (error) {
      if (error instanceof Error && "code" in error) {
        throw new CockpitError((error as { message?: string }).message ?? error.message);
      }
      throw error;
    }
  });

  ctx.actions.register("cockpit.push.subscribe", async (params, context) => {
    const companyId = requiredCompany(context);
    const userId = requireUser(context);
    if (!userId) throw new CockpitError("Invalid user");
    try {
      return await subscribe(ctx, companyId, userId, params as Parameters<typeof subscribe>[3]);
    } catch (error) {
      const err = error as { code?: string; message?: string };
      if (err.code) throw new CockpitError(err.message ?? err.code);
      throw error;
    }
  });

  ctx.actions.register("cockpit.push.devices", async (_params, context) => {
    const companyId = requiredCompany(context);
    const userId = requireUser(context);
    if (!userId) throw new CockpitError("Invalid user");
    return { devices: await devices(ctx, companyId, userId) };
  });

  ctx.actions.register("cockpit.push.mute", async (params, context) => {
    const companyId = requiredCompany(context);
    const userId = requireUser(context);
    if (!userId) throw new CockpitError("Invalid user");
    try {
      return await mute(ctx, companyId, userId, params as unknown as Parameters<typeof mute>[3]);
    } catch (error) {
      const err = error as { code?: string; message?: string };
      if (err.code) throw new CockpitError(err.message ?? err.code);
      throw error;
    }
  });

  ctx.actions.register("cockpit.push.unsubscribe", async (params, context) => {
    const companyId = requiredCompany(context);
    const userId = requireUser(context);
    if (!userId) throw new CockpitError("Invalid user");
    try {
      return await unsubscribe(ctx, companyId, userId, params as unknown as Parameters<typeof unsubscribe>[3]);
    } catch (error) {
      const err = error as { code?: string; message?: string };
      if (err.code) throw new CockpitError(err.message ?? err.code);
      throw error;
    }
  });

  ctx.actions.register("cockpit.push.test", async (params, context) => {
    const companyId = requiredCompany(context);
    const userId = requireUser(context);
    if (!userId) throw new CockpitError("Invalid user");
    try {
      return await test(ctx, companyId, userId, params as unknown as Parameters<typeof test>[3]);
    } catch (error) {
      const err = error as { code?: string; message?: string };
      if (err.code) throw new CockpitError(err.message ?? err.code);
      throw error;
    }
  });

  ctx.jobs.register(JOBS.reemitRoles, async () => {
    const result = await trackJob(ctx, JOBS.reemitRoles, async () => {
      const sent = await reemitRoles(env);
      await linkPendingAcceptance(env);
      return sent;
    });
    if (result.emitted || result.failed) ctx.logger.info("Cockpit roles re-sent", result);
  });
  ctx.jobs.register(JOBS.acceptanceNightly, async () => {
    ctx.logger.info("Nightly acceptance request", await trackJob(ctx, JOBS.acceptanceNightly, () => nightlyAcceptance(env)));
  });
  ctx.jobs.register(JOBS.healthAlerts, async () => {
    ctx.logger.info("Cockpit health alerts", await trackJob(ctx, JOBS.healthAlerts, () => healthAlerts(env)));
  });
  ctx.jobs.register(JOBS.memoryUpkeep, async () => {
    ctx.logger.info("Company memory upkeep", await trackJob(ctx, JOBS.memoryUpkeep, () => upkeep(env)));
  });
  ctx.jobs.register(JOBS.closeoutSweep, async () => {
    ctx.logger.info("Close-out sweep", await trackJob(ctx, JOBS.closeoutSweep, () => closeoutSweep(env)));
  });
  ctx.jobs.register(JOBS.improvementsRecheck, async () => {
    ctx.logger.info("Improvements re-check", await trackJob(ctx, JOBS.improvementsRecheck, () => recheckImprovements(env)));
  });
  ctx.jobs.register(JOBS.credentialsCheck, async () => {
    ctx.logger.info("Credentials check", await trackJob(ctx, JOBS.credentialsCheck, () => credentialsCheck(env)));
  });
  ctx.jobs.register(JOBS.businessReview, async () => {
    ctx.logger.info("Weekly business review", await trackJob(ctx, JOBS.businessReview, () => businessReviews(env)));
  });
  ctx.jobs.register(JOBS.governor, async () => {
    ctx.logger.info("Agent governor", await trackJob(ctx, JOBS.governor, () => governorTick(env)));
  });
  ctx.jobs.register(JOBS.pushDigest, async () => {
    ctx.logger.info("Push digest", await trackJob(ctx, JOBS.pushDigest, () => runPushDigest(ctx)));
  });

  registerMemoryActions(env);

  // A person's reply answers an open question; **Learned:** lines in agents' and people's comments become company memory.
  ctx.events.on("issue.comment.created", async (event) => {
    try {
      await onAskComment(env, event);
    } catch (error) {
      ctx.logger.info("Ask: could not read a reply", { issueId: event.entityId, error: message(error) });
    }
    try {
      await onCommentCreated(env, event);
    } catch (error) {
      ctx.logger.info("Memory: could not read Learned lines from a comment", { issueId: event.entityId, error: message(error) });
    }
    // Risk-tier close: auto-close LOW-tier in_review issues with required PASS verdicts (handles errors internally).
    await riskTierCloseCheck(env, event);
  });
  // One issue.updated handler (each extra subscription would deliver every event again):
  // an open question follows its issue, and an agent's close of an onboarding or
  // System health issue is checked (unfinished work reopens with what is missing).
  const doneCheck = doneCheckFor(env);
  const outwardGate = outwardGateFor(env);
  ctx.events.on("issue.updated", async (event) => {
    try {
      await onAskIssueUpdated(env, event);
    } catch (error) {
      ctx.logger.info("Ask: could not follow an issue update", { issueId: event.entityId, error: message(error) });
    }
    // An epic whose last issue just closed gets its close-out review (only a close is read: every other update costs nothing).
    try {
      await onIssueClosed(env, event);
    } catch (error) {
      ctx.logger.info("Close-out: could not read an issue close", { issueId: event.entityId, error: message(error) });
    }
    try {
      await doneCheck(event);
    } catch (error) {
      ctx.logger.info("Done check failed", { issueId: event.entityId, error: message(error) });
    }
    try {
      await outwardGate(event);
    } catch (error) {
      ctx.logger.info("Outward gate failed", { issueId: event.entityId, error: message(error) });
    }
    try {
      await onIssueNeedsYou(env, event);
    } catch (error) {
      ctx.logger.info("Push: needs-you trigger failed", { issueId: event.entityId, error: message(error) });
    }
    // Risk-tier close: auto-close LOW-tier in_review issues with required PASS verdicts (handles errors internally).
    await riskTierCloseCheck(env, event);
  });

  // "Needs you" push trigger fires when an issue is assigned to the owner.
  ctx.events.on("issue.created", async (event) => {
    try {
      await onIssueNeedsYou(env, event);
    } catch (error) {
      ctx.logger.info("Push: needs-you trigger failed", { issueId: event.entityId, error: message(error) });
    }
  });

  // A project set to completed gets its close-out review at once (the one project.updated handler).
  ctx.events.on("project.updated", async (event) => {
    try {
      await onProjectUpdated(env, event);
    } catch (error) {
      ctx.logger.info("Close-out: could not read a project update", { projectId: event.entityId, error: message(error) });
    }
  });

  for (const tool of COCKPIT_TOOLS) {
    ctx.tools.register(tool.name, tool, async (params, run) => {
      await env.skills.ensure(run.companyId).catch(() => undefined);
      const result = MEMORY_TOOL_NAMES.has(tool.name)
        ? await runMemoryTool(env, tool.name, params, run)
        : AGENT_TOOL_NAMES.has(tool.name)
          ? await runAgentTool(env, tool.name, params, run)
          : AGENT_READ_TOOL_NAMES.has(tool.name)
            ? await runAgentReadTool(env, tool.name, params, run)
            : OPS_TOOL_SET.has(tool.name)
              ? await runOpsTool(env, tool.name, params, run)
              : GROWTH_TOOL_SET.has(tool.name)
                ? await runGrowthTool(env, tool.name, params, run)
                : ACCEPTANCE_TOOL_SET.has(tool.name)
                  ? await runAcceptanceTool(env, tool.name, params, run)
                  : EVAL_TOOL_SET.has(tool.name)
                    ? await runEvalTool(env, tool.name, params, run)
                    : await runTool(env, tool.name, params, run);
      return normalizeToolResult(result);
    });
  }
  return env;
}

export async function handleApiRoute(env: Env, input: PluginApiRequestInput): Promise<PluginApiResponse> {
  try {
    if (input.routeKey === "cockpit") return { status: 200, body: await ownSnapshot(env, input.companyId) };
    if (input.routeKey === "setup-status") return { status: 200, body: await ownSetupStatus(env, input.companyId) };
    if (input.routeKey === "repairs-create") {
      const body = input.body && typeof input.body === "object" && !Array.isArray(input.body) ? (input.body as Record<string, unknown>) : {};
      const { recordRepair } = await import("./repairs.js");

      // Validate required string fields
      const required = ["companyId", "kind", "targetKind", "targetId", "action", "outcome", "actor"];
      for (const field of required) {
        if (typeof body[field] !== "string" || !String(body[field]).trim()) {
          return { status: 400, body: { error: `${field} is required and must be a non-empty string` } };
        }
      }

      // Check for unknown fields
      const allowed = new Set([...required, "detail"]);
      for (const field of Object.keys(body)) {
        if (!allowed.has(field)) {
          return { status: 400, body: { error: `Unknown field: ${field}` } };
        }
      }

      // Check companyId match
      if (String(body.companyId).trim() !== input.companyId) {
        return { status: 400, body: { error: "Body companyId does not match resolved companyId" } };
      }

      const row = await recordRepair(env.ctx, input.companyId, {
        kind: String(body.kind).trim(),
        targetKind: String(body.targetKind).trim(),
        targetId: String(body.targetId).trim(),
        action: String(body.action).trim(),
        outcome: String(body.outcome).trim(),
        detail: typeof body.detail === "string" ? body.detail : undefined,
        actor: String(body.actor).trim(),
      });
      return { status: 201, body: row };
    }
    if (input.routeKey === "repairs-list") {
      const query = input.query && typeof input.query === "object" ? (input.query as Record<string, unknown>) : {};
      const companyId = typeof query.companyId === "string" ? query.companyId : input.companyId;

      if (!companyId) {
        return { status: 400, body: { error: "companyId is required" } };
      }

      let since: string | undefined;
      if (typeof query.since === "string" && query.since.trim()) {
        if (!Number.isFinite(Date.parse(query.since))) {
          return { status: 400, body: { error: "since must be a valid ISO date" } };
        }
        since = new Date(query.since).toISOString();
      }

      const { listRepairs } = await import("./repairs.js");
      const rows = await listRepairs(env.ctx, companyId, {
        kind: typeof query.kind === "string" ? query.kind : undefined,
        since,
        limit: typeof query.limit === "number" ? query.limit : undefined,
      });
      return { status: 200, body: { rows } };
    }
    if (input.routeKey === "governor-rehearse") {
      const body = input.body && typeof input.body === "object" && !Array.isArray(input.body) ? (input.body as Record<string, unknown>) : {};

      // Validate required field
      if (typeof body.companyId !== "string" || !String(body.companyId).trim()) {
        return { status: 400, body: { error: "companyId is required and must be a non-empty string" } };
      }

      // Check companyId match
      if (String(body.companyId).trim() !== input.companyId) {
        return { status: 400, body: { error: "Body companyId does not match resolved companyId" } };
      }

      // Validate agentName
      if (typeof body.agentName !== "string" || !String(body.agentName).trim()) {
        return { status: 400, body: { error: "agentName is required and must be a non-empty string" } };
      }

      // Check for unknown fields
      const allowed = new Set(["companyId", "agentName", "canaryStatus"]);
      for (const field of Object.keys(body)) {
        if (!allowed.has(field)) {
          return { status: 400, body: { error: `Unknown field: ${field}` } };
        }
      }

      const result = await rehearseGovernor(env, input.companyId, {
        agentName: String(body.agentName).trim(),
        canaryStatus: typeof body.canaryStatus === "string" ? body.canaryStatus : undefined,
      });

      if (result.outcome === "completed") {
        return { status: 200, body: result };
      }

      const reason = result.reason;
      if (reason === "bad_input" || reason === "never_pause" || reason === "agent_not_found") {
        return { status: 400, body: result };
      }

      // agent_already_paused, governor_active, not_paused -> 409
      return { status: 409, body: result };
    }
    if (input.routeKey === "owner-push") {
      return await handleOwnerPush(env, input);
    }
    return { status: 404, body: { error: "Not found" } };
  } catch (error) {
    env.ctx.logger.info("Cockpit route failed", { routeKey: input.routeKey, error: message(error) });
    return { status: 500, body: { error: message(error) } };
  }
}
