import type { AgentPublicIdentity } from "@paperclipai/shared";
import type { AgentProjectAccess } from "@paperclipai/shared";
import type {
  Agent,
  EnvironmentProbeResult,
  ConnectionIntentInteraction,
  AgentDesiredSkillEntry,
  AgentSkillAssignmentMode,
  AgentPermissions,
  AgentDetail,
  AgentInstructionsBundle,
  AgentInstructionHistory,
  AgentInstructionCandidate,
  ResolveAgentInstructionCandidate,
  AgentInstructionDiff,
  AgentInstructionSnapshot,
  AgentInstructionsFileDetail,
  AgentSkillSnapshot,
  AdapterEnvironmentTestResult,
  AdapterAuthSignalResponse,
  AdapterAuthSessionResponse,
  AdapterAuthSessionOwnerResponse,
  ClaudeSetupTokenSessionResponse,
  ClaudeSetupTokenSessionOwnerResponse,
  ClaudeSetupTokenSessionPrompt,
  ClaudeSetupTokenCompletionResponse,
  ClaudeSetupTokenOverwrite,
  ClaudeOAuthTokenStatusResponse,
  SubmitBrowserCodeRequest,
  AgentKeyCreated,
  AgentRuntimeState,
  AgentTaskSession,
  AgentWakeupResponse,
  ChatFailedRunRetryResponse,
  HeartbeatRun,
  Approval,
  AgentConfigRevision,
  ClearAgentErrorResponse,
  AgentApiKeyScope,
} from "@paperclipai/shared";
import { deriveAgentUrlKey, isUuidLike, normalizeAgentUrlKey } from "@paperclipai/shared";
import { ApiError, api, type RequestOptions } from "./client";

export interface AgentKey {
  id: string;
  name: string;
  scope: AgentApiKeyScope;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface AdapterModel {
  id: string;
  label: string;
}

export interface DetectedAdapterModel {
  model: string;
  provider: string;
  source: string;
  candidates?: string[];
}

export interface ClaudeLoginResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  loginUrl: string | null;
  stdout: string;
  stderr: string;
}

export interface OrgNode {
  id: string;
  name: string;
  role: string;
  status: string;
  reports: OrgNode[];
}

export interface AgentHireResponse {
  agent: Agent;
  approval: Approval | null;
}

export interface AgentPermissionUpdate {
  canCreateAgents: boolean;
  canCreateSkills: boolean;
  canAssignTasks: boolean;
  trustPreset?: AgentPermissions["trustPreset"];
  authorizationPolicy?: AgentPermissions["authorizationPolicy"];
}

export interface AgentWakeRequest {
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  forceFreshSession?: boolean;
  debug?: { providerTrace: "raw" };
}

/** The adapter type a reduced agent gets. No adapter registers it, so every adapter lookup finds nothing. */
export const REDUCED_AGENT_ADAPTER_TYPE = "paperclip_reduced_agent_view";

/** Marks an agent the server sent in its reduced view (`restrictedAgentView`, PAR-13469 decision B). */
export interface ReducedAgentMarker {
  reducedView: true;
}

/** The six fields a restricted member gets for an agent under `enforce` (AC-G4). */
export type ReducedAgentBody = Pick<Agent, "id" | "companyId" | "name" | "title" | "icon" | "status">;

export function isReducedAgent<T extends Agent>(agent: T): agent is T & ReducedAgentMarker {
  return (agent as Partial<ReducedAgentMarker>).reducedView === true;
}

const EMPTY_AGENT_ACCESS: AgentDetail["access"] = { canAssignTasks: false, taskAssignSource: "none", membership: null, grants: [] };

/**
 * Completes an agent body at the API boundary (PAR-13474). It decides by the
 * body's shape (no `adapterType` key), never by the session, so a stale
 * session's reduced body is completed too. A full body comes back untouched.
 * A reduced body gets every other field empty (`null`, `0`, `[]`, `{}`), so no
 * screen reads `undefined` where the type promises a value. Left out are only
 * the optional fields whose type has no empty value: `avatarUrl`,
 * `lifecycleState` and `orgChainHealth`.
 */
