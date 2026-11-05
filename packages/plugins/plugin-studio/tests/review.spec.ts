import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { reviewAsset } from "../src/review.js";

/** An in-memory asset row; the guarded UPDATE is applied like Postgres would, one statement at a time. */
function fakeCtx(status = "draft", emitError?: Error) {
  const asset = {
    id: "a1",
    company_id: "c1",
    client_kind: "company",
    client_ref: "acme",
    client_name: "Acme",
    project_id: "p1",
    name: "Hero",
    kind: "image",
    alt_text: null,
    status,
    source: "generated",
    generation_id: null,
    current_version: 1,
    created_at: "2026-11-05T00:00:00Z",
    r2_key: "studio/c1/company-acme/a1/v1.png",
    mime: "image/png",
    bytes: 10,
  };
  const emit = vi.fn(async () => {
    if (emitError) throw emitError;
  });
  const ctx = {
    db: {
      namespace: "plugin_studio_test",
      query: async (_sql: string, params: unknown[]) => (params[0] === "c1" && params[1] === "a1" ? [{ ...asset }] : []),
      execute: async (sql: string, params: unknown[]) => {
        if (!sql.startsWith("UPDATE")) return { rowCount: 0 };
        await Promise.resolve();
        const allowed = sql.includes("ANY(") ? (params[3] as string[]) : ["approved"];
        if (params[0] !== "c1" || params[1] !== "a1" || !allowed.includes(asset.status)) return { rowCount: 0 };
        asset.status = params[2] as string;
        return { rowCount: 1 };
      },
    },
    events: { emit },
  } as unknown as PluginContext;
  return { ctx, emit, asset };
}

const deps = { signUrl: async () => "https://r2.example/signed", now: () => new Date("2026-11-05T10:00:00Z") };

describe("Studio review", () => {
  it("approves once and hands the file to Social with a one-hour URL", async () => {
    const { ctx, emit, asset } = fakeCtx();
    const out = await reviewAsset(ctx, "c1", { assetId: "a1", decision: "approved" }, { userId: "u1" }, deps);
    expect(out).toMatchObject({ changed: true, exported: true, asset: { status: "approved" } });
    expect(asset.status).toBe("approved");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("asset.approved", "c1", expect.objectContaining({ assetId: "a1", url: "https://r2.example/signed", expiresAt: "2026-11-05T11:00:00.000Z", client: { kind: "company", id: "acme", name: "Acme" }, approvedBy: { userId: "u1", agentId: null } }));
  });

  it("two approvals at once: one status change, one event", async () => {
    const { ctx, emit } = fakeCtx();
    const outs = await Promise.all([
      reviewAsset(ctx, "c1", { assetId: "a1", decision: "approved" }, { userId: "u1" }, deps),
      reviewAsset(ctx, "c1", { assetId: "a1", decision: "approved" }, { agentId: "g1" }, deps),
    ]);
    expect(outs.filter((o) => o.changed)).toHaveLength(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("rejects a draft without telling Social", async () => {
    const { ctx, emit } = fakeCtx();
    const out = await reviewAsset(ctx, "c1", { assetId: "a1", decision: "reject" }, { userId: "u1" }, deps);
    expect(out).toMatchObject({ changed: true, exported: false, asset: { status: "rejected" } });
    expect(emit).not.toHaveBeenCalled();
  });

  it("won't reject an approved asset, but approves a rejected one", async () => {
    const approved = fakeCtx("approved");
    await expect(reviewAsset(approved.ctx, "c1", { assetId: "a1", decision: "rejected" }, {}, deps)).rejects.toThrow(/approved/);
    const rejected = fakeCtx("rejected");
    await expect(reviewAsset(rejected.ctx, "c1", { assetId: "a1", decision: "approved" }, {}, deps)).resolves.toMatchObject({ exported: true });
  });

  it("undoes the approval when the hand-off fails", async () => {
    const { ctx, asset } = fakeCtx("draft", new Error("bus down"));
    await expect(reviewAsset(ctx, "c1", { assetId: "a1", decision: "approved" }, {}, deps)).rejects.toThrow(/undone/);
    expect(asset.status).toBe("draft");
  });

  it("refuses another company's asset and a bad decision", async () => {
    const { ctx } = fakeCtx();
    await expect(reviewAsset(ctx, "c2", { assetId: "a1", decision: "approved" }, {}, deps)).rejects.toThrow(/not found/);
    await expect(reviewAsset(ctx, "c1", { assetId: "a1", decision: "maybe" }, {}, deps)).rejects.toThrow(/decision/);
  });
});
