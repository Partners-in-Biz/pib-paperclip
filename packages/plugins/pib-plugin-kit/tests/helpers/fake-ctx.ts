/**
 * An in-memory PluginContext for the kit's tests: state, events, issues,
 * companies, agents, grants, projects, skills and jobs, with the failure modes
 * the host really has (a company-scoped call refused for a company the plugin
 * has no saved config for; the host refusing an assignee).
 */
import { vi } from "vitest";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";

export interface FakeIssue {
  id: string;
  identifier: string;
  companyId: string;
  title: string;
  description?: string;
  status: string;
  originKind?: string;
  originId?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  createdAt: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface FakeOptions {
  manifestId?: string;
  companies?: Record<string, { name?: string; issuePrefix?: string; defaultResponsibleUserId?: string | null }>;
  agents?: Array<Record<string, unknown>>;
  grants?: Record<string, Array<{ permissionKey: string; scope: Record<string, unknown> | null }>>;
  projects?: Record<string, { archivedAt?: string | null }>;
  /** Company ids whose company-scoped host calls are refused ("company context is required"), like a company with no saved plugin config. */
  deniedCompanies?: string[];
  /** User ids the host refuses as an assignee ("Assignee user not found"). */
  refusedUsers?: string[];
  /** Make every state read throw. */
  stateReadThrows?: boolean;
  /** `ctx.companies.list` refuses (another call in flight). */
  companyListThrows?: boolean;
  /** `ctx.authorization` refuses. */
  grantsThrow?: boolean;
  /** Issue ids that have blockers (`ctx.issues.relations.get`), or `"throws"` for a plugin without `issue.relations.read`. */
  blockers?: Record<string, string[]> | "throws";
  now?: () => number;
}

export function stateKeyOf(key: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }): string {
  return `${key.scopeKind}|${key.scopeId ?? ""}|${key.namespace ?? "default"}|${key.stateKey}`;
}

