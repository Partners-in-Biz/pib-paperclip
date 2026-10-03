import { describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { onApprovalEvent, onSignoffEvent, signoffBlock } from "../src/site-signoff.js";

/** A tiny in-memory stand-in for the one table the lock reads and writes. */
function fakeCtx() {
  const rows = new Map<string, { required: boolean; until: number | null }>();
  const ctx = {
    db: {
      namespace: "plugin_crm_832258244c",
      async execute(sql: string, p: unknown[]) {
        const id = String(p[0]);
        const cur = rows.get(id) ?? { required: true, until: null };
        if (/approved_until/.test(sql) && /INSERT/.test(sql) && /ON CONFLICT \(site_id\) DO UPDATE SET approved_until/.test(sql)) rows.set(id, { ...cur, until: Date.parse(String(p[2])) });
        else rows.set(id, { ...cur, required: Boolean(p[2]) });
        return { rowCount: 1 };
      },
      async query(_sql: string, p: unknown[]) {
        const r = rows.get(String(p[0]));
        return r ? [{ required: r.required, approved: r.until != null && r.until > Date.now() }] : [];
      },
    },
  } as unknown as PluginContext;
  return ctx;
}

describe("site sign-off lock", () => {
  it("does not block a site nobody marked", async () => {
    expect(await signoffBlock(fakeCtx(), "s1")).toBeNull();
  });

  it("blocks agent writes on a pr_only site until a person approves, then again after the window", async () => {
    const ctx = fakeCtx();
    await onSignoffEvent(ctx, { companyId: "c", payload: { siteId: "s1", required: true } });
    expect(await signoffBlock(ctx, "s1")).toMatch(/sign-off/);
    await onApprovalEvent(ctx, { companyId: "c", payload: { siteId: "s1", until: new Date(Date.now() + 3600_000).toISOString(), by: "user-1" } });
    expect(await signoffBlock(ctx, "s1")).toBeNull();
    await onApprovalEvent(ctx, { companyId: "c", payload: { siteId: "s1", until: new Date(Date.now() - 1000).toISOString() } });
    expect(await signoffBlock(ctx, "s1")).toMatch(/sign-off/);
  });

  it("unlocks when the sprint is no longer pr_only and ignores malformed events", async () => {
    const ctx = fakeCtx();
    await onSignoffEvent(ctx, { companyId: "c", payload: { siteId: "s1", required: true } });
    await onSignoffEvent(ctx, { companyId: "c", payload: { siteId: "s1", required: false } });
    expect(await signoffBlock(ctx, "s1")).toBeNull();
    await onSignoffEvent(ctx, { companyId: "c", payload: { siteId: 5 } });
    await onApprovalEvent(ctx, { companyId: "c", payload: { siteId: "s1", until: "nonsense" } });
    expect(await signoffBlock(ctx, "s1")).toBeNull();
  });
});
