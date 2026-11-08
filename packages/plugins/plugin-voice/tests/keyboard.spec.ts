// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keepFieldVisible } from "../src/ui/keyboard.js";

function fakeViewport(height: number, offsetTop = 0) {
  const l = new Map<string, Set<() => void>>();
  return {
    height,
    offsetTop,
    addEventListener: vi.fn((t: string, f: () => void) => (l.get(t) ?? l.set(t, new Set()).get(t)!).add(f)),
    removeEventListener: vi.fn((t: string, f: () => void) => l.get(t)?.delete(f)),
    fire: (t: string) => l.get(t)?.forEach((f) => f()),
    count: () => [...l.values()].reduce((n, s) => n + s.size, 0),
  };
}

function field(bottom: number) {
  const el = document.createElement("textarea");
  document.body.appendChild(el);
  el.getBoundingClientRect = () => ({ bottom }) as DOMRect;
  el.scrollIntoView = vi.fn();
  return el;
}

const setVV = (v: unknown) => Object.defineProperty(window, "visualViewport", { value: v, configurable: true });

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (f: () => void) => (f(), 0));
  window.requestAnimationFrame = (f: FrameRequestCallback) => (f(0), 0);
});
afterEach(() => {
  document.body.innerHTML = "";
  setVV(undefined);
  vi.unstubAllGlobals();
});

describe("keepFieldVisible", () => {
  it("scrolls a field below the shrunk visual viewport to the top", () => {
    const vv = fakeViewport(400);
    setVV(vv);
    const stop = keepFieldVisible(document);
    const el = field(700);
    el.focus();
    expect(el.scrollIntoView).toHaveBeenCalledWith({ block: "start", inline: "nearest" });
    stop();
  });

  it("re-checks on visualViewport resize while focused, and stops after blur", () => {
    const vv = fakeViewport(800);
    setVV(vv);
    const stop = keepFieldVisible(document);
    const el = field(700);
    el.focus();
    expect(el.scrollIntoView).not.toHaveBeenCalled();
    vv.height = 400;
    vv.fire("resize");
    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
    el.blur();
    vv.fire("scroll");
    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
    stop();
  });

  it("leaves a field that is already visible alone (offsetTop counted)", () => {
    setVV(fakeViewport(400, 100));
    const stop = keepFieldVisible(document);
    const el = field(480);
    el.focus();
    expect(el.scrollIntoView).not.toHaveBeenCalled();
    stop();
  });

  it("is a no-op without visualViewport", () => {
    setVV(undefined);
    const add = vi.spyOn(document, "addEventListener");
    const stop = keepFieldVisible(document);
    const el = field(700);
    el.focus();
    expect(el.scrollIntoView).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });

  it("removes its listeners on unmount", () => {
    const vv = fakeViewport(400);
    setVV(vv);
    const stop = keepFieldVisible(document);
    expect(vv.count()).toBe(2);
    stop();
    expect(vv.count()).toBe(0);
    const el = field(700);
    el.focus();
    expect(el.scrollIntoView).not.toHaveBeenCalled();
  });
});
