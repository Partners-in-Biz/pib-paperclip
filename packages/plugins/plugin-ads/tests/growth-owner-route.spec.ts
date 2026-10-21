import { describe, it, expect, vi } from "vitest";
import {
  gateGrowthHandlers,
  growthSpendDeclarations,
  experimentSpendIncreaseMinor,
  parseArmSpend,
  type SpendLedger,
  type SpendGateDeps,
} from "../src/growth-spend.js";
import { type GrowthToolHandler, type GrowthToolName, type GrowthActor } from "@partnersinbiz/pib-plugin-kit";
import { AdsError } from "../src/domain.js";
import type { PluginToolDeclaration } from "@paperclipai/plugin-sdk";

describe("growth-spend", () => {
  // Type-level assertion: handlers typed with the kit's types can be passed to gateGrowthHandlers
  type _GateAcceptsKitTypes = (
    handlers: Record<GrowthToolName, GrowthToolHandler<GrowthActor>>,
    deps: SpendGateDeps,
  ) => ReturnType<typeof gateGrowthHandlers>;

  const fakeLedger = (): SpendLedger => {
    const records = new Map<string, Map<string, any>>();
    return {
      save: async (c, e, r) => {
        if (!records.has(c)) records.set(c, new Map());
        records.get(c)!.set(e, r);
      },
      load: async (c, e) => records.get(c)?.get(e) ?? null,
    };
  };

  const fakeActor = (o?: Partial<GrowthActor>): GrowthActor => ({
    companyId: "tc",
    userId: null,
    agentId: null,
    isAgent: true,
    ...o,
  });

  const setup = (s: Map<string, any>, l = fakeLedger()) => {
    const ip = vi.fn(async (a: any, p: any) => ({ id: p.id || "e" }));
    const ia = vi.fn(async () => ({ status: "ok" }));
    const il = vi.fn(async () => ({}));
    const h = {
      "propose-experiment": ip,
      "approve-experiment": ia,
      "list-experiments": il,
    } as Record<string, GrowthToolHandler<GrowthActor>>;
    const d: SpendGateDeps = { ledger: l, getScope: async (c, sk) => s.get(sk) ?? null };
    return { h, d, l, ip, ia, il };
  };

  describe("parseArmSpend", () => {
    it.each([
      ["empty", [], [], false],
      ["valid", [{ key: "control", addedMinor: 1000 }], [{ key: "control", addedMinor: 1000 }], false],
      ["miss", undefined, undefined, true],
      ["bad", "x", undefined, true],
      ["neg", [{ key: "control", addedMinor: -1 }], undefined, true],
      ["frac", [{ key: "control", addedMinor: 1.5 }], undefined, true],
      ["dup", [{ key: "control", addedMinor: 0 }, { key: "control", addedMinor: 1 }], undefined, true],
    ])("%s", (_, i, e, t) => {
      if (t) expect(() => parseArmSpend(i as any)).toThrow(AdsError);
      else expect(parseArmSpend(i as any)).toEqual(e);
    });
  });

  describe("experimentSpendIncreaseMinor", () => {
    it("sums", () => {
      expect(experimentSpendIncreaseMinor([{ key: "control", addedMinor: 40_000 }, { key: "variant", addedMinor: 40_000 }] as any)).toBe(80_000);
    });
    it("empty", () => expect(experimentSpendIncreaseMinor([])).toBe(0));
  });

  describe("gateGrowthHandlers", () => {
    it.each([[49900, true], [50000, true], [50100, false]])("R%s: propose %s", async (sp, ok) => {
      const { h, d, l, ip } = setup(new Map().set("own", { currency: "ZAR", owner_threshold_minor: 50000 }));
      const w = gateGrowthHandlers(h, d);
      const p = { id: "e", armSpend: [{ key: "control", addedMinor: sp }] };
      if (ok) {
        await w["propose-experiment"](fakeActor(), p);
        expect(ip).toHaveBeenCalled();
        expect(await l.load("tc", "e")).toEqual({ scopeKey: "own", increaseMinor: sp });
      } else {
        await expect(w["propose-experiment"](fakeActor(), p)).rejects.toThrow();
        expect(ip).not.toHaveBeenCalled();
      }
    });

    it("cumulative 80k refused", async () => {
      const { h, d, ip } = setup(new Map().set("own", { currency: "ZAR", owner_threshold_minor: 50000 }));
      await expect(
        gateGrowthHandlers(h, d)["propose-experiment"](fakeActor(), {
          id: "e",
          armSpend: [
            { key: "control", addedMinor: 40000 },
            { key: "variant", addedMinor: 40000 },
          ],
        }),
      ).rejects.toThrow();
      expect(ip).not.toHaveBeenCalled();
    });

    it("100k threshold allows 80k", async () => {
      const { h, d, ip } = setup(new Map().set("own", { currency: "ZAR", owner_threshold_minor: 100000 }));
      await gateGrowthHandlers(h, d)["propose-experiment"](fakeActor(), {
        id: "e",
        armSpend: [
          { key: "control", addedMinor: 40000 },
          { key: "variant", addedMinor: 40000 },
        ],
      });
      expect(ip).toHaveBeenCalled();
    });

    it("USD null threshold: 0 ok, >0 refused", async () => {
      const { h, d, ip } = setup(new Map().set("own", { currency: "USD", owner_threshold_minor: null }));
      const w = gateGrowthHandlers(h, d);
      await w["propose-experiment"](fakeActor(), { id: "e1", armSpend: [{ key: "control", addedMinor: 0 }] });
      expect(ip).toHaveBeenCalledTimes(1);
      await expect(w["propose-experiment"](fakeActor(), { id: "e2", armSpend: [{ key: "control", addedMinor: 1 }] })).rejects.toThrow();
    });

    it("person approve >threshold ok", async () => {
      const l = fakeLedger();
      await l.save("tc", "e8", { scopeKey: "own", increaseMinor: 80000 });
      const { h, d, ia } = setup(new Map().set("own", { currency: "ZAR", owner_threshold_minor: 50000 }), l);
      await gateGrowthHandlers(h, d)["approve-experiment"](fakeActor({ isAgent: false }), { experimentId: "e8" });
      expect(ia).toHaveBeenCalled();
    });

    it("agent reviewer >threshold refused", async () => {
      const l = fakeLedger();
      await l.save("tc", "e9", { scopeKey: "own", increaseMinor: 80000 });
      const { h, d, ia } = setup(new Map().set("own", { currency: "ZAR", owner_threshold_minor: 50000 }), l);
      await expect(gateGrowthHandlers(h, d)["approve-experiment"](fakeActor({ isReviewer: true }), { experimentId: "e9" })).rejects.toThrow();
      expect(ia).not.toHaveBeenCalled();
    });

    it("agent within threshold ok", async () => {
      const l = fakeLedger();
      await l.save("tc", "e10", { scopeKey: "own", increaseMinor: 40000 });
      const { h, d, ia } = setup(new Map().set("own", { currency: "ZAR", owner_threshold_minor: 50000 }), l);
      await gateGrowthHandlers(h, d)["approve-experiment"](fakeActor(), { experimentId: "e10" });
      expect(ia).toHaveBeenCalled();
    });

    it("lowered threshold refuses", async () => {
      const l = fakeLedger();
      await l.save("tc", "e11", { scopeKey: "own", increaseMinor: 40000 });
      const { h, d, ia } = setup(new Map().set("own", { currency: "ZAR", owner_threshold_minor: 30000 }), l);
      await expect(gateGrowthHandlers(h, d)["approve-experiment"](fakeActor(), { experimentId: "e11" })).rejects.toThrow();
      expect(ia).not.toHaveBeenCalled();
    });

    it("missing record refused", async () => {
      const { h, d, ia } = setup(new Map().set("own", { currency: "ZAR", owner_threshold_minor: 50000 }));
      await expect(gateGrowthHandlers(h, d)["approve-experiment"](fakeActor(), { experimentId: "x" })).rejects.toThrow(/No spend record/);
      expect(ia).not.toHaveBeenCalled();
    });

    it("unknown scope refused", async () => {
      const l = fakeLedger();
      await l.save("tc", "e13", { scopeKey: "x", increaseMinor: 1000 });
      const { h, d, ia } = setup(new Map(), l);
      await expect(gateGrowthHandlers(h, d)["approve-experiment"](fakeActor(), { experimentId: "e13" })).rejects.toThrow(/not found/);
      expect(ia).not.toHaveBeenCalled();
    });

    it("two-scope isolation", async () => {
      const s = new Map<string, any>();
      s.set("A", { currency: "ZAR", owner_threshold_minor: 100000 });
      s.set("B", { currency: "ZAR", owner_threshold_minor: 10000 });
      const gs = vi.fn(async (c: string, sk: string) => s.get(sk) ?? null) as any;
      const { h, l } = setup(s);
      const w = gateGrowthHandlers(h, { ledger: l, getScope: gs });
      await w["propose-experiment"](fakeActor(), { id: "eA", armSpend: [{ key: "control", addedMinor: 50000 }], client: "A" });
      expect(gs).toHaveBeenCalledWith("tc", "A");
      await expect(w["propose-experiment"](fakeActor(), { id: "eB", armSpend: [{ key: "control", addedMinor: 50000 }], client: "B" })).rejects.toThrow();
      expect(gs).toHaveBeenCalledWith("tc", "B");
    });

    it("null client => own", async () => {
      const gs = vi.fn(async (c: string, sk: string) => (sk === "own" ? { currency: "ZAR", owner_threshold_minor: 50000 } : null)) as any;
      const { h, l } = setup(new Map(), fakeLedger());
      const w = gateGrowthHandlers(h, { ledger: l, getScope: gs });
      await w["propose-experiment"](fakeActor(), { id: "e", armSpend: [{ key: "control", addedMinor: 40000 }] });
      expect(gs).toHaveBeenCalledWith("tc", "own");
    });

    it("list-experiments pass-through", async () => {
      const { h, d, il } = setup(new Map());
      const w = gateGrowthHandlers(h, d);
      expect(w["list-experiments"]).toBe(h["list-experiments"]);
      await w["list-experiments"](fakeActor(), {});
      expect(il).toHaveBeenCalled();
    });
  });

  describe("growthSpendDeclarations", () => {
    it("propose gets armSpend", () => {
      const t: PluginToolDeclaration[] = [
        { name: "propose-experiment", displayName: "P", description: "d", parametersSchema: { type: "object", required: ["x"], properties: { x: { type: "string" } } } },
      ];
      const r = growthSpendDeclarations(t);
      const s = r[0].parametersSchema as any;
      expect(s.required).toContain("armSpend");
      expect(s.properties.armSpend.description.length).toBeLessThanOrEqual(200);
      expect(s.properties.armSpend.description).not.toContain("\n");
    });

    it("others unchanged", () => {
      const t: PluginToolDeclaration[] = [{ name: "list-experiments", displayName: "L", description: "d", parametersSchema: { type: "object" } }];
      expect(growthSpendDeclarations(t)[0]).toEqual(t[0]);
    });
  });
});
