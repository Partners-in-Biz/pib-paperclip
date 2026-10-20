import { describe, it, expect, beforeEach } from "vitest";
import { DISABLED_POLICY, parseOwnerDefaults, readOwnerDefaults, writeOwnerDefaults, pinAskDeadline } from "../src/owner-defaults-store.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { OwnerDefaultsPolicy } from "../src/owner-defaults-model.js";

describe("owner-defaults-store", () => {
  let stateMap: Map<string, unknown>;
  function mockCtx(): Pick<PluginContext, "state"> {
    return { state: { get: async (c: any) => stateMap.get(`${c.scopeKind}:${c.scopeId}:${c.namespace}:${c.stateKey}`) ?? null, set: async (c: any, v: unknown) => stateMap.set(`${c.scopeKind}:${c.scopeId}:${c.namespace}:${c.stateKey}`, v), delete: async (c: any) => stateMap.delete(`${c.scopeKind}:${c.scopeId}:${c.namespace}:${c.stateKey}`) } as any };
  }
  beforeEach(() => { stateMap = new Map(); });

  describe("parseOwnerDefaults", () => {
    it("returns DISABLED_POLICY for nothing stored", () => { expect(parseOwnerDefaults(null)).toEqual(DISABLED_POLICY); });
    it.each([["string", "str"], ["array", ["x"]], ["enabled=string", { enabled: "true", name: "T", rootIssueIds: ["i1"], classes: ["engineering-decision"] }]])("malformed: %s", (_, p) => {
      expect(parseOwnerDefaults(p)).toEqual(DISABLED_POLICY);
    });
    it("filters unknown classes", () => { const r = parseOwnerDefaults({ enabled: true, name: "T", rootIssueIds: ["i1"], classes: ["engineering-decision", "unknown", "hire"] }); expect(r.classes).toEqual(["engineering-decision", "hire"]); });
    it("rejects roots with whitespace", () => { const r = parseOwnerDefaults({ enabled: true, name: "T", rootIssueIds: ["i1", "i 2", "i\t3"], classes: ["engineering-decision"] }); expect(r.rootIssueIds).toEqual(["i1"]); });
    it("caps rootIssueIds at 20", () => { const ids = Array.from({ length: 30 }, (_, i) => `id${i}`); const r = parseOwnerDefaults({ enabled: true, name: "T", rootIssueIds: ids, classes: ["engineering-decision"] }); expect(r.rootIssueIds.length).toBe(20); });
    it("disables when roots/classes empty", () => { expect(parseOwnerDefaults({ enabled: true, name: "T", rootIssueIds: [], classes: ["engineering-decision"] }).enabled).toBe(false); });
    it("trims name, caps at 80", () => { const r = parseOwnerDefaults({ enabled: true, name: `  ${"a".repeat(100)}  `, rootIssueIds: ["i1"], classes: ["engineering-decision"] }); expect(r.name).toBe("a".repeat(80)); });
    it("dedupes roots and classes", () => { const r = parseOwnerDefaults({ enabled: true, name: "T", rootIssueIds: ["i1", "i1", "i2"], classes: ["engineering-decision", "engineering-decision", "hire"] }); expect(r.rootIssueIds).toEqual(["i1", "i2"]); expect(r.classes).toEqual(["engineering-decision", "hire"]); });
    it.each([[0], [-1], [NaN]])("minHours invalid: %s -> null", (v) => { const r = parseOwnerDefaults({ enabled: true, name: "T", rootIssueIds: ["i1"], classes: ["engineering-decision"], minHours: v }); expect(r.minHours).toBeNull(); });
  });

  describe("read/write", () => {
    it("reads nothing as DISABLED_POLICY", async () => { const r = await readOwnerDefaults(mockCtx(), "c1"); expect(r).toEqual(DISABLED_POLICY); });
    it("round-trips valid policy", async () => { const p: OwnerDefaultsPolicy = { enabled: true, name: "P", rootIssueIds: ["i1"], classes: ["engineering-decision"], minHours: 24 }; const w = await writeOwnerDefaults(mockCtx(), "c1", p); const r = await readOwnerDefaults(mockCtx(), "c1"); expect(w).toEqual(p); expect(r).toEqual(p); });
    it("isolates companies", async () => { const ctx = mockCtx(); const p: OwnerDefaultsPolicy = { enabled: true, name: "T", rootIssueIds: ["i1"], classes: ["engineering-decision"], minHours: null }; await writeOwnerDefaults(ctx, "c1", p); await writeOwnerDefaults(ctx, "c2", DISABLED_POLICY); expect((await readOwnerDefaults(ctx, "c1")).name).toBe("T"); expect(await readOwnerDefaults(ctx, "c2")).toEqual(DISABLED_POLICY); });
  });

  describe("pinAskDeadline", () => {
    it("returns null for invalid askKey", async () => { expect(await pinAskDeadline(mockCtx(), "c1", "", new Date().toISOString(), 24)).toBeNull(); });
    it("returns null for long askKey", async () => { expect(await pinAskDeadline(mockCtx(), "c1", "k".repeat(201), new Date().toISOString(), 24)).toBeNull(); });
    it("returns null for bad date", async () => { expect(await pinAskDeadline(mockCtx(), "c1", "ask1", "not-a-date", 24)).toBeNull(); });
    it("first write wins", async () => { const ctx = mockCtx(); const t1 = new Date("2026-10-20T10:00:00Z").toISOString(); const t2 = new Date("2026-10-20T14:00:00Z").toISOString(); const d1 = await pinAskDeadline(ctx, "c1", "a1", t1, 24); const d2 = await pinAskDeadline(ctx, "c1", "a1", t2, 48); expect(d1).toBe(d2); expect(stateMap.size).toBe(1); });
    it("caps at 500 entries", async () => { const ctx = mockCtx(); const base = new Date("2026-10-20T00:00:00Z"); for (let i = 0; i < 502; i++) { await pinAskDeadline(ctx, "c1", `ask${i}`, new Date(base.getTime() + i * 60000).toISOString(), 24); } const [k] = Array.from(stateMap.entries()).find(([k]) => k.includes("ownerDefaultsDeadlines")) || [""]; const d = stateMap.get(k) as Record<string, string>; expect(Object.keys(d).length).toBeLessThanOrEqual(500); });
  });
});
