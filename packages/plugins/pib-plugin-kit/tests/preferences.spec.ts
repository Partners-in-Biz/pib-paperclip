import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  PREFERENCES_MAX_BYTES,
  definePreferences,
  describePreferences,
  readPreferences,
  savePreferences,
} from "../src/index.js";

const CAPS = ["plugin.state.read", "plugin.state.write", "companies.read", "access.members.read", "agent.tools.register"];
const manifestOf = (capabilities: string[]) =>
  ({
    id: "partnersinbiz.test",
    apiVersion: 1,
    version: "0.0.0",
    displayName: "Prefs (test)",
    description: "test",
    author: "test",
    categories: ["automation"],
    capabilities,
    entrypoints: { worker: "worker.js" },
  }) as unknown as PaperclipPluginManifestV1;

const CO = "co-own";
const OTHER = "co-client";
const member = (companyId: string, principalId: string, membershipRole: string, status = "active", principalType = "user") =>
  ({ id: `${companyId}:${principalId}`, companyId, principalType, principalId, status, membershipRole, grants: [] }) as never;

const schema = definePreferences({
  id: "test",
  fields: {
    fromName: { type: "string", label: "From name", default: ({ companyName }) => companyName, legacy: "fromName", max: 20 },
    labelPrefix: { type: "string", label: "Label prefix", default: ({ shortName }) => shortName },
    replyIssues: { type: "bool", label: "Reply issues", default: true, legacy: "replyIssues" },
    retries: { type: "int", label: "Retries", default: 3, min: 0, max: 10 },
    mode: { type: "enum", label: "Mode", default: "a", options: ["a", "b"] },
    notes: { type: "text", label: "Notes", default: "", max: 20000 },
  },
  ownCompanyPins: { labelPrefix: "PiB" },
  isOwnCompany: (_ctx, companyId) => companyId === CO,
});

const scopeOf = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "preferences", stateKey: "v1" });
const act = (companyId: string | undefined, userId: string | undefined, type = "user") => ({ companyId, actor: { type, userId } });

function boot(opts: { config?: Record<string, unknown>; capabilities?: string[] } = {}) {
  const harness = createTestHarness({ manifest: manifestOf(opts.capabilities ?? CAPS), config: opts.config ?? {} });
  harness.seed({
    companies: [
      { id: CO, name: "Partners in Biz", issuePrefix: "PAR" } as never,
      { id: OTHER, name: "Acme, Ltd.", issuePrefix: "ACM" } as never,
    ],
    accessMembers: [
      member(CO, "u-owner", "owner"),
      member(CO, "u-admin", "admin"),
      member(CO, "u-operator", "operator"),
      member(CO, "u-viewer", "viewer"),
      member(CO, "u-gone", "owner", "suspended"),
      member(CO, "agent-1", "owner", "active", "agent"),
      member(OTHER, "u-client", "owner"),
    ],
  });
  const counts = { membersList: 0 };
  const list = harness.ctx.access.members.list.bind(harness.ctx.access.members);
  (harness.ctx.access.members as { list: unknown }).list = async (input: never) => {
    counts.membersList++;
    return list(input);
  };
  const row = (companyId: string) => harness.ctx.state.get(scopeOf(companyId)) as Promise<{ values: Record<string, unknown>; updatedBy: string } | null>;
  return { harness, ctx: harness.ctx, counts, row };
}

describe("definePreferences", () => {
  it.each(["apiKey", "webhookSecret", "authToken", "smtpPassword", "privateNote"])("refuses secret-like field %s", (id) => {
    expect(() => definePreferences({ id: "x", fields: { [id]: { type: "string", label: "x", default: "" } } })).toThrow(/secret/);
  });
  it("refuses a bad id, a bad default and a pin that is not a field", () => {
    expect(() => definePreferences({ id: "x", fields: { "1a": { type: "bool", label: "x", default: true } } })).toThrow(/must start/);
    expect(() => definePreferences({ id: "x", fields: { n: { type: "int", label: "n", default: 99, max: 5 } } })).toThrow(/Default/);
    expect(() => definePreferences({ id: "x", fields: {}, ownCompanyPins: { nope: "x" } })).toThrow(/not a preference field/);
  });
  it("describes fields as plain JSON, leaving out computed defaults", () => {
    const described = describePreferences(schema);
    expect(JSON.parse(JSON.stringify(described))).toEqual(described);
    expect(described.find((f) => f.id === "labelPrefix")?.default).toBeUndefined();
    expect(described.find((f) => f.id === "retries")).toMatchObject({ type: "int", default: 3, min: 0, max: 10 });
    expect(described.find((f) => f.id === "mode")?.options).toEqual(["a", "b"]);
  });
});

