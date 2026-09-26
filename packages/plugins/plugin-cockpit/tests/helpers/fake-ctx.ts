import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "../../src/namespace.js";
import { createFakeDb, type Row, type Store } from "./fake-db.js";

export interface FakeIssue {
  id: string;
  companyId: string;
  title: string;
  description: string;
  status: string;
  priority?: string;
  assigneeUserId?: string | null;
  assigneeAgentId?: string | null;
  originKind?: string;
  originId?: string | null;
  identifier?: string;
}

export interface FakeAgent {
  id: string;
  companyId: string;
  name: string;
  status: string;
  role?: string;
  title?: string | null;
  budgetMonthlyCents?: number;
  spentMonthlyCents?: number;
  lastHeartbeatAt?: string | null;
  errorReason?: string | null;
  createdAt?: string;
  adapterConfig?: Record<string, unknown>;
}

export interface FakeRoutine {
  key: string;
  companyId: string;
  id: string;
  status: string;
  assigneeAgentId: string | null;
}

export function fakeCtx(options: {
  savedConfigs?: Record<string, Record<string, unknown>>;
  prefixes?: Record<string, string>;
  agents?: FakeAgent[];
  approvals?: Array<Record<string, unknown>>;
  coreIssues?: Row[];
  runs?: Row[];
} = {}) {
  const store: Store = { core_issues: options.coreIssues ?? [], core_runs: options.runs ?? [] };
  const db = createFakeDb(store, {
    namespace: NAMESPACE,
    coreReadTables: ["issues", "heartbeat_runs"],
    routes: [
      [/FROM public\.issues/i, (params, s) => (s.core_issues ?? []).filter((row) => row.company_id === params[0] && row.assignee_user_id === params[1] && ["todo", "in_progress", "in_review", "blocked"].includes(row.status))],
      [/FROM public\.heartbeat_runs/i, (params, s) => (s.core_runs ?? []).filter((row) => row.company_id === params[0])],
    ],
  });
  const emitted: Array<{ name: string; companyId: string; payload: unknown }> = [];
  const handlers = new Map<string, Array<(event: PluginEvent) => Promise<void>>>();
  const actions = new Map<string, (params: Record<string, unknown>, context: unknown) => Promise<unknown>>();
  const jobs = new Map<string, () => Promise<void>>();
  const tools = new Map<string, (params: unknown, run: unknown) => Promise<unknown>>();
  const issues = new Map<string, FakeIssue>();
  const comments: Array<{ issueId: string; body: string; companyId: string; authorAgentId?: string }> = [];
  const wakeups: string[] = [];
  const state = new Map<string, unknown>();
  const configs = options.savedConfigs ?? {};
  const agents = [...(options.agents ?? [])];
  const routines = new Map<string, FakeRoutine>();
  const grants = new Map<string, Array<{ permissionKey: string; scope: unknown }>>();
  const skillCalls: string[] = [];
  let seq = 0;
  const stateKey = (key: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) => `${key.scopeKind}:${key.scopeId ?? ""}:${key.namespace ?? ""}:${key.stateKey}`;
  const routineRes = (key: string, companyId: string, status: string) => {
    const routine = routines.get(`${companyId}:${key}`) ?? null;
    return { routineId: routine?.id ?? null, routine, status, missingRefs: [] };
  };
  const ctx = {
    db,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    events: {
      on: (name: string, fn: (event: PluginEvent) => Promise<void>) => {
        handlers.set(name, [...(handlers.get(name) ?? []), fn]);
        return () => undefined;
      },
      emit: async (name: string, companyId: string, payload: unknown) => {
        emitted.push({ name, companyId, payload });
      },
    },
    actions: { register: (key: string, fn: (params: Record<string, unknown>, context: unknown) => Promise<unknown>) => actions.set(key, fn) },
    jobs: { register: (key: string, fn: () => Promise<void>) => jobs.set(key, fn) },
    tools: { register: (name: string, _decl: unknown, fn: (params: unknown, run: unknown) => Promise<unknown>) => tools.set(name, fn) },
    config: { get: async (companyId: string) => configs[companyId] ?? {} },
    state: {
      get: async (key: Parameters<typeof stateKey>[0]) => state.get(stateKey(key)) ?? null,
      set: async (key: Parameters<typeof stateKey>[0], value: unknown) => {
        state.set(stateKey(key), value);
      },
    },
    companies: { get: async (companyId: string) => ({ id: companyId, name: `Company ${companyId}`, issuePrefix: options.prefixes?.[companyId] ?? null }) },
    agents: {
      list: async ({ companyId }: { companyId: string }) => agents.filter((a) => a.companyId === companyId).map((a) => ({ createdAt: "2026-01-01T00:00:00.000Z", ...a })),
      get: async (id: string, companyId: string) => {
        const agent = agents.find((a) => a.id === id && a.companyId === companyId);
        return agent ? { createdAt: "2026-01-01T00:00:00.000Z", ...agent } : null;
      },
    },
    approvals: { list: async ({ companyId }: { companyId: string }) => (options.approvals ?? []).filter((a) => a.companyId === companyId) },
    routines: {
      managed: {
        get: async (key: string, companyId: string) => routineRes(key, companyId, routines.has(`${companyId}:${key}`) ? "resolved" : "missing"),
        reconcile: async (key: string, companyId: string, overrides?: { assigneeAgentId?: string | null }) => {
          if (!routines.has(`${companyId}:${key}`)) {
            seq += 1;
            routines.set(`${companyId}:${key}`, { key, companyId, id: `routine-${seq}`, status: "active", assigneeAgentId: overrides?.assigneeAgentId ?? null });
            return routineRes(key, companyId, "created");
          }
          return routineRes(key, companyId, "resolved");
        },
        reset: async (key: string, companyId: string, overrides?: { assigneeAgentId?: string | null }) => {
          const routine = routines.get(`${companyId}:${key}`)!;
          routine.assigneeAgentId = overrides?.assigneeAgentId ?? null;
          routine.status = "active";
          return routineRes(key, companyId, "reset");
        },
        update: async (key: string, companyId: string, patch: { status?: string }) => {
          const routine = routines.get(`${companyId}:${key}`)!;
          if (patch.status) routine.status = patch.status;
          return routine;
        },
      },
    },
    skills: {
      managed: {
        reconcile: async (key: string) => {
          skillCalls.push(`reconcile:${key}`);
          return {};
        },
        reset: async (key: string) => {
          skillCalls.push(`reset:${key}`);
          return {};
        },
      },
    },
    authorization: {
      grants: {
        list: async ({ principalId }: { principalId: string }) => grants.get(principalId) ?? [],
        set: async ({ principalId, grants: next }: { principalId: string; grants: Array<{ permissionKey: string; scope: unknown }> }) => {
          grants.set(principalId, next);
          return next;
        },
      },
    },
    issues: {
      create: async (input: Omit<FakeIssue, "id" | "status"> & { status?: string }) => {
        seq += 1;
        const issue: FakeIssue = { ...input, id: `issue-${seq}`, identifier: `PIB-${seq}`, status: input.status ?? "backlog", description: input.description ?? "" };
        issues.set(issue.id, issue);
        return { ...issue };
      },
      get: async (id: string, companyId: string) => {
        const issue = issues.get(id);
        return issue && issue.companyId === companyId ? { ...issue } : null;
      },
      update: async (id: string, patch: Partial<FakeIssue>, companyId: string) => {
        const issue = issues.get(id);
        if (!issue || issue.companyId !== companyId) throw new Error("issue not found");
        Object.assign(issue, patch);
        return { ...issue };
      },
      createComment: async (issueId: string, body: string, companyId: string, opts?: { authorAgentId?: string }) => {
        comments.push({ issueId, body, companyId, ...(opts?.authorAgentId ? { authorAgentId: opts.authorAgentId } : {}) });
        return { id: `comment-${comments.length}` };
      },
      requestWakeup: async (issueId: string) => {
        wakeups.push(issueId);
        return { queued: true };
      },
    },
  } as unknown as PluginContext;

  async function fire(name: string, event: Partial<PluginEvent>) {
    for (const fn of handlers.get(name) ?? []) await fn({ eventId: "e", eventType: name as PluginEvent["eventType"], occurredAt: new Date().toISOString(), companyId: "", payload: null, ...event } as PluginEvent);
  }

  return { ctx, store, db, emitted, handlers, actions, jobs, tools, issues, comments, wakeups, state, configs, agents, routines, grants, skillCalls, fire };
}

export function fixedClock(iso: string) {
  let now = new Date(iso);
  return {
    now: () => now,
    set(next: string) {
      now = new Date(next);
    },
  };
}
