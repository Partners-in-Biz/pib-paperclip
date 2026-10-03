import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "../../src/namespace.js";
import { createFakeDb, type Row, type Store } from "./fake-db.js";
import { canonicalSkillKey, declarationOf, hostDefaultDrift, type InstalledCopy } from "./host-skills.js";

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
  createdAt?: string;
  updatedAt?: string;
  projectId?: string | null;
  parentId?: string | null;
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

function seeded(rows: unknown): Row[] {
  if (rows instanceof Error) throw rows;
  return (rows as Row[] | undefined) ?? [];
}

/** What `listRuns`' GROUP BY agent_id, status statement answers for these rows. */
export function aggregateRuns(rows: Row[], params: string[]): Row[] {
  const [, period, week, win, day] = params.map((p, i) => (i === 0 ? p : Date.parse(p)));
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const at = Date.parse(row.started_at);
    if (Number.isNaN(at) || at < (period as number)) continue;
    const key = `${row.agent_id}|${row.status}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map((group) => {
    const newest = [...group].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))[0]!;
    const since = (from: number) => String(group.filter((row) => Date.parse(row.started_at) >= from).length);
    return { agent_id: newest.agent_id, status: newest.status, week: since(week as number), win: since(win as number), day: since(day as number), last_started_at: newest.started_at, last_id: newest.id ?? null };
  });
}

export function fakeCtx(options: {
  savedConfigs?: Record<string, Record<string, unknown>>;
  prefixes?: Record<string, string>;
  agents?: FakeAgent[];
  approvals?: Array<Record<string, unknown>>;
  coreIssues?: Row[];
  runs?: Row[];
  /** What `ctx.access.members.list` answers; omit and the capability is missing (the call throws). */
  members?: Array<{ principalType: string; status: string; membershipRole: string | null }>;
  /** Company secrets by id, for `ctx.secrets.resolve`. */
  secrets?: Record<string, string>;
  /** `ctx.goals`: present when true (the capability granted). */
  goals?: boolean;
  /**
   * What `ctx.skills.managed.get` resolves, by skill key: the company's copy as the host stores it (see
   * helpers/host-skills.ts: `installedLikeHost` gives the host-shaped, unedited copy). The resolution carries the
   * host's own `defaultDrift` verdict, computed the way the host computes it. Not listed: "missing".
   */
  installedSkills?: Record<string, InstalledCopy>;
} = {}) {
  const store: Store = { core_issues: options.coreIssues ?? [], core_runs: options.runs ?? [] };
  const OPEN = ["todo", "in_progress", "in_review", "blocked"];
  const PRIORITY: Record<string, number> = { critical: 0, high: 1, medium: 2 };
  const db = createFakeDb(store, {
    namespace: NAMESPACE,
    coreReadTables: ["issues", "heartbeat_runs", "issue_relations", "projects"],
    routes: [
      // The operations watch (watch.ts): rows a test seeds in `store.watch_<rule>` (an Error there makes that read fail); none by default.
      // They come before the generic routes below.
      [/row_number\(\) OVER/i, (_params, s) => seeded(s.watch_streak)],
      [/GROUP BY context_snapshot/i, (_params, s) => seeded(s.watch_storm)],
      [/GROUP BY agent_id, status, error_code/i, (_params, s) => seeded(s.watch_rate)],
      // Blocked issues that name an agent owner (the owner check), before the generic blocked read, which shares the same function name.
      [/unblock_descriptor -> 'owner' ->> 'agentId' IS NOT NULL/i, (_params, s) => seeded(s.watch_blocked_owned)],
      [/jsonb_typeof\(i\.unblock_descriptor\)/i, (_params, s) => seeded(s.watch_blocked)],
      [/i\.status = 'in_progress'/i, (_params, s) => seeded(s.watch_stalled)],
      [/FROM public\.issues/i, (params, s, sql) => {
        if (/origin_kind = \$2/i.test(sql)) {
          // Open issues of one origin kind (backlog counts as open), oldest first.
          return (s.core_issues ?? [])
            .filter((row) => row.company_id === params[0] && row.origin_kind === params[1] && ["backlog", ...OPEN].includes(row.status) && !row.hidden_at)
            .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
        }
        const rows = (s.core_issues ?? []).filter((row) => row.company_id === params[0] && OPEN.includes(row.status) && !row.hidden_at);
        if (/assignee_user_id IS NULL/i.test(sql)) {
          // Open, nobody assigned, created more than a day ago.
          const dayAgo = Date.now() - 86_400_000;
          const unassigned = rows
            .filter((row) => !row.assignee_agent_id && !row.assignee_user_id && Date.parse(row.created_at) < dayAgo)
            .sort((a, b) => (PRIORITY[a.priority] ?? 3) - (PRIORITY[b.priority] ?? 3) || Date.parse(a.created_at) - Date.parse(b.created_at));
          return /count\(\*\)/i.test(sql) ? [{ n: String(unassigned.length) }] : unassigned.slice(0, Number(/LIMIT (\d+)/i.exec(sql)?.[1] ?? 5));
        }
        return rows.filter((row) => row.assignee_user_id === params[1]);
      }],
      [/FROM public\.heartbeat_runs/i, (params, s, sql) => {
        const rows = (s.core_runs ?? []).filter((row) => row.company_id === params[0]);
        // `listRuns`: counted per agent and status, windows given as parameters ($2 period, $3 week, $4 window, $5 day).
        if (/GROUP BY agent_id, status/i.test(sql)) return aggregateRuns(rows, params as string[]);
        return rows;
      }],
    ],
  });
  const emitted: Array<{ name: string; companyId: string; payload: unknown }> = [];
  const handlers = new Map<string, Array<(event: PluginEvent) => Promise<void>>>();
  const actions = new Map<string, (params: Record<string, unknown>, context: unknown) => Promise<unknown>>();
  const jobs = new Map<string, () => Promise<void>>();
  const tools = new Map<string, (params: unknown, run: unknown) => Promise<unknown>>();
  const issues = new Map<string, FakeIssue>();
  const comments: Array<{ id: string; issueId: string; body: string; companyId: string; authorAgentId?: string; authorUserId?: string | null; createdAt: string; deletedAt?: string | null }> = [];
  const wakeups: string[] = [];
  const wakeReasons: Array<{ issueId: string; reason?: string }> = [];
  const updates: Array<{ issueId: string; patch: Partial<FakeIssue> }> = [];
  const state = new Map<string, unknown>();
  const configs = options.savedConfigs ?? {};
  const agents = [...(options.agents ?? [])];
  const routines = new Map<string, FakeRoutine>();
  const grants = new Map<string, Array<{ permissionKey: string; scope: unknown }>>();
  const skillCalls: string[] = [];
  /** Issue documents by `issueId:key` (what `ctx.issues.documents.get` reads). */
  const documents = new Map<string, string>();
  const hostGoals = new Map<string, { id: string; companyId: string; title: string; status: string; level?: string }>();
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
        get: async (key: string) => {
          const found = options.installedSkills?.[key];
          if (!found) return { status: "missing", skillId: null, skill: null, defaultDrift: null, missingRefs: [] };
          const resolution = { status: "resolved", skillId: found.skillId, skill: found.markdown === null ? null : { id: found.skillId, key: canonicalSkillKey(key), markdown: found.markdown }, missingRefs: [] };
          // Like the host: the verdict is always present (null: nothing differs), unless the test models a server that does not report it.
          return found.hostReportsDrift === false ? resolution : { ...resolution, defaultDrift: hostDefaultDrift(declarationOf(key), found) };
        },
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
    ...(options.members
      ? { access: { members: { list: async () => options.members } } }
      : { access: { members: { list: async () => { throw new Error("access.members.read is not granted"); } } } }),
    secrets: { resolve: async (ref: { secretId?: string } | string) => {
      const id = typeof ref === "string" ? ref : String(ref.secretId);
      if (!(id in (options.secrets ?? {}))) throw new Error(`secret ${id} not found`);
      return options.secrets![id]!;
    } },
    ...(options.goals
      ? {
          goals: {
            create: async (input: { companyId: string; title: string; level?: string; status?: string }) => {
              seq += 1;
              const goal = { id: `host-goal-${seq}`, companyId: input.companyId, title: input.title, status: input.status ?? "planned", level: input.level };
              hostGoals.set(goal.id, goal);
              return { ...goal };
            },
            update: async (id: string, patch: { status?: string }) => {
              const goal = hostGoals.get(id);
              if (!goal) throw new Error("goal not found");
              Object.assign(goal, patch);
              return { ...goal };
            },
          },
        }
      : {}),
    issues: {
      list: async (input: { companyId: string; projectId?: string; assigneeAgentId?: string; originKind?: string; originKindPrefix?: string; originId?: string; status?: string; limit?: number }) =>
        [...issues.values()]
          .filter((i) => i.companyId === input.companyId)
          .filter((i) => (input.originKind ? i.originKind === input.originKind : true))
          .filter((i) => (input.originKindPrefix ? (i.originKind ?? "").startsWith(input.originKindPrefix) : true))
          .filter((i) => (input.originId ? i.originId === input.originId : true))
          .filter((i) => (input.status ? i.status === input.status : true))
          .filter((i) => (input.assigneeAgentId ? i.assigneeAgentId === input.assigneeAgentId : true))
          .slice(0, input.limit ?? 100)
          .map((i) => ({ ...i })),
      create: async (input: Omit<FakeIssue, "id" | "status"> & { status?: string }) => {
        seq += 1;
        const issue: FakeIssue = { ...input, id: `issue-${seq}`, identifier: `PIB-${seq}`, status: input.status ?? "backlog", description: input.description ?? "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        issues.set(issue.id, issue);
        return { ...issue };
      },
      get: async (id: string, companyId: string) => {
        // Like the host: an id or an identifier (PIB-12).
        const issue = issues.get(id) ?? [...issues.values()].find((i) => i.identifier === id);
        return issue && issue.companyId === companyId ? { ...issue } : null;
      },
      update: async (id: string, patch: Partial<FakeIssue>, companyId: string) => {
        const issue = issues.get(id);
        if (!issue || issue.companyId !== companyId) throw new Error("issue not found");
        Object.assign(issue, patch);
        updates.push({ issueId: id, patch: { ...patch } });
        return { ...issue };
      },
      createComment: async (issueId: string, body: string, companyId: string, opts?: { authorAgentId?: string }) => {
        const id = `comment-${comments.length + 1}`;
        comments.push({ id, issueId, body, companyId, createdAt: new Date().toISOString(), ...(opts?.authorAgentId ? { authorAgentId: opts.authorAgentId } : {}) });
        return { id };
      },
      listComments: async (issueId: string, companyId: string) =>
        comments.filter((c) => c.issueId === issueId && c.companyId === companyId).map((c) => ({ authorAgentId: null, authorUserId: null, ...c })),
      documents: {
        get: async (issueId: string, key: string) => {
          const body = documents.get(`${issueId}:${key}`);
          return body === undefined ? null : { id: `doc-${issueId}-${key}`, key, body, title: key, format: "markdown" };
        },
      },
      requestWakeup: async (issueId: string, _companyId: string, options?: { reason?: string }) => {
        wakeups.push(issueId);
        wakeReasons.push({ issueId, reason: options?.reason });
        return { queued: true };
      },
    },
  } as unknown as PluginContext;

  async function fire(name: string, event: Partial<PluginEvent>) {
    for (const fn of handlers.get(name) ?? []) await fn({ eventId: "e", eventType: name as PluginEvent["eventType"], occurredAt: new Date().toISOString(), companyId: "", payload: null, ...event } as PluginEvent);
  }

  /** A person's comment on an issue (what the host stores when a board user replies). */
  function userComment(issueId: string, body: string, userId: string, companyId?: string): string {
    const issue = issues.get(issueId);
    const id = `comment-${comments.length + 1}`;
    comments.push({ id, issueId, body, companyId: companyId ?? issue?.companyId ?? "", authorUserId: userId, createdAt: new Date(Date.now() + comments.length).toISOString() });
    return id;
  }

  return { ctx, store, db, emitted, handlers, actions, jobs, tools, issues, comments, wakeups, wakeReasons, updates, state, configs, agents, routines, grants, skillCalls, documents, hostGoals, fire, userComment };
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
