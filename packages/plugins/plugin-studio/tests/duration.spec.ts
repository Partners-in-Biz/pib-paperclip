import { describe, expect, it } from "vitest";
import { requestBody } from "../src/generation.js";
import { MODEL_CATALOG } from "../src/models.js";
import { PAGE_MODELS } from "../src/page.js";

const KLING = "kling-video/v3.0-turbo/text-to-video";
const SOUL = "higgsfield-ai/soul/v2/standard";
const HAILUO = "minimax/hailuo-2.3/standard/text-to-video";

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return null;
};

describe("video duration", () => {
  it("sets the three fields for every model", () => {
    for (const m of MODEL_CATALOG) {
      expect(Array.isArray(m.durations)).toBe(true);
      expect(m.durationField === null).toBe(m.durations.length === 0);
      expect(m.defaultDuration === null).toBe(m.durationField === null);
      if (m.defaultDuration !== null) expect(m.durations).toContain(m.defaultDuration);
      if (m.kind === "image") expect(m.durationField).toBeNull();
    }
    expect(MODEL_CATALOG.find((m) => m.id === HAILUO)).toMatchObject({ durations: [6, 10], durationField: "duration", defaultDuration: 6 });
  });

  it("refuses a duration outside the list", () => {
    expect(refusal(() => requestBody({ model: KLING, prompt: "x", params: { duration: 99 } }))).toBe("bad_duration");
    expect(refusal(() => requestBody({ model: HAILUO, prompt: "x", params: { duration: 5 } }))).toBe("bad_duration");
  });

  it("refuses a string duration", () => {
    expect(refusal(() => requestBody({ model: KLING, prompt: "x", params: { duration: "5" } }))).toBe("bad_duration");
  });

  it("fills the default when missing, keeps a valid value", () => {
    expect(requestBody({ model: KLING, prompt: "x" }).body.duration).toBe(5);
    expect(requestBody({ model: HAILUO, prompt: "x", params: { duration: null } }).body.duration).toBe(6);
    expect(requestBody({ model: KLING, prompt: "x", params: { duration: 12 } }).body.duration).toBe(12);
  });

  it("refuses a duration key on a model with no duration field", () => {
    expect(refusal(() => requestBody({ model: SOUL, prompt: "x", params: { duration: 5 } }))).toBe("no_duration");
    expect(refusal(() => requestBody({ model: SOUL, prompt: "x", params: { duration_seconds: 5 } }))).toBe("no_duration");
    expect("duration" in requestBody({ model: SOUL, prompt: "x" }).body).toBe(false);
  });

  it("carries the fields on the page model list", () => {
    const kling = PAGE_MODELS.find((m) => m.id === KLING)!;
    expect(kling.durations).toHaveLength(13);
    expect(kling).toMatchObject({ durationField: "duration", defaultDuration: 5 });
    expect(PAGE_MODELS.find((m) => m.id === SOUL)).toMatchObject({ durations: [], durationField: null, defaultDuration: null });
  });
});
