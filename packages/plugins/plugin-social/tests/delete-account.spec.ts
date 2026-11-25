import { describe, expect, it } from "vitest";
import { deleteAccountRecord } from "../src/service.js";
import { fakeCtx } from "./helpers.js";

const person = { companyId: "co", userId: "u1", agentId: null, runId: null, isAgent: false };
const row = (over: Record<string, unknown> = {}) => ({
  id: "a1", company_id: "co", platform: "linkedin", display_name: "Wrong Page", scope: "org", owner_user_id: null, status: "disabled", meta: {}, ...over,
});
const ctxWith = (account: Record<string, unknown> | null, published = 0) =>
  fakeCtx({}, {
    queryResult: (sql) => {
      if (sql.includes("count(*) AS n") && sql.includes(".destinations")) return [{ n: String(published) }];
      return sql.includes(".accounts") && account ? [account] : [];
    },
  });

describe("social.delete-account", () => {
  it("deletes a disconnected account: inbox items, metrics and feed links first, the account row last (only if still disabled)", async () => {
    const ctx = ctxWith(row());
    expect(await deleteAccountRecord(ctx, person, "a1")).toEqual({ accountId: "a1", deleted: true });
    const sqls = ctx.fakeDb.executes.map((e) => e.sql);
    expect(sqls).toHaveLength(4);
    expect(sqls[0]).toMatch(/DELETE FROM .*\.inbox_items/);
    expect(sqls[1]).toMatch(/DELETE FROM .*\.post_metrics/);
    expect(sqls[2]).toMatch(/UPDATE .*\.rss_feeds[\s\S]*array_remove/);
    expect(sqls[3]).toMatch(/DELETE FROM .*\.accounts a WHERE a\.company_id = \$1 AND a\.id = \$2 AND a\.status = 'disabled' AND NOT EXISTS \(SELECT 1 FROM .*\.destinations d WHERE d\.account_id = a\.id AND d\.status = 'published'\)/);
    for (const e of ctx.fakeDb.executes) expect(e.params).toEqual(["co", "a1"]);
  });

  it("refuses an account with published posts: deleting it would cascade away their record and metrics (PAR-10115)", async () => {
    const ctx = ctxWith(row(), 1);
    await expect(deleteAccountRecord(ctx, person, "a1")).rejects.toThrow(/Wrong Page has 1 published post\. Deleting it would erase/);
    expect(ctx.fakeDb.executes).toHaveLength(0);
    await expect(deleteAccountRecord(ctxWith(row(), 3), person, "a1")).rejects.toThrow(/3 published posts/);
  });

  it("refuses a connected account, an agent, and someone else's personal account", async () => {
    await expect(deleteAccountRecord(ctxWith(row({ status: "connected" })), person, "a1")).rejects.toThrow(/Disconnect Wrong Page first/);
    await expect(deleteAccountRecord(ctxWith(row()), { ...person, userId: null, agentId: "ag", isAgent: true }, "a1")).rejects.toThrow(/person must/);
    await expect(deleteAccountRecord(ctxWith(row({ scope: "personal", owner_user_id: "u2" })), person, "a1")).rejects.toThrow(/not visible/);
  });
});
