/**
 * Where the browser preview loads a sticker from: `<plugin ui base>stickers/<pack>/<id>.png` (the build copies `stickers/`
 * to `dist/ui/stickers`, as it does the fonts). The path comes from the closed manifest (`stickerRelPath`), never from a
 * doc string, so a sticker outside it has no URL (undefined) and nothing is requested.
 */
import { stickerRelPath, type StickerRef } from "../../video-edit/sticker-packs.js";

/** The served URL of a sticker under `base` (ends with `/`), or undefined when the ref is not in the manifest. */
export function stickerUrl(base: string | null, ref: StickerRef | null | undefined): string | undefined {
  if (!base || !ref) return undefined;
  try {
    return `${base}stickers/${stickerRelPath(ref)}`;
  } catch {
    return undefined;
  }
}

/** The library asset ids an overlay list needs previews for: stickers have no asset, so they are left out. */
export function overlayAssetIds(overlays: readonly { assetId: string; sticker?: StickerRef | null }[]): string[] {
  return overlays.filter((s) => !s.sticker).map((s) => s.assetId);
}

/** The URL an overlay segment plays from: the bundled pack for a sticker, else its library preview. */
export function overlaySourceUrl(
  seg: { assetId: string; sticker?: StickerRef | null },
  stickerBase: string | null,
  overlayUrls: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return seg.sticker ? stickerUrl(stickerBase, seg.sticker) : overlayUrls[seg.assetId];
}
