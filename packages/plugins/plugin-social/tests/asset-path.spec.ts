/**
 * W5 C35: a rendered image goes to R2, the scope's Drive "02 Assets" folder and the post. The broker is a fake `driveSave`;
 * R2 is a stubbed fetch. The file is a real-size PNG (over 100 KB), not an empty body.
 */
import type { DriveSaveResult } from "@partnersinbiz/pib-plugin-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { storeRenderedAsset, type AssetPathDeps } from "../src/asset-path.js";
import { NAMESPACE } from "../src/namespace.js";
import { fakeCtx, mockFetch } from "./helpers.js";

type Drive = NonNullable<AssetPathDeps["driveSave"]>;
const T = (name: string) => `${NAMESPACE}.${name}`;
const u32 = (n: number) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
/** A PNG header for w x h followed by filler: 150 KB, enough to prove a binary payload survives. */
const bigPng = (w = 1080, h = 1350) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32(13), Buffer.from("IHDR"), u32(w), u32(h), Buffer.alloc(5), Buffer.alloc(150 * 1024, 9)]);

const VIEWER = { companyId: "co", userId: "owner-1", agentId: "ag-social", runId: "run-1", isAgent: true } as const;
const postRowOf = (id: string, client: { kind: string; id: string; name: string } | null, media: unknown[] = []) => ({
  id, company_id: "co", body: "Spring sale", overrides: {}, media, status: "draft", scheduled_at: null, scope: "org", owner_user_id: "owner-1",
  client_kind: client?.kind ?? null, client_ref: client?.id ?? null, client_name: client?.name ?? null, first_comment: null, source: "agent", source_ref: null,
  failure_issue_id: null, published_at: null, error: null, created_by_agent_id: "ag-social", review_issue_id: null, review_returns: 0, created_at: new Date(), updated_at: new Date(),
  experiment_id: null, experiment_arm: null, tags: [],
});

function world(posts: Record<string, ReturnType<typeof postRowOf>>) {
  const inserted: unknown[][] = [];
  const ctx = fakeCtx(
    {
      config: {
        get: vi.fn(async () => ({
          publicBaseUrl: "https://paperclip.example.com",
          r2: { accountId: "acc", bucket: "media", accessKeyId: "AK", secretAccessKey: { type: "secret_ref", secretId: "s" }, publicMediaBaseUrl: "https://media.example.com" },
        })),
      },
      secrets: { resolve: vi.fn(async () => "SK") },
      state: { get: vi.fn(async () => null) },
    },
    {
      queryResult: (sql, params) => {
        if (sql.includes(`FROM ${T("posts")} WHERE id = $1`)) return posts[String(params[0])] ? [posts[String(params[0])]] : [];
        if (sql.includes(`FROM ${T("crm_companies")}`)) {
          const id = params.includes("c2") ? "c2" : "c1";
          return [{ id, name: id === "c2" ? "Beta" : "Acme", domain: null, lifecycle: null }];
        }
        return [];
      },
      executeResult: (sql, params) => {
        if (sql.startsWith(`INSERT INTO ${T("media_assets")}`)) inserted.push(params);
        return 1;
      },
    },
  );
  return { ctx, inserted };
}

