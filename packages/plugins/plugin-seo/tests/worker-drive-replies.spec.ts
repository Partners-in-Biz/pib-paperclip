import { describe, expect, it, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { driveSave, registerDriveReplies, DRIVE_EVENTS } from "@partnersinbiz/pib-plugin-kit";
import { CRM_PLUGIN_ID } from "@partnersinbiz/pib-plugin-kit";
import plugin from "../src/worker.js";

/**
 * Test that the SEO plugin's setup calls registerDriveReplies,
 * so that driveSave can receive CRM reply events.
 */
describe("plugin setup registers Drive reply handlers", () => {
  function createFakeCtx() {
    const state = new Map<string, unknown>();
    const handlers = new Map<string, unknown[]>();

    const ctx = {
      manifest: { id: "test-seo" },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      config: { get: async () => ({}) },
      state: {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
      },
      events: {
        on: (name: string, fn: unknown) => {
          handlers.set(name, [...(handlers.get(name) ?? []), fn]);
          return () => undefined;
        },
        emit: async () => {},
      },
      jobs: { register: () => {} },
      companies: { get: async () => ({ id: "co-1", issuePrefix: "PIB" }), list: async () => [] },
      agents: { get: async () => null, list: async () => [] },
      authorization: { grants: { list: async () => [], set: async () => [] } },
      projects: { get: async () => null },
      skills: { managed: { reconcile: async () => ({}) } },
      issues: {
        create: async () => ({ id: "iss-1", identifier: "PIB-1" }),
        get: async () => null,
        list: async () => [],
        update: async () => {},
        createComment: async () => {},
        listComments: async () => [],
        requestWakeup: async () => {},
        relations: { get: async () => ({ blockedBy: [], blocks: [] }) },
      },
      db: {
        namespace: "pib-seo",
        query: async () => [],
        execute: async () => ({ rowCount: 0 }),
      },
      tools: {
        register: () => {},
      },
      actions: {
        register: () => {},
      },
    } as unknown as PluginContext;

    return { ctx, state, handlers };
  }

  it("registers handlers for drive.file.saved and drive.file.failed events during setup", async () => {
    const { ctx, handlers } = createFakeCtx();
    await plugin.definition.setup(ctx);

    const savedEventName = `plugin.${CRM_PLUGIN_ID}.${DRIVE_EVENTS.saved}`;
    const failedEventName = `plugin.${CRM_PLUGIN_ID}.${DRIVE_EVENTS.failed}`;

    expect(handlers.has(savedEventName)).toBe(true);
    expect(handlers.has(failedEventName)).toBe(true);
  });

  it("driveSave resolves with 'saved' when setup has registered handlers and CRM replies", async () => {
    const { ctx, handlers } = createFakeCtx();
    await plugin.definition.setup(ctx);

    let emittedPayload: Record<string, unknown> | null = null;
    const originalEmit = ctx.events.emit;
    (ctx.events.emit as any) = async (name: string, companyId: string, payload: Record<string, unknown>) => {
      if (name === DRIVE_EVENTS.saveRequested) {
        emittedPayload = payload;
      }
      await originalEmit.call(ctx.events, name, companyId, payload);
    };

    const promise = driveSave(ctx, {
      companyId: "co-1",
      kind: "test",
      name: "test.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("test content"),
    });

    // Give the promise time to set up the pending request
    await new Promise((resolve) => setTimeout(resolve, 10));

    if (!emittedPayload) throw new Error("driveSave did not emit saveRequested event");

    const requestId = String(emittedPayload["requestId"]);
    const savedEventName = `plugin.${CRM_PLUGIN_ID}.${DRIVE_EVENTS.saved}`;
    const savedHandlers = handlers.get(savedEventName) as Array<(event: any) => Promise<void>>;

    if (!savedHandlers || savedHandlers.length === 0) throw new Error("No handlers registered for saved event");

    // Deliver the saved event
    for (const handler of savedHandlers) {
      await handler({
        eventType: savedEventName,
        companyId: "co-1",
        payload: {
          requestId,
          driveFileId: "file-123",
          url: "https://drive.example.com/file-123",
        } as Record<string, unknown>,
        occurredAt: new Date().toISOString(),
      } as any);
    }

    const result = await promise;
    expect(result.status).toBe("saved");
    if (result.status === "saved") {
      expect(result.driveFileId).toBe("file-123");
      expect(result.url).toBe("https://drive.example.com/file-123");
    }
  });
});
