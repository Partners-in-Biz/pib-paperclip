import { describe, expect, it } from "vitest";
import { onDriveBind, onDriveBindingEvent, loadSetup } from "../src/service.js";
import { fakeCtx } from "./helpers/fake-ctx.js";

const A = "company-a";
const B = "company-b";
const event = (companyId: string) => ({ payload: { companyId, connected: true, candidates: [{ id: "drive-1", name: "Shared" }] } }) as never;

// Mirrors the host gate: a company-scoped state key with no scopeId reads as "all companies" and is refused.
function gated() {
  const h = fakeCtx();
  const { get, set } = h.ctx.state as unknown as { get: (k: any) => Promise<unknown>; set: (k: any, v: unknown) => Promise<void> };
  const check = (k: { scopeKind: string; scopeId?: string }) => {
    if (k.scopeKind === "company" && !k.scopeId) throw new Error("the current invocation is scoped to a company");
  };
  (h.ctx.state as any).get = async (k: any) => { check(k); return get(k); };
  (h.ctx.state as any).set = async (k: any, v: unknown) => { check(k); return set(k, v); };
  return h;
}

describe("drive binding state key", () => {
  it("stores the event, loads the candidates and accepts a bind for the same company", async () => {
    const { ctx } = gated();
    await onDriveBindingEvent(ctx, event(A));
    const setup = await loadSetup(ctx, A);
    expect(setup.drive?.candidates).toEqual([{ id: "drive-1", name: "Shared" }]);
    expect(await onDriveBind(ctx, { companyId: A, sharedDriveId: "drive-1" })).toEqual({ ok: true });
    expect((await loadSetup(ctx, B)).drive).toBeNull();
  });
});
