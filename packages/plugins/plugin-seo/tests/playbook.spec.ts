import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import * as db from "../src/db.js";
import { NAMESPACE } from "../src/namespace.js";
import { PLAYBOOK_ITEM_KEY, playbookChangesItem } from "../src/engine/items.js";
import {
  agentMayDecide,
  agentMayPropose,
  applyPlaybookChange,
  autoKeep,
  changeDiff,
  measuredChange,
  normalizeChange,
  PlaybookError,
  scopeKey,
  seoStarterPlaybook,
} from "../src/engine/playbook.js";
import { createEnv, SeoError, type Actor } from "../src/service/common.js";
import { playbookNote } from "../src/service/optimize.js";
import { decidePlaybookChangeTool, draftFromMeasurement, getPlaybookTool, proposePlaybookChangeTool } from "../src/service/playbook.js";
import type { PlaybookStore } from "../src/service/playbook-store.js";
import { HANDLERS } from "../src/dispatch.js";
import { SEO_TOOLS } from "../src/tools.js";
import { OPTIMIZATION_LOOP_DOC, SKILL_BODY } from "../src/skills.js";
import { splitSqlStatements, validateMigrationStatement, validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

type Row = Record<string, unknown>;

// ── Pure engine ─────────────────────────────────────────────────────────────

describe("learned playbook engine", () => {
  const starter = seoStarterPlaybook("Acme");

  it("starts with the shared sections", () => {
    for (const heading of ["## Goal", "## Rules we follow", "## Things that did not work", "## Open questions to test", "## Constraints"]) {
      expect(starter).toContain(heading);
    }
    expect(scopeKey(null)).toBe("own");
    expect(scopeKey({ kind: "contact", id: "ct-1" })).toBe("contact:ct-1");
  });

  it("adds a rule in place of (none yet), once, and removes it back", () => {
    const added = applyPlaybookChange(starter, { op: "add", section: "rules", body: "Add FAQ schema to stuck pages" });
    const rules = added.split("## Rules we follow")[1]!.split("##")[0]!;
    expect(rules).toContain("- Add FAQ schema to stuck pages");
    expect(rules).not.toContain("(none yet)");
    expect(applyPlaybookChange(added, { op: "add", section: "rules", body: "add faq schema to stuck pages" })).toBe(added);
    const removed = applyPlaybookChange(added, { op: "remove", section: null, body: "- Add FAQ schema to stuck pages." });
    expect(removed.split("## Rules we follow")[1]!.split("##")[0]).toContain("- (none yet)");
    expect(() => applyPlaybookChange(starter, { op: "remove", section: null, body: "Not a rule" })).toThrow(PlaybookError);
    expect(() => applyPlaybookChange(starter, { op: "replace", section: null, body: "   " })).toThrow(/empty/);
  });

  it("normalises tool input and describes the change", () => {
    expect(normalizeChange({ text: "Use comparison pages" })).toEqual({ op: "add", section: "rules", body: "Use comparison pages" });
    expect(() => normalizeChange({ op: "add", section: "misc", text: "abc" })).toThrow(/section must be/);
    expect(() => normalizeChange({ op: "rename" })).toThrow(/op must be/);
    expect(() => normalizeChange({ text: "x".repeat(401) })).toThrow(/longer than 400/);
    expect(changeDiff({ op: "add", section: "avoid", body: "Buying links" })).toBe("+ Things that did not work: - Buying links");
    expect(changeDiff({ op: "replace", section: null, body: "a\nb" }, "x\ny\nz")).toBe("Replace the whole playbook (3 → 2 lines)");
  });

  it("drafts a rule from a win, an avoid line from a loss, nothing otherwise", () => {
    const o = { id: "o-1", hypothesisType: "stuck_page:internal-links", proposedAction: "Add 3+ contextual internal links to https://acme.co.za/x from strong pages" };
    const win = measuredChange(o, { result: "win", reasons: ["Average position improved by 3."] }, "2026-10-10")!;
    expect(win).toMatchObject({ op: "add", section: "rules" });
    expect(win.body).toContain("win on 2026-10-10: Average position improved by 3; stuck_page:internal-links");
    expect(measuredChange(o, { result: "loss", reasons: ["Impressions down 30%."] }, "2026-10-10")!.section).toBe("avoid");
    expect(measuredChange(o, { result: "no_change", reasons: [] }, "2026-10-10")).toBeNull();
    expect(measuredChange(o, { result: "inconclusive", reasons: [] }, "2026-10-10")).toBeNull();
    const long = measuredChange({ ...o, proposedAction: "y".repeat(900) }, { result: "win", reasons: ["r."] }, "2026-10-10")!;
    expect(long.body.length).toBeLessThanOrEqual(400);
    expect(long.body).toContain("stuck_page:internal-links");
  });

  it("agents decide only on full autopilot and propose unless it is off", () => {
    expect([agentMayDecide("off"), agentMayDecide("safe"), agentMayDecide("full")]).toEqual([false, false, true]);
    expect([agentMayPropose("off"), agentMayPropose("safe"), agentMayPropose("full")]).toEqual([false, true, true]);
    expect([autoKeep("full", "win"), autoKeep("full", "loss"), autoKeep("safe", "win")]).toEqual([true, false, false]);
  });

  it("batches pending changes into one Needs you item and notes them on the measured comment", () => {
    const item = playbookChangesItem({ playbookPath: "/PIB/seo?sprint=sp-1&tab=playbook", scopeLabel: "Acme", diffs: Array.from({ length: 10 }, (_, i) => `+ Rules we follow: - rule ${i}`) });
    expect(item).toMatchObject({ key: PLAYBOOK_ITEM_KEY, kind: "review", check: "playbook_decided", title: "Keep or discard 10 learned SEO playbook changes" });
    expect(item.steps).toHaveLength(10); // 8 shown + "…and 2 more" + where to decide
    expect(playbookNote({ autopilotMode: "safe" }, { id: "o-1" }, null)).toBe("");
    expect(playbookNote({ autopilotMode: "safe" }, { id: "o-1" }, { changeId: "c-1", diff: "+ Rules we follow: - x", kept: false, version: null })).toContain("propose-playbook-change` (optimizationId `o-1`)");
    expect(playbookNote({ autopilotMode: "full" }, { id: "o-1" }, { changeId: "c-1", diff: "+ Rules we follow: - x", kept: true, version: 4 })).toContain("Playbook v4 (kept automatically");
  });
});

// ── Migration, SQL, tools, skill ────────────────────────────────────────────

describe("learned playbook storage and surface", () => {
  it("013 creates the three tables and passes the host migration guard", () => {
    const sql = readFileSync(new URL("../migrations/013_seo.sql", import.meta.url), "utf8");
    for (const table of ["playbooks", "playbook_versions", "playbook_changes"]) expect(sql).toContain(`CREATE TABLE ${NAMESPACE}.${table}`);
    expect(sql).toContain("playbooks_scope ON");
    expect(sql).toContain("WHERE source = 'measured'");
    for (const statement of splitSqlStatements(sql)) expect(() => validateMigrationStatement(statement, NAMESPACE)).not.toThrow();
  });

  it("runtime SQL passes the host guard", async () => {
    const calls: string[] = [];
    const fake: db.SeoDb = {
      namespace: NAMESPACE,
      async query<T>(sql: string, params: unknown[] = []) {
        validateRuntimeQuery(sql, NAMESPACE, ["heartbeat_runs"]);
        validateParams(sql, params);
        calls.push(sql);
        return [] as T[];
      },
      async execute(sql: string, params: unknown[] = []) {
        validateRuntimeExecute(sql, NAMESPACE);
        validateParams(sql, params);
        calls.push(sql);
        return { rowCount: 1 };
      },
    };
    await db.findPlaybook(fake, "c", "own");
    await db.getPlaybook(fake, "c", "p");
    await db.insertPlaybook(fake, { id: "p", companyId: "c", scopeKey: "company:x", clientKind: "company", clientRef: "x", clientName: "X", playbook: "# P" });
    await db.setPlaybookClientName(fake, "c", "p", "X");
    await db.savePlaybook(fake, "c", "p", 1, "# P2");
    await db.insertPlaybookVersion(fake, { id: "v", companyId: "c", playbookId: "p", version: 2, playbook: "# P2", reason: "r", optimizationId: null, changeId: "ch", decidedBy: "u" });
    await db.listPlaybookVersions(fake, "c", "p", 10);
    await db.insertPlaybookChange(fake, { id: "ch", companyId: "c", playbookId: "p", sprintId: "s", optimizationId: "o", source: "measured", op: "add", section: "rules", body: "b", diff: "d", reason: "r", baseVersion: 1, proposedBy: "system" });
    await db.getPlaybookChange(fake, "c", "ch");
    await db.listPlaybookChanges(fake, "c", "p", { status: "pending" });
    await db.listPlaybookChanges(fake, "c", "p");
    await db.pendingPlaybookChangesForSprint(fake, "c", "s");
    await db.updatePlaybookChange(fake, "c", "ch", { status: "kept", decidedBy: "u", decisionNote: null }, true);
    await db.updatePlaybookChange(fake, "c", "ch", { resultVersion: 2 }, false);
    expect(calls).toHaveLength(14);
    expect(calls.every((sql) => !/\bundefined\b/.test(sql))).toBe(true);
  });

  it("declares and dispatches the three tools", () => {
    for (const name of ["get-playbook", "propose-playbook-change", "decide-playbook-change"]) {
      expect(SEO_TOOLS.some((t) => t.name === name), name).toBe(true);
      expect(HANDLERS[name], name).toBeTypeOf("function");
    }
  });

  it("tells the agent to read the playbook before tasks and to learn after measurements", () => {
    const everyRun = SKILL_BODY.split("## Every run")[1]!.split("## Autonomy")[0]!;
    expect(everyRun.indexOf("get-playbook")).toBeLessThan(everyRun.indexOf("Work each assigned issue"));
    expect(everyRun).toContain("propose-playbook-change");
    expect(OPTIMIZATION_LOOP_DOC).toContain("## 5. Learn: the playbook");
  });
});

// ── Service ─────────────────────────────────────────────────────────────────

function memoryStore(): PlaybookStore & { playbooks: db.Playbook[]; versions: Array<db.PlaybookVersion & { playbookId: string }>; changes: db.PlaybookChange[] } {
  const playbooks: db.Playbook[] = [];
  const versions: Array<db.PlaybookVersion & { playbookId: string }> = [];
  const changes: db.PlaybookChange[] = [];
  const copy = <T>(x: T | undefined): T | null => (x ? structuredClone(x) : null);
  return {
    playbooks,
    versions,
    changes,
    async findPlaybook(companyId, key) {
      return copy(playbooks.find((p) => p.companyId === companyId && p.scopeKey === key));
    },
    async getPlaybook(companyId, id) {
      return copy(playbooks.find((p) => p.companyId === companyId && p.id === id));
    },
    async insertPlaybook(p) {
      if (playbooks.some((x) => x.companyId === p.companyId && x.scopeKey === p.scopeKey)) return false;
      playbooks.push({ ...p, version: 1, createdAt: null, updatedAt: null });
      return true;
    },
    async setClientName(companyId, id, clientName) {
      const p = playbooks.find((x) => x.companyId === companyId && x.id === id);
      if (p) p.clientName = clientName;
    },
    async savePlaybook(companyId, id, expected, playbook) {
      const p = playbooks.find((x) => x.companyId === companyId && x.id === id && x.version === expected);
      if (!p) return false;
      p.playbook = playbook;
      p.version += 1;
      return true;
    },
    async insertVersion(v) {
      if (!versions.some((x) => x.playbookId === v.playbookId && x.version === v.version)) versions.push({ ...v, createdAt: "2026-10-10T08:00:00Z" });
    },
    async listVersions(companyId, playbookId, limit) {
      return versions.filter((v) => v.playbookId === playbookId).sort((a, b) => b.version - a.version).slice(0, limit);
    },
    async insertChange(c) {
      if (c.source === "measured" && changes.some((x) => x.source === "measured" && x.optimizationId === c.optimizationId)) return false;
      changes.push({ ...c, status: "pending", resultVersion: null, decidedBy: null, decidedAt: null, decisionNote: null, createdAt: `2026-10-10T08:00:0${changes.length}Z` });
      return true;
    },
    async getChange(companyId, id) {
      return copy(changes.find((c) => c.companyId === companyId && c.id === id));
    },
    async listChanges(companyId, playbookId, status) {
      return changes.filter((c) => c.companyId === companyId && c.playbookId === playbookId && (!status || c.status === status)).reverse();
    },
    async pendingForSprint(companyId, sprintId) {
      return changes.filter((c) => c.companyId === companyId && c.sprintId === sprintId && c.status === "pending");
    },
    async updateChange(companyId, id, patch, onlyPending) {
      const c = changes.find((x) => x.companyId === companyId && x.id === id && (!onlyPending || x.status === "pending"));
      if (!c) return false;
      if (patch.status) {
        c.status = patch.status;
        c.decidedAt = "2026-10-10T09:00:00Z";
      }
      if (patch.resultVersion != null) c.resultVersion = patch.resultVersion;
      if (patch.decidedBy !== undefined) c.decidedBy = patch.decidedBy;
      if (patch.decisionNote !== undefined) c.decisionNote = patch.decisionNote;
      return true;
    },
  };
}

const SPRINT: Row = {
  id: "sp-1", company_id: "co-1", name: "Acme", site_url: "https://acme.co.za", site_name: "Acme", client_kind: "company", client_ref: "crm-1", client_name: "Acme Ltd",
  status: "active", start_date: "2026-09-01", template_id: "outrank-90", template_version: 3, autopilot_mode: "safe", owner_user_id: "user-1",
  project_id: "proj-1", root_issue_id: "root-1", root_issue_identifier: "PIB-1", agent_id: "agent-1", notes: null, paused_reason: null,
  health: {}, scoreboard: {}, today: {}, current_day: 40, current_week: 6, current_phase: 2, last_daily_on: null, last_weekly_on: null,
  audit_days_done: [0, 30], seeded_at: "2026-09-01T00:00:00Z", site_access: "repo", change_policy: "merge_seo_scope", verification: {},
  created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};

/** Fake host: sprints from rows, a stateful Needs you table, issues that always succeed. */
function host(sprints: Row[]) {
  const needsYou = new Map<string, Row>();
  const issuesCreated: Row[] = [];
  const ctx = {
    db: {
      namespace: NAMESPACE,
      async query(sql: string, params: unknown[] = []) {
        validateRuntimeQuery(sql, NAMESPACE, ["heartbeat_runs"]);
        validateParams(sql, params);
        if (sql.includes(`FROM ${NAMESPACE}.sprints WHERE id = $1`)) return sprints.filter((s) => s.id === params[0]);
        if (sql.includes(`FROM ${NAMESPACE}.sprints WHERE company_id = $1`)) return sprints;
        if (sql.includes(`FROM ${NAMESPACE}.needs_you`) && sql.includes("week_start = $3::date")) {
          const row = needsYou.get(`${params[1]}:${params[2]}`);
          return row ? [row] : [];
        }
        if (sql.includes(`FROM ${NAMESPACE}.optimizations WHERE id = $1`)) return [{ id: params[0], company_id: "co-1", sprint_id: "sp-1", signal_type: "stuck_page", status: "measured" }];
        return [];
      },
      async execute(sql: string, params: unknown[] = []) {
        validateRuntimeExecute(sql, NAMESPACE);
        validateParams(sql, params);
        if (sql.startsWith(`INSERT INTO ${NAMESPACE}.needs_you`)) {
          const key = `${params[2]}:${params[3]}`;
          const prev = needsYou.get(key);
          needsYou.set(key, { ...(prev ?? {}), id: prev?.id ?? params[0], company_id: params[1], sprint_id: params[2], week_start: params[3], items: params[4], status: params[5] });
        }
        if (sql.startsWith(`UPDATE ${NAMESPACE}.needs_you SET issue_id`)) {
          for (const row of needsYou.values()) if (row.id === params[2]) Object.assign(row, { issue_id: params[0], issue_identifier: params[1] });
        }
        return { rowCount: 1 };
      },
    },
    config: { get: vi.fn(async () => ({ saved: true })) },
    secrets: { resolve: vi.fn(async () => "") },
    companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PIB" })) },
    issues: {
      get: vi.fn(async (id: string) => ({ id, status: "todo", identifier: "PIB-7" })),
      update: vi.fn(async (id: string, patch: Row) => ({ id, ...patch })),
      createComment: vi.fn(async () => ({ id: "c" })),
      create: vi.fn(async (input: Row) => {
        issuesCreated.push(input);
        return { id: `iss-${issuesCreated.length}` };
      }),
      requestWakeup: vi.fn(async () => ({ queued: true, runId: null })),
    },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    skills: { managed: { reconcile: vi.fn(), reset: vi.fn() } },
    state: { get: vi.fn(async () => null), set: vi.fn() },
  } as unknown as PluginContext;
  const store = memoryStore();
  const env = createEnv(ctx, { now: () => new Date("2026-10-10T08:00:00Z"), fetch: vi.fn() as never, site: vi.fn() as never, playbooks: store });
  const items = () => [...needsYou.values()].flatMap((row) => JSON.parse(String(row.items)) as Array<{ key: string; status: string; title: string; steps: string[] }>);
  return { env, store, items, issuesCreated };
}

const agent: Actor = { kind: "agent", agentId: "agent-1", runId: "run-1", responsibleUserId: null };
const person: Actor = { kind: "user", userId: "user-1" };

describe("learned playbook service", () => {
  it("creates one playbook per client scope on first read, with a starter version", async () => {
    const { env, store } = host([SPRINT, { ...SPRINT, id: "sp-2", created_at: "2026-09-20T00:00:00Z" }]);
    const first = await getPlaybookTool(env, "co-1", agent, { sprintId: "sp-1" });
    const second = await getPlaybookTool(env, "co-1", agent, { sprintId: "sp-2" });
    expect(first.playbookId).toBe(second.playbookId); // shared across the client's sprints
    expect(first).toMatchObject({ client: "company:crm-1", clientName: "Acme Ltd", version: 1, autopilotMode: "safe", pendingChanges: [] });
    expect(first.playbook).toContain("# Acme Ltd SEO playbook");
    expect(store.playbooks).toHaveLength(1);
    expect(store.playbooks[0]!.scopeKey).toBe("company:crm-1");
    expect(first.versions).toEqual([expect.objectContaining({ version: 1, reason: "Starter playbook" })]);
    await expect(getPlaybookTool(env, "co-1", agent, {})).rejects.toThrow(/Pass sprintId, or client/);
    await expect(getPlaybookTool(env, "co-1", agent, { sprintId: "sp-1", client: "own" })).rejects.toThrow(/belongs to company:crm-1/);
  });

  it("safe autopilot: the agent proposes, only a person decides, and the change is batched on Needs you", async () => {
    const { env, store, items, issuesCreated } = host([SPRINT]);
    const proposed = await proposePlaybookChangeTool(env, "co-1", agent, { sprintId: "sp-1", op: "add", section: "rules", text: "Add an FAQ block to pages stuck in 8–20", reason: "Won twice" });
    expect(proposed).toMatchObject({ status: "pending", source: "agent", diff: "+ Rules we follow: - Add an FAQ block to pages stuck in 8–20" });
    expect(proposed.message).toMatch(/Waiting for a person/);
    const again = await proposePlaybookChangeTool(env, "co-1", agent, { sprintId: "sp-1", text: "Add an FAQ block to pages stuck in 8–20", reason: "Won twice" });
    expect(again.message).toMatch(/already pending/);
    await proposePlaybookChangeTool(env, "co-1", agent, { sprintId: "sp-1", section: "avoid", text: "Mass directory submissions", reason: "No impressions after 60 days" });

    const open = items().filter((i) => i.key === PLAYBOOK_ITEM_KEY && i.status === "open");
    expect(open).toHaveLength(1); // one item for both changes
    expect(open[0]!.title).toBe("Keep or discard 2 learned SEO playbook changes");
    expect(issuesCreated.filter((i) => String(i.title).includes("Needs you"))).toHaveLength(1);

    await expect(decidePlaybookChangeTool(env, "co-1", agent, { changeId: proposed.changeId, decision: "keep" })).rejects.toThrow(/Only a person/);
    const kept = await decidePlaybookChangeTool(env, "co-1", person, { changeId: proposed.changeId, decision: "keep" });
    expect(kept).toEqual({ changeId: proposed.changeId, status: "kept", playbookVersion: 2 });
    await expect(decidePlaybookChangeTool(env, "co-1", person, { changeId: proposed.changeId, decision: "discard" })).rejects.toThrow(/already kept/);

    const view = await getPlaybookTool(env, "co-1", agent, { sprintId: "sp-1" });
    expect(view.version).toBe(2);
    expect(view.playbook).toContain("- Add an FAQ block to pages stuck in 8–20");
    expect(view.versions[0]).toMatchObject({ version: 2, reason: "Won twice", changeId: proposed.changeId, decidedBy: "user-1" });
    expect(view.pendingChanges).toHaveLength(1);
    expect(items().find((i) => i.key === PLAYBOOK_ITEM_KEY)!.title).toBe("Keep or discard 1 learned SEO playbook change");

    const last = view.pendingChanges[0]!;
    await decidePlaybookChangeTool(env, "co-1", person, { changeId: last.changeId, decision: "discard", note: "Too early" });
    expect(items().find((i) => i.key === PLAYBOOK_ITEM_KEY)!.status).toBe("done"); // closes once nothing is pending
    expect(store.changes.find((c) => c.id === last.changeId)).toMatchObject({ status: "discarded", decisionNote: "Too early" });
  });

  it("refuses agent proposals on autopilot off and removals that do not match", async () => {
    const off = host([{ ...SPRINT, autopilot_mode: "off" }]);
    await expect(proposePlaybookChangeTool(off.env, "co-1", agent, { sprintId: "sp-1", text: "Some rule", reason: "r" })).rejects.toThrow(/Autopilot is off/);
    const person1 = await proposePlaybookChangeTool(off.env, "co-1", person, { sprintId: "sp-1", text: "Some rule", reason: "r" });
    expect(person1.source).toBe("person");
    const safe = host([SPRINT]);
    await expect(proposePlaybookChangeTool(safe.env, "co-1", agent, { sprintId: "sp-1", op: "remove", text: "Not there", reason: "r" })).rejects.toBeInstanceOf(SeoError);
  });

  it("full autopilot: measured wins are kept at once, losses wait for the agent, one draft per optimization", async () => {
    const { env, store, items } = host([{ ...SPRINT, autopilot_mode: "full" }]);
    const info = { companyId: "co-1", today: "2026-10-10", prefix: "PIB" } as never;
    const sprint = (await db.getSprint(env.ctx.db, "co-1", "sp-1"))!;
    const o = { id: "o-1", hypothesis: "The page lacks internal authority", hypothesisType: "stuck_page:internal-links", proposedAction: "Add 3+ internal links to /pricing" } as db.Optimization;
    const win = await draftFromMeasurement(env, info, sprint, o, { result: "win", reasons: ["Average position improved by 3."] });
    expect(win).toMatchObject({ kept: true, version: 2 });
    expect(await draftFromMeasurement(env, info, sprint, o, { result: "win", reasons: ["again"] })).toBeNull();
    expect(await draftFromMeasurement(env, info, sprint, { ...o, id: "o-2" }, { result: "no_change", reasons: [] })).toBeNull();
    const loss = await draftFromMeasurement(env, info, sprint, { ...o, id: "o-3", proposedAction: "Rewrite the title tag" }, { result: "loss", reasons: ["Impressions down 25%."] });
    expect(loss).toMatchObject({ kept: false, version: null });
    expect(store.playbooks[0]!.playbook).toContain("- Add 3+ internal links to /pricing (win on 2026-10-10");
    expect(store.versions.find((v) => v.version === 2)).toMatchObject({ decidedBy: "autopilot", optimizationId: "o-1" });
    expect(items().some((i) => i.key === PLAYBOOK_ITEM_KEY)).toBe(false); // the agent decides on full

    const decided = await decidePlaybookChangeTool(env, "co-1", agent, { changeId: loss!.changeId, decision: "keep" });
    expect(decided).toMatchObject({ status: "kept", playbookVersion: 3 });
    expect(store.playbooks[0]!.playbook.split("## Things that did not work")[1]).toContain("- Rewrite the title tag (loss on 2026-10-10");
  });

  it("safe autopilot: a measured win is drafted for a person, not kept", async () => {
    const { env, items } = host([SPRINT]);
    const info = { companyId: "co-1", today: "2026-10-10", prefix: "PIB" } as never;
    const sprint = (await db.getSprint(env.ctx.db, "co-1", "sp-1"))!;
    const o = { id: "o-9", hypothesis: "h", hypothesisType: "cwv:fix", proposedAction: "Compress hero images" } as db.Optimization;
    expect(await draftFromMeasurement(env, info, sprint, o, { result: "win", reasons: ["Impressions up 40%."] })).toMatchObject({ kept: false });
    const item = items().find((i) => i.key === PLAYBOOK_ITEM_KEY)!;
    expect(item.status).toBe("open");
    expect(item.steps[0]).toContain("+ Rules we follow: - Compress hero images (win on 2026-10-10");
  });
});
