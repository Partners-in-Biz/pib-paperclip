import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { companyEvent, contactEvent, emitChanges } from "../src/sync.js";

const NO_BILLING = { billing_email: null, phone: null, address: null, vat_number: null, registration_number: null };

describe("CRM change events", () => {
  it("maps company rows", () => {
    expect(companyEvent({ ...NO_BILLING, id: "a", name: "Acme", domain: null, lifecycle: "customer", updated_at: "2026-09-26T05:00:00Z" })).toEqual({
      id: "a",
      name: "Acme",
      domain: null,
      lifecycle: "customer",
      updatedAt: "2026-09-26T05:00:00.000Z",
      billing: { email: null, phone: null, address: null, vatNumber: null, registrationNumber: null },
    });
  });

  it("carries the five billing details on the company event, null for what is unset", () => {
    const event = companyEvent({
      ...NO_BILLING,
      id: "a",
      name: "Acme",
      domain: "acme.test",
      lifecycle: "customer",
      billing_email: "accounts@acme.test",
      address: "1 Main Rd\nCape Town\n8001",
      vat_number: "4123456789",
      updated_at: "2026-09-26T05:00:00Z",
    });
    expect(event.billing).toEqual({
      email: "accounts@acme.test",
      phone: null,
      address: "1 Main Rd\nCape Town\n8001",
      vatNumber: "4123456789",
      registrationNumber: null,
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
          if (sql.includes(".companies")) return [{ id: "a", name: "Acme", domain: "acme.test", lifecycle: "lead", ...NO_BILLING, vat_number: "4123456789", updated_at: "2026-09-26T05:00:00Z" }];
          return [];
        },
      },
      events: { emit },
    } as unknown as PluginContext;
    const counts = await emitChanges(ctx, "co-1", 120);
    expect(counts).toEqual({ companies: 1, contacts: 0 });
    expect(queries[0]!.params).toEqual(["co-1", 120]);
    expect(emit).toHaveBeenCalledWith("company.upserted", "co-1", expect.objectContaining({ id: "a", name: "Acme", billing: expect.objectContaining({ vatNumber: "4123456789", email: null }) }));
    expect(queries[0]!.sql).toMatch(/billing_email, phone, address, vat_number, registration_number/);
  });
});
