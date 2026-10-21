/**
 * Growth Lab service lifecycle: tests that the decision gates enforce the semantics
 * for off|safe|reviewed|full autopilot modes across actors and actions.
 * Models the in-memory fakes after plugin-social/tests/memory-store.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as E from "../src/growth/engine.js";
import * as S from "../src/growth/service.js";
import { starterPlaybook, type Verdict } from "../src/experiments.js";
import { sameClient, scopeOfRow, type ClientScope } from "../src/client-ref.js";
import type { GrowthStore, ApprovalIssuePort, ScopeResolver } from "../src/growth/ports.js";

const DAY = 24 * 3600_000;
const NOW = new Date("2026-09-26T10:00:00Z");

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Minimal in-memory fake GrowthStore ──────────────────────────────────────

interface FakeProgram {
  id: string;
  companyId: string;
  channel: string;
  clientKind: string | null;
  clientRef: string | null;
  clientName: string | null;
  autopilot: E.Autopilot;
  playbook: string;
  playbookVersion: number;
  approvalIssueId: string | null;
  approvalWeek: string | null;
  objective: string;
  metric: string;
  constraints: Record<string, unknown>;
  scoreboard: Record<string, unknown>;
  featureQuestions: any[];
  ownerUserId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface FakeExperiment {
  id: string;
  companyId: string;
  programId: string;
  status: string;
  hypothesis: string;
  hypothesisType: string;
  variable: string;
  arms: E.ArmSpec[];
  metric: string;
  minPerArm: number;
  windowDays: number;
  proposedBy: string;
  approvedAt: string | null;
  approvedBy: string | null;
  startedAt: string | null;
  measureAfter: string | null;
  measuredAt: string | null;
  verdict: string | null;
  outcome: any;
  playbookDiff: string | null;
  playbookDecision: string | null;
  decisionNote: string | null;
  approvalIssueId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FakeChange {
  id: string;
  companyId: string;
  programId: string;
  experimentId: string | null;
  status: string;
  op: string;
  section: string | null;
  body: string;
  diff: string;
  reason: string;
  baseVersion: number;
  proposedBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  resultVersion: number | null;
  approvalIssueId: string | null;
  createdAt: string;
}

interface FakeVersion {
  programId: string;
  version: number;
  playbook: string;
  reason: string;
  experimentId: string | null;
  createdBy: string | null;
  createdAt: string;
}

function fakeGrowthStore(): any {
  let clock = 0;
  const stamp = () => new Date(Date.now() + clock++).toISOString();

  const db = {
    programs: [] as FakeProgram[],
    experiments: [] as FakeExperiment[],
    changes: [] as FakeChange[],
    versions: [] as FakeVersion[],
  };

  const scopeMatch = (row: { clientKind?: string | null; clientRef?: string | null }, scope: ClientScope): boolean => {
    return sameClient(scopeOfRow({ client_kind: row.clientKind ?? null, client_ref: row.clientRef ?? null }), scope);
  };

  const copy = <T>(value: T): T => structuredClone(value);
  const defined = <T extends object>(patch: T): Partial<T> => Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;

  const store: GrowthStore = {
    async findProgram(companyId, channel, scope) {
      return copy(db.programs.find((p) => p.companyId === companyId && p.channel === channel && scopeMatch(p, scope)) ?? null);
    },
    async getProgram(companyId, id) {
      return copy(db.programs.find((p) => p.id === id && p.companyId === companyId) ?? null);
    },
    async insertProgram(p: any) {
      if (db.programs.some((x) => x.companyId === p.companyId && x.channel === p.channel && scopeMatch(x, scopeOfRow({ client_kind: p.clientKind, client_ref: p.clientRef })))) return;
      db.programs.push({ ...p, status: "active", approvalIssueId: null, approvalWeek: null, createdAt: stamp(), updatedAt: stamp() });
    },
    async updateProgram(companyId, id, patch) {
      const p = db.programs.find((x) => x.id === id && x.companyId === companyId);
      if (p) Object.assign(p, defined(patch as any), { updatedAt: stamp() });
    },
    async savePlaybook(companyId, id, expectedVersion, playbook) {
      const p = db.programs.find((x) => x.id === id && x.companyId === companyId && x.playbookVersion === expectedVersion);
      if (!p) return false;
      p.playbook = playbook;
      p.playbookVersion += 1;
      return true;
    },
    async insertPlaybookVersion(v) {
      if (db.versions.some((x) => x.programId === v.programId && x.version === v.version)) return;
      db.versions.push({ ...v, createdAt: stamp() });
    },
    async listPlaybookVersions(programId, limit) {
      return copy(db.versions.filter((v) => v.programId === programId).sort((a, b) => b.version - a.version).slice(0, limit));
    },
    async insertExperiment(e: any) {
      db.experiments.push({
        ...e,
        approvalIssueId: null,
        approvedAt: null,
        approvedBy: null,
        startedAt: null,
        measureAfter: null,
        measuredAt: null,
        verdict: null,
        outcome: null,
        playbookDiff: null,
        playbookDecision: null,
        decisionNote: null,
        createdAt: stamp(),
        updatedAt: stamp(),
      });
    },
    async getExperiment(companyId, id) {
      return copy(db.experiments.find((e) => e.id === id && e.companyId === companyId) ?? null);
    },
    async listExperiments(companyId, programId, statuses) {
      return copy(db.experiments.filter((e) => e.companyId === companyId && e.programId === programId && (!statuses?.length || statuses.includes(e.status))).reverse());
    },
    async updateExperiment(companyId, id, from, patch: any) {
      const e = db.experiments.find((x) => x.id === id && x.companyId === companyId && (!from || from.includes(x.status)));
      if (!e) return false;
      Object.assign(e, defined(patch), { updatedAt: stamp() });
      return true;
    },
    async companiesWithRunningExperiments() {
      return Array.from(new Set(db.experiments.filter((e) => e.status === "running").map((e) => e.companyId)));
    },
    async runningExperiments(companyId) {
      return copy(db.experiments.filter((e) => e.companyId === companyId && e.status === "running"));
    },
    async upsertItem() {
      /* no-op */
    },
    async deleteItem() {
      /* no-op */
    },
    async listItems() {
      return [];
    },
    async insertChange(c: any) {
      db.changes.push({ ...c, status: "pending", resultVersion: null, decidedBy: null, decidedAt: null, decisionNote: null, approvalIssueId: null, createdAt: stamp() });
    },
    async getChange(companyId, id) {
      return copy(db.changes.find((c) => c.id === id && c.companyId === companyId) ?? null);
    },
    async listChanges(companyId, programId, status) {
      return copy(db.changes.filter((c) => c.companyId === companyId && c.programId === programId && (!status || c.status === status)).reverse());
    },
    async updateChange(companyId, id, patch: any, onlyPending) {
      const c = db.changes.find((x) => x.id === id && x.companyId === companyId && (!onlyPending || x.status === "pending"));
      if (!c) return false;
      Object.assign(c, defined(patch));
      if (patch.status) c.decidedAt = stamp();
      return true;
    },
  };

  return { store, db };
}

