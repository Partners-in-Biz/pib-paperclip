/** PAR-14284: the example op in skills/paperclip-canvas/references/studio.md must pass the shared validator. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planningCanvasOpBatchSchema } from "./planning-canvas.js";

const md = readFileSync(new URL("../../../../skills/paperclip-canvas/references/studio.md", import.meta.url), "utf8");
const example = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(md)![1]!.replaceAll("<unique per attempt>", "batch-1").replaceAll("<assetId>", "asset-1"));

describe("studio recipe example", () => {
  it("passes the ops validator as a Studio embed card", () => {
    const parsed = planningCanvasOpBatchSchema.safeParse(example);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    const data = example.ops[0].item.data;
    expect(data).toEqual({ plugin: "partnersinbiz.studio", type: "studio-media", assetId: "asset-1", props: {} });
  });
  it("is linked from the skill index", () => {
    expect(readFileSync(new URL("../../../../skills/paperclip-canvas/SKILL.md", import.meta.url), "utf8")).toContain("references/studio.md");
  });
});
