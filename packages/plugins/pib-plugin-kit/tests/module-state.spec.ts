import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearModuleCache, fetchModules, moduleEnabled, moduleState, moduleStateOf } from "../src/setup-client.js";

const body = {
  modules: { crm: true, seo: false, billing: false },
  enabled: { crm: true, seo: false, billing: true },
  entitled: { crm: true, seo: true, billing: false },
};

function stubFetch(response: { ok?: boolean; json?: unknown } | "throw") {
  const fn = vi.fn(async () => {
    if (response === "throw") throw new Error("offline");
    return { ok: response.ok ?? true, json: async () => response.json };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("module state", () => {
  beforeEach(() => clearModuleCache());
  afterEach(() => vi.unstubAllGlobals());

  it("tells on, off and not in the plan apart", async () => {
    stubFetch({ json: body });
    expect(await moduleState("co", "partnersinbiz.crm")).toBe("on");
    expect(await moduleState("co", "partnersinbiz.seo")).toBe("off");
    expect(await moduleState("co", "partnersinbiz.billing")).toBe("not_entitled");
  });

  it("moduleEnabled is true only when the module is on and in the plan", async () => {
    stubFetch({ json: body });
    expect(await moduleEnabled("co", "partnersinbiz.crm")).toBe(true);
    expect(await moduleEnabled("co", "partnersinbiz.seo")).toBe(false);
    expect(await moduleEnabled("co", "partnersinbiz.billing")).toBe(false);
  });

  it("asks Setup once per company and keeps fetchModules as the combined switches", async () => {
    const fn = stubFetch({ json: body });
    await moduleState("co", "partnersinbiz.crm");
    await moduleEnabled("co", "partnersinbiz.seo");
    expect(await fetchModules("co")).toEqual(body.modules);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("reads the data envelope the host may wrap routes in", async () => {
    stubFetch({ json: { data: body } });
    expect(await moduleState("co", "partnersinbiz.billing")).toBe("not_entitled");
  });

  it("a Setup older than 0.6.1 only has the combined switches, which read as off", async () => {
    stubFetch({ json: { modules: { seo: false } } });
    expect(await moduleState("co", "partnersinbiz.seo")).toBe("off");
    expect(await moduleState("co", "partnersinbiz.crm")).toBe("on");
  });

  it("is on when there is no company, no module, or Setup cannot be reached", async () => {
    stubFetch("throw");
    expect(await moduleState(null, "partnersinbiz.seo")).toBe("on");
    expect(await moduleState("co", "other")).toBe("on");
    expect(await moduleState("co", "partnersinbiz.seo")).toBe("on");
    clearModuleCache();
    stubFetch({ ok: false });
    expect(await moduleState("co", "partnersinbiz.seo")).toBe("on");
  });

  it("not in the plan wins over switched off", () => {
    expect(moduleStateOf({ modules: { seo: false }, enabled: { seo: false }, entitled: { seo: false } }, "seo")).toBe("not_entitled");
    expect(moduleStateOf(null, "seo")).toBe("on");
  });
});