export function completeAgentBody(body: Agent | ReducedAgentBody): Agent;
export function completeAgentBody(body: AgentDetail | ReducedAgentBody, kind: "detail"): AgentDetail;
export function completeAgentBody(body: Agent | AgentDetail | ReducedAgentBody, kind?: "detail"): Agent | AgentDetail {
  if ("adapterType" in body) return body;
  const agent: Agent & ReducedAgentMarker = {
    id: body.id,
    companyId: body.companyId,
    name: body.name,
    urlKey: deriveAgentUrlKey(body.name, body.id),
    role: "general",
    title: body.title ?? null,
    icon: body.icon ?? null,
    appearance: null,
    status: body.status,
    lifecycleVersion: 0,
    lifecycleError: null,
    lifecycleStatusDetail: null,
    reportsTo: null,
    capabilities: null,
    adapterType: REDUCED_AGENT_ADAPTER_TYPE,
    adapterConfig: {},
    configurationWarnings: [],
    runtimeConfig: {},
    defaultEnvironmentId: null,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    errorReason: null,
    // `{}` does not satisfy `AgentPermissions`; `canCreateAgents` is its one required key.
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdByUserId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    reducedView: true,
  };
  return kind === "detail" ? { ...agent, chainOfCommand: [], access: EMPTY_AGENT_ACCESS } : agent;
}