describe("readPreferences", () => {
  it("computes the short name from issuePrefix, else the cleaned company name", async () => {
    const { ctx, harness } = boot();
    expect(await readPreferences(ctx, OTHER, schema)).toMatchObject({ labelPrefix: "ACM", fromName: "Acme, Ltd." });
    harness.seed({ companies: [{ id: "co-3", name: "Beta, Inc.", issuePrefix: "" } as never] });
    expect(await readPreferences(ctx, "co-3", schema)).toMatchObject({ labelPrefix: "Beta Inc" });
  });

  it("orders row, then saved legacy value, then default", async () => {
    const { ctx, row } = boot({ config: { fromName: "Legacy", replyIssues: false } });
    expect(await readPreferences(ctx, OTHER, schema)).toMatchObject({ fromName: "Legacy", replyIssues: false, retries: 3 });
    await ctx.state.set(scopeOf(OTHER), { values: { fromName: "Row" }, updatedBy: "u", updatedAt: "t" });
    expect(await readPreferences(ctx, OTHER, schema)).toMatchObject({ fromName: "Row", replyIssues: false });
    expect(await row(OTHER)).not.toBeNull();
  });

  it("ignores a legacy value of the wrong type", async () => {
    const { ctx } = boot({ config: { fromName: 5 } });
    expect((await readPreferences(ctx, OTHER, schema)).fromName).toBe("Acme, Ltd.");
  });

  it("seeds the own company once from legacy values plus pins, and never another company", async () => {
    const { ctx, row, counts } = boot({ config: { fromName: "Legacy" } });
    expect(await readPreferences(ctx, OTHER, schema)).toMatchObject({ labelPrefix: "ACM" });
    expect(await row(OTHER)).toBeNull();
    expect(await readPreferences(ctx, CO, schema)).toMatchObject({ labelPrefix: "PiB", fromName: "Legacy" });
    expect(await row(CO)).toMatchObject({ values: { labelPrefix: "PiB", fromName: "Legacy" }, updatedBy: "seed" });
    expect(counts.membersList).toBe(0);
  });

  it("seeds nobody when the schema names no own company", async () => {
    const { ctx, row } = boot({ config: { fromName: "Legacy" } });
    const bare = definePreferences({ id: "bare", fields: schema.fields, ownCompanyPins: { labelPrefix: "PiB" } });
    expect((await readPreferences(ctx, CO, bare)).labelPrefix).toBe("PAR");
    expect(await row(CO)).toBeNull();
  });

  it("still reads when the seed cannot be written", async () => {
    const { ctx } = boot();
    (ctx.state as { set: unknown }).set = async () => {
      throw new Error("no write");
    };
    expect((await readPreferences(ctx, CO, schema)).labelPrefix).toBe("PiB");
  });

  it("does not overwrite a row that appears between the seed's check and its write", async () => {
    const { ctx, row } = boot();
    const get = ctx.state.get.bind(ctx.state);
    let calls = 0;
    (ctx.state as { get: unknown }).get = async (input: never) => {
      // read, seed check, then the seed's re-read: a save lands just before the third.
      if (++calls === 3) await ctx.state.set(scopeOf(CO), { values: { fromName: "Saved" }, updatedBy: "u-owner", updatedAt: "t" });
      return get(input);
    };
    await readPreferences(ctx, CO, schema);
    expect((await row(CO))?.values).toEqual({ fromName: "Saved" });
  });

  it("works from a tool run (state.set is allowed there)", async () => {
    const { ctx, harness, row } = boot();
    ctx.tools.register("read-prefs", { displayName: "x", description: "x", parametersSchema: { type: "object" } }, async (_p, run) => ({
      content: "ok",
      data: await readPreferences(ctx, run.companyId, schema),
    }));
    await harness.executeTool("read-prefs", {}, { companyId: CO, agentId: "a1", runId: "r1", projectId: "p1" });
    expect((await row(CO))?.updatedBy).toBe("seed");
  });

  it("rejects an empty company id", async () => {
    const { ctx } = boot();
    await expect(readPreferences(ctx, "", schema)).rejects.toThrow(/companyId/);
  });
});

