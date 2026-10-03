import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createEnv, type Actor } from "../src/service/common.js";
import { approveSiteWrites, syncSignoff } from "../src/service/signoff.js";
import { UI_ONLY_HANDLERS, HANDLERS } from "../src/dispatch.js";

const emitted: Array<{ name: string; companyId: string; payload: Record<string, unknown> }> = [];
function host(rows: Record<string, unknown>[]) {
  emitted.length = 0;
  const ctx = {
    db: { namespace: "plugin_seo_8099f8879a", query: vi.fn(async () => rows), execute: vi.fn() },
    events: { emit: vi.fn(async (name: string, companyId: string, payload: Record<string, unknown>) => void emitted.push({ name, companyId, payload })) },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  } as unknown as PluginContext;
  return createEnv(ctx, { now: () => new Date("2026-10-02T12:00:00Z") });
}

describe("sign-off sync", () => {
  it("tells the CRM which WordPress sites need the client's sign-off", async () => {
    const env = host([
      { company_id: "co-1", site_id: "site-a", required: true },
      { company_id: "co-1", site_id: "site-b", required: false },
    ]);
    expect(await syncSignoff(env)).toBe(2);
    expect(emitted.map((e) => [e.name, e.payload])).toEqual([
      ["site.signoff", { siteId: "site-a", required: true }],
      ["site.signoff", { siteId: "site-b", required: false }],
    ]);
  });
});

describe("approve-site-writes", () => {
  it("is a page-only action and refuses agents and system callers", async () => {
    expect(HANDLERS["approve-site-writes"]).toBeUndefined();
    expect(UI_ONLY_HANDLERS["approve-site-writes"]).toBeDefined();
    const env = host([]);
    for (const actor of [{ kind: "agent", agentId: "a", runId: "r", responsibleUserId: null }, { kind: "system" }] as Actor[]) {
      await expect(approveSiteWrites(env, "co-1", actor, { sprintId: "sp-1" })).rejects.toThrow(/Only a person/);
    }
    expect(emitted).toHaveLength(0);
  });
});