// ── Test setup ──────────────────────────────────────────────────────────────

const STARTER_PLAYBOOK = `# PiB playbook

## Goal
${E.DEFAULT_OBJECTIVE}

## Rules we follow
(none yet)

## Things that did not work
(none yet)

## Open questions to test
(none yet)

## Constraints
(none yet)
`;

function setup(mode: E.Autopilot = "safe", scopeKind: "company" | null = null) {
  const { store, db } = fakeGrowthStore();
  const issues = new Map<string, { id: string; status: string }>();
  let issueCount = 0;

  const issuePort: ApprovalIssuePort = {
    async createApproval() {
      const id = `iss-${++issueCount}`;
      issues.set(id, { id, status: "todo" });
      return { id };
    },
    async isOpen(companyId, issueId) {
      return (issues.get(issueId)?.status ?? "done") !== "done";
    },
    async setStatus(companyId, issueId, status) {
      const issue = issues.get(issueId);
      if (issue) issue.status = status;
    },
    async comment() {
      /* no-op */
    },
  };

  const scopes: ScopeResolver = {
    async fromParams(companyId, params) {
      return { scope: scopeKind ? { kind: scopeKind, id: "c1" } : null };
    },
    toParam(scope) {
      return scope ? `${scope.kind}:${scope.id}` : "own";
    },
  };

  const ctx = {
    logger: { info: vi.fn() },
  };

  const env = {
    ctx,
    store,
    now: () => NOW,
    scopes,
    timezone: "Africa/Johannesburg",
    starterPlaybook: (target: any) => {
      const title = target.scope ? `${target.name ?? target.scope.id} social` : "PiB social";
      return starterPlaybook(title).replace("(what we optimise, in one sentence)", E.DEFAULT_OBJECTIVE);
    },
    issuePort: () => issuePort,
    buildApprovalInput: () => ({ title: "Approve" }),
    experimentLines: (e: any) => [`Test: ${e.hypothesis}`],
    changeLines: (c: any) => [`Change: ${c.diff}`],
    actorLabel: (actor: S.GrowthActor) => (actor.isAgent ? "agent" : "person"),
    experimentOut: (e: any) => ({ experimentId: e.id, status: e.status, hypothesisType: e.hypothesisType, minPerArm: e.minPerArm, approvalIssueId: e.approvalIssueId }),
    changeOut: (c: any) => ({ changeId: c.id, status: c.status, diff: c.diff }),
    programOut: (p: any) => ({ client: null }),
  };

  return { store, db, env, issues };
}

