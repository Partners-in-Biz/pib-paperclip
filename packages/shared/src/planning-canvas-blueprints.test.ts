import { describe, expect, it } from "vitest";
import {
  PLANNING_CANVAS_BLUEPRINT_IDS,
  PLANNING_CANVAS_BLUEPRINT_ISSUES_PER_CALL_MAX,
  PLANNING_CANVAS_BLUEPRINTS,
  planningCanvasBlueprint,
  planningCanvasFromBlueprintSchema,
} from "./planning-canvas-blueprints.js";
import { planningCanvasItemInputSchema, planningCanvasNodeFieldsSchema } from "./validators/planning-canvas.js";

const AGENT = "11111111-1111-4111-8111-111111111111";

describe("planning canvas blueprints (PAR-13941, C14)", () => {
  it("has the six built-ins, one per id", () => {
    expect(PLANNING_CANVAS_BLUEPRINTS.map((blueprint) => blueprint.id)).toEqual([...PLANNING_CANVAS_BLUEPRINT_IDS]);
    expect(PLANNING_CANVAS_BLUEPRINT_IDS).toEqual(["sprint_plan", "okr_workshop", "roadmap", "retro", "launch_checklist", "agent_workflow_map"]);
  });

  describe.each(PLANNING_CANVAS_BLUEPRINTS.map((blueprint) => [blueprint.id, blueprint] as const))("%s", (_id, blueprint) => {
    it("every item passes the add-op item schema, keys are unique and connectors join its own nodes", () => {
      const keys = blueprint.items.map((item) => item.key);
      expect(new Set(keys).size).toBe(keys.length);
      const nodes = new Set(blueprint.items.filter((item) => item.itemType === "node").map((item) => item.key));
      for (const item of blueprint.items) {
        const parsed = planningCanvasItemInputSchema.safeParse(item);
        expect(parsed.success, `${item.key}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
        if (item.itemType === "connector") {
          expect(nodes.has(item.fromKey) && nodes.has(item.toKey), item.key).toBe(true);
        }
      }
    });

    it("marks 1 to 49 plain nodes, and each one is still valid as an issue card", () => {
      expect(blueprint.issueKeys.length).toBeGreaterThan(0);
      expect(blueprint.issueKeys.length).toBeLessThan(PLANNING_CANVAS_BLUEPRINT_ISSUES_PER_CALL_MAX);
      for (const key of blueprint.issueKeys) {
        const item = blueprint.items.find((candidate) => candidate.key === key);
        expect(item?.itemType, key).toBe("node");
        if (item?.itemType !== "node") continue;
        expect(["sticky", "text", "shape"]).toContain(item.kind);
        expect(item.title.trim(), key).not.toBe("");
        const { itemType: _t, key: _k, ...fields } = item;
        const card = planningCanvasNodeFieldsSchema.safeParse({ ...fields, kind: "issue", ref: { id: AGENT } });
        expect(card.success, `${key}: ${JSON.stringify(card.error?.issues)}`).toBe(true);
      }
    });
  });

  it("finds a blueprint by id, and nothing for an unknown id", () => {
    expect(planningCanvasBlueprint("retro")?.title).toBe("Retro");
    expect(planningCanvasBlueprint("nope")).toBeNull();
  });

  describe("apply body", () => {
    it("takes a blueprint, a key, and marked nodes with assignees", () => {
      const parsed = planningCanvasFromBlueprintSchema.safeParse({
        blueprintId: "retro",
        idempotencyKey: "k",
        title: "Sprint 12 retro",
        parentIssue: true,
        issues: [{ key: "action-1", assigneeAgentId: AGENT }, { key: "action-2" }],
      });
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    });

    it.each([
      ["no idempotency key", { blueprintId: "retro" }],
      ["unknown blueprint", { blueprintId: "nope", idempotencyKey: "k" }],
      ["an unmarked node", { blueprintId: "retro", idempotencyKey: "k", issues: [{ key: "well-1" }] }],
      ["a key twice", { blueprintId: "retro", idempotencyKey: "k", issues: [{ key: "action-1" }, { key: "action-1" }] }],
      ["an unknown field", { blueprintId: "retro", idempotencyKey: "k", scope: "company" }],
      ["more than 50 issues", { blueprintId: "retro", idempotencyKey: "k", issues: Array.from({ length: 51 }, () => ({ key: "action-1" })) }],
    ])("refuses %s", (_label, body) => {
      expect(planningCanvasFromBlueprintSchema.safeParse(body).success).toBe(false);
    });
  });
});
