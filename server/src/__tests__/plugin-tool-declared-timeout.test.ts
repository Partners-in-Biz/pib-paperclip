/**
 * PAR-9039: a slow plugin tool (run-pagespeed) declares its own timeout in its
 * manifest, so gateway callers need not send `timeoutMs`. The declared budget
 * must reach the gateway's timeout resolver and the worker `executeTool` RPC.
 */
import { describe, expect, it, vi } from "vitest";
import { pluginToolDeclarationSchema, type PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { resolveToolTimeoutMs, type ToolGatewayDescriptor } from "../services/tool-gateway.js";

const PLUGIN_KEY = "acme.slow";
const PLUGIN_DB_ID = "00000000-0000-4000-8000-000000000002";

const MANIFEST = {
  id: PLUGIN_KEY,
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Slow plugin",
  description: "Fixture",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
  tools: [
    { name: "slow", displayName: "Slow", description: "Slow tool", parametersSchema: { type: "object" }, timeoutMs: 60_000 },
    { name: "fast", displayName: "Fast", description: "Fast tool", parametersSchema: { type: "object" } },
  ],
} as unknown as PaperclipPluginManifestV1;

function workerManager() {
  const call = vi.fn(async () => ({ content: "ok" }));
  return { manager: { isRunning: vi.fn(() => true), call } as unknown as PluginWorkerManager, call };
}

function pluginDescriptor(timeoutMs?: number): ToolGatewayDescriptor {
  return {
    name: `${PLUGIN_KEY}:slow`,
    displayName: "Slow",
    description: "Slow tool",
    parametersSchema: {},
    pluginId: PLUGIN_DB_ID,
    providerType: "paperclip_plugin",
    risk: "read",
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

describe("plugin tool declared timeout", () => {
  it("accepts a timeoutMs of 1-60 s in the manifest tool declaration", () => {
    const base = { name: "x", displayName: "X", description: "x", parametersSchema: { type: "object" } };
    expect(pluginToolDeclarationSchema.parse({ ...base, timeoutMs: 60_000 }).timeoutMs).toBe(60_000);
    expect(pluginToolDeclarationSchema.parse(base).timeoutMs).toBeUndefined();
    expect(pluginToolDeclarationSchema.safeParse({ ...base, timeoutMs: 120_000 }).success).toBe(false);
    expect(pluginToolDeclarationSchema.safeParse({ ...base, timeoutMs: 0 }).success).toBe(false);
  });

  it("carries the declared timeout to the agent descriptor and the worker RPC", async () => {
    const { manager, call } = workerManager();
    const dispatcher = createPluginToolDispatcher({ workerManager: manager });
    dispatcher.registerPluginTools(PLUGIN_KEY, MANIFEST, PLUGIN_DB_ID);

    const tools = dispatcher.listToolsForAgent();
    expect(tools.find((t) => t.name === `${PLUGIN_KEY}:slow`)?.timeoutMs).toBe(60_000);
    expect(tools.find((t) => t.name === `${PLUGIN_KEY}:fast`)).not.toHaveProperty("timeoutMs");

    const run = { agentId: "a", runId: "r", companyId: "c", projectId: "p" };
    await dispatcher.executeTool(`${PLUGIN_KEY}:slow`, {}, run);
    await dispatcher.executeTool(`${PLUGIN_KEY}:fast`, {}, run);
    expect(call.mock.calls[0]?.[3]).toBe(60_000);
    // Undeclared tools keep the worker manager's default RPC timeout.
    expect(call.mock.calls[1]?.[3]).toBeUndefined();
  });

  it("uses the declared timeout at the gateway when the caller sends none", () => {
    expect(resolveToolTimeoutMs(undefined, pluginDescriptor(60_000))).toBe(60_000);
    expect(resolveToolTimeoutMs(undefined, pluginDescriptor(500_000))).toBe(60_000);
    expect(resolveToolTimeoutMs(undefined, pluginDescriptor())).toBe(10_000);
    // An explicit caller value still wins.
    expect(resolveToolTimeoutMs(15_000, pluginDescriptor(60_000))).toBe(15_000);
    // Only plugin tools may declare their own budget.
    expect(resolveToolTimeoutMs(undefined, { ...pluginDescriptor(60_000), providerType: "mcp_remote_http" })).toBe(10_000);
  });
});