function withCompanyScope(path: string, companyId?: string) {
  if (!companyId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}companyId=${encodeURIComponent(companyId)}`;
}

function agentPath(id: string, companyId?: string, suffix = "") {
  return withCompanyScope(`/agents/${encodeURIComponent(id)}${suffix}`, companyId);
}

export const agentsApi = {
  projectAccess: (id: string) => api.get<AgentProjectAccess>(`/agents/${id}/project-access`),
  addProjectAccess: (id: string, projectIds: string[]) => api.post<AgentProjectAccess>(`/agents/${id}/project-access`, { projectIds }),
  qualifyRunner: (id: string, expectedEnvironmentId: string, companyId?: string) =>
    api.post<EnvironmentProbeResult>(agentPath(id, companyId, "/qualify-runner"), { expectedEnvironmentId }),
  setAvatar: (companyId: string, agentId: string, imageBase64: string | null) =>
    api.put<{ agentId: string; appearance: import("@paperclipai/shared").AgentAppearance; avatarUrl: string }>(`/companies/${companyId}/agents/${agentId}/avatar`, { imageBase64 }),
  getIdentity: (id: string, companyId?: string) =>
    api.get<AgentPublicIdentity | null>(agentPath(id, companyId, "/identity")),
  adoptAiConnection: (agentId: string, interactionId: string, connectionId: string, companyId: string) =>
    api.post<ConnectionIntentInteraction>(withCompanyScope(`/agents/${agentId}/connection-intents/${interactionId}/adopt`, companyId), { connectionId }),

  list: async (companyId: string) =>
    (await api.get<Array<Agent | ReducedAgentBody>>(`/companies/${companyId}/agents`)).map((body) => completeAgentBody(body)),
  org: (companyId: string) => api.get<OrgNode[]>(`/companies/${companyId}/org`),
  listConfigurations: (companyId: string) =>
    api.get<Record<string, unknown>[]>(`/companies/${companyId}/agent-configurations`),
  get: async (id: string, companyId?: string, options?: RequestOptions) => {
    try {
      return completeAgentBody(await api.get<AgentDetail | ReducedAgentBody>(agentPath(id, companyId), options), "detail");
    } catch (error) {
      // Backward-compat fallback: if backend shortname lookup reports ambiguity,
      // resolve using company agent list while ignoring terminated agents.
      if (
        !(error instanceof ApiError) ||
        error.status !== 409 ||
        !companyId ||
        isUuidLike(id)
      ) {
        throw error;
      }

      const urlKey = normalizeAgentUrlKey(id);
      if (!urlKey) throw error;

      // Completed before the filter: a reduced body has no `urlKey` of its own.
      const agents = (await api.get<Array<Agent | ReducedAgentBody>>(`/companies/${companyId}/agents`, options))
        .map((body) => completeAgentBody(body));
      const matches = agents.filter(
        (agent) => agent.status !== "terminated" && normalizeAgentUrlKey(agent.urlKey) === urlKey,
      );
      if (matches.length !== 1) throw error;
      return completeAgentBody(await api.get<AgentDetail | ReducedAgentBody>(agentPath(matches[0]!.id, companyId), options), "detail");
    }
  },
  getConfiguration: (id: string, companyId?: string) =>
    api.get<import("@paperclipai/shared").AgentConfigurationResponse>(agentPath(id, companyId, "/configuration")),
  listConfigRevisions: (id: string, companyId?: string) =>
    api.get<AgentConfigRevision[]>(agentPath(id, companyId, "/config-revisions")),
  getConfigRevision: (id: string, revisionId: string, companyId?: string) =>
    api.get<AgentConfigRevision>(agentPath(id, companyId, `/config-revisions/${revisionId}`)),
  rollbackConfigRevision: (id: string, revisionId: string, companyId?: string) =>
    api.post<Agent>(agentPath(id, companyId, `/config-revisions/${revisionId}/rollback`), {}),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Agent>(`/companies/${companyId}/agents`, data),
  hire: (companyId: string, data: Record<string, unknown>) =>
    api.post<AgentHireResponse>(`/companies/${companyId}/agent-hires`, data),
  updateRuntimeSettings: (id: string, runtimeSettings: import("@paperclipai/shared").AgentRuntimeSettingsPatch, companyId: string) =>
    api.patch<Agent>(agentPath(id, companyId), { runtimeSettings }),
  update: (id: string, data: Record<string, unknown>, companyId?: string) =>
    api.patch<Agent & import("@paperclipai/shared").AgentConfigurationResponse>(agentPath(id, companyId), data),
  updatePermissions: (id: string, data: AgentPermissionUpdate, companyId?: string) =>
    api.patch<AgentDetail>(agentPath(id, companyId, "/permissions"), data),
  instructionsBundle: (id: string, companyId?: string) =>
    api.get<AgentInstructionsBundle>(agentPath(id, companyId, "/instructions-bundle")),
  updateInstructionsBundle: (
    id: string,
    data: {
      mode?: "managed" | "external";
      rootPath?: string | null;
      entryFile?: string;
      clearLegacyPromptTemplate?: boolean;
      requireExistingEntry?: boolean;
    },
    companyId?: string,
  ) => api.patch<AgentInstructionsBundle>(agentPath(id, companyId, "/instructions-bundle"), data),
  instructionsFile: (id: string, relativePath: string, companyId?: string) =>
    api.get<AgentInstructionsFileDetail>(
      agentPath(id, companyId, `/instructions-bundle/file?path=${encodeURIComponent(relativePath)}`),
    ),
  saveInstructionsFile: (
    id: string,
    data: { path: string; content: string; baseRevisionId?: string | null; baseHash?: string | null; clearLegacyPromptTemplate?: boolean },
    companyId?: string,
  ) => api.put<AgentInstructionsFileDetail>(agentPath(id, companyId, "/instructions-bundle/file"), data),
  instructionCandidates: (id: string, companyId?: string) =>
    api.get<AgentInstructionCandidate[]>(agentPath(id, companyId, "/instructions-bundle/candidates")),
  resolveInstructionCandidate: (id: string, runId: string, data: ResolveAgentInstructionCandidate, companyId?: string) =>
    api.post<AgentInstructionsFileDetail>(agentPath(id, companyId, `/instructions-bundle/candidates/${runId}/resolve`), data),
  instructionHistory: (id: string, path: string, companyId?: string, cursor?: string) =>
    api.get<AgentInstructionHistory>(agentPath(id, companyId, `/instructions-bundle/history?path=${encodeURIComponent(path)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)),
  instructionRevision: (id: string, path: string, revisionId: string, companyId?: string) =>
    api.get<AgentInstructionSnapshot>(agentPath(id, companyId, `/instructions-bundle/revision/${revisionId}?path=${encodeURIComponent(path)}`)),
  instructionDiff: (id: string, path: string, from: string, to: string, companyId?: string) =>
    api.get<AgentInstructionDiff>(agentPath(id, companyId, `/instructions-bundle/diff?path=${encodeURIComponent(path)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)),
  restoreInstructions: (id: string, data: { path: string; revisionId: string; baseRevisionId: string }, companyId?: string) =>
    api.post<AgentInstructionsFileDetail>(agentPath(id, companyId, "/instructions-bundle/restore"), data),
  downloadInstructionsFile: (id: string, relativePath: string, companyId?: string) =>
    `/api${agentPath(id, companyId, `/instructions-bundle/file?path=${encodeURIComponent(relativePath)}&download=true`)}`,
  deleteInstructionsFile: (id: string, relativePath: string, companyId?: string, baseHash?: string) =>
    api.delete<AgentInstructionsBundle>(
      agentPath(id, companyId, `/instructions-bundle/file?path=${encodeURIComponent(relativePath)}${baseHash ? `&baseHash=${baseHash}` : ""}`),
    ),
  retryLifecycle: (id: string, companyId?: string) => api.post<Agent>(agentPath(id, companyId, "/lifecycle/retry"), {}),
  pause: (id: string, companyId?: string) => api.post<Agent>(agentPath(id, companyId, "/pause"), {}),
  resume: (id: string, companyId?: string) => api.post<Agent>(agentPath(id, companyId, "/resume"), {}),
  clearError: (id: string, companyId?: string) =>
    api.post<ClearAgentErrorResponse>(agentPath(id, companyId, "/clear-error"), {}),
  approve: (id: string, companyId?: string) => api.post<Agent>(agentPath(id, companyId, "/approve"), {}),
  terminate: (id: string, companyId?: string) => api.post<Agent>(agentPath(id, companyId, "/terminate"), {}),
  remove: (id: string, companyId?: string) => api.delete<{ ok: true }>(agentPath(id, companyId)),
  listKeys: (id: string, companyId?: string) => api.get<AgentKey[]>(agentPath(id, companyId, "/keys")),
  skills: (id: string, companyId?: string) =>
    api.get<AgentSkillSnapshot>(agentPath(id, companyId, "/skills")),
  syncSkills: (
    id: string,
    desiredSkills: Array<string | AgentDesiredSkillEntry>,
    mode: AgentSkillAssignmentMode,
    companyId?: string,
  ) => api.post<AgentSkillSnapshot>(agentPath(id, companyId, "/skills/sync"), { desiredSkills, mode }),
  createKey: (id: string, name: string, companyId?: string, scope?: AgentApiKeyScope) =>
    api.post<AgentKeyCreated>(agentPath(id, companyId, "/keys"), { name, ...(scope ? { scope } : {}) }),
  revokeKey: (agentId: string, keyId: string, companyId?: string) =>
    api.delete<{ ok: true }>(agentPath(agentId, companyId, `/keys/${encodeURIComponent(keyId)}`)),
  runtimeState: (id: string, companyId?: string) =>
    api.get<AgentRuntimeState>(agentPath(id, companyId, "/runtime-state")),
  taskSessions: (id: string, companyId?: string) =>
    api.get<AgentTaskSession[]>(agentPath(id, companyId, "/task-sessions")),
  resetSession: (id: string, taskKey?: string | null, companyId?: string) =>
    api.post<void>(agentPath(id, companyId, "/runtime-state/reset-session"), { taskKey: taskKey ?? null }),
  adapterModels: (
    companyId: string,
    type: string,
    options?: { refresh?: boolean; environmentId?: string | null; provider?: string; acpxAgent?: string; aiConnection?: import("@paperclipai/shared").AiConnectionBinding; agentId?: string; poolId?: string },
  ) => {
    const params = new URLSearchParams();
    if (options?.refresh) params.set("refresh", "1");
    if (options?.provider) params.set("provider", options.provider);
    if (options?.acpxAgent) params.set("acpxAgent", options.acpxAgent);
    if (options?.aiConnection) params.set("aiConnection", JSON.stringify(options.aiConnection));
    if (options?.agentId) params.set("agentId", options.agentId);
    if (options?.poolId) params.set("poolId", options.poolId);
    if (options?.environmentId) params.set("environmentId", options.environmentId);
    const query = params.size > 0 ? `?${params.toString()}` : "";
    return api.get<AdapterModel[]>(
      `/companies/${encodeURIComponent(companyId)}/adapters/${encodeURIComponent(type)}/models${query}`,
    );
  },
  detectModel: (companyId: string, type: string) =>
    api.get<DetectedAdapterModel | null>(
      `/companies/${encodeURIComponent(companyId)}/adapters/${encodeURIComponent(type)}/detect-model`,
    ),
  testEnvironment: (
    companyId: string,
    type: string,
    data: {
      adapterConfig: Record<string, unknown>;
      runner?: import("@paperclipai/shared").AgentRunnerChoice;
      aiConnection?: import("@paperclipai/shared").AiRuntimeConnectionBinding;
      agentId?: string;
      testCredentials?: Record<string, string>;
      environmentId?: string | null;
    },
    options?: RequestOptions,
  ) =>
    api.post<AdapterEnvironmentTestResult>(
      `/companies/${companyId}/adapters/${type}/test-environment`,
      data,
      options,
    ),
  getAdapterAuthSignal: (companyId: string, type: string, environmentId?: string | null) => {
    const query = environmentId ? `?environmentId=${encodeURIComponent(environmentId)}` : "";
    return api.get<AdapterAuthSignalResponse>(
      `/companies/${encodeURIComponent(companyId)}/adapters/${encodeURIComponent(type)}/auth-signal${query}`,
    );
  },
  invoke: (id: string, companyId?: string, data: AgentWakeRequest = {}) =>
    api.post<HeartbeatRun>(agentPath(id, companyId, "/heartbeat/invoke"), data),
  wakeup: (
    id: string,
    data: AgentWakeRequest,
    companyId?: string,
  ) => api.post<AgentWakeupResponse>(agentPath(id, companyId, "/wakeup"), data),
  retryFailedRun: async (
    id: string,
    failedRunId: string,
    companyId: string,
  ) => {
    const result = await api.post<
      AgentWakeupResponse | ChatFailedRunRetryResponse
    >(agentPath(id, companyId, "/wakeup"), {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "retry_failed_run",
      failedRunId,
    });
    if ("id" in result) {
      // Exact retries are idempotent: a repeated click can return a successor
      // that has already stopped. It does not mean a new attempt was queued.
      if (["failed", "timed_out", "cancelled", "interrupted"].includes(result.status)) {
        throw new Error(
          "The previous retry has already stopped. Refresh the task and retry its latest failed run.",
        );
      }
      return { runId: result.id, issueId: null };
    }
    if ("actionId" in result) {
      if (result.status === "failed" || result.status === "cancelled") {
        throw new Error(
          "This retry could not start. Open the task to review its current access and recovery state.",
        );
      }
      return { runId: result.runId, issueId: result.issueId };
    }
    throw new Error(result.message ?? "Retry was skipped.");
  },
  loginWithClaude: (id: string, companyId?: string) =>
    api.post<ClaudeLoginResult>(agentPath(id, companyId, "/claude-login"), {}),
  startAdapterAuthLogin: (
    companyId: string,
    type: string,
    data: { environmentId: string; ttlSeconds?: number; aiConnection?: import("@paperclipai/shared").AiConnectionLoginIntent },
  ) =>
    api.post<AdapterAuthSessionResponse>(
      `/companies/${encodeURIComponent(companyId)}/adapters/${encodeURIComponent(type)}/login-sessions`,
      data,
    ),
  // The owner response repeats the live prompt on every read while the
  // session holds an active public status, so this polling call carries the
  // same no-store request option as the active-session read below.
  getAdapterAuthLoginStatus: (companyId: string, type: string, sessionId: string, options?: { signal?: AbortSignal }) =>
    api.get<AdapterAuthSessionOwnerResponse>(
      `/companies/${encodeURIComponent(companyId)}/adapters/${encodeURIComponent(type)}/login-sessions/${encodeURIComponent(sessionId)}`,
      { cache: "no-store", ...options },
    ),
  // Reads the caller's active login session for one company and adapter, with
  // no session id, so the browser rediscovers its own session after a reload
  // with no local state. A 404 means no active session for the caller.
  getActiveAdapterAuthLoginSession: (companyId: string, type: string, options?: { signal?: AbortSignal; fresh?: boolean }) =>
    api.get<AdapterAuthSessionOwnerResponse>(
      `/companies/${encodeURIComponent(companyId)}/adapters/${encodeURIComponent(type)}/login-sessions/active`,
      { cache: "no-store", ...options },
    ),
  cancelAdapterAuthLogin: (companyId: string, type: string, sessionId: string) =>
    api.post<AdapterAuthSessionOwnerResponse>(
      `/companies/${encodeURIComponent(companyId)}/adapters/${encodeURIComponent(type)}/login-sessions/${encodeURIComponent(sessionId)}/cancel`,
      {},
    ),
  // The Claude submitted-browser-code login uses the company-and-environment
  // setup-token routes. The route fixes the `claude_local` adapter. The start
  // response carries the panel mode; the authorization URL rides only through the
  // guarded prompt read. The completion response carries a non-secret
  // `storedSessionId` claim and no token.
  // Reads the stored Claude OAuth token status for the authenticated owner. A
  // 200 carries only the secret id and the latest version; a 404 means the owner
  // has no stored value (indistinguishable from a foreign value). The client
  // applies the stored token first and captures the version for a later
  // version-checked overwrite.
  getClaudeOAuthTokenStatus: (companyId: string) =>
    api.get<ClaudeOAuthTokenStatusResponse>(
      `/companies/${encodeURIComponent(companyId)}/claude-oauth-token-status`,
    ),
  startClaudeSetupTokenLogin: (
    companyId: string,
    data: { environmentId: string; overwrite?: ClaudeSetupTokenOverwrite; aiConnection?: import("@paperclipai/shared").AiConnectionLoginIntent },
  ) =>
    api.post<ClaudeSetupTokenSessionOwnerResponse>(
      `/companies/${encodeURIComponent(companyId)}/setup-token-login-sessions`,
      { adapterType: "claude_local", ...data },
    ),
  getClaudeSetupTokenLoginStatus: (companyId: string, sessionId: string, options?: { signal?: AbortSignal }) =>
    api.get<ClaudeSetupTokenSessionResponse>(
      `/companies/${encodeURIComponent(companyId)}/setup-token-login-sessions/${encodeURIComponent(sessionId)}`,
      options,
    ),
  // Reads the caller's active Claude setup-token login session, with no
  // session id, so the browser rediscovers its own session after a reload with
  // no local state. A 404 means no active session for the caller.
  getActiveClaudeSetupTokenLoginSession: (companyId: string, options?: { signal?: AbortSignal; fresh?: boolean }) =>
    api.get<ClaudeSetupTokenSessionOwnerResponse>(
      `/companies/${encodeURIComponent(companyId)}/setup-token-login-sessions/active`,
      { cache: "no-store", ...options },
    ),
  getClaudeSetupTokenLoginPrompt: (companyId: string, sessionId: string, options?: { signal?: AbortSignal }) =>
    api.get<ClaudeSetupTokenSessionPrompt>(
      `/companies/${encodeURIComponent(companyId)}/setup-token-login-sessions/${encodeURIComponent(sessionId)}/prompt`,
      options,
    ),
  submitClaudeSetupTokenBrowserCode: (companyId: string, sessionId: string, browserCode: string) =>
    api.post<ClaudeSetupTokenSessionResponse>(
      `/companies/${encodeURIComponent(companyId)}/setup-token-login-sessions/${encodeURIComponent(sessionId)}/code`,
      { browserCode } satisfies SubmitBrowserCodeRequest,
    ),
  completeClaudeSetupTokenLogin: (companyId: string, sessionId: string) =>
    api.post<ClaudeSetupTokenCompletionResponse>(
      `/companies/${encodeURIComponent(companyId)}/setup-token-login-sessions/${encodeURIComponent(sessionId)}/completion`,
      {},
    ),
  cancelClaudeSetupTokenLogin: (companyId: string, sessionId: string) =>
    api.post<void>(
      `/companies/${encodeURIComponent(companyId)}/setup-token-login-sessions/${encodeURIComponent(sessionId)}/cancel`,
      {},
    ),
  availableSkills: () =>
    api.get<{ skills: AvailableSkill[] }>("/skills/available"),
};

export interface AvailableSkill {
  name: string;
  description: string;
  isPaperclipManaged: boolean;
}
