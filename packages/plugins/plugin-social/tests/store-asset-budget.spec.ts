import { describe, expect, it } from "vitest";
import { STORE_ASSET_DRIVE_ACK_MS } from "../src/asset-path.js";
import { SOCIAL_TOOLS, STORE_RENDERED_ASSET_TOOL_TIMEOUT_MS } from "../src/tools.js";

describe("store-rendered-asset gateway budget (PAR-10249)", () => {
  it("declares 25 s and waits 20 s for the Drive ack", () => {
    const tool = SOCIAL_TOOLS.find((t) => t.name === "store-rendered-asset");
    expect(tool?.timeoutMs).toBe(25_000);
    expect(STORE_RENDERED_ASSET_TOOL_TIMEOUT_MS).toBe(25_000);
    expect(STORE_ASSET_DRIVE_ACK_MS).toBe(20_000);
    expect(STORE_ASSET_DRIVE_ACK_MS).toBeLessThan(tool!.timeoutMs!);
  });
});
