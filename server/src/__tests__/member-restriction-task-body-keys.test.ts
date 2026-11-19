import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  MEMBER_RESTRICTION_TASK_BODY_ALLOWLISTS, TASK_KEPT_OBJECTS, restrictedTaskBodyKeys,
} from "../services/member-restriction/body-allowlist.js";
import { parseIssueExecutionWorkspaceSettings } from "../services/execution-workspace-policy.js";

/**
 * PAR-12950 (C4i-b) 1/2: the task body maps and the keep-stored merge, no
 * routes. The routes and the caller x mode table are in
 * member-restriction-task-body-allowlist.test.ts (2/2).
 */

const R = "restricted-person";
const ENV = "11111111-1111-4111-8111-111111111111";
const STORED = {
  assigneeUserId: null, executionWorkspaceId: "ws-stored",
  executionWorkspaceSettings: { mode: "shared_workspace", environmentId: ENV, networkEgress: { allowFqdns: ["o.example"] },
    workspaceStrategy: { type: "git_worktree", provisionCommand: "make o" } },
  assigneeAdapterOverrides: { adapterConfig: { model: "o-model", chrome: true } },
  executionPolicy: { mode: "normal", commentRequired: true, stages: [], authorizationPolicy: { trustPreset: "standard" } },
};
const patch = (body: Record<string, unknown>, stored: typeof STORED | null = STORED) =>
  restrictedTaskBodyKeys("updateIssue", body, stored, R);

it("tripwire: every key of the three schemas, and one level into the kept objects, is classified", () => {
  const unwrap = (field: z.ZodType): z.ZodType => field instanceof z.ZodOptional || field instanceof z.ZodNullable
    || field instanceof z.ZodDefault ? unwrap(field.unwrap() as z.ZodType) : field;
  const shapeOf = (schema: z.ZodType): Record<string, z.ZodType> =>
    schema instanceof z.ZodPipe ? shapeOf(schema.out as z.ZodType) : (schema as z.ZodObject).shape;
  for (const [key, { schema, fields }] of Object.entries(MEMBER_RESTRICTION_TASK_BODY_ALLOWLISTS)) {
    expect(Object.keys(fields).sort(), key).toEqual(Object.keys(shapeOf(schema)).sort());
    for (const [name, field] of Object.entries(shapeOf(schema))) {
      const inner = unwrap(field);
      if (!(inner instanceof z.ZodObject) || !(name in TASK_KEPT_OBJECTS)) continue;
      const kept = TASK_KEPT_OBJECTS[name as keyof typeof TASK_KEPT_OBJECTS] as Record<string, unknown>;
      expect(Object.keys(kept).sort(), `${key}.${name}`).toEqual(Object.keys(inner.shape).sort());
    }
  }
});