const r2Ok = () => mockFetch([[/^PUT https:\/\/acc\.r2\.cloudflarestorage\.com\/media\/social\/co\//, () => new Response("", { status: 200 })]]);
const saved: DriveSaveResult = { status: "saved", requestId: "r1", driveFileId: "drv-1", url: "https://drive.example.com/f/drv-1" };

afterEach(() => vi.unstubAllGlobals());

describe("store-rendered-asset", () => {
  it("stores a 150 KB PNG on R2 and in the client's Drive 02 Assets folder, and adds it to the post", async () => {
    const png = bigPng();
    const w = world({ p1: postRowOf("p1", { kind: "company", id: "c1", name: "Acme" }, [{ assetId: "a-old", url: "https://media.example.com/x.png", kind: "image", mime: "image/png", width: null, height: null, durationS: null, altText: "old", bytes: 1 }]) });
    const net = r2Ok();
    const driveSave = vi.fn<Drive>(async () => saved);
    const attach = vi.fn(async () => ({}));
    const out = await storeRenderedAsset(w.ctx, VIEWER, { contentBase64: png.toString("base64"), altText: "Spring sale banner", name: "spring-banner.png", postId: "p1" }, { driveSave, attach, now: () => new Date("2026-10-21T10:00:00Z") });

    expect(png.length).toBeGreaterThan(100 * 1024);
    expect(out.asset).toMatchObject({ mime: "image/png", kind: "image", width: 1080, height: 1350, bytes: png.length, altText: "Spring sale banner", client: "company:c1", clientName: "Acme" });
    expect((net.calls[0]!.body as Uint8Array).length).toBe(png.length);
    // Drive: the scope's own folder, the exact bytes, a human-readable name.
    const sent = driveSave.mock.calls[0]![1] as Record<string, unknown>;
    expect(sent).toMatchObject({ companyId: "co", kind: "social", subfolder: "02 Assets", mimeType: "image/png", client: { kind: "company", ref: "c1" }, name: "2026-10-21 Acme spring-banner v01.png" });
    expect(Buffer.from(sent.bytes as Uint8Array).equals(png)).toBe(true);
    expect(out.drive).toEqual({ ok: true, url: saved.url, driveFileId: "drv-1" });
    // Attach keeps the post's current media and adds the new asset.
    expect(attach).toHaveBeenCalledWith(w.ctx, VIEWER, { postId: "p1", mediaAssetIds: ["a-old", out.asset.id] });
    expect(out.attached).toEqual({ ok: true, postId: "p1" });
  });

  it("a Drive failure leaves the R2 asset (with its alt text) and reports it", async () => {
    const w = world({});
    r2Ok();
    for (const driveSave of [vi.fn<Drive>(async () => ({ status: "failed", requestId: "r", reason: "broker_down" })), vi.fn<Drive>(async () => { throw new Error("rpc closed"); }), vi.fn<Drive>(async () => ({ status: "no_ack", requestId: "r" }))]) {
      const out = await storeRenderedAsset(w.ctx, VIEWER, { contentBase64: bigPng().toString("base64"), altText: "A chart of leads" }, { driveSave });
      expect(out.drive.ok).toBe(false);
      expect(out.asset).toMatchObject({ altText: "A chart of leads", client: null });
      expect(out.attached).toBeNull();
    }
    expect(w.inserted).toHaveLength(3);
    expect(w.inserted.every((row) => row.includes("A chart of leads"))).toBe(true);
    expect((await storeRenderedAsset(w.ctx, VIEWER, { contentBase64: bigPng().toString("base64"), altText: "x" }, { driveSave: async () => ({ status: "failed", requestId: "r", reason: "too_large" }) })).drive).toEqual({ ok: false, reason: "too_large" });
  });

  it("an attach failure keeps the asset and reports it", async () => {
    const w = world({ p1: postRowOf("p1", null) });
    r2Ok();
    const out = await storeRenderedAsset(w.ctx, VIEWER, { contentBase64: bigPng().toString("base64"), altText: "Banner", postId: "p1" }, { driveSave: async () => saved, attach: async () => { throw new Error("Post is locked"); } });
    expect(out.asset.altText).toBe("Banner");
    expect(out.attached).toEqual({ ok: false, postId: "p1", reason: "Post is locked" });
  });

  it("refuses without alt text, empty or non-media bytes, before anything is written", async () => {
    const w = world({});
    const net = r2Ok();
    const driveSave = vi.fn<Drive>(async () => saved);
    const png = bigPng().toString("base64");
    await expect(storeRenderedAsset(w.ctx, VIEWER, { contentBase64: png }, { driveSave })).rejects.toThrow("altText is required");
    await expect(storeRenderedAsset(w.ctx, VIEWER, { contentBase64: png, altText: "   " }, { driveSave })).rejects.toThrow("altText is required");
    await expect(storeRenderedAsset(w.ctx, VIEWER, { altText: "x" }, { driveSave })).rejects.toThrow("contentBase64 is required");
    await expect(storeRenderedAsset(w.ctx, VIEWER, { contentBase64: Buffer.from("hello world").toString("base64"), altText: "x" }, { driveSave })).rejects.toThrow("not a JPEG");
    expect(net.calls).toEqual([]);
    expect(driveSave).not.toHaveBeenCalled();
    expect(w.inserted).toEqual([]);
  });

  it("two scopes: a post of client A is never written to as client B, and a refused call writes nothing", async () => {
    const w = world({ pa: postRowOf("pa", { kind: "company", id: "c1", name: "Acme" }), pown: postRowOf("pown", null) });
    const net = r2Ok();
    const driveSave = vi.fn<Drive>(async () => saved);
    const attach = vi.fn(async () => ({}));
    const body = { contentBase64: bigPng().toString("base64"), altText: "x" };
    await expect(storeRenderedAsset(w.ctx, VIEWER, { ...body, postId: "pa", client: "company:c2" }, { driveSave, attach })).rejects.toThrow("different client");
    await expect(storeRenderedAsset(w.ctx, VIEWER, { ...body, postId: "pown", client: "company:c1" }, { driveSave, attach })).rejects.toThrow("different client");
    await expect(storeRenderedAsset(w.ctx, VIEWER, { ...body, postId: "missing" }, { driveSave, attach })).rejects.toThrow("not visible");
    expect(net.calls).toEqual([]);
    expect(driveSave).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
    expect(w.inserted).toEqual([]);
    // Without a post, the named client decides the Drive folder and the asset row.
    const ok = await storeRenderedAsset(w.ctx, VIEWER, { ...body, client: "company:c2" }, { driveSave, attach });
    expect(ok.asset).toMatchObject({ client: "company:c2", clientName: "Beta" });
    expect((driveSave.mock.calls[0]![1] as Record<string, unknown>).client).toEqual({ kind: "company", ref: "c2" });
    const own = await storeRenderedAsset(w.ctx, VIEWER, body, { driveSave, attach });
    expect(own.asset.client ?? null).toBeNull();
    expect((driveSave.mock.calls[1]![1] as Record<string, unknown>).client).toBeUndefined();
  });
});
