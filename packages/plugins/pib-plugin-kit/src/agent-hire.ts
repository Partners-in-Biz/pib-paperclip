/**
 * Hiring a plugin's agent through the company's normal hiring path.
 *
 * Instead of the plugin creating its agent directly, "Activate" opens a task
 * (a hire request) with the full spec: name, role, adapter, skills, budget.
 * A person picks who does the hire, usually the agent that hires for the
 * company, so every agent is created the same way and lands in the org
 * chart. When an agent matching the spec appears, the plugin links it and
 * wires it up (tool access, routines, waiting work). A person can also link
 * any existing agent by hand.
 *
 * The link lives in company-scoped plugin state, so it works for agents the
 * plugin did not create. Agents activated the old way (host-managed) are
 * still found through `legacy`.
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";

export interface HireSkill {
  /** Canonical key the host gives the managed skill, e.g. `plugin/partnersinbiz-seo/seo-sprint`. */
  key: string;
  /** Unique slug from the skill's frontmatter, e.g. `pib-seo-sprint`. */
  slug: string;
  /** What the skill is for, one line. */
  purpose: string;
}

export interface HireRole {
  /** Plugin that owns the role, e.g. `partnersinbiz.seo`. */
  pluginKey: string;
  /** Plugin's display name, e.g. `SEO`. */
  pluginName: string;
  /** Stable key, e.g. `seo-specialist`. */
  roleKey: string;
  displayName: string;
  title: string;
  /** Paperclip agent role, e.g. `general`. */
  role: string;
  icon?: string;
  /** What the agent does, one or two sentences. */
  capabilities: string;
  adapterPreference: string[];
  skills: HireSkill[];
  budgetMonthlyCents: number;
  /** Who it should report to, in words (e.g. "the marketing lead"). */
  suggestedManager?: string;
  /** Short AGENTS.md the hirer should give the agent. The procedure lives in the skills. */
  instructions: string;
  /** What the plugin sets up once the agent is linked, one line each. */
  pluginSetup: string[];
  /** Other plugin tool namespaces the agent will use, e.g. `partnersinbiz.crm`. */
  toolPlugins: string[];
}

export interface HireRecord {
  issueId: string;
  identifier: string | null;
  title: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  createdAt: string;
  status: "open" | "linked" | "cancelled";
}

export interface HireState {
  agentId: string | null;
  linkedAt: string | null;
  linkedBy: "auto" | "manual" | "managed" | null;
  hire: HireRecord | null;
}

export interface HireAgentSummary {
  id: string;
  name: string;
  title: string | null;
  role: string | null;
  status: string;
  icon: string | null;
  createdAt: string | null;
}

export interface HireStatus {
  agent: HireAgentSummary | null;
  linkedBy: HireState["linkedBy"];
  hire: HireRecord | null;
  /** Agents that look like this hire but were not linked automatically (more than one match). */
  candidates: HireAgentSummary[];
}

/** Lets the plugin find an agent that was set up before hiring moved to tasks. */
export type LegacyAgentLookup = (companyId: string) => Promise<string | null>;

/** Wires a linked agent: tool grant, routines, adopting waiting work. Returns one line per step. */
export type OnAgentLinked = (companyId: string, agentId: string, by: { userId: string | null }) => Promise<string[]>;

const STATE_NAMESPACE = "pib-hire";
const INACTIVE = new Set(["terminated", "archived", "deleted"]);

function stateKey(companyId: string, roleKey: string) {
  return { scopeKind: "company" as const, scopeId: companyId, namespace: STATE_NAMESPACE, stateKey: `role:${roleKey}` };
}

const EMPTY: HireState = { agentId: null, linkedAt: null, linkedBy: null, hire: null };

export async function readHireState(ctx: PluginContext, companyId: string, roleKey: string): Promise<HireState> {
  try {
    const value = await ctx.state.get(stateKey(companyId, roleKey));
    if (value && typeof value === "object") return { ...EMPTY, ...(value as Partial<HireState>) };
  } catch (error) {
    ctx.logger.info("Hire state read failed", { roleKey, error: error instanceof Error ? error.message : String(error) });
  }
  return { ...EMPTY };
}

async function writeHireState(ctx: PluginContext, companyId: string, roleKey: string, state: HireState): Promise<void> {
  await ctx.state.set(stateKey(companyId, roleKey), state);
}

function money(cents: number): string {
  return cents > 0 ? `$${(cents / 100).toFixed(2)} per month` : "$0 (set one before resuming)";
}

