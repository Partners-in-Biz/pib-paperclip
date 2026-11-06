import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { importStudioAsset, parseStudioApproved, STUDIO_ASSET_APPROVED } from "../src/studio-import.js";

function fakeCtx() {
  const store = new Map<string, unknown>();
  const k = (key: { scopeId?: string; namespace?: string; stateKey: string }) => `${key.scopeId}/${key.namespace}/${key.stateKey}`;
  return {
    state: {
      get: async (key: { scopeId?: string; namespace?: string; stateKey: string }) => store.get(k(key)) ?? null,
      set: async (key: { scopeId?: string; namespace?: string; stateKey: string }, value: unknown) => void store.set(k(key), value),
    },
  } as unknown as PluginContext;
}

const payload = { assetId: "a1", url: "https://r2.example/studio/c1/x.png?sig=1", name: "Hero", altText: "A chair", client: { kind: "company", id: "acme", name: "Acme" } };

describe("Studio hand-off into Social", () => {
  it("listens on Studio's namespaced event", () => {
    expect(STUDIO_ASSET_APPROVED).toMatch(/^plugin\.[^_].*\.asset\.approved$/);
  });

  it("imports into the asset's client by URL", async () => {
    const importer = vi.fn(async () => ({ id: "m1" }));
    const out = await importStudioAsset(fakeCtx(), "c1", payload, importer);
    expect(out).toEqual({ status: "imported", mediaAssetId: "m1" });
    expect(importer).toHaveBeenCalledWith(expect.anything(), "c1", { url: payload.url, name: "Hero", altText: "A chair", client: "company:acme" });
  });

  it("imports own work without a client", async () => {
    const importer = vi.fn(async () => ({ id: "m2" }));
    await importStudioAsset(fakeCtx(), "c1", { ...payload, client: null }, importer);
    expect(importer).toHaveBeenCalledWith(expect.anything(), "c1", { url: payload.url, name: "Hero", altText: "A chair" });
  });

  it("imports a replayed event once", async () => {
    const ctx = fakeCtx();
    const importer = vi.fn(async () => ({ id: "m1" }));
    await importStudioAsset(ctx, "c1", payload, importer);
    const again = await importStudioAsset(ctx, "c1", { ...payload, url: "https://r2.example/other?sig=2" }, importer);
    expect(again).toEqual({ status: "duplicate", mediaAssetId: "m1" });
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("keeps companies apart", async () => {
    const ctx = fakeCtx();
    const importer = vi.fn(async () => ({ id: "m1" }));
    await importStudioAsset(ctx, "c1", payload, importer);
    await importStudioAsset(ctx, "c2", payload, importer);
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it("ignores a payload without an asset id or an https URL", async () => {
    expect(parseStudioApproved({ assetId: "a1", url: "http://x" })).toBeNull();
    expect(parseStudioApproved({ url: "https://x" })).toBeNull();
    const importer = vi.fn();
    expect(await importStudioAsset(fakeCtx(), "c1", null, importer)).toEqual({ status: "ignored", mediaAssetId: null });
    expect(importer).not.toHaveBeenCalled();
  });
});
