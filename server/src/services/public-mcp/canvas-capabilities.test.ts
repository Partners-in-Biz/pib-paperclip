import { describe, expect, it, vi } from "vitest";
import { canvasMcpCapabilities } from "./canvas-capabilities.js";

const cap = (name: string) => canvasMcpCapabilities.find((c) => c.name === name)!;
const ids = { companyId: "11111111-1111-4111-8111-111111111111", boardId: "22222222-2222-4222-8222-222222222222" };
const requestId = "33333333-3333-4333-8333-333333333333";

describe("public MCP canvas tools", () => {
  it("exposes the five tools; the three writes are marked write", () => {
    expect(canvasMcpCapabilities.map((c) => [c.name, !!c.write])).toEqual([
      ["paperclip_canvas_list", false], ["paperclip_canvas_read", false], ["paperclip_canvas_apply_ops", true],
      ["paperclip_canvas_import", true], ["paperclip_canvas_comment", true],
    ]);
  });
  it("writes require a requestId and reject unknown fields", () => {
    for (const [name, args] of [
      ["paperclip_canvas_apply_ops", { ...ids, ops: [{ op: "restore", key: "a" }] }],
      ["paperclip_canvas_import", { ...ids, format: "markdown", source: "# A" }],
      ["paperclip_canvas_comment", { ...ids, body: "hi" }],
    ] as const) {
      expect(cap(name).schema.safeParse(args).success, name).toBe(false);
      expect(cap(name).schema.safeParse({ ...args, requestId }).success, name).toBe(true);
      expect(cap(name).schema.safeParse({ ...args, requestId, extra: 1 }).success, name).toBe(false);
    }
  });
  it("validates formats, ops and import format", () => {
    expect(cap("paperclip_canvas_read").schema.safeParse({ ...ids, format: "yaml" }).success).toBe(false);
    expect(cap("paperclip_canvas_read").schema.safeParse({ ...ids, format: "mermaid", q: "x", keys: ["a"] }).success).toBe(true);
    expect(cap("paperclip_canvas_apply_ops").schema.safeParse({ ...ids, requestId, ops: [{ op: "bogus" }] }).success).toBe(false);
    expect(cap("paperclip_canvas_apply_ops").schema.safeParse({ ...ids, requestId, ops: [] }).success).toBe(false);
    expect(cap("paperclip_canvas_import").schema.safeParse({ ...ids, requestId, format: "svg", source: "x" }).success).toBe(false);
  });
  it("maps requestId to clientBatchId on ops and import", async () => {
    const api = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
    const principal = {} as never;
    await cap("paperclip_canvas_apply_ops").run(principal, { ...ids, requestId, ops: [{ op: "restore", key: "a" }] }, api, "");
    expect(api).toHaveBeenLastCalledWith(principal, "POST", `/companies/${ids.companyId}/planning-canvases/${ids.boardId}/ops`, { ops: [{ op: "restore", key: "a" }], clientBatchId: requestId });
    await cap("paperclip_canvas_import").run(principal, { ...ids, requestId, format: "markdown", source: "# A", at: { x: 1, y: 2 } }, api, "");
    expect(api).toHaveBeenLastCalledWith(principal, "POST", `/companies/${ids.companyId}/planning-canvases/${ids.boardId}/import`, { format: "markdown", source: "# A", at: { x: 1, y: 2 }, clientBatchId: requestId });
  });
  it("read returns text for markdown and the board for json", async () => {
    const text = vi.fn(async (..._args: unknown[]) => "# Board");
    expect(await cap("paperclip_canvas_read").run({} as never, { ...ids, format: "markdown", q: "a b" }, text, "")).toEqual({ format: "markdown", text: "# Board" });
    expect(text.mock.calls[0]![2]).toBe(`/companies/${ids.companyId}/planning-canvases/${ids.boardId}?format=markdown&q=a+b`);
    const json = vi.fn(async (..._args: unknown[]) => ({ id: ids.boardId }));
    expect(await cap("paperclip_canvas_read").run({} as never, { ...ids, format: "json" }, json, "")).toEqual({ format: "json", board: { id: ids.boardId } });
  });
});