describe("savePreferences role gate", () => {
  it.each([
    ["owner", "u-owner", true],
    ["admin", "u-admin", true],
    ["operator", "u-operator", false],
    ["viewer", "u-viewer", false],
    ["suspended owner", "u-gone", false],
    ["non-member", "u-nobody", false],
    ["member of another company", "u-client", false],
    ["agent-type member", "agent-1", false],
  ])("%s", async (_name, userId, allowed) => {
    const { ctx, row } = boot();
    const result = await savePreferences(ctx, act(CO, userId), schema, { mode: "b" });
    expect(result.ok).toBe(allowed);
    expect((await row(CO))?.values.mode).toBe(allowed ? "b" : undefined);
  });

  it("refuses an agent actor and a user without an id", async () => {
    const { ctx, row } = boot();
    expect((await savePreferences(ctx, act(CO, "u-owner", "agent"), schema, { mode: "b" })).ok).toBe(false);
    expect((await savePreferences(ctx, act(CO, undefined), schema, { mode: "b" })).ok).toBe(false);
    expect((await savePreferences(ctx, { companyId: CO, actor: null }, schema, { mode: "b" })).ok).toBe(false);
    expect(await row(CO)).toBeNull();
  });

  it("writes only to the action's company, so another company's owner cannot reach CO", async () => {
    const { ctx, row } = boot();
    expect((await savePreferences(ctx, act(CO, "u-client"), schema, { mode: "b" })).ok).toBe(false);
    expect((await savePreferences(ctx, act(OTHER, "u-client"), schema, { mode: "b" })).ok).toBe(true);
    expect(await row(CO)).toBeNull();
    expect((await row(OTHER))?.values.mode).toBe("b");
  });

  it("treats local-board as owner", async () => {
    const { ctx } = boot();
    expect((await savePreferences(ctx, act(OTHER, "local-board"), schema, { mode: "b" })).ok).toBe(true);
  });

  it.each([
    ["capability denied (-32001)", () => Object.assign(new Error('missing required capability "access.members.read"'), { code: -32001 })],
    ["host error", () => new Error("boom")],
  ])("fails closed when members.list rejects: %s", async (_name, make) => {
    const { ctx, row } = boot();
    (ctx.access.members as { list: unknown }).list = async () => {
      throw make();
    };
    const result = await savePreferences(ctx, act(CO, "u-owner"), schema, { mode: "b" });
    expect(result).toEqual({ ok: false, error: "Cannot verify your role" });
    expect(await row(CO)).toBeNull();
  });

  it("fails closed when the plugin lacks access.members.read", async () => {
    const { ctx, row } = boot({ capabilities: CAPS.filter((c) => c !== "access.members.read") });
    const result = await savePreferences(ctx, act(CO, "u-owner"), schema, { mode: "b" });
    expect(result).toEqual({ ok: false, error: "Cannot verify your role" });
    expect(await row(CO)).toBeNull();
  });

  it.each([undefined, "", "   "])("refuses company id %j before any lookup", async (companyId) => {
    const { ctx, counts, row } = boot();
    const result = await savePreferences(ctx, act(companyId, "u-owner"), schema, { mode: "b" });
    expect(result.ok).toBe(false);
    expect(counts.membersList).toBe(0);
    expect(await row("")).toBeNull();
  });
});

