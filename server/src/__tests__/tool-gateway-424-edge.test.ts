import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { mcpGatewayProtocolRoutes, toolGatewayRoutes } from "../routes/tool-gateway.js";
import { ToolGatewayHttpError } from "../services/tool-gateway.js";

function app(error: ToolGatewayHttpError) {
  const gateway = { executeTool: async () => { throw error; } } as never;
  const a = express();
  a.use(express.json());
  a.use("/api", toolGatewayRoutes({} as never, gateway));
  a.use("/api", mcpGatewayProtocolRoutes(gateway));
  return a;
}
const rest = (e: ToolGatewayHttpError) =>
  request(app(e)).post("/api/tool-gateway/tools/call").set("x-paperclip-tool-gateway-token", "t").send({ tool: "x" });
const rpc = (e: ToolGatewayHttpError) =>
  request(app(e)).post("/api/mcp/gateways/g1").set("Authorization", "Bearer t")
    .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x" } });

describe("tool gateway upstream failures at the route edge", () => {
  it("REST: tool_error and tool_timeout return 424 with the body unchanged", async () => {
    const a = await rest(new ToolGatewayHttpError(502, "Slides failed", "tool_error", { detail: 1 }));
    expect(a.status).toBe(424);
    expect(a.body).toEqual({ error: "Slides failed", reasonCode: "tool_error", detail: 1 });
    expect((await rest(new ToolGatewayHttpError(504, "slow", "tool_timeout"))).status).toBe(424);
  });
  it("REST: other codes keep their status", async () => {
    expect((await rest(new ToolGatewayHttpError(403, "no", "github_access_denied"))).status).toBe(403);
    expect((await rest(new ToolGatewayHttpError(502, "x", "something_else"))).status).toBe(502);
    expect((await rest(new ToolGatewayHttpError(400, "x", "tool_error"))).status).toBe(400);
  });
  it("JSON-RPC: 424 with error.code -32603 and data unchanged", async () => {
    const r = await rpc(new ToolGatewayHttpError(502, "bad", "mcp_remote_status", { s: 500 }));
    expect(r.status).toBe(424);
    expect(r.body.error).toEqual({ code: -32603, message: "bad", data: { reasonCode: "mcp_remote_status", s: 500 } });
  });
  it("JSON-RPC: tool_error stays 200 isError", async () => {
    const r = await rpc(new ToolGatewayHttpError(502, "bad", "tool_error"));
    expect(r.status).toBe(200);
    expect(r.body.result.isError).toBe(true);
  });
});
