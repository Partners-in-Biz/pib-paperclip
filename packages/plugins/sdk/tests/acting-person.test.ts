import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { definePlugin } from "../src/define-plugin.js";
import { createRequest, isJsonRpcResponse, parseMessage, serializeMessage, type JsonRpcResponse } from "../src/protocol.js";
import { createTestHarness } from "../src/testing.js";
import { startWorkerRpcHost } from "../src/worker-rpc-host.js";

// PAR-12715 (H3 core half): the action caller carries the host's acting person
// when the host sends it, and keeps today's shape when an older host does not.

const manifest = {
  id: "paperclip.test-acting-person", apiVersion: 1, version: "1.0.0", displayName: "Acting person",
  description: "Test plugin", author: "Paperclip", categories: ["automation"], capabilities: [], entrypoints: {},
};

async function performAction(actorContext: Record<string, unknown>) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines = createInterface({ input: stdout });
  const pending = new Map<string, (response: JsonRpcResponse) => void>();
  const plugin = definePlugin({
    async setup(ctx) { ctx.actions.register("inspect", async (_params, context) => context.actor); },
  });
  const worker = startWorkerRpcHost({ plugin, stdin, stdout });
  lines.on("line", (line: string) => {
    const message = parseMessage(line);
    if (isJsonRpcResponse(message)) pending.get(String(message.id))?.(message);
  });
  const call = (id: string, method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
    pending.set(id, (response) => ("error" in response && response.error
      ? reject(new Error(response.error.message))
      : resolve((response as { result?: unknown }).result)));
    stdin.write(serializeMessage(createRequest(method, params, id)));
  });
  try {
    await call("init", "initialize", { manifest, config: {}, databaseNamespace: null });
    return await call("act", "performAction", { key: "inspect", params: {}, actorContext });
  } finally {
    worker.stop(); lines.close(); stdin.destroy(); stdout.destroy();
  }
}

const caller = { type: "agent", userId: null, agentId: "agent-1", runId: "run-1", companyId: "company-1" };

describe("action caller acting person", () => {
  it.each([
    ["the host's person and mark", { onBehalfOfUserId: "p-1", onBehalfOfRestricted: true }, { onBehalfOfUserId: "p-1", onBehalfOfRestricted: true }],
    ["null for no person; anything but true is not restricted", { onBehalfOfUserId: null, onBehalfOfRestricted: "yes" }, { onBehalfOfUserId: null, onBehalfOfRestricted: false }],
    ["neither field from an older host", {}, {}],
  ])("passes %s", async (_label, sent, received) => {
    await expect(performAction({ ...caller, ...sent })).resolves.toEqual({ ...caller, ...received });
  });

  it("the test harness hands the person to actions and tools", async () => {
    const harness = createTestHarness({ manifest: { ...manifest, capabilities: ["agent.tools.register"], tools: [
      { name: "probe", displayName: "Probe", description: "Probe", parametersSchema: { type: "object" } },
    ] } as never });
    harness.ctx.actions.register("inspect", async (_params, context) => context.actor);
    harness.ctx.tools.register("probe", { displayName: "Probe", description: "Probe", parametersSchema: { type: "object" } },
      async (_params, runCtx) => ({ data: runCtx }));
    await expect(harness.performAction("inspect", {}, { actor: { type: "user", userId: "u", onBehalfOfUserId: "u", onBehalfOfRestricted: true } }))
      .resolves.toMatchObject({ onBehalfOfUserId: "u", onBehalfOfRestricted: true });
    await expect(harness.executeTool("probe", {}, { onBehalfOfUserId: null }))
      .resolves.toMatchObject({ data: { onBehalfOfUserId: null, onBehalfOfRestricted: false } });
  });
});