export function fakeCtx(options: FakeOptions = {}) {
  const state = new Map<string, unknown>();
  const handlers = new Map<string, Array<(event: PluginEvent) => Promise<void>>>();
  const emitted: Array<{ name: string; companyId: string; payload: Record<string, unknown> }> = [];
  const issues: FakeIssue[] = [];
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const comments: Array<{ issueId: string; body: string }> = [];
  const wakeups: string[] = [];
  const jobs = new Map<string, () => Promise<void>>();
  const resets: Array<{ key: string; companyId: string }> = [];
  const denied = new Set(options.deniedCompanies ?? []);
  const grantStore: Record<string, Array<{ permissionKey: string; scope: Record<string, unknown> | null }>> = { ...(options.grants ?? {}) };
  const grantWrites: Array<{ principalId: string; grants: Array<{ permissionKey: string; scope?: Record<string, unknown> | null }>; grantedByUserId?: string | null }> = [];
  let counter = 0;

  const guard = (companyId: string | undefined, method: string) => {
    if (companyId && denied.has(companyId)) throw new Error(`Plugin "x" is not allowed to perform "${method}": company context is required`);
  };

  const ctx = {
    manifest: { id: options.manifestId ?? "partnersinbiz.test" },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    state: {
      get: async (key: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) => {
        if (options.stateReadThrows) throw new Error("state store failed");
        if (key.scopeKind === "company") guard(key.scopeId, "state.get");
        return state.get(stateKeyOf(key)) ?? null;
      },
      set: async (key: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }, value: unknown) => {
        if (key.scopeKind === "company") guard(key.scopeId, "state.set");
        state.set(stateKeyOf(key), value);
      },
      delete: async (key: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) => void state.delete(stateKeyOf(key)),
    },
    events: {
      on: (name: string, ...rest: unknown[]) => {
        const fn = rest[rest.length - 1] as (event: PluginEvent) => Promise<void>;
        handlers.set(name, [...(handlers.get(name) ?? []), fn]);
        return () => undefined;
      },
      emit: async (name: string, companyId: string, payload: Record<string, unknown>) => void emitted.push({ name, companyId, payload }),
    },
    jobs: { register: (key: string, fn: () => Promise<void>) => void jobs.set(key, fn) },
    companies: {
      get: async (companyId: string) => {
        const company = options.companies?.[companyId];
        return company ? { id: companyId, name: "Test Co", issuePrefix: "TST", defaultResponsibleUserId: null, ...company } : null;
      },
      list: async () => {
        if (options.companyListThrows) throw new Error('Plugin "x" is not allowed to perform "companies.list": the worker referenced a missing, expired, or unknown invocation scope');
        return Object.keys(options.companies ?? {}).map((id) => ({ id, name: options.companies![id]!.name ?? "Test Co" }));
      },
    },
    agents: {
      get: async (id: string) => options.agents?.find((a) => a.id === id) ?? null,
      list: async () => options.agents ?? [],
    },
    authorization: {
      grants: {
        list: async (input: { principalId?: string }) => {
          if (options.grantsThrow) throw new Error("authorization.grants.read is not granted");
          return grantStore[input.principalId ?? ""] ?? [];
        },
        set: async (input: { principalId: string; grants: Array<{ permissionKey: string; scope?: Record<string, unknown> | null }>; grantedByUserId?: string | null }) => {
          if (options.grantsThrow) throw new Error("authorization.grants.write is not granted");
          grantWrites.push({ principalId: input.principalId, grants: input.grants, grantedByUserId: input.grantedByUserId });
          grantStore[input.principalId] = input.grants.map((g) => ({ permissionKey: g.permissionKey, scope: g.scope ?? null }));
          return grantStore[input.principalId];
        },
      },
    },
    projects: {
      get: async (id: string) => {
        const project = options.projects?.[id];
        return project ? { id, ...project } : null;
      },
    },
    skills: {
      managed: {
        reconcile: async () => ({ defaultDrift: null }),
        reset: async (key: string, companyId: string) => {
          guard(companyId, "skills.managed.reset");
          resets.push({ key, companyId });
          return {};
        },
      },
    },
    issues: {
      create: async (input: Record<string, unknown>) => {
        const companyId = String(input.companyId);
        guard(companyId, "issues.create");
        if (typeof input.assigneeUserId === "string" && options.refusedUsers?.includes(input.assigneeUserId)) throw new Error("Assignee user not found");
        counter += 1;
        const stamp = new Date((options.now ?? Date.now)()).toISOString();
        const issue = { id: `issue-${counter}`, identifier: `TST-${counter}`, createdAt: stamp, updatedAt: stamp, assigneeAgentId: null, assigneeUserId: null, status: "todo", ...input } as FakeIssue;
        issues.push(issue);
        return issue;
      },
      list: async (input: { companyId: string; status?: string; originKindPrefix?: string; originKind?: string; originId?: string }) =>
        issues.filter((i) => i.companyId === input.companyId && (!input.status || i.status === input.status) && (!input.originKindPrefix || (i.originKind ?? "").startsWith(input.originKindPrefix)) && (!input.originKind || i.originKind === input.originKind) && (!input.originId || i.originId === input.originId)),
      update: async (id: string, patch: Record<string, unknown>) => {
        updates.push({ id, patch });
        const issue = issues.find((i) => i.id === id);
        if (issue) Object.assign(issue, patch);
        return issue;
      },
      createComment: async (issueId: string, body: string) => void comments.push({ issueId, body }),
      requestWakeup: async (id: string) => void wakeups.push(id),
      relations: {
        get: async (id: string) => {
          if (options.blockers === "throws") throw new Error("issue.relations.read is not granted");
          return { blockedBy: (options.blockers?.[id] ?? []).map((b) => ({ id: b })), blocks: [] };
        },
      },
    },
  } as unknown as PluginContext;

  /** Delivers a core or plugin event to every handler subscribed to `name`. */
  const deliver = async (name: string, companyId: string, payload: unknown = {}) => {
    for (const fn of handlers.get(name) ?? []) await fn({ eventType: name, companyId, payload, occurredAt: new Date().toISOString() } as unknown as PluginEvent);
  };

  return { ctx, state, handlers, emitted, issues, updates, comments, wakeups, jobs, resets, deliver, denied, grantStore, grantWrites };
}

/** A roles copy as the Cockpit broadcasts it. */
export function rolesCopy(patch: Record<string, unknown> = {}) {
  return { companyId: "co-1", operatorAgentId: "op", reviewerAgentId: "rev", ownerUserId: "owner", reviewOutward: true, operatorStatus: "idle", reviewerStatus: "idle", updatedAt: "2026-09-27T18:46:11.052Z", ...patch };
}

export function setRoles(fake: ReturnType<typeof fakeCtx>, companyId: string, roles: Record<string, unknown> | null): void {
  fake.state.set(stateKeyOf({ scopeKind: "company", scopeId: companyId, namespace: "pib-cockpit", stateKey: "roles" }), roles);
}
