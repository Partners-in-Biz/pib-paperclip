import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { SHIPPED_EVAL_FILES, shippedEvalFile } from "../src/shipped-evals.js";
import { loadPack } from "../src/templates.js";
import { TEMPLATE_TOOLS, registerTemplateTools } from "../src/template-tools.js";
import { fakeCtx } from "./helpers/fake-ctx.js";

describe("shipped eval files", () => {
  it("match the eval files Cockpit ships", () => {
    const dir = fileURLToPath(new URL("../../plugin-cockpit/evals/agents/", import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "results.json").sort();
    expect([...SHIPPED_EVAL_FILES]).toEqual(files);
  });

  it("shippedEvalFile drops unknown or missing files", () => {
    expect(shippedEvalFile("developer.json")).toBe("developer.json");
    expect(shippedEvalFile("nope.json")).toBeUndefined();
    expect(shippedEvalFile(undefined)).toBeUndefined();
  });

  it("template-get returns evalFile only when the eval ships", async () => {
    expect(TEMPLATE_TOOLS.length).toBeGreaterThan(0);
    const { ctx } = fakeCtx({ companies: { c: { name: "C" } } });
    let handler: any;
    (ctx as any).tools.register = (n: string, _d: unknown, fn: unknown) => { if (n === "template-get") handler = fn; };
    registerTemplateTools(ctx);
    const real = loadPack().templates.filter((t) => !t.hostOwned);
    const withEval = real.find((t) => shippedEvalFile(t.evalFile ?? `${t.key}.json`));
    const without = real.find((t) => !shippedEvalFile(t.evalFile ?? `${t.key}.json`));
    expect(withEval?.key).toBe("planner");
    expect(without?.key).toBe("ceo");
    expect((await handler({ key: withEval!.key, companyId: "c" }, { companyId: "c" })).data.evalFile).toBe(withEval!.evalFile ?? `${withEval!.key}.json`);
    if (without) expect((await handler({ key: without.key, companyId: "c" }, { companyId: "c" })).data.evalFile).toBeUndefined();
  });
});
