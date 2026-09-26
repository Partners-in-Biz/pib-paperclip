import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "../../src/namespace.js";
import { createFakeDb, type Store } from "./fake-db.js";

export interface FakeIssue {
  id: string;
  companyId: string;
  title: string;
  description: string;
  status: string;
  assigneeUserId?: string | null;
  originKind?: string;
  originId?: string | null;
}

export function fakeCtx(options: { savedConfigs?: Record<string, Record<string, unknown>>; prefixes?: Record<string, string> } = {}) {
  const store: Store = {};
  const db = createFakeDb(store, { namespace: NAMESPACE });
  const emitted: Array<{ name: string; companyId: string; payload: unknown }> = [];
  const handlers = new Map<string, Array<(event: PluginEvent) => Promise<void>>>();
  const actions = new Map<string, (params: Record<string, unknown>, context: unknown) => Promise<unknown>>();
  const jobs = new Map<string, () => Promise<void>>();
  const issues = new Map<string, FakeIssue>();
  const state = new Map<string, unknown>();
  const configs = options.savedConfigs ?? {};
  let seq = 0;
  const stateKey = (key: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) => `${key.scopeKind}:${key.scopeId ?? ""}:${key.namespace ?? ""}:${key.stateKey}`;
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
    config: { get: async (companyId: string) => configs[companyId] ?? {} },
    state: {
      get: async (key: Parameters<typeof stateKey>[0]) => state.get(stateKey(key)) ?? null,
      set: async (key: Parameters<typeof stateKey>[0], value: unknown) => {
        state.set(stateKey(key), value);
      },
    },
    companies: { get: async (companyId: string) => (options.prefixes?.[companyId] ? { id: companyId, issuePrefix: options.prefixes[companyId] } : null) },
    issues: {
      create: async (input: Omit<FakeIssue, "id" | "status"> & { status?: string }) => {
        seq += 1;
        const issue: FakeIssue = { ...input, id: `issue-${seq}`, status: input.status ?? "backlog", description: input.description ?? "" };
        issues.set(issue.id, issue);
        return issue;
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
      requestWakeup: async () => ({ queued: true }),
    },
  } as unknown as PluginContext;

  async function fire(name: string, event: Partial<PluginEvent>) {
    for (const fn of handlers.get(name) ?? []) await fn({ eventId: "e", eventType: name as PluginEvent["eventType"], occurredAt: new Date().toISOString(), companyId: "", payload: null, ...event } as PluginEvent);
  }

  return { ctx, store, db, emitted, handlers, actions, jobs, issues, state, configs, fire };
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
