import { describe, expect, it, vi } from "vitest";
import { CO, boot, seed, tool, toolRaw } from "./helpers/crm.js";
import type { Store } from "./helpers/fake-db.js";

type Stage = { name: string; kind: string };
const lead: Stage[] = [{ name: "Lead", kind: "open" }, { name: "Signed", kind: "won" }, { name: "Declined", kind: "lost" }];

/**
 * The fake store parses one VALUES tuple per INSERT; `insertStages` writes all stages in one multi-row statement.
 * This wrapper applies that statement to the store ; the tests wrap it again to make the stage insert and/or the pipeline delete throw.
 */
async function bootEmpty() {
  const store: Store = { ...seed(), pipelines: [], pipeline_stages: [], deals: [] };
  const booted = await boot({ store });
  const real = booted.db.execute.bind(booted.db);
  vi.spyOn(booted.db, "execute").mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/INSERT INTO \S+\.pipeline_stages/.test(sql)) {
      for (let i = 0; i < params.length; i += 6) {
        const [id, company_id, pipeline_id, name, kind, position] = params.slice(i, i + 6);
        store.pipeline_stages!.push({ id, company_id, pipeline_id, name, kind, position });
      }
      return { rowCount: params.length / 6 };
    }
    return real(sql, params);
  });
  return booted;
}

describe("create-pipeline", () => {
  it("on a company with no pipelines makes Sales (default) first, then the new one (not default)", async () => {
    const { harness, store } = await bootEmpty();
    const made = await tool(harness, "create-pipeline", { name: "  JagGids  ", stages: lead });
    expect(made).toMatchObject({ name: "JagGids", isDefault: false });
    expect(made.stages.map((s: Stage & { position: number }) => [s.name, s.kind, s.position])).toEqual([["Lead", "open", 0], ["Signed", "won", 1], ["Declined", "lost", 2]]);
    expect(made.stages.every((s: { id: string }) => typeof s.id === "string" && s.id)).toBe(true);
    const listed = await tool(harness, "list-stages", {});
    expect(listed.pipelines.map((p: { name: string; isDefault: boolean }) => [p.name, p.isDefault])).toEqual([["Sales", true], ["JagGids", false]]);
    expect(listed.stages.map((s: Stage) => s.name)).toEqual(["Discovery", "Proposal", "Negotiation", "Won", "Lost"]);
    expect(store.pipeline_stages!.filter((s) => s.pipeline_id === made.pipelineId)).toHaveLength(3);
  });

  it("uses the default five stages when none are given", async () => {
    const { harness } = await bootEmpty();
    const made = await tool(harness, "create-pipeline", { name: "Partners" });
    expect(made.stages.map((s: Stage) => [s.name, s.kind])).toEqual([["Discovery", "open"], ["Proposal", "open"], ["Negotiation", "open"], ["Won", "won"], ["Lost", "lost"]]);
  });

  it.each([
    ["no won stage", [{ name: "A", kind: "open" }, { name: "B", kind: "lost" }], /exactly one won/],
    ["two lost stages", [{ name: "A", kind: "open" }, { name: "W", kind: "won" }, { name: "L1", kind: "lost" }, { name: "L2", kind: "lost" }], /exactly one lost/],
    ["no open stage", [{ name: "W", kind: "won" }, { name: "L", kind: "lost" }], /at least one open/],
    ["a duplicate stage name in another case", [{ name: "Lead", kind: "open" }, { name: "lead", kind: "open" }, { name: "W", kind: "won" }, { name: "L", kind: "lost" }], /unique/],
    ["an empty stage name", [{ name: "  ", kind: "open" }, { name: "W", kind: "won" }, { name: "L", kind: "lost" }], /needs a name/],
    ["an unknown kind", [{ name: "A", kind: "maybe" }, { name: "W", kind: "won" }, { name: "L", kind: "lost" }], /open, won or lost/],
  ])("refuses %s and writes nothing", async (_label, stages, message) => {
    const { harness, store } = await bootEmpty();
    const result = await toolRaw(harness, "create-pipeline", { name: "X", stages });
    expect(result.error).toMatch(message);
    // Only Sales (made first) exists.
    expect(store.pipelines!.map((p) => p.name)).toEqual(["Sales"]);
  });

  it("refuses an empty name, and a name that clashes with another pipeline in another case", async () => {
    const { harness, store } = await bootEmpty();
    expect((await toolRaw(harness, "create-pipeline", { name: "   " })).error).toBeTruthy();
    expect((await toolRaw(harness, "create-pipeline", { name: "sALES" })).error).toMatch(/already exists/);
    await tool(harness, "create-pipeline", { name: "Sponsors" });
    expect((await toolRaw(harness, "create-pipeline", { name: "SPONSORS", stages: lead })).error).toMatch(/already exists/);
    expect(store.pipelines!.map((p) => p.name)).toEqual(["Sales", "Sponsors"]);
  });

  it("deletes the pipeline row when the stage insert throws, and returns the error", async () => {
    const { harness, store, db } = await bootEmpty();
    await tool(harness, "list-stages", {}); // makes Sales
    const spy = vi.spyOn(db, "execute");
    const real = spy.getMockImplementation()!;
    spy.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (/INSERT INTO \S+\.pipeline_stages/.test(sql) && params[3] === "Lead") throw new Error("stage insert failed");
      return real(sql, params);
    });
    expect((await toolRaw(harness, "create-pipeline", { name: "JagGids", stages: lead })).error).toMatch(/stage insert failed/);
    expect(store.pipelines!.map((p) => p.name)).toEqual(["Sales"]);
  });

  it("leaves an invisible row when the stage insert and the cleanup both throw; a same-name retry works", async () => {
    const { harness, store, db } = await bootEmpty();
    await tool(harness, "list-stages", {}); // makes Sales
    const spy = vi.spyOn(db, "execute");
    const real = spy.getMockImplementation()!;
    let broken = true;
    spy.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (broken && /INSERT INTO \S+\.pipeline_stages/.test(sql) && params[3] === "Lead") throw new Error("stage insert failed");
      if (broken && /DELETE FROM \S+\.pipelines/.test(sql)) throw new Error("delete failed");
      return real(sql, params);
    });
    expect((await toolRaw(harness, "create-pipeline", { name: "JagGids", stages: lead })).error).toMatch(/stage insert failed/);
    // The empty row is still there but no reader or default rule sees it.
    expect(store.pipelines!.map((p) => p.name)).toEqual(["Sales", "JagGids"]);
    const listed = await tool(harness, "list-stages", {});
    expect(listed.pipelines.map((p: { name: string }) => p.name)).toEqual(["Sales"]);
    broken = false;
    const retry = await tool(harness, "create-pipeline", { name: "JagGids", stages: lead });
    expect(retry.stages).toHaveLength(3);
    expect((await tool(harness, "list-stages", {})).pipelines.map((p: { name: string }) => p.name)).toEqual(["Sales", "JagGids"]);
  });

  it("lets another company use the same name", async () => {
    const { harness, store } = await bootEmpty();
    store.pipelines!.push({ id: "px", company_id: "co-2", name: "JagGids", created_at: "2026-01-01T00:00:00Z" });
    store.pipeline_stages!.push({ id: "sx", company_id: "co-2", pipeline_id: "px", name: "Open", kind: "open", position: 0 });
    const made = await tool(harness, "create-pipeline", { name: "JagGids" });
    expect(made.name).toBe("JagGids");
    expect(store.pipelines!.filter((p) => p.name === "JagGids").map((p) => p.company_id).sort()).toEqual([CO, "co-2"]);
  });
});
