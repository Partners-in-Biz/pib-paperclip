/**
 * Bundled sticker files (schema v5, PAR-8279 D4b). A sticker is named by `{ pack, id }`; the file is found by a map
 * lookup in the closed manifest (`sticker-packs.ts`) and joined to the bundled folder, so no doc string ever becomes a
 * path segment: an unknown pack or id (`../x`, `__proto__`, a missing id) is refused before any path is built.
 * Files: `stickers/<pack>/<id>.png` in the package, copied to `dist/stickers` (render) and `dist/ui/stickers`
 * (browser preview) by the build.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stickerRelPath } from "./sticker-packs.js";

export { stickerRelPath };

/** Folder holding the packs: `dist/stickers` beside the built worker, or the package's `stickers/` from source (tests). */
export function stickersDir(): string {
  for (const url of [new URL("./stickers/", import.meta.url), new URL("../../stickers/", import.meta.url)]) {
    const dir = fileURLToPath(url);
    if (existsSync(join(dir, stickerRelPath({ pack: "pib-shapes", id: "circle" })))) return dir.replace(/\/$/, "");
  }
  throw new Error("Studio stickers are missing: expected stickers/<pack>/*.png beside the worker (check the plugin build).");
}

/** The absolute file of a sticker in `dir` (default: the bundled folder). Throws for a ref outside the manifest. */
export function stickerFile(ref: unknown, dir: string = stickersDir()): string {
  return join(dir, stickerRelPath(ref));
}
