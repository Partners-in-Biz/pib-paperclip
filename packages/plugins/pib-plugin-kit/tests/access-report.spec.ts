import { describe, expect, it } from "vitest";
import { ACCESS_REFUSAL_EVENT, ACCESS_REFUSAL_INTERVAL_MS, reportAccessRefusal, type AccessRefusal } from "../src/access/report.js";
import { CO, PLUGIN, accessFake } from "./helpers/access-fake.js";

const refusal = (over: Partial<AccessRefusal> = {}): AccessRefusal => ({
  companyId: CO, pluginKey: PLUGIN, userId: "u1", key: "ads.save", permission: "ads.campaigns:edit", viaAgentId: null, ...over,
});

describe("reportAccessRefusal", () => {
  it("emits once per person and key per 10 minutes", async () => {
    const f = accessFake();
    let t = 0;
    const now = () => t;
    expect(await reportAccessRefusal(f.ctx, "enforce", refusal(), { now })).toBe(true);
    t = ACCESS_REFUSAL_INTERVAL_MS - 1;
    expect(await reportAccessRefusal(f.ctx, "enforce", refusal(), { now })).toBe(false);
    expect(await reportAccessRefusal(f.ctx, "report", refusal(), { now })).toBe(false);
    t = ACCESS_REFUSAL_INTERVAL_MS;
    expect(await reportAccessRefusal(f.ctx, "report", refusal(), { now })).toBe(true);
    expect(f.named(ACCESS_REFUSAL_EVENT)).toHaveLength(2);
  });

  it("counts another person or another key separately", async () => {
    const f = accessFake();
    await reportAccessRefusal(f.ctx, "enforce", refusal());
    await reportAccessRefusal(f.ctx, "enforce", refusal({ userId: "u2" }));
    await reportAccessRefusal(f.ctx, "enforce", refusal({ key: "tool:ads-list" }));
    expect(f.named(ACCESS_REFUSAL_EVENT)).toHaveLength(3);
  });

  it("sends the payload of the plan, with viaAgentId for an agent call", async () => {
    const f = accessFake();
    await reportAccessRefusal(f.ctx, "report", refusal({ key: "tool:ads-list", viaAgentId: "agent-9" }));
    expect(f.named(ACCESS_REFUSAL_EVENT)[0]).toEqual({
      name: "access.refusal",
      companyId: CO,
      payload: { companyId: CO, pluginKey: PLUGIN, userId: "u1", key: "tool:ads-list", permission: "ads.campaigns:edit", viaAgentId: "agent-9" },
    });
  });

  it("throttles an agent with no person by the agent", async () => {
    const f = accessFake();
    await reportAccessRefusal(f.ctx, "enforce", refusal({ userId: null, viaAgentId: "a1" }));
    await reportAccessRefusal(f.ctx, "enforce", refusal({ userId: null, viaAgentId: "a1" }));
    await reportAccessRefusal(f.ctx, "enforce", refusal({ userId: null, viaAgentId: "a2" }));
    expect(f.named(ACCESS_REFUSAL_EVENT).map((e) => e.payload.viaAgentId)).toEqual(["a1", "a2"]);
  });

  it("sends nothing under off", async () => {
    const f = accessFake();
    expect(await reportAccessRefusal(f.ctx, "off", refusal())).toBe(false);
    expect(f.emitted).toHaveLength(0);
  });

  it("never throws when the emit fails", async () => {
    const f = accessFake();
    (f.ctx.events as { emit: unknown }).emit = async () => {
      throw new Error("host refused");
    };
    await expect(reportAccessRefusal(f.ctx, "enforce", refusal())).resolves.toBe(true);
  });
});
