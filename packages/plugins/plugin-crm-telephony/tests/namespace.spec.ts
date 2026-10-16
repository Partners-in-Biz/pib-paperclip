import { describe, it, expect } from "vitest";
import { pluginNamespace } from "../src/namespace.js";

describe("pluginNamespace", () => {
  it("unchanged", () => expect(pluginNamespace()).toBe("plugin_crm_telephony_40e33d0807"));
  it("collapses __", () => {
    const n = pluginNamespace("x.y", "a__b");
    expect(n).not.toContain("__");
    expect(n).toContain("a_b");
  });
  it("≤63", () => expect(pluginNamespace().length).toBeLessThanOrEqual(63));
});
