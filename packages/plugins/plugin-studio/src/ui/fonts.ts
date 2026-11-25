/**
 * Loads the bundled OFL fonts (the same TTFs the render draws with, `fonts/` -> `dist/ui/fonts`) into the browser with
 * `FontFace`, so the editor overlay and the Layout card preview the exact glyphs. The files are a served plugin asset,
 * fetched by URL: never a data URL or import inside the UI bundle (`scripts/bundle-size-guard.mjs` enforces that).
 * Families are prefixed so they never clash with a font the host page has (names: font-names.ts).
 */
import { useEffect, useState } from "react";
import { resolvePluginUiBase } from "@partnersinbiz/pib-plugin-kit/oauth-client";
import type { LayoutFont } from "../layout.js";
import { UI_FONTS } from "./font-names.js";

export { fontStack, loadedFamily, UI_FONTS } from "./font-names.js";

const PLUGIN_KEY = "partnersinbiz.studio";

let loading: Promise<boolean> | null = null;

/** Loads all six faces once per page; resolves true when they are usable, false (never throws) when they can't load. */
export function loadStudioFonts(): Promise<boolean> {
  if (typeof document === "undefined" || typeof FontFace === "undefined") return Promise.resolve(false);
  loading ??= (async () => {
    try {
      const base = await resolvePluginUiBase(PLUGIN_KEY, import.meta.url);
      if (!base) return false;
      const faces = (Object.keys(UI_FONTS) as LayoutFont[]).flatMap((id) =>
        (["regular", "bold"] as const).map((w) => new FontFace(`Studio ${UI_FONTS[id].family}`, `url(${base}fonts/${UI_FONTS[id][w]})`, { weight: w === "bold" ? "700" : "400", display: "swap" })),
      );
      await Promise.all(faces.map(async (f) => { document.fonts.add(await f.load()); }));
      return true;
    } catch {
      loading = null; // allow a retry on the next use
      return false;
    }
  })();
  return loading;
}

/** True once the bundled fonts are loaded; components re-render then so the preview switches to the exact glyphs. */
export function useStudioFonts(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void loadStudioFonts().then((ok) => { if (live) setReady(ok); });
    return () => { live = false; };
  }, []);
  return ready;
}
