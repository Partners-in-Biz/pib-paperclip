/** Growth service measuring: min per arm, keep/revert, tie, the 21-day cut-off, and the events it emits. */
import { describe, expect, it, vi } from "vitest";
import * as E from "../src/growth/engine.js";
import * as S from "../src/growth/service.js";
import { GROWTH_EVENTS } from "../src/contracts.js";
import { starterPlaybook } from "../src/experiments.js";

const DAY = 24 * 3600_000;
const START = new Date("2026-09-01T10:00:00Z");

type Arm = "control" | "variant";

function setup(opts: { autopilot?: E.Autopilot; scope?: { kind: string; id: string } | null; lifts: Array<[Arm, number | null]>; minPerArm?: number; daysSinceStart?: number }) {
  const program: any = {
    id: "prog-1", companyId: "co", channel: "social", clientKind: opts.scope?.kind ?? null, clientRef: opts.scope?.id ?? null, clientName: null,
    autopilot: opts.autopilot ?? "safe", playbook: starterPlaybook("t"), playbookVersion: 1, scoreboard: {}, approvalIssueId: null, approvalWeek: null,
  };
  const exp: any = {
    id: "exp-1", companyId: "co", programId: "prog-1", status: "running", hypothesis: "Questions beat statements", hypothesisType: "hook:question",
    arms: [{ key: "control", description: "Statement" }, { key: "variant", description: "Question" }], minPerArm: opts.minPerArm ?? 3,
    startedAt: START.toISOString(), approvalIssueId: null,
  };
  const changes: any[] = [];
  const posts = opts.lifts.map(([arm, lift], i) => ({ postId: `p${i}`, arm, status: "published", lifts: [lift] }));
  const store: any = {
    experimentPosts: async () => posts,
    listItems: async () => [],
    upsertItem: vi.fn(async () => undefined),
    deleteItem: vi.fn(async () => undefined),
    getProgram: async (_c: string, id: string) => (id === program.id ? structuredClone(program) : null),
    updateProgram: async (_c: string, _id: string, patch: any) => { Object.assign(program, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))); },
    updateExperiment: async (_c: string, _id: string, from: string[] | null, patch: any) => {
      if (from && !from.includes(exp.status)) return false;
      Object.assign(exp, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
      return true;
    },
    insertChange: async (c: any) => { changes.push({ ...c, status: "pending", approvalIssueId: null }); },
    getChange: async (_c: string, id: string) => structuredClone(changes.find((c) => c.id === id) ?? null),
    updateChange: async (_c: string, id: string, patch: any, onlyPending: boolean) => {
      const c = changes.find((x) => x.id === id);
      if (!c || (onlyPending && c.status !== "pending")) return false;
      Object.assign(c, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
      return true;
    },
    savePlaybook: async (_c: string, _id: string, v: number, playbook: string) => {
      if (program.playbookVersion !== v) return false;
      program.playbook = playbook;
      program.playbookVersion += 1;
      return true;
    },
    insertPlaybookVersion: async () => undefined,
  };
  const emit = vi.fn(async () => undefined);
  const now = new Date(START.getTime() + (opts.daysSinceStart ?? 8) * DAY);
  const env: any = {
    ctx: { logger: { info: vi.fn() }, events: { emit } },
    store, now: () => now, timezone: "UTC",
    issuePort: () => ({ createApproval: async () => ({ id: "iss-1" }), isOpen: async () => true, setStatus: async () => undefined, comment: async () => undefined }),
    buildApprovalInput: () => ({}),
    changeLines: (c: any) => [c.diff],
    verdictComment: (_e: any, verdict: string) => `verdict ${verdict}`,
  };
  return { env, exp, program, changes, emit };
}

const lifts = (control: number[], variant: number[]): Array<[Arm, number]> => [...control.map((v) => ["control", v] as [Arm, number]), ...variant.map((v) => ["variant", v] as [Arm, number])];
const verdictEvent = (emit: any) => emit.mock.calls.find((c: any[]) => c[0] === GROWTH_EVENTS.verdict);