describe("keep-stored merge", () => {
  it("the picker body and a mode-only body put O's stored keys back", () => {
    for (const settings of [{ mode: "isolated_workspace", environmentId: null }, { mode: "isolated_workspace" }]) {
      const { refused, merged } = patch({ executionWorkspaceSettings: settings });
      expect(refused).toEqual([]);
      expect(merged.executionWorkspaceSettings).toEqual({ ...STORED.executionWorkspaceSettings, mode: "isolated_workspace" });
    }
  });

  it("a strategy body without its type (null, or baseRef only) keeps O's stored strategy through the service parser", () => {
    for (const workspaceStrategy of [null, { baseRef: "x" }, { type: null, baseRef: "x" }]) {
      const { refused, merged } = patch({ executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy } });
      expect(refused).toEqual([]);
      const parsed = parseIssueExecutionWorkspaceSettings(merged.executionWorkspaceSettings);
      expect(parsed?.workspaceStrategy, JSON.stringify(workspaceStrategy))
        .toMatchObject({ type: "git_worktree", provisionCommand: "make o" });
    }
    // R's own type is kept; with nothing stored no type is added.
    expect(patch({ executionWorkspaceSettings: { workspaceStrategy: { type: "project_primary" } } })
      .merged.executionWorkspaceSettings).toMatchObject({ workspaceStrategy: { type: "project_primary", provisionCommand: "make o" } });
    expect(patch({ executionWorkspaceSettings: { workspaceStrategy: { baseRef: "x" } } }, { ...STORED,
      executionWorkspaceSettings: { mode: "shared_workspace", workspaceStrategy: { type: "git_worktree" } } as never })
      .merged.executionWorkspaceSettings).toEqual({ workspaceStrategy: { baseRef: "x" } });
  });

  it("an equal value is kept; another value, or a null whole object over stored keys, is refused", () => {
    expect(patch({ assigneeAdapterOverrides: { adapterConfig: { model: "m", chrome: true } } }).refused).toEqual([]);
    expect(patch({ assigneeAdapterOverrides: { adapterConfig: { chrome: false, env: { A: "b" } } } }).refused)
      .toEqual(["assigneeAdapterOverrides.adapterConfig.chrome", "assigneeAdapterOverrides.adapterConfig.env"]);
    expect(patch({ executionWorkspaceSettings: { workspaceStrategy: { type: "git_worktree", provisionCommand: "rm -rf /" } } })
      .refused).toEqual(["executionWorkspaceSettings.workspaceStrategy.provisionCommand"]);
    expect(patch({ executionWorkspaceSettings: null, assigneeAdapterOverrides: null, executionPolicy: null }).refused)
      .toEqual(["assigneeAdapterOverrides", "executionPolicy", "executionWorkspaceSettings"]);
    expect(patch({ executionWorkspaceSettings: null }, { ...STORED, executionWorkspaceSettings: { mode: "shared_workspace" } as never })
      .refused).toEqual([]);
  });

  it("the overrides body without O's chrome key keeps it; a stripped policy compare is completed", () => {
    expect(patch({ assigneeAdapterOverrides: { adapterConfig: { model: "r" } } }).merged.assigneeAdapterOverrides)
      .toEqual({ adapterConfig: { model: "r", chrome: true } });
    const { authorizationPolicy: _hidden, ...stripped } = STORED.executionPolicy;
    const { refused, merged } = patch({ expectedExecutionPolicy: stripped, executionPolicy: { ...stripped, mode: "normal" } });
    expect(refused).toEqual([]);
    expect(merged.expectedExecutionPolicy).toEqual(STORED.executionPolicy);
    expect(merged.executionPolicy).toEqual(STORED.executionPolicy);
  });

  it("on create nothing is stored: a host key is refused, the allowed ones pass unchanged", () => {
    const create = (body: Record<string, unknown>) => restrictedTaskBodyKeys("createIssue", body, null, R);
    const body = { executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: { type: "git_worktree", baseRef: "main" } },
      assigneeAdapterOverrides: { adapterConfig: { model: "m", effort: "high" } } };
    expect(create(body)).toEqual({ refused: [], merged: body });
    expect(create({ executionWorkspaceSettings: { environmentId: ENV } }).refused).toEqual(["executionWorkspaceSettings.environmentId"]);
  });
});

describe("other classes", () => {
  it.each([
    [{ resume: true }, []], [{ interrupt: true }, ["interrupt"]], [{ interrupt: false }, []], [{ reviewRequest: {} }, ["reviewRequest"]],
    [{ assigneeUserId: "someone-else" }, ["assigneeUserId"]], [{ assigneeUserId: R }, []], [{ assigneeUserId: null }, []],
    [{ executionWorkspaceId: "ws-other" }, ["executionWorkspaceId"]], [{ executionWorkspaceId: "ws-stored" }, []],
    [{ projectWorkspaceId: "pw" }, ["projectWorkspaceId"]], [{ blockedByIssueIds: ["t"] }, ["blockedByIssueIds"]],
    [{ blockedByIssueIds: [] }, []], [{ projectId: "p", parentId: "t", assigneeAgentId: "a", title: "x" }, []],
    [{ executionPolicy: { ...STORED.executionPolicy, stages: [{ participants: [{ userId: "someone-else" }] }] } },
      ["executionPolicy.stages"]],
  ])("patch %j refuses %j", (body, refused) => expect(patch(body).refused).toEqual(refused));
});
