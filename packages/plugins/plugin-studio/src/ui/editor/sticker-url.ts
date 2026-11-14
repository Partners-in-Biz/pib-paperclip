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
