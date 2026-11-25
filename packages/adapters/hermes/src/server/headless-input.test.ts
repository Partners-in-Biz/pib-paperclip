import { describe, expect, it } from "vitest";
import { applyHeadlessEnv, detectInputRequired, stripInteractiveToolsets } from "./headless-input.js";

describe("headless-input", () => {
  it("strips clarify from explicit toolsets", () => {
    expect(stripInteractiveToolsets("terminal, clarify,file")).toBe("terminal,file");
    expect(stripInteractiveToolsets("clarify")).toBeUndefined();
    expect(stripInteractiveToolsets(undefined)).toBeUndefined();
  });

  it("marks single-query unless operator set it", () => {
    const a: Record<string, string> = {};
    applyHeadlessEnv(a);
    expect(a.HERMES_SINGLE_QUERY_SESSION).toBe("1");
    const b: Record<string, string> = { HERMES_SINGLE_QUERY_SESSION: "0" };
    applyHeadlessEnv(b);
    expect(b.HERMES_SINGLE_QUERY_SESSION).toBe("0");
  });

  it("detects the detach line and returns an actionable message", () => {
    const msg = detectInputRequired("", "Input required; detached without cancelling. Resume this session interactively.\n");
    expect(msg).toMatch(/clarify/);
    expect(detectInputRequired("ok", "")).toBeNull();
  });
});
