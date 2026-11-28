import { describe, expect, it } from "vitest";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { cleanManagers, listManagedCrmCompanyIds, registerCrmProjection } from "../src/crm-projection.js";

function fake() {
  const handlers = new Map<string, (event: PluginEvent) => Promise<void>>();
  const sql: Array<{ text: string; params: unknown[] }> = [];
  const ctx = {
    events: { on: (name: string, h: (event: PluginEvent) => Promise<void>) => void handlers.set(name, h) },
    db: {
      execute: async (text: string, params: unknown[]) => void sql.push({ text, params }),
      query: async (text: string, params: unknown[]) => (sql.push({ text, params }), [{ id: "crm-a" }, { id: "crm-b" }]),
    },
    logger: { info: () => undefined },
  } as unknown as PluginContext;
  return { ctx, handlers, sql };
}

const event = (payload: unknown) => ({ companyId: "co-1", payload }) as unknown as PluginEvent;
const company = { id: "crm-a", name: "Acme", domain: null, lifecycle: null, updatedAt: "2026-11-28T00:00:00.000Z" };

describe("CRM copy: managers (stage B)", () => {
  it("cleans what the CRM sent: trims, drops blanks and duplicates, null for nothing readable", () => {
    expect(cleanManagers({ ownerUserId: " u1 ", managerUserIds: ["u2", "u2", "", 3, " u3"] })).toEqual({ ownerUserId: "u1", managerUserIds: ["u2", "u3"] });
    expect(cleanManagers({ managerUserIds: "u2" })).toEqual({ ownerUserId: null, managerUserIds: [] });
    for (const bad of [null, undefined, "u1", ["u1"]]) expect(cleanManagers(bad)).toBeNull();
  });

  it("keeps `managers` only when the consumer asked for it", async () => {
    const on = fake();
    registerCrmProjection(on.ctx, "ns", { companies: true, contacts: false, companyManagers: true });
    await on.handlers.get("plugin.partnersinbiz.crm.company.upserted")!(event({ ...company, managers: { ownerUserId: "u1", managerUserIds: ["u2"] } }));
    expect(on.sql[0].text).toContain("managers = EXCLUDED.managers");
    expect(on.sql[0].params.at(-1)).toBe(JSON.stringify({ ownerUserId: "u1", managerUserIds: ["u2"] }));

    const older = fake();
    registerCrmProjection(older.ctx, "ns", { companies: true, contacts: false, companyManagers: true });
    await older.handlers.get("plugin.partnersinbiz.crm.company.upserted")!(event(company)); // a CRM before stage B
    expect(older.sql[0].text).not.toContain("managers"); // the stored value stays; a new row starts null
    await older.handlers.get("plugin.partnersinbiz.crm.company.upserted")!(event({ ...company, managers: "junk" }));
    expect(older.sql[1].params.at(-1)).toBe("null");

    const off = fake();
    registerCrmProjection(off.ctx, "ns", { companies: true, contacts: false });
    await off.handlers.get("plugin.partnersinbiz.crm.company.upserted")!(event({ ...company, managers: { ownerUserId: "u1", managerUserIds: [] } }));
    expect(off.sql[0].text).not.toContain("managers");
  });

  it("lists the companies one person manages, in this company only; no person, no query", async () => {
    const f = fake();
    expect(await listManagedCrmCompanyIds(f.ctx, "ns", "co-1", "u2")).toEqual(["crm-a", "crm-b"]);
    expect(f.sql[0].params).toEqual(["co-1", "u2"]);
    expect(f.sql[0].text).toContain("company_id = $1 AND deleted = false");
    expect(f.sql[0].text).toContain("managers->>'ownerUserId' = $2");
    expect(await listManagedCrmCompanyIds(f.ctx, "ns", "co-1", "")).toEqual([]);
    expect(f.sql).toHaveLength(1);
  });
});
