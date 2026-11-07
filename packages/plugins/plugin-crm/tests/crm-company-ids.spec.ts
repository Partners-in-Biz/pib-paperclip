import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { crmCompanyIds } from "../src/sync.js";

// PAR-8198: jobs looped over CRM rows of a company deleted in Paperclip; every host call for it was refused.
function fakeCtx(query: (sql: string) => Promise<unknown[]>) {
  const info = vi.fn();
  const ctx = { db: { namespace: "plugin_crm_test", query: vi.fn(query) }, logger: { info, warn: vi.fn(), error: vi.fn() } };
  return { ctx: ctx as unknown as PluginContext, query: ctx.db.query, info };
}

describe("crmCompanyIds", () => {
  it("keeps only CRM company ids that are live Paperclip companies", async () => {
    const { ctx, query } = fakeCtx(async () => [{ company_id: "live-1" }]);
    expect(await crmCompanyIds(ctx)).toEqual(["live-1"]);
    expect(query).toHaveBeenCalledTimes(1);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("JOIN public.companies AS c");
    expect(sql).toContain("c.status <> 'archived'");
    expect(sql).toContain("plugin_crm_test.companies");
    expect(sql).toContain("plugin_crm_test.contacts");
  });

  it("falls back to the unfiltered list when the core companies read is refused", async () => {
    const { ctx, query, info } = fakeCtx(async (sql) => {
      if (sql.includes("public.companies")) throw new Error("table public.companies is not allowed");
      return [{ company_id: "live-1" }, { company_id: "orphan-1" }];
    });
    expect(await crmCompanyIds(ctx)).toEqual(["live-1", "orphan-1"]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[1]?.[0])).not.toContain("public.companies");
    expect(info).toHaveBeenCalledWith("CRM company list not filtered by live companies", expect.objectContaining({ error: expect.stringContaining("not allowed") }));
  });
});
