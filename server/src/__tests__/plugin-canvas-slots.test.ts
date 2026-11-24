import { describe, expect, it } from "vitest";
import { PLUGIN_UI_SLOT_TYPES } from "@paperclipai/shared";
import { pluginCapabilityValidator } from "../services/plugin-capability-validator.js";

describe("canvas plugin slots", () => {
  it("are known slot types that need only ui.sidebar.register", () => {
    const v = pluginCapabilityValidator();
    for (const slot of ["canvasNode", "canvasPanel"] as const) {
      expect(PLUGIN_UI_SLOT_TYPES).toContain(slot);
      expect(v.getUiSlotCapability(slot)).toBe("ui.sidebar.register");
    }
  });
  it("every slot type has a capability mapping", () => {
    const v = pluginCapabilityValidator();
    for (const slot of PLUGIN_UI_SLOT_TYPES) expect(v.getUiSlotCapability(slot)).toBeTruthy();
  });
});