describe("measureExperiment", () => {
  it("waits below minPerArm before the cut-off", async () => {
    const t = setup({ lifts: lifts([0.1, 0.1], [0.5, 0.5]) });
    expect(await S.measureExperiment(t.env, t.exp)).toBe("waiting");
    expect(t.exp.status).toBe("running");
    expect(t.emit).not.toHaveBeenCalled();
  });

  it("measures at minPerArm: a win proposes a keep on safe autopilot", async () => {
    const t = setup({ lifts: lifts([0, 0, 0], [0.5, 0.6, 0.7]) });
    expect(await S.measureExperiment(t.env, t.exp)).toBe("measured");
    expect(t.exp).toMatchObject({ status: "measured", verdict: "win", playbookDecision: "pending" });
    expect(t.changes).toHaveLength(1);
    expect(t.changes[0]).toMatchObject({ section: "rules", status: "pending" });
    expect(t.program.playbookVersion).toBe(1);
    expect(t.program.scoreboard["hook:question"].wins).toBe(1);
    const [name, companyId, payload] = verdictEvent(t.emit);
    expect(companyId).toBe("co");
    expect(payload).toEqual({
      channel: "social", scope_key: null, experiment_id: "exp-1", verdict: "win", relative_change: expect.any(Number), items: 6, min_per_arm: 3,
      playbook_decision: "pending", decided_by: null, decided_at: null,
    });
    expect(name).toBe("growth.verdict");
  });

  it("keeps a win automatically on full autopilot and reports who decided", async () => {
    const t = setup({ autopilot: "full", scope: { kind: "company", id: "c1" }, lifts: lifts([0, 0, 0], [0.5, 0.6, 0.7]) });
    await S.measureExperiment(t.env, t.exp);
    expect(t.changes[0].status).toBe("kept");
    expect(t.program.playbookVersion).toBe(2);
    expect(t.program.playbook).toContain("Question");
    expect(verdictEvent(t.emit)[2]).toMatchObject({ scope_key: "company:c1", playbook_decision: "kept", decided_by: "autopilot", decided_at: new Date(t.env.now()).toISOString() });
  });

  it("a loss is not auto-kept: it proposes an 'avoid' rule", async () => {
    const t = setup({ autopilot: "full", lifts: lifts([0.5, 0.5, 0.5], [0, 0, 0]) });
    await S.measureExperiment(t.env, t.exp);
    expect(t.exp.verdict).toBe("loss");
    expect(t.changes[0]).toMatchObject({ section: "avoid", status: "pending" });
    expect(t.program.playbookVersion).toBe(1);
    expect(verdictEvent(t.emit)[2]).toMatchObject({ verdict: "loss", playbook_decision: "pending", decided_by: null });
  });

  it("a tie is no_change: no playbook change", async () => {
    const t = setup({ lifts: lifts([0.2, 0.2, 0.2], [0.2, 0.2, 0.2]) });
    await S.measureExperiment(t.env, t.exp);
    expect(t.exp.verdict).toBe("no_change");
    expect(t.changes).toHaveLength(0);
    expect(verdictEvent(t.emit)[2]).toMatchObject({ verdict: "no_change", playbook_decision: null });
  });

  it("after 21 days it measures with too few scores and says inconclusive", async () => {
    const t = setup({ lifts: lifts([0.1], [0.9]), daysSinceStart: E.MEASURE_CUTOFF_DAYS }) ;
    expect(await S.measureExperiment(t.env, t.exp)).toBe("measured");
    expect(t.exp.verdict).toBe("inconclusive");
    expect(t.changes).toHaveLength(0);
    expect(verdictEvent(t.emit)[2]).toMatchObject({ verdict: "inconclusive", relative_change: null, items: 2 });
  });

  it("one day short of the cut-off still waits", async () => {
    const t = setup({ lifts: lifts([0.1], [0.9]), daysSinceStart: E.MEASURE_CUTOFF_DAYS - 1 });
    expect(await S.measureExperiment(t.env, t.exp)).toBe("waiting");
  });

  it("an emit failure does not undo the measurement", async () => {
    const t = setup({ lifts: lifts([0, 0, 0], [0.5, 0.6, 0.7]) });
    t.emit.mockRejectedValueOnce(new Error("bus down"));
    expect(await S.measureExperiment(t.env, t.exp)).toBe("measured");
    expect(t.exp.status).toBe("measured");
  });
});

describe("growth.program.upserted", () => {
  it("is emitted when a program is created and when a person updates it", async () => {
    const t = setup({ lifts: [] });
    const programs: any[] = [];
    t.env.store.findProgram = async () => programs[0] ?? null;
    t.env.store.insertProgram = async (p: any) => { programs.push({ ...p, channel: "social" }); };
    t.env.store.getProgram = async () => programs[0] ?? null;
    t.env.store.updateProgram = async (_c: string, _i: string, patch: any) => { Object.assign(programs[0], Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))); };
    t.env.store.insertPlaybookVersion = async () => undefined;
    t.env.starterPlaybook = () => "# p";
    t.env.scopes = { fromParams: async () => ({ scope: { kind: "company", id: "c9" }, client: { name: "Nine" } }) };
    t.env.programOut = (p: any) => p;
    const person = { companyId: "co", userId: "u1", agentId: null, isAgent: false };
    await S.updateProgramRecord(t.env, person, { autopilot: "full" });
    const calls = t.emit.mock.calls.filter((c: any[]) => c[0] === GROWTH_EVENTS.programUpserted);
    expect(calls.map((c: any[]) => c[2])).toEqual([
      expect.objectContaining({ channel: "social", scope_key: "company:c9", created: true, autopilot: "safe" }),
      expect.objectContaining({ scope_key: "company:c9", created: false, autopilot: "full" }),
    ]);
  });
});
