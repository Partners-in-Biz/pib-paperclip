import { describe, expect, it } from "vitest";
import { mcpToolCallResult } from "../routes/tool-gateway.js";

describe("mcpToolCallResult", () => {
  it("unwraps plugin tool results and sends their data as structuredContent", () => {
    const out = mcpToolCallResult({
      pluginId: "p1",
      toolName: "company-profile",
      result: { content: "Profile loaded", data: { tradingName: "Acme" } },
    });
    expect(out).toEqual({
      content: [{ type: "text", text: "Profile loaded" }],
      structuredContent: { tradingName: "Acme" },
      isError: false,
    });
  });

  it("never sends null or an array as structuredContent", () => {
    for (const execution of [
      { pluginId: "p1", toolName: "t", result: { content: "No data" } },
      { pluginId: "p1", toolName: "t", result: { content: "A list", data: [1, 2] } },
      "replayed summary",
      null,
    ]) {
      const out = mcpToolCallResult(execution);
      expect(out).not.toHaveProperty("structuredContent");
      expect(typeof out.content[0]!.text).toBe("string");
    }
  });

  it("marks plugin tool errors as errors", () => {
    const out = mcpToolCallResult({ pluginId: "p1", toolName: "t", result: { content: "Not allowed", error: "Not allowed" } });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toBe("Not allowed");
  });

  it("keeps other tool results as before", () => {
    expect(mcpToolCallResult({ content: "ok", data: { a: 1 } })).toEqual({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { a: 1 },
      isError: false,
    });
    expect(mcpToolCallResult({ data: { a: 1 } }).content[0]!.text).toBe('{"a":1}');
  });
});
