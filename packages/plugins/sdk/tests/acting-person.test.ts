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

async function callWorker(setup: Parameters<typeof definePlugin>[0]["setup"], method: string, params: unknown) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines = createInterface({ input: stdout });
  const pending = new Map<string, (response: JsonRpcResponse) => void>();
  const worker = startWorkerRpcHost({ plugin: definePlugin({ setup }), stdin, stdout });
  lines.on("line", (line: string) => {
    const message = parseMessage(line);
    if (isJsonRpcResponse(message)) pending.get(String(message.id))?.(message);
  });
  const call = (id: string, name: string, input: unknown) => new Promise<unknown>((resolve, reject) => {
    pending.set(id, (response) => ("error" in response && response.error
      ? reject(new Error(response.error.message))
      : resolve((response as { result?: unknown }).result)));
    stdin.write(serializeMessage(createRequest(name, input, id)));
  });
  try {
    await call("init", "initialize", { manifest, config: {}, databaseNamespace: null });
    return await call("call", method, params);
  } finally {
    worker.stop(); lines.close(); stdin.destroy(); stdout.destroy();
  }
}

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

// PAR-14297: a getData handler gets the host's acting person as a frozen second argument.
describe("data handler acting person", () => {
  async function getData(params: Record<string, unknown>) {
    return await callWorker(async (ctx) => {
      ctx.data.register("inspect", async (handlerParams, context) => ({
        params: handlerParams, actor: context.actor, frozen: Object.isFrozen(context) && Object.isFrozen(context.actor),
      }));
    }, "getData", { key: "inspect", ...params });
  }

  it.each([
    ["the host's person and mark", { onBehalfOfUserId: "p-1", onBehalfOfRestricted: true }, { onBehalfOfUserId: "p-1", onBehalfOfRestricted: true }],
    ["null for no person; anything but true is not restricted", { onBehalfOfUserId: null, onBehalfOfRestricted: "yes" }, { onBehalfOfUserId: null, onBehalfOfRestricted: false }],
  ])("passes %s", async (_label, sent, received) => {
    await expect(getData({ companyId: "company-1", params: { q: 1 }, actorContext: sent }))
      .resolves.toEqual({ params: { q: 1, companyId: "company-1" }, actor: received, frozen: true });
  });

  it.each([
    ["no actorContext (an older host)", {}],
    ["a null actorContext", { actorContext: null }],
    ["a non-object actorContext", { actorContext: "p-1" }],
  ])("gives {} for %s; a person in the params is not the mark", async (_label, extra) => {
    await expect(getData({ params: { onBehalfOfUserId: "spoofed", onBehalfOfRestricted: true }, ...extra }))
      .resolves.toMatchObject({ actor: {}, frozen: true });
    const result = await getData({ params: {}, ...extra }) as { actor: Record<string, unknown> };
    expect(result.actor).toEqual({});
  });

  it("a one-argument handler still works", async () => {
    await expect(callWorker(async (ctx) => { ctx.data.register("old", async (p) => p); }, "getData",
      { key: "old", params: { a: 1 }, actorContext: { onBehalfOfUserId: "p", onBehalfOfRestricted: true } }))
      .resolves.toEqual({ a: 1 });
  });

  it("the test harness hands the person to data handlers, {} when none is given", async () => {
    const harness = createTestHarness({ manifest: manifest as never });
    harness.ctx.data.register("inspect", async (_params, context) => context.actor);
    await expect(harness.getData("inspect", {}, { actor: { onBehalfOfUserId: "u", onBehalfOfRestricted: true } }))
      .resolves.toEqual({ onBehalfOfUserId: "u", onBehalfOfRestricted: true });
    await expect(harness.getData("inspect", {}, { actor: { onBehalfOfUserId: null } }))
      .resolves.toEqual({ onBehalfOfUserId: null, onBehalfOfRestricted: false });
    await expect(harness.getData("inspect")).resolves.toEqual({});
  });
});
