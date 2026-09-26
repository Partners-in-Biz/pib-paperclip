import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { companyEvent, contactEvent, emitChanges } from "../src/sync.js";

describe("CRM change events", () => {
  it("maps company rows", () => {
    expect(companyEvent({ id: "a", name: "Acme", domain: null, lifecycle: "customer", updated_at: "2026-09-26T05:00:00Z" })).toEqual({
      id: "a",
      name: "Acme",
      domain: null,
      lifecycle: "customer",
      updatedAt: "2026-09-26T05:00:00.000Z",
    });
  });

  it("maps contact rows with jsonb lists", () => {
    const event = contactEvent({
      id: "c",
      name: "Jo",
      emails: ["jo@acme.test"],
      phones: [],
      lifecycle: "lead",
      tags: ["vip"],
      account_ids: ["a"],
      updated_at: new Date("2026-09-26T05:00:00Z"),
    });
    expect(event.emails).toEqual(["jo@acme.test"]);
    expect(event.accountIds).toEqual(["a"]);
    expect(event.tags).toEqual(["vip"]);
  });

  it("emits upserts with the company id and a recent-window filter", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const emit = vi.fn(async () => undefined);
    const ctx = {
      db: {
        namespace: "plugin_crm_832258244c",
        query: async (sql: string, params: unknown[]) => {
          queries.push({ sql, params });
          if (sql.includes(".companies")) return [{ id: "a", name: "Acme", domain: "acme.test", lifecycle: "lead", updated_at: "2026-09-26T05:00:00Z" }];
          return [];
        },
      },
      events: { emit },
    } as unknown as PluginContext;
    const counts = await emitChanges(ctx, "co-1", 120);
    expect(counts).toEqual({ companies: 1, contacts: 0 });
    expect(queries[0]!.params).toEqual(["co-1", 120]);
    expect(emit).toHaveBeenCalledWith("company.upserted", "co-1", expect.objectContaining({ id: "a", name: "Acme" }));
  });
});
