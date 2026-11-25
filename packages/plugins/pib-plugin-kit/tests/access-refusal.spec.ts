import { describe, expect, it } from "vitest";
import { guardAction, isRefusal, permissionRefusal, RefusalError, unwrapAction } from "../src/access/refusal.js";

describe("refusal form (plan 4.4, moved from Studio)", () => {
  it("is a 200 answer with code PERMISSION_DENIED", () => {
    const r = permissionRefusal("No");
    expect(r).toEqual({ ok: false, refused: true, code: "PERMISSION_DENIED", message: "No" });
    expect(isRefusal(r)).toBe(true);
    expect(isRefusal({ ok: false, message: "x" })).toBe(false);
  });

  it("guardAction turns a refusal error into the form and rethrows anything else; unwrapAction throws it back", async () => {
    class Plain extends Error {
      code = "PLAIN";
    }
    const isPlain = (e: unknown): e is Plain => e instanceof Plain;
    const answer = await guardAction(async () => { throw new Plain("not yours"); }, isPlain)({}, {});
    expect(answer).toEqual({ ok: false, refused: true, code: "PLAIN", message: "not yours" });
    await expect(guardAction(async () => { throw new Error("fault"); }, isPlain)({}, {})).rejects.toThrow("fault");
    expect(() => unwrapAction(answer)).toThrow(RefusalError);
    expect(unwrapAction({ ok: true })).toEqual({ ok: true });
  });
});