describe("growth service lifecycle semantics", () => {
  describe("experiment decision gates", () => {
    it("off mode: agents cannot propose", async () => {
      const { env, db, store } = setup("off");
      const program = db.programs[0] ?? (await (async () => {
        await store.insertProgram({
          id: "prog-1",
          companyId: "co",
          channel: "social",
          clientKind: null,
          clientRef: null,
          clientName: null,
          autopilot: "off",
          playbook: STARTER_PLAYBOOK,
          playbookVersion: 1,
          objective: E.DEFAULT_OBJECTIVE,
          metric: E.DEFAULT_METRIC,
          constraints: {},
          scoreboard: {},
          featureQuestions: [],
          ownerUserId: null,
        });
        return (await store.getProgram("co", "prog-1"))!;
      })());

      const agent: S.GrowthActor = { companyId: "co", userId: null, agentId: "a1", isAgent: true };
      const proposal = { hypothesis: "Test whether question hooks improve engagement rates significantly", hypothesisType: "hook:question", variable: "hook", arms: [{ key: "control", description: "Statement hook" }, { key: "variant", description: "Question hook" }], minPerArm: 3, windowDays: 7 };

      // Agents cannot propose in off mode
      await expect(S.proposeExperiment(env as any, agent, proposal as any)).rejects.toThrow(/autopilot is off/);
    });

    it("safe mode: agents propose, only person approves", async () => {
      const { env, db, store } = setup("safe");
      await store.insertProgram({
        id: "prog-1",
        companyId: "co",
        channel: "social",
        clientKind: null,
        clientRef: null,
        clientName: null,
        autopilot: "safe",
        playbook: STARTER_PLAYBOOK,
        playbookVersion: 1,
        objective: E.DEFAULT_OBJECTIVE,
        metric: E.DEFAULT_METRIC,
        constraints: {},
        scoreboard: {},
        featureQuestions: [],
        ownerUserId: null,
      });

      const agent: S.GrowthActor = { companyId: "co", userId: null, agentId: "a1", isAgent: true };
      const person: S.GrowthActor = { companyId: "co", userId: "u1", agentId: null, isAgent: false };
      const proposal = { hypothesis: "Test whether question hooks improve engagement", hypothesisType: "hook:question", variable: "hook", arms: [{ key: "control", description: "Statement hook" }, { key: "variant", description: "Question hook" }], minPerArm: 3, windowDays: 7 };

      // Agent proposes → proposed state
      const result = await S.proposeExperiment(env as any, agent, proposal as any);
      expect(result.status).toBe("proposed");

      // Agent cannot approve
      await expect(S.approveExperiment(env as any, agent, { experimentId: result.experimentId, note: "" } as any)).rejects.toThrow(/Only a person approves/);

      // Person approves → running state
      const approved = await S.approveExperiment(env as any, person, { experimentId: result.experimentId, note: "" } as any);
      expect(approved.status).toBe("running");
    });

    it("reviewed mode: agents propose, person or Reviewer decides, no auto-start", async () => {
      const { env, db, store } = setup("safe");
      await store.insertProgram({
        id: "prog-1",
        companyId: "co",
        channel: "social",
        clientKind: null,
        clientRef: null,
        clientName: null,
        autopilot: "reviewed",
        playbook: STARTER_PLAYBOOK,
        playbookVersion: 1,
        objective: E.DEFAULT_OBJECTIVE,
        metric: E.DEFAULT_METRIC,
        constraints: {},
        scoreboard: {},
        featureQuestions: [],
        ownerUserId: null,
      });

      const agent: S.GrowthActor = { companyId: "co", userId: null, agentId: "a1", isAgent: true };
      const reviewer: S.GrowthActor = { companyId: "co", userId: "u1", agentId: null, isAgent: false, isReviewer: true };
      const plainAgent: S.GrowthActor = { companyId: "co", userId: null, agentId: "a2", isAgent: true }; // No isReviewer
      const agentReviewer: S.GrowthActor = { companyId: "co", userId: null, agentId: "a3", isAgent: true, isReviewer: true };
      const proposal = { hypothesis: "Test whether question hooks improve engagement", hypothesisType: "hook:question", variable: "hook", arms: [{ key: "control", description: "Statement hook" }, { key: "variant", description: "Question hook" }], minPerArm: 3, windowDays: 7 };

      // Update to reviewed mode
      await store.updateProgram("co", "prog-1", { autopilot: "reviewed" });

      // Agent proposes → proposed state (no auto-start in reviewed)
      const result = await S.proposeExperiment(env as any, agent, proposal as any);
      expect(result.status).toBe("proposed");

      // Reviewer (person with isReviewer:true) can approve
      const approved = await S.approveExperiment(env as any, reviewer, { experimentId: result.experimentId, note: "" } as any);
      expect(approved.status).toBe("running");

      // Plain agent (without isReviewer) cannot approve in reviewed mode
      const proposal2 = { ...proposal, hypothesisType: "hook:bold_claim" };
      const result2 = await S.proposeExperiment(env as any, agent, proposal2 as any);
      await expect(S.approveExperiment(env as any, plainAgent, { experimentId: result2.experimentId, note: "" } as any)).rejects.toThrow(/Only a person/);

      // Agent reviewer CAN approve in reviewed mode
      const proposal3 = { ...proposal, hypothesisType: "hook:story" };
      const result3 = await S.proposeExperiment(env as any, agent, proposal3 as any);
      const agentApproved = await S.approveExperiment(env as any, agentReviewer, { experimentId: result3.experimentId, note: "" } as any);
      expect(agentApproved.status).toBe("running");
    });

    it("full mode: agents decide, auto-starts on propose", async () => {
      const { env, db, store } = setup("safe");
      await store.insertProgram({
        id: "prog-1",
        companyId: "co",
        channel: "social",
        clientKind: null,
        clientRef: null,
        clientName: null,
        autopilot: "full",
        playbook: STARTER_PLAYBOOK,
        playbookVersion: 1,
        objective: E.DEFAULT_OBJECTIVE,
        metric: E.DEFAULT_METRIC,
        constraints: {},
        scoreboard: {},
        featureQuestions: [],
        ownerUserId: null,
      });

      const agent: S.GrowthActor = { companyId: "co", userId: null, agentId: "a1", isAgent: true };
      const proposal = { hypothesis: "Test whether question hooks improve engagement rates significantly", hypothesisType: "hook:question", variable: "hook", arms: [{ key: "control", description: "Statement hook" }, { key: "variant", description: "Question hook" }], minPerArm: 3, windowDays: 7 };

      // Update to full mode
      await store.updateProgram("co", "prog-1", { autopilot: "full" });

      // Agent proposes → auto-starts to running
      const result = await S.proposeExperiment(env as any, agent, proposal as any);
      expect(result.status).toBe("running");
    });

    it("abandon is person-only across all modes", async () => {
      for (const mode of ["safe", "reviewed", "full"] as E.Autopilot[]) {
        const { env, db, store } = setup(mode);
        await store.insertProgram({
          id: "prog-1",
          companyId: "co",
          channel: "social",
          clientKind: null,
          clientRef: null,
          clientName: null,
          autopilot: mode,
          playbook: STARTER_PLAYBOOK,
          playbookVersion: 1,
          objective: E.DEFAULT_OBJECTIVE,
          metric: E.DEFAULT_METRIC,
          constraints: {},
          scoreboard: {},
          featureQuestions: [],
          ownerUserId: null,
        });

        const agent: S.GrowthActor = { companyId: "co", userId: null, agentId: "a1", isAgent: true };
        const person: S.GrowthActor = { companyId: "co", userId: "u1", agentId: null, isAgent: false };
        const proposal = { hypothesis: "Test whether different hooks improve engagement rates significantly", hypothesisType: `hook:${["question", "bold_claim", "story"][["safe", "reviewed", "full"].indexOf(mode)]}`, variable: "hook", arms: [{ key: "control", description: "Statement hook" }, { key: "variant", description: "Question hook" }], minPerArm: 3, windowDays: 7 };

        const result = await S.proposeExperiment(env as any, person, proposal as any);
        const experimentId = result.experimentId;

        // Agent cannot abandon
        await expect(S.abandonExperiment(env as any, agent, { experimentId } as any)).rejects.toThrow(/A person must abandon/);

        // Person can abandon
        const abandoned = await S.abandonExperiment(env as any, person, { experimentId } as any);
        expect(abandoned.status).toBe("abandoned");
      }
    });
  });

  describe("G5 scenario: client-scoped reviewed mode", () => {
    it("Reviewer may approve client experiment but mayDecide clientPost is false", async () => {
      const { env, db, store } = setup("reviewed", "company");
      await store.insertProgram({
        id: "prog-1",
        companyId: "co",
        channel: "social",
        clientKind: "company",
        clientRef: "c1",
        clientName: "ACME",
        autopilot: "reviewed",
        playbook: STARTER_PLAYBOOK,
        playbookVersion: 1,
        objective: E.DEFAULT_OBJECTIVE,
        metric: E.DEFAULT_METRIC,
        constraints: {},
        scoreboard: {},
        featureQuestions: [],
        ownerUserId: null,
      });

      const agent: S.GrowthActor = { companyId: "co", userId: null, agentId: "a1", isAgent: true };
      const reviewer: S.GrowthActor = { companyId: "co", userId: "u1", agentId: null, isAgent: false, isReviewer: true };
      const proposal = { hypothesis: "Test whether question hooks improve engagement rates significantly for client work", hypothesisType: "hook:question", variable: "hook", arms: [{ key: "control", description: "Statement hook" }, { key: "variant", description: "Question hook" }], minPerArm: 3, windowDays: 7 };

      const result = await S.proposeExperiment(env as any, agent, proposal as any);
      expect(result.status).toBe("proposed");

      // Reviewer can approve experiments in reviewed mode
      const approved = await S.approveExperiment(env as any, reviewer, { experimentId: result.experimentId, note: "" } as any);
      expect(approved.status).toBe("running");

      // But mayDecide("reviewed", agentReviewer, "clientPost") is false
      // (persons can always decide, but agent reviewers cannot decide on clientPost)
      const agentReviewer: S.GrowthActor = { companyId: "co", userId: null, agentId: "a2", isAgent: true, isReviewer: true };
      const canDecidePost = E.mayDecide("reviewed", agentReviewer, "clientPost");
      expect(canDecidePost).toBe(false);
    });
  });

  describe("two-scope isolation", () => {
    it("experiments and changes under scope A do not appear in scope B", async () => {
      const { store, env } = setup("safe", "company");

      // Create two programs under different scopes
      await store.insertProgram({
        id: "prog-a",
        companyId: "co",
        channel: "social",
        clientKind: "company",
        clientRef: "c-a",
        clientName: "Client A",
        autopilot: "safe",
        playbook: STARTER_PLAYBOOK,
        playbookVersion: 1,
        objective: E.DEFAULT_OBJECTIVE,
        metric: E.DEFAULT_METRIC,
        constraints: {},
        scoreboard: {},
        featureQuestions: [],
        ownerUserId: null,
      });

      await store.insertProgram({
        id: "prog-b",
        companyId: "co",
        channel: "social",
        clientKind: "company",
        clientRef: "c-b",
        clientName: "Client B",
        autopilot: "safe",
        playbook: STARTER_PLAYBOOK,
        playbookVersion: 1,
        objective: E.DEFAULT_OBJECTIVE,
        metric: E.DEFAULT_METRIC,
        constraints: {},
        scoreboard: {},
        featureQuestions: [],
        ownerUserId: null,
      });

      // Insert experiments under different programs/scopes
      await store.insertExperiment({
        id: "exp-a",
        companyId: "co",
        programId: "prog-a",
        hypothesis: "A test",
        hypothesisType: "hook:question",
        variable: "hook",
        arms: [{ key: "control", description: "A" }, { key: "variant", description: "B" }],
        metric: E.DEFAULT_METRIC,
        minPerArm: 3,
        windowDays: 7,
        status: "proposed",
        proposedBy: "agent:a1",
      });

      await store.insertExperiment({
        id: "exp-b",
        companyId: "co",
        programId: "prog-b",
        hypothesis: "B test",
        hypothesisType: "hook:bold_claim",
        variable: "hook",
        arms: [{ key: "control", description: "C" }, { key: "variant", description: "D" }],
        metric: E.DEFAULT_METRIC,
        minPerArm: 3,
        windowDays: 7,
        status: "proposed",
        proposedBy: "agent:a1",
      });

      // List experiments for program A (scope c-a)
      const listA = await store.listExperiments("co", "prog-a", undefined);
      expect(listA).toHaveLength(1);
      expect(listA[0]!.id).toBe("exp-a");

      // List experiments for program B (scope c-b)
      const listB = await store.listExperiments("co", "prog-b", undefined);
      expect(listB).toHaveLength(1);
      expect(listB[0]!.id).toBe("exp-b");

      // Insert changes under different programs
      await store.insertChange({
        id: "change-a",
        companyId: "co",
        programId: "prog-a",
        experimentId: null,
        op: "add",
        section: "rules",
        body: "Rule for A",
        diff: "+ A rule",
        reason: "Test A",
        baseVersion: 1,
        proposedBy: "agent:a1",
      });

      await store.insertChange({
        id: "change-b",
        companyId: "co",
        programId: "prog-b",
        experimentId: null,
        op: "add",
        section: "rules",
        body: "Rule for B",
        diff: "+ B rule",
        reason: "Test B",
        baseVersion: 1,
        proposedBy: "agent:a1",
      });

      // List changes for program A
      const changesA = await store.listChanges("co", "prog-a", "pending");
      expect(changesA).toHaveLength(1);
      expect(changesA[0]!.id).toBe("change-a");

      // List changes for program B
      const changesB = await store.listChanges("co", "prog-b", "pending");
      expect(changesB).toHaveLength(1);
      expect(changesB[0]!.id).toBe("change-b");

      // Save playbook for A does not affect B
      const progBefore = await store.getProgram("co", "prog-b");
      expect(progBefore!.playbookVersion).toBe(1);

      await store.savePlaybook("co", "prog-a", 1, "Updated playbook A\n");

      const progAfterA = await store.getProgram("co", "prog-a");
      const progAfterB = await store.getProgram("co", "prog-b");
      expect(progAfterA!.playbookVersion).toBe(2);
      expect(progAfterB!.playbookVersion).toBe(1);
    });
  });

  describe("engine-level autoKeep behavior", () => {
    it("autoKeep returns true only for full mode wins", () => {
      expect(E.autoKeep("off", "win")).toBe(false);
      expect(E.autoKeep("safe", "win")).toBe(false);
      expect(E.autoKeep("reviewed", "win")).toBe(false);
      expect(E.autoKeep("full", "win")).toBe(true);
      expect(E.autoKeep("full", "loss")).toBe(false);
      expect(E.autoKeep("full", "inconclusive")).toBe(false);
      expect(E.autoKeep("full", "no_change")).toBe(false);
    });
  });

  describe("playbook change decision gates", () => {
    it("reviewed mode: agents propose, person or Reviewer decides", async () => {
      const { env, db, store } = setup("safe");
      await store.insertProgram({
        id: "prog-1",
        companyId: "co",
        channel: "social",
        clientKind: null,
        clientRef: null,
        clientName: null,
        autopilot: "reviewed",
        playbook: STARTER_PLAYBOOK,
        playbookVersion: 1,
        objective: E.DEFAULT_OBJECTIVE,
        metric: E.DEFAULT_METRIC,
        constraints: {},
        scoreboard: {},
        featureQuestions: [],
        ownerUserId: null,
      });

      await store.updateProgram("co", "prog-1", { autopilot: "reviewed" });

      const agent: S.GrowthActor = { companyId: "co", userId: null, agentId: "a1", isAgent: true };
      const plainAgent: S.GrowthActor = { companyId: "co", userId: null, agentId: "a2", isAgent: true }; // Plain agent without isReviewer
      const reviewer: S.GrowthActor = { companyId: "co", userId: "u1", agentId: null, isAgent: false, isReviewer: true };
      const agentReviewer: S.GrowthActor = { companyId: "co", userId: null, agentId: "a3", isAgent: true, isReviewer: true };

      // Agent proposes change
      const changeResult = await S.proposePlaybookChange(env as any, agent, {
        op: "add",
        section: "rules",
        text: "New rule",
        reason: "Testing",
      } as any);
      expect(changeResult.status).toBe("pending");

      const changeId = changeResult.changeId;

      // Plain agent (without isReviewer) cannot decide
      await expect(S.decidePlaybookChange(env as any, plainAgent, { changeId, decision: "keep" } as any)).rejects.toThrow(/Only a person/);

      // Reviewer (person with isReviewer:true) can decide
      const kept = await S.decidePlaybookChange(env as any, reviewer, { changeId, decision: "keep" } as any);
      expect(kept.status).toBe("kept");

      // Agent reviewer can also decide
      const changeResult2 = await S.proposePlaybookChange(env as any, agent, {
        op: "add",
        section: "rules",
        text: "Another rule",
        reason: "Testing 2",
      } as any);
      const kept2 = await S.decidePlaybookChange(env as any, agentReviewer, { changeId: changeResult2.changeId, decision: "discard" } as any);
      expect(kept2.status).toBe("discarded");
    });
  });
});
