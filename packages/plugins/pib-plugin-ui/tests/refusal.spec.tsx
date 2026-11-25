// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { AccessRefused, isRefusal, unwrapRefusal, withRefusal } from "../src/refusal.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ActionFn = (params?: Record<string, unknown>) => Promise<unknown>;
const REFUSAL = { ok: false, refused: true, code: "PERMISSION_DENIED", message: "The person this run works for may not do this." };

/** Renders a component that uses the wrapped hook and hands back each action it got. */
function renderWrapped(hook: (key: string) => ActionFn, renders = 1): ActionFn[] {
  const useAction = withRefusal(hook);
  const got: ActionFn[] = [];
  function Probe() {
    got.push(useAction("ads.save"));
    return null;
  }
  const root = createRoot(document.createElement("div"));
  for (let i = 0; i < renders; i++) act(() => root.render(<Probe key="one" />));
  act(() => root.unmount());
  return got;
}

describe("withRefusal", () => {
  it("throws AccessRefused with the message on the refusal form of 4.4", async () => {
    const inner = vi.fn<ActionFn>(async () => REFUSAL);
    const [save] = renderWrapped(() => inner);
    const error = await save({ id: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccessRefused);
    expect(error).toBeInstanceOf(Error);
    expect((error as AccessRefused).message).toBe(REFUSAL.message);
    expect((error as AccessRefused).code).toBe("PERMISSION_DENIED");
    expect(inner).toHaveBeenCalledWith({ id: 1 });
  });

  it("passes a normal answer through, including a plain ok: false", async () => {
    for (const answer of [{ ok: true, id: 7 }, { ok: false, error: "Name is required" }, null, [1, 2], "done"]) {
      const [save] = renderWrapped(() => async () => answer);
      await expect(save()).resolves.toBe(answer);
    }
  });

  it("lets bridge errors through unchanged", async () => {
    const bridgeError = { code: "WORKER_ERROR", message: "Boom" };
    const [save] = renderWrapped(() => async () => {
      throw bridgeError;
    });
    await expect(save()).rejects.toBe(bridgeError);
  });

  it("passes the hook its arguments and keeps one action across renders", () => {
    const stable = vi.fn<ActionFn>(async () => null);
    const hook = vi.fn((_key: string) => stable);
    const [first, second] = renderWrapped(hook, 2);
    expect(hook).toHaveBeenCalledWith("ads.save");
    expect(second).toBe(first);
  });
});

describe("the refusal form", () => {
  it("needs ok false, refused true and a message", () => {
    expect(isRefusal(REFUSAL)).toBe(true);
    expect(isRefusal({ ok: false, refused: true, code: "SOMETHING", message: "Studio" })).toBe(true);
    expect(isRefusal({ ok: false, refused: true })).toBe(false);
    expect(isRefusal({ ok: true, refused: true, message: "x" })).toBe(false);
    expect(isRefusal(undefined)).toBe(false);
    expect(() => unwrapRefusal(REFUSAL)).toThrow(AccessRefused);
    expect(unwrapRefusal(5)).toBe(5);
  });
});
