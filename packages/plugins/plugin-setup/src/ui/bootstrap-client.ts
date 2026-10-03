/**
 * Wires the New company runner (`bootstrap-runner.ts`) to the host: the board
 * session's fetch calls (settings, other plugins' actions, the agent list) and
 * Setup's own worker actions (state, template hire tasks, starter pack).
 */
import type { OwnerGrant, StepId, StepItem, StepStatus } from "../bootstrap.js";
import type { RunnerEnv, RunnerPlugin, StarterState } from "../bootstrap-runner.js";
import { runMemorySetup } from "./memory-client.js";
import { fetchPluginConfig, runPluginAction, savePluginConfig, type PluginRecordLite } from "./api.js";
import { fetchCompanyAgentsRaw, fetchHireOptions, loadTeam, startHire } from "./team-client.js";
import type { BootstrapOptions } from "../bootstrap.js";
import type { ModuleKey, SetupStatus } from "../kit-setup.js";
import { moduleOfPlugin } from "../kit-setup.js";
import type { HiringPick } from "../hiring.js";
import type { TemplateHireLike } from "../templates.js";

/** The page's `usePluginAction` handles for Setup's own actions, as plain async functions. */
export interface SetupActions {
  record(params: Record<string, unknown>): Promise<unknown>;
  startTemplateHire(params: Record<string, unknown>): Promise<unknown>;
  templateDraft(params: Record<string, unknown>): Promise<unknown>;
  starterPackImport(): Promise<unknown>;
}

export interface EnvInput {
  companyId: string;
  company: { id: string; name: string; prefix: string | null };
  me: string | null;
  ownerName: string | null;
  modules: Record<ModuleKey, boolean>;
  /** The plugin list, or null when it could not be read: the run then fails the steps that need it instead of treating the company as having no plugins. */
  installed: Record<string, PluginRecordLite> | null;
  options: BootstrapOptions;
  requireApproval: boolean | null;
  statuses: Record<string, SetupStatus | null | undefined>;
  starter: StarterState;
  hires: TemplateHireLike[];
  actions: SetupActions;
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * What the page tells the worker about the CEO and the agents, so a draft can name a manager and link the CEO.
 * Only the fields matching needs: an agent record also carries its adapter settings (env bindings), which never travel in an action body.
 */
export function agentContext(raw: unknown[] | null, hiring: HiringPick | null) {
  return {
    agents: (raw ?? []).slice(0, 200).map((entry) => {
      const row = rec(entry);
      return { id: row.id, name: row.name, title: row.title, role: row.role, status: row.status, reportsTo: row.reportsTo, urlKey: row.urlKey };
    }),
    ceo: hiring?.agent ? { name: hiring.agent.name, urlKey: (raw ?? []).map(rec).find((row) => row.id === hiring.agent!.id)?.urlKey ?? null } : null,
  };
}

export function buildRunnerEnv(input: EnvInput): RunnerEnv {
  // Null stays null: an unreadable plugin list is not an empty one.
  let plugins: Record<string, RunnerPlugin> | null = null;
  if (input.installed) {
    plugins = {};
    for (const plugin of Object.values(input.installed)) {
      const module = moduleOfPlugin(plugin.pluginKey);
      if (module) plugins[plugin.pluginKey] = { pluginKey: plugin.pluginKey, id: plugin.id, status: plugin.status, schema: plugin.schema, module };
    }
  }
  const { companyId, actions } = input;
  let rawAgents: Promise<unknown[] | null> | null = null;
  return {
    companyId,
    company: input.company,
    me: input.me,
    ownerName: input.ownerName,
    modules: input.modules,
    installed: plugins,
    options: input.options,
    requireApproval: input.requireApproval,
    statuses: input.statuses,
    starter: input.starter,
    hires: input.hires,
    getConfig: (pluginIdOrKey, company) => fetchPluginConfig(pluginIdOrKey, company),
    saveConfig: (pluginIdOrKey, company, config) => savePluginConfig(pluginIdOrKey, company, config),
    runAction: (pluginKey, actionKey, params = {}) => runPluginAction(pluginKey, actionKey, companyId, params),
    // One read per run: the steps look at the same agents.
    fetchAgents: () => (rawAgents ??= fetchCompanyAgentsRaw(companyId)),
    loadTeam: async (roles) => (await loadTeam({ companyId, roles, installed: input.installed })).states,
    hireOptions: (role) => fetchHireOptions(companyId, role),
    startRoleHire: (role, task) => startHire(companyId, role, task),
    templateDraft: async (key, hiring) => {
      const context = agentContext(await (rawAgents ??= fetchCompanyAgentsRaw(companyId)), hiring);
      const draft = rec(await actions.templateDraft({ key, ownerName: input.ownerName, ...context }));
      return { title: String(draft.title ?? ""), description: String(draft.description ?? "") };
    },
    startTemplateHire: async (key, assignee, hiring) => {
      const context = agentContext(await (rawAgents ??= fetchCompanyAgentsRaw(companyId)), hiring);
      const result = rec(await actions.startTemplateHire({ key, ownerName: input.ownerName, ...assignee, ...context }));
      const staffed = rec(result.staffed);
      return { identifier: typeof result.identifier === "string" ? result.identifier : null, existed: result.existed === true, staffed: typeof staffed.name === "string" ? staffed.name : null, woke: result.woke === true };
    },
    setupWiki: () => runMemorySetup(companyId, {}),
    starterPackImport: async () => {
      const result = rec(await actions.starterPackImport());
      return { data: result.data };
    },
    record: async (stepId: StepId, status: StepStatus, detail: string, extra?: { items?: StepItem[]; grants?: OwnerGrant[]; starterImport?: unknown }) => {
      await actions.record({ stepId, status, detail, items: extra?.items, grants: extra?.grants, starterImport: extra?.starterImport });
    },
  };
}
