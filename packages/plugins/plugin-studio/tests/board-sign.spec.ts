/**
 * The card's signing on a board (PAR-14280; plan PAR-14257 E "S1, 3"): one batched call per board, re-sign before the
 * 300 s link expires and after an image error, "removed" for a deleted file, placeholders for refusals.
 */
import { describe, expect, it, vi } from "vitest";
import { AccessRefused } from "@partnersinbiz/pib-plugin-ui";
import { BATCH_MS, BoardSigner, cardStateFromError, cardStatesFromReply, embedNodeOp, libraryLoadFromError, MAX_BATCH, nextCheckIn, placeAt, RESIGN_MARGIN_MS, RETRY_MS, REUSE_MS, SIGNED_FOR_MS } from "../src/ui/board-sign.js";
import { PLUGIN_ID } from "../src/namespace.js";
import { STUDIO_PLUGIN_KEY } from "../src/plugin-key.js";
import manifest from "../src/manifest.js";

/** A clock the test moves by hand; scheduled work runs when it is due. */
function fakeClock() {
  let now = 1_000_000;
  const jobs: Array<{ at: number; fn: () => void }> = [];
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => void jobs.push({ at: now + ms, fn }),
    async advance(ms: number) {
      now += ms;
      for (const job of jobs.splice(0).sort((a, b) => a.at - b.at)) {
        if (job.at <= now) job.fn();
        else jobs.push(job);
      }
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

const ok = (ids: string[]) => ({
  urls: Object.fromEntries(ids.map((id) => [id, `https://r2.example/${id}?sig=1`])),
  failed: [],
  error: null,
  refused: [],
  removed: [],
  assets: Object.fromEntries(ids.map((id) => [id, { name: `${id}.png`, kind: "image", mime: "image/png", altText: null }])),
});

describe("board signer (PAR-14280)", () => {
  it("cards drawn together share one call per board, with the board's scope", async () => {
    const clock = fakeClock();
    const signer = new BoardSigner(clock);
    const call = vi.fn(async (p: Record<string, unknown>) => ok(p.assetIds as string[]));
    const states = Promise.all([
      signer.request(call, "co", "project-a", "x"),
      signer.request(call, "co", "project-a", "y"),
      signer.request(call, "co", "project-a", "x"),
      signer.request(call, "co", null, "z"),
    ]);
    await clock.advance(BATCH_MS);
    const [x, y, x2, z] = await states;
    expect(call).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenCalledWith({ companyId: "co", assetIds: ["x", "y"], boardScope: { projectId: "project-a" } });
    expect(call).toHaveBeenCalledWith({ companyId: "co", assetIds: ["z"], boardScope: { projectId: null } });
    expect(x).toMatchObject({ state: "ready", url: "https://r2.example/x?sig=1", name: "x.png", kind: "image" });
    expect(x2).toEqual(x);
    expect(y.state).toBe("ready");
    expect(z.state).toBe("ready");
  });

  it("splits a big board into calls of at most 100 files", async () => {
    const clock = fakeClock();
    const signer = new BoardSigner(clock);
    const call = vi.fn(async (p: Record<string, unknown>) => ok(p.assetIds as string[]));
    const all = Promise.all(Array.from({ length: 250 }, (_, i) => signer.request(call, "co", null, `a${i}`)));
    await clock.advance(BATCH_MS);
    expect((await all).every((s) => s.state === "ready")).toBe(true);
    expect(call.mock.calls.map(([p]) => (p.assetIds as string[]).length)).toEqual([MAX_BATCH, MAX_BATCH, 50]);
  });

  it("re-signs before the 300 s link expires; a redraw within a minute reuses the link", async () => {
    const clock = fakeClock();
    const signer = new BoardSigner(clock);
    const call = vi.fn(async (p: Record<string, unknown>) => ok(p.assetIds as string[]));
    const first = signer.request(call, "co", null, "x");
    await clock.advance(BATCH_MS);
    const state = await first;
    expect(state.state).toBe("ready");
    expect(nextCheckIn(state, clock.now())).toBe(SIGNED_FOR_MS - RESIGN_MARGIN_MS);
    expect(SIGNED_FOR_MS).toBe(300_000);

    // Panning away and back: same link, no call.
    await clock.advance(REUSE_MS - BATCH_MS - 1);
    expect(await signer.request(call, "co", null, "x")).toBe(state);
    expect(call).toHaveBeenCalledTimes(1);

    // The card's timer fires at expiry minus the margin and asks fresh.
    await clock.advance(nextCheckIn(state, clock.now())!);
    const renewed = signer.request(call, "co", null, "x", { fresh: true });
    await clock.advance(BATCH_MS);
    expect((await renewed).state).toBe("ready");
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("an image error forgets the link, so the next draw signs again", async () => {
    const clock = fakeClock();
    const signer = new BoardSigner(clock);
    const call = vi.fn(async (p: Record<string, unknown>) => ok(p.assetIds as string[]));
    const first = signer.request(call, "co", null, "x");
    await clock.advance(BATCH_MS);
    await first;
    signer.forget("co", null, "x");
    const again = signer.request(call, "co", null, "x");
    await clock.advance(BATCH_MS);
    await again;
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("reads removed, refused, withheld and failed files from the reply", () => {
    const states = cardStatesFromReply({ urls: { x: "u" }, assets: { x: { name: "x", kind: "video", mime: "video/mp4" } }, removed: ["gone"], refused: ["other"], withheld: ["client"], failed: ["slow"] }, ["x", "gone", "other", "client", "slow", "unlisted"], 0);
    expect(states.x).toMatchObject({ state: "ready", kind: "video", expiresAt: SIGNED_FOR_MS - RESIGN_MARGIN_MS });
    expect(states.gone).toEqual({ state: "removed" });
    expect(states.other).toEqual({ state: "refused" });
    expect(states.client).toEqual({ state: "refused" });
    expect(states.slow).toEqual({ state: "error", retryAt: RETRY_MS });
    expect(states.unlisted).toEqual({ state: "error", retryAt: RETRY_MS });
    // A link without the file's details is not drawn.
    expect(cardStatesFromReply({ urls: { x: "u" } }, ["x"], 0).x.state).toBe("error");
    expect(nextCheckIn({ state: "removed" }, 0)).toBeNull();
    expect(nextCheckIn({ state: "refused" }, 0)).toBeNull();
  });

  it("a refused call is a placeholder; the switch is its own state; a passing fault retries", async () => {
    expect(cardStateFromError(new AccessRefused("no", "PERMISSION_DENIED"), 0)).toEqual({ state: "refused" });
    expect(cardStateFromError(new AccessRefused("off", "board_cards_off"), 0)).toEqual({ state: "off" });
    expect(cardStateFromError(new AccessRefused("later", "MEMBER_RESTRICTION_UNAVAILABLE"), 0)).toEqual({ state: "error", retryAt: RETRY_MS });
    expect(cardStateFromError(new Error("network"), 0)).toEqual({ state: "error", retryAt: RETRY_MS });

    const clock = fakeClock();
    const signer = new BoardSigner(clock);
    const call = vi.fn(async () => {
      throw new AccessRefused("Studio is not open to you", "PERMISSION_DENIED");
    });
    const pending = Promise.all([signer.request(call, "co", null, "x"), signer.request(call, "co", null, "y")]);
    await clock.advance(BATCH_MS);
    expect(await pending).toEqual([{ state: "refused" }, { state: "refused" }]);
  });

  it("the panel's errors: the switch, no Studio access, a fault", () => {
    expect(libraryLoadFromError(new AccessRefused("off", "board_cards_off"))).toEqual({ status: "off" });
    expect(libraryLoadFromError(new AccessRefused("no", "PERMISSION_DENIED"))).toEqual({ status: "error", message: "Studio isn't open to you in this company." });
    expect(libraryLoadFromError(new Error("boom"))).toMatchObject({ status: "error", message: expect.stringContaining("boom") });
  });

  it("the browser's plugin key is Studio's plugin id, and the card's slot is in the manifest", () => {
    expect(STUDIO_PLUGIN_KEY).toBe(PLUGIN_ID);
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.ui?.slots?.find((s) => s.type === "canvasNode")).toMatchObject({ id: "studio-media", exportName: "StudioCanvasCard" });
    expect(manifest.ui?.slots?.find((s) => s.type === "canvasPanel")).toMatchObject({ exportName: "StudioBoardLibrary" });
  });

  it("places a Studio file as an embed node core accepts: plugin key, slot id, asset id, flat props", () => {
    const op = embedNodeOp({ pluginKey: "partnersinbiz.studio", type: "studio-media", assetId: "asset-1", name: "x".repeat(400), kind: "video", at: placeAt(12), key: "k1" });
    expect(op).toEqual({
      op: "add",
      item: {
        itemType: "node", key: "k1", kind: "embed", x: 144, y: 144, width: 320, height: 220, zIndex: 1, color: "slate",
        title: "x".repeat(300), content: "",
        data: { plugin: "partnersinbiz.studio", type: "studio-media", assetId: "asset-1", props: {} },
      },
    });
    expect(embedNodeOp({ pluginKey: "p", type: "t", assetId: "a", name: "n", kind: "image", at: { x: 0, y: 0 } }).item.key).toMatch(/^studio-a-[a-z0-9]+$/);
  });
});