/** Title and markdown description for the hire task. Deterministic, so the popup can show it. */
export function hireTaskDraft(role: HireRole): { title: string; description: string } {
  const skillLines = role.skills.map((s) => `- \`${s.slug}\` — ${s.purpose} (skill key \`${s.key}\`)`).join("\n");
  const setupLines = role.pluginSetup.map((line) => `- ${line}`).join("\n");
  const description = `The ${role.pluginName} plugin needs an agent. Please hire it the way we hire every agent, so it sits in the right place in the org chart.

## The agent

| | |
|---|---|
| **Name** | ${role.displayName} |
| **Title** | ${role.title} |
| **Role** | \`${role.role}\` |
| **Reports to** | ${role.suggestedManager ?? "the right manager for this work (your call)"} |
| **Adapter** | ${role.adapterPreference.map((a) => `\`${a}\``).join(", then ")} (first one that has a working model key) |
| **Budget** | ${money(role.budgetMonthlyCents)} |
| **Start** | paused, until its model key is checked |

**What it does:** ${role.capabilities}

## Skills to attach

${skillLines}

The skills hold the full procedure and are kept up to date by the plugin. Do not copy them into the instructions.

## Instructions (AGENTS.md)

\`\`\`markdown
${role.instructions.trim()}
\`\`\`

## What the plugin does after the hire

The ${role.pluginName} plugin notices the new agent (it looks for an agent created after this task with the skill above or the name **${role.displayName}**) and then:

${setupLines}

It comments here when that is done. Do not grant plugin tool access by hand; the plugin does it. If the link does not happen within a few minutes, open the ${role.pluginName} page and use **Link agent**.

## Done when

- The agent exists with the skills above, reporting to the right manager.
- The ${role.pluginName} plugin has commented that it linked the agent.
- The agent is resumed once its adapter has a working model key.`;
  return { title: `Hire: ${role.displayName} (${role.pluginName} agent)`, description };
}

function summarize(agent: Record<string, unknown>): HireAgentSummary {
  const created = agent.createdAt;
  return {
    id: String(agent.id),
    name: String(agent.name ?? "Agent"),
    title: typeof agent.title === "string" ? agent.title : null,
    role: typeof agent.role === "string" ? agent.role : null,
    status: String(agent.status ?? ""),
    icon: typeof agent.icon === "string" ? agent.icon : null,
    createdAt: created instanceof Date ? created.toISOString() : typeof created === "string" ? created : null,
  };
}

