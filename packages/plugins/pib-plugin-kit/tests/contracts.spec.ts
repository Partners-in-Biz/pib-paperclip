import { describe, expect, it } from "vitest";
import { GROWTH_EVENTS, PIB_PLUGINS, pluginEvent } from "../src/contracts.js";

describe("growth event contracts", () => {
  it("names the events and namespaces them per plugin", () => {
    expect(GROWTH_EVENTS).toEqual({ verdict: "growth.verdict", programUpserted: "growth.program.upserted" });
    expect(pluginEvent(PIB_PLUGINS.social, GROWTH_EVENTS.verdict)).toBe("plugin.partnersinbiz.social.growth.verdict");
  });
});
