import { afterEach, describe, expect, it, vi } from "vitest";

describe("sidebar refresh", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refreshes no more often than every two minutes", async () => {
    const { SIDEBAR_REFRESH_MS } = await import("../src/ui/data.js");
    expect(SIDEBAR_REFRESH_MS).toBeGreaterThanOrEqual(120_000);
  });

  it("treats a background tab as hidden", async () => {
    const { isTabHidden } = await import("../src/ui/data.js");
    vi.stubGlobal("document", { visibilityState: "hidden" });
    expect(isTabHidden()).toBe(true);
    vi.stubGlobal("document", { visibilityState: "visible" });
    expect(isTabHidden()).toBe(false);
  });
});