/** Agents a person can assign the hire task to, or link by hand. */
export async function listCompanyAgents(ctx: PluginContext, companyId: string): Promise<HireAgentSummary[]> {
  const agents = await ctx.agents.list({ companyId, limit: 200 });
  return (agents as unknown as Array<Record<string, unknown>>)
    .filter((a) => !INACTIVE.has(String(a.status)))
    .map(summarize)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function desiredSkills(agent: Record<string, unknown>): string[] {
  const config = agent.adapterConfig;
  if (!config || typeof config !== "object") return [];
  const sync = (config as Record<string, unknown>).paperclipSkillSync;
  if (!sync || typeof sync !== "object") return [];
  const list = (sync as Record<string, unknown>).desiredSkills;
  return Array.isArray(list) ? list.filter((s): s is string => typeof s === "string") : [];
}

function norm(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** True when the agent has one of the role's skills or carries the role's name or title. */
export function matchesRole(agent: Record<string, unknown>, role: HireRole): boolean {
  const skills = desiredSkills(agent).map((s) => s.toLowerCase());
  const hasSkill = role.skills.some((s) =>
    skills.some((k) => k === s.key.toLowerCase() || k === s.slug.toLowerCase() || k.endsWith(`/${s.slug.toLowerCase()}`) || k.endsWith(`/${s.key.split("/").pop()!.toLowerCase()}`)),
  );
  if (hasSkill) return true;
  const wanted = [norm(role.displayName), norm(role.title)].filter(Boolean);
  const got = [norm(String(agent.name ?? "")), norm(typeof agent.title === "string" ? agent.title : "")];
  return got.some((g) => g && wanted.some((w) => g === w || g.includes(w)));
}

/** Agents created after the hire task that match the role. */
export async function hireCandidates(ctx: PluginContext, companyId: string, role: HireRole, since: string): Promise<HireAgentSummary[]> {
  const sinceMs = Date.parse(since) - 60_000;
  const agents = (await ctx.agents.list({ companyId, limit: 200 })) as unknown as Array<Record<string, unknown>>;
  return agents
    .filter((a) => !INACTIVE.has(String(a.status)))
    .filter((a) => {
      const created = a.createdAt instanceof Date ? a.createdAt.getTime() : Date.parse(String(a.createdAt ?? ""));
      return Number.isFinite(created) && created >= sinceMs;
    })
    .filter((a) => matchesRole(a, role))
    .map(summarize);
}

async function agentIfUsable(ctx: PluginContext, companyId: string, agentId: string | null): Promise<HireAgentSummary | null> {
  if (!agentId) return null;
  try {
    const agent = await ctx.agents.get(agentId, companyId);
    if (!agent || INACTIVE.has(String(agent.status))) return null;
    return summarize(agent as unknown as Record<string, unknown>);
  } catch {
    return null;
  }
}

/** The linked agent id (or a legacy host-managed one), or null. Cheap enough for jobs. */
export async function linkedAgentId(ctx: PluginContext, companyId: string, role: HireRole, legacy?: LegacyAgentLookup): Promise<string | null> {
  const state = await readHireState(ctx, companyId, role.roleKey);
  const linked = await agentIfUsable(ctx, companyId, state.agentId);
  if (linked) return linked.id;
  if (legacy) {
    try {
      const id = await legacy(companyId);
      if (id && (await agentIfUsable(ctx, companyId, id))) return id;
    } catch {
      // no legacy agent
    }
  }
  return null;
}

async function comment(ctx: PluginContext, companyId: string, issueId: string, body: string): Promise<void> {
  try {
    await ctx.issues.createComment(issueId, body, companyId);
  } catch (error) {
    ctx.logger.info("Hire comment skipped", { issueId, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Opens the hire task and remembers it. The assignee is woken when it is an agent. */
export async function startHire(
  ctx: PluginContext,
  companyId: string,
  role: HireRole,
  input: { title?: string; description?: string; assigneeAgentId?: string | null; assigneeUserId?: string | null; actorUserId: string | null },
): Promise<HireRecord> {
  const draft = hireTaskDraft(role);
  const title = input.title?.trim() || draft.title;
  const description = input.description?.trim() || draft.description;
  const assigneeAgentId = input.assigneeAgentId || null;
  const assigneeUserId = assigneeAgentId ? null : input.assigneeUserId || null;
  const issue = await ctx.issues.create({
    companyId,
    title,
    description,
    status: assigneeAgentId || assigneeUserId ? "todo" : "backlog",
    priority: "medium",
    ...(assigneeAgentId ? { assigneeAgentId } : {}),
    ...(assigneeUserId ? { assigneeUserId } : {}),
    originKind: `plugin:${role.pluginKey}` as Parameters<PluginContext["issues"]["create"]>[0]["originKind"],
    originId: `hire:${role.roleKey}`,
    ...(input.actorUserId ? { actor: { actorUserId: input.actorUserId } } : {}),
  });
  if (assigneeAgentId) {
    try {
      await ctx.issues.requestWakeup(issue.id, companyId, { reason: `New hire request from the ${role.pluginName} plugin`, idempotencyKey: `wake:${issue.id}` });
    } catch (error) {
      ctx.logger.info("Hire wakeup skipped", { issueId: issue.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const record: HireRecord = {
    issueId: issue.id,
    identifier: (issue as { identifier?: string | null }).identifier ?? null,
    title,
    assigneeAgentId,
    assigneeUserId,
    createdAt: new Date().toISOString(),
    status: "open",
  };
  const state = await readHireState(ctx, companyId, role.roleKey);
  await writeHireState(ctx, companyId, role.roleKey, { ...state, hire: record });
  return record;
}

/** Links an agent (auto or by hand), wires it, and reports on the hire task. */
export async function linkAgent(
  ctx: PluginContext,
  companyId: string,
  role: HireRole,
  agentId: string,
  options: { by: "auto" | "manual" | "managed"; userId: string | null; onLinked: OnAgentLinked },
): Promise<{ agent: HireAgentSummary; steps: string[] }> {
  const agent = await agentIfUsable(ctx, companyId, agentId);
  if (!agent) throw new Error("That agent was not found in this company, or it has been terminated.");
  const state = await readHireState(ctx, companyId, role.roleKey);
  const hire = state.hire && state.hire.status === "open" ? { ...state.hire, status: "linked" as const } : state.hire;
  await writeHireState(ctx, companyId, role.roleKey, { agentId: agent.id, linkedAt: new Date().toISOString(), linkedBy: options.by, hire });
  let steps: string[] = [];
  try {
    steps = await options.onLinked(companyId, agent.id, { userId: options.userId });
  } catch (error) {
    steps = [`Setup did not finish: ${error instanceof Error ? error.message : String(error)}. Open the ${role.pluginName} page and click Link agent again.`];
  }
  if (state.hire?.status === "open") {
    const how = options.by === "auto" ? "found" : "was given";
    await comment(
      ctx,
      companyId,
      state.hire.issueId,
      [`The ${role.pluginName} plugin ${how} **${agent.name}** as its agent.`, "", ...steps.map((s) => `- ${s}`), "", agent.status === "paused" || agent.status === "pending_approval"
        ? "Next: check its adapter has a working model key, then resume it."
        : "The agent is active."].join("\n"),
    );
  }
  return { agent, steps };
}

/**
 * Links the hire when exactly one new agent matches. Safe to call often:
 * from agent events, the plugin page load and hourly jobs.
 */
const inFlight = new Map<string, Promise<HireAgentSummary | null>>();

export async function tryLinkPendingHire(
  ctx: PluginContext,
  companyId: string,
  role: HireRole,
  onLinked: OnAgentLinked,
): Promise<HireAgentSummary | null> {
  // Agent events often arrive in bursts (created, then updated). One check per
  // company and role at a time, so a hire is linked and announced once.
  const key = `${companyId}:${role.pluginKey}:${role.roleKey}`;
  const running = inFlight.get(key);
  if (running) return running;
  const attempt = linkPendingHireOnce(ctx, companyId, role, onLinked).finally(() => inFlight.delete(key));
  inFlight.set(key, attempt);
  return attempt;
}

async function linkPendingHireOnce(
  ctx: PluginContext,
  companyId: string,
  role: HireRole,
  onLinked: OnAgentLinked,
): Promise<HireAgentSummary | null> {
  const state = await readHireState(ctx, companyId, role.roleKey);
  if (!state.hire || state.hire.status !== "open") return null;
  if (await agentIfUsable(ctx, companyId, state.agentId)) return null;
  const candidates = await hireCandidates(ctx, companyId, role, state.hire.createdAt);
  if (candidates.length !== 1) return null;
  const { agent } = await linkAgent(ctx, companyId, role, candidates[0]!.id, { by: "auto", userId: null, onLinked });
  return agent;
}

/** Status for the plugin page: linked agent, open hire task, and ambiguous candidates. */
export async function hireStatus(ctx: PluginContext, companyId: string, role: HireRole, legacy?: LegacyAgentLookup): Promise<HireStatus> {
  const state = await readHireState(ctx, companyId, role.roleKey);
  let agent = await agentIfUsable(ctx, companyId, state.agentId);
  let linkedBy = agent ? state.linkedBy : null;
  if (!agent && legacy) {
    try {
      agent = await agentIfUsable(ctx, companyId, await legacy(companyId));
      if (agent) linkedBy = "managed";
    } catch {
      agent = null;
    }
  }
  const candidates = !agent && state.hire?.status === "open" ? await hireCandidates(ctx, companyId, role, state.hire.createdAt) : [];
  return { agent, linkedBy, hire: state.hire, candidates };
}

/** Forgets the linked agent (the agent itself is untouched). */
export async function unlinkAgent(ctx: PluginContext, companyId: string, role: HireRole): Promise<void> {
  const state = await readHireState(ctx, companyId, role.roleKey);
  await writeHireState(ctx, companyId, role.roleKey, { ...state, agentId: null, linkedAt: null, linkedBy: null });
}

const AGENT_EVENTS = ["agent.created", "agent.updated", "agent.status_changed", "approval.decided"] as const;

/**
 * Watches agent events and links pending hires. Delivery is at-most-once, so
 * callers also run `tryLinkPendingHire` from their page load and hourly job.
 */
export function registerHireWatch(ctx: PluginContext, roles: Array<{ role: HireRole; onLinked: OnAgentLinked }>): void {
  for (const name of AGENT_EVENTS) {
    ctx.events.on(name, async (event: PluginEvent) => {
      if (!event.companyId) return;
      for (const { role, onLinked } of roles) {
        try {
          await tryLinkPendingHire(ctx, event.companyId, role, onLinked);
        } catch (error) {
          ctx.logger.info("Hire link check failed", { roleKey: role.roleKey, error: error instanceof Error ? error.message : String(error) });
        }
      }
    });
  }
}
