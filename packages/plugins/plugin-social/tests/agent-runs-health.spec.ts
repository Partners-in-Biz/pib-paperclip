/**
 * 0.7.2: the Social agent that cannot start.
 *
 * The plugin cannot give its managed project a workspace policy (see README),
 * so a project with no policy and a folder that is not a git checkout makes
 * every run stop at the host's workspace check. The plugin cannot fix that, but
 * it can say so: the Cockpit health reads the agent's latest runs.
 */
import { describe, expect, it, vi } from "vitest";
import { agentRunChecks, cockpitSnapshot, WORKSPACE_FAILURE_CODE, WORKSPACE_FIX } from "../src/cockpit.js";
import { fakeCtx } from "./helpers.js";

const FAIL = (at: string) => ({ error_code: WORKSPACE_FAILURE_CODE, at });
const OK = (at: string) => ({ error_code: null, at });

describe("agentRunChecks", () => {
  it("is fine without runs, or when the latest run got past the workspace check", () => {
    expect(agentRunChecks([], "p1")).toEqual([{ key: "agent-runs", title: "Social agent runs", status: "ok" }]);
    expect(agentRunChecks([OK("2026-10-03T07:00:00Z"), FAIL("2026-10-03T05:00:00Z")], "p1")).toEqual([{ key: "agent-runs", title: "Social agent runs", status: "ok" }]);
    // Other failures are not this check's business.
    expect(agentRunChecks([{ error_code: "adapter_failed", at: "2026-10-03T07:00:00Z" }], "p1")[0]).toMatchObject({ status: "ok" });
  });

  it("flags the latest runs that all stopped at the workspace check, with the fix and a link to the project", () => {
    const [check] = agentRunChecks([FAIL("2026-10-03T06:52:00Z"), FAIL("2026-10-03T05:12:00Z"), OK("2026-10-01T05:59:00Z")], "proj-social");
    expect(check).toMatchObject({
      key: "agent-runs",
      status: "bad",
      href: "/projects/proj-social/configuration",
      since: "2026-10-03T05:12:00Z",
      fix: WORKSPACE_FIX,
    });
    expect(check!.title).toContain("cannot start");
    expect(check!.detail).toContain("2 runs stopped at the workspace check");
    expect(check!.detail).toContain(WORKSPACE_FAILURE_CODE);
    expect(WORKSPACE_FIX).toContain("shared_workspace");
    expect(WORKSPACE_FIX).toContain("Social needs no git repo");
  });

});

describe("cockpit health", () => {
  function snapshotCtx(opts: { agent: boolean; project?: string | null; runs: Array<{ error_code: string | null; at: string }> }) {
    const heartbeat: unknown[][] = [];
    const ctx = fakeCtx(
      {
        state: {
          get: vi.fn(async (key: { namespace?: string }) => (key.namespace === "pib-hire" && opts.agent ? { agentId: "agent-1" } : null)),
          set: vi.fn(async () => undefined),
          delete: vi.fn(async () => undefined),
        },
        agents: { get: vi.fn(async (id: string) => ({ id, status: "error" })), managed: { get: vi.fn(async () => ({ agentId: null })) } },
        projects: { managed: { get: vi.fn(async () => ({ projectId: opts.project === undefined ? "proj-social" : opts.project })) } },
        events: { emit: vi.fn(async () => undefined), on: vi.fn() },
      },
      {
        queryResult: (sql, params) => {
          if (sql.includes("public.heartbeat_runs")) {
            heartbeat.push(params);
            return opts.runs;
          }
          return [];
        },
      },
    );
    return { ctx, heartbeat };
  }

  it("shows the agent's workspace failures as a bad health check", async () => {
    const { ctx, heartbeat } = snapshotCtx({ agent: true, runs: [FAIL("2026-10-03T06:52:00Z"), FAIL("2026-10-03T05:12:00Z")] });
    const snap = await cockpitSnapshot(ctx, "co");
    // Only the agent's runs on the Social project's issues.
    expect(heartbeat).toEqual([["co", "agent-1", "proj-social"]]);
    expect(snap.health.find((h) => h.key === "agent-runs")).toMatchObject({ status: "bad", href: "/projects/proj-social/configuration" });
    expect(snap.team).toEqual([{ role: "social", agentId: "agent-1", status: "error" }]);
  });

  it("is fine when the agent's runs start, and not asked at all when no agent is linked", async () => {
    const fine = snapshotCtx({ agent: true, runs: [OK("2026-10-03T07:00:00Z")] });
    expect((await cockpitSnapshot(fine.ctx, "co")).health.find((h) => h.key === "agent-runs")).toMatchObject({ status: "ok" });
    const none = snapshotCtx({ agent: false, runs: [FAIL("2026-10-03T06:52:00Z")] });
    const snap = await cockpitSnapshot(none.ctx, "co");
    expect(none.heartbeat).toEqual([]);
    expect(snap.health.find((h) => h.key === "agent-runs")).toBeUndefined();
    // No Social project yet: nothing to blame, nothing asked.
    const noProject = snapshotCtx({ agent: true, project: null, runs: [FAIL("2026-10-03T06:52:00Z")] });
    expect((await cockpitSnapshot(noProject.ctx, "co")).health.find((h) => h.key === "agent-runs")).toBeUndefined();
    expect(noProject.heartbeat).toEqual([]);
  });

  it("a failing runs query never breaks the snapshot", async () => {
    const ctx = fakeCtx(
      {
        state: { get: vi.fn(async (key: { namespace?: string }) => (key.namespace === "pib-hire" ? { agentId: "agent-1" } : null)), set: vi.fn(), delete: vi.fn() },
        agents: { get: vi.fn(async (id: string) => ({ id, status: "idle" })), managed: { get: vi.fn(async () => ({ agentId: null })) } },
        projects: { managed: { get: vi.fn(async () => ({ projectId: "proj-social" })) } },
        events: { emit: vi.fn(), on: vi.fn() },
      },
      {
        queryResult: (sql) => {
          if (sql.includes("public.heartbeat_runs")) throw new Error("boom");
          return [];
        },
      },
    );
    const snap = await cockpitSnapshot(ctx, "co");
    expect(snap.health.some((h) => h.key.startsWith("job:"))).toBe(true);
    expect(snap.health.find((h) => h.key === "agent-runs")).toBeUndefined();
  });
});
