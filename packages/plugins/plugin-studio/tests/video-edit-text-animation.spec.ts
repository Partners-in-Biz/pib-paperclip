/**
 * PAR-10174 (D4d1): the pure text animation presets shared by the render (compile-text.ts) and the preview.
 */
import { describe, expect, it } from "vitest";
import { phases, revealCount, revealUnits, textAnimationAt } from "../src/video-edit/text-animation.js";

describe("text-animation.ts", () => {
  it("reveal units rebuild the text; graphemes stay whole, newlines ride with the next unit", () => {
    const text = "Hi 👍🏽 yo\nok ";
    for (const kind of ["char", "word"] as const) {
      const { units, tail } = revealUnits(text, kind);
      expect(units.map((u) => u.prefix + u.text).join("") + tail).toBe(text);
    }
    expect(revealUnits(text, "char").units.map((u) => u.text)).toEqual(["H", "i", " ", "👍🏽", " ", "y", "o", "o", "k", " "]);
    expect(revealUnits(text, "word").units.map((u) => u.text)).toEqual(["Hi", "👍🏽", "yo", "ok"]);
  });

  it("entry shows units from the first at once, exit hides them last first", () => {
    const [entry, exit] = phases({ in: "typewriter", inDuration: 1, out: "typewriter", outDuration: 1 }, 3);
    expect([0, 0.24, 0.25, 0.99, 1].map((t) => revealCount(entry!, t, 4))).toEqual([1, 1, 2, 4, 4]);
    expect([2, 2.24, 2.26, 2.76, 2.99].map((t) => revealCount(exit!, t, 4))).toEqual([4, 4, 3, 1, 1]);
  });

  it("a slide enters from one side and leaves to the other; scale and alpha follow the curves", () => {
    const clip = { duration: 2, transform: { x: 10, y: -20 }, animation: { in: "slideLeft" as const, inDuration: 0.5, out: "slideLeft" as const, outDuration: 0.5 } };
    const at = (t: number) => textAnimationAt(clip, { width: 1080, height: 1920 }, t);
    expect(at(0)).toEqual({ x: 550 + 216, y: 940, scale: 1, alpha: 0, shown: null });
    expect(at(1)).toEqual({ x: 550, y: 940, scale: 1, alpha: 1, shown: null });
    expect(at(2).x).toBeCloseTo(550 - 216, 9);
    const pop = textAnimationAt({ ...clip, animation: { in: "pop", inDuration: 1 } }, { width: 1080, height: 1920 }, 0.3);
    expect(pop.scale).toBeCloseTo(0.55, 9);
    expect(pop.alpha).toBe(1);
  });
});