describe("savePreferences validation and merge", () => {
  const owner = act(CO, "u-owner");

  it.each([
    ["unknown key", { nope: "x" }],
    ["inherited key", { constructor: "x" }],
    ["wrong type", { retries: "3" }],
    ["non-integer", { retries: 1.5 }],
    ["above max", { retries: 11 }],
    ["enum outside options", { mode: "c" }],
    ["longer than the field max", { fromName: "x".repeat(21) }],
  ])("refuses %s and writes nothing", async (_name, patch) => {
    const { ctx, row } = boot();
    const result = await savePreferences(ctx, owner, schema, patch as never);
    expect(result.ok).toBe(false);
    expect(await row(CO)).toBeNull();
  });

  it("refuses a row over the 16 KB cap and keeps the old row", async () => {
    const { ctx, row } = boot();
    await savePreferences(ctx, owner, schema, { mode: "b" });
    const result = await savePreferences(ctx, owner, schema, { notes: "n".repeat(PREFERENCES_MAX_BYTES + 1) });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("16384") });
    expect((await row(CO))?.values).toEqual({ labelPrefix: "PiB", mode: "b" });
  });

  it("saves, stores who and when, returns new and previous values, and null resets a field", async () => {
    const { ctx, row } = boot();
    const first = await savePreferences(ctx, owner, schema, { fromName: "Hello", retries: 5 });
    expect(first).toMatchObject({ ok: true, previous: { fromName: "Partners in Biz", retries: 3 }, values: { fromName: "Hello", retries: 5 } });
    expect(await row(CO)).toMatchObject({ updatedBy: "u-owner", values: { fromName: "Hello", retries: 5, labelPrefix: "PiB" } });
    const second = await savePreferences(ctx, owner, schema, { fromName: null });
    expect(second).toMatchObject({ ok: true, previous: { fromName: "Hello" }, values: { fromName: "Partners in Biz", retries: 5 } });
  });

  it("seeds the own company first, so a first save keeps the legacy values", async () => {
    const { ctx, row } = boot({ config: { fromName: "Legacy" } });
    await savePreferences(ctx, owner, schema, { mode: "b" });
    expect((await row(CO))?.values).toEqual({ labelPrefix: "PiB", fromName: "Legacy", mode: "b" });
  });

  it("merges over a seed that lands between the save's check and its fresh read", async () => {
    const { ctx, row } = boot();
    const bare = definePreferences({ id: "bare", fields: schema.fields });
    const get = ctx.state.get.bind(ctx.state);
    let calls = 0;
    (ctx.state as { get: unknown }).get = async (input: never) => {
      // 1: "is there a row"; 2: the fresh re-read. A seed lands before the second.
      if (++calls === 2) await ctx.state.set(scopeOf(CO), { values: { labelPrefix: "PiB" }, updatedBy: "seed", updatedAt: "t" });
      return get(input);
    };
    expect((await savePreferences(ctx, owner, bare, { mode: "b" })).ok).toBe(true);
    expect((await row(CO))?.values).toEqual({ labelPrefix: "PiB", mode: "b" });
  });

  it("keeps seed values when the seed write fails on first call only", async () => {
    const { ctx, row } = boot({ config: { fromName: "Legacy" } });
    let setCallCount = 0;
    const set = ctx.state.set.bind(ctx.state);
    (ctx.state as { set: unknown }).set = async (scope: never, value: never) => {
      setCallCount++;
      if (setCallCount === 1) throw new Error("first write fails");
      return set(scope, value);
    };
    const result = await savePreferences(ctx, owner, schema, { mode: "b" });
    expect(result.ok).toBe(true);
    expect((await row(CO))?.values).toEqual({ labelPrefix: "PiB", fromName: "Legacy", mode: "b" });
  });

  it("refuses and throws nothing when state.set always throws", async () => {
    const { ctx, row } = boot();
    (ctx.state as { set: unknown }).set = async () => {
      throw new Error("always fails");
    };
    const result = await savePreferences(ctx, owner, schema, { mode: "b" });
    expect(result).toEqual({ ok: false, error: "Could not save preferences" });
    expect(await row(CO)).toBeNull();
  });

  it("drops keys not in the schema when storing the row", async () => {
    const { ctx, row } = boot();
    await ctx.state.set(scopeOf(CO), { values: { gone: "x", mode: "a" }, updatedBy: "u", updatedAt: "t" });
    const result = await savePreferences(ctx, owner, schema, { retries: 2 });
    expect(result.ok).toBe(true);
    const stored = await row(CO);
    expect(stored?.values).toEqual({ mode: "a", retries: 2 });
    expect(stored?.values && Object.hasOwn(stored.values, "gone")).toBe(false);
  });

  it("handles a legacy function that throws by skipping that field", async () => {
    const throwingSchema = definePreferences({
      id: "test",
      fields: {
        throwing: { type: "string", label: "Throws", default: "default-val", legacy: (_raw: Record<string, unknown>) => { throw new Error("boom"); } },
        safe: { type: "string", label: "Safe", default: "safe-default", legacy: "safe" },
      },
    });
    const { ctx } = boot({ config: { throwing: "should-be-ignored", safe: "legacy-safe" } });
    const values = await readPreferences(ctx, OTHER, throwingSchema);
    expect(values.throwing).toBe("default-val");
    expect(values.safe).toBe("legacy-safe");
  });
});
