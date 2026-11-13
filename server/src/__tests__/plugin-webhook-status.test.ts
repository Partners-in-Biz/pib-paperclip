// The public webhook route's status for a failed worker call (PAR-11278): a plugin's
// RATE_LIMITED refusal answers 429, every other worker error stays 502, and the
// delivery row is marked failed either way.
import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => ({}),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../services/live-events.js", () => ({
  publishGlobalLiveEvent: vi.fn(),
}));

const pluginKey = "acme.leads";
const deliveryId = "99999999-9999-4999-8999-999999999999";

function fakeDb() {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn(async () => [{ id: deliveryId }]) })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updates.push(values);
        return { where: vi.fn(async () => undefined) };
      }),
    })),
  };
  return { db, updates };
}

let pluginRoutes: typeof import("../routes/plugins.js").pluginRoutes;

async function send(callError: unknown) {
  const { db, updates } = fakeDb();
  const workerManager = { call: vi.fn(async () => { throw callError; }) };
  const app = express();
  app.use(express.json());
  app.use("/api", pluginRoutes(db as never, {} as never, undefined, { workerManager } as never));
  const res = await request(app).post(`/api/plugins/${pluginKey}/webhooks/lead`).send({ email: "a@example.test" });
  return { res, updates, workerManager };
}

describe("POST /api/plugins/:pluginId/webhooks/:endpointKey worker errors", () => {
  // The routes module is large: load it once, outside the per-test timeout.
  beforeAll(async () => {
    ({ pluginRoutes } = await import("../routes/plugins.js"));
  }, 60_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry.getByKey.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      pluginKey,
      status: "ready",
      manifestJson: {
        capabilities: ["webhooks.receive"],
        webhooks: [{ endpointKey: "lead", displayName: "Lead" }],
      },
    });
  });

  it("answers 429 with the plugin's message and no Retry-After for a RATE_LIMITED refusal", async () => {
    const message = "Too many submissions. Please try again in a few minutes.";
    const { res, updates, workerManager } = await send(
      new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.RATE_LIMITED, message }),
    );
    expect(workerManager.call).toHaveBeenCalledWith(expect.any(String), "handleWebhook", expect.objectContaining({ endpointKey: "lead" }));
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ deliveryId, status: "failed", error: message });
    expect(res.headers["retry-after"]).toBeUndefined();
    expect(updates).toEqual([expect.objectContaining({ status: "failed", error: message })]);
  });

  it.each([
    ["a plain worker error", new Error("This form is temporarily unavailable.")],
    [
      "a WORKER_ERROR call error",
      new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR, message: "This form is temporarily unavailable." }),
    ],
  ])("keeps 502 for %s", async (_label, error) => {
    const { res, updates } = await send(error);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ deliveryId, status: "failed", error: "This form is temporarily unavailable." });
    expect(updates).toEqual([expect.objectContaining({ status: "failed" })]);
  });
});
