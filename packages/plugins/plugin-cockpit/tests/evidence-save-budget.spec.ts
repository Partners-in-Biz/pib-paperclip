import { describe, expect, it } from "vitest";
import { EVIDENCE_ACK_TIMEOUT_MS } from "../src/evidence-drive.js";
import { EVIDENCE_SAVE_TOOL_TIMEOUT_MS, OPS_TOOLS } from "../src/ops-tool-declarations.js";

describe("evidence-save gateway budget (PAR-10249)", () => {
  it("declares 25 s and waits less than that for the Drive ack", () => {
    const tool = OPS_TOOLS.find((t) => t.name === "evidence-save");
    expect(tool?.timeoutMs).toBe(25_000);
    expect(EVIDENCE_SAVE_TOOL_TIMEOUT_MS).toBe(25_000);
    expect(EVIDENCE_ACK_TIMEOUT_MS).toBe(20_000);
    expect(EVIDENCE_ACK_TIMEOUT_MS).toBeLessThan(tool!.timeoutMs!);
  });
});
