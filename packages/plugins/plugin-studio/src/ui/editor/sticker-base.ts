import { resolvePluginUiBase } from "@partnersinbiz/pib-plugin-kit/oauth-client";
import { useEffect, useState } from "react";

const PLUGIN_KEY = "partnersinbiz.studio";

/** The plugin's served UI base, resolved once per page; null until known (or when it cannot be). */
export function useStickerBase(): string | null {
  const [base, setBase] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void resolvePluginUiBase(PLUGIN_KEY, import.meta.url).then((b) => { if (live) setBase(b ?? null); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  return base;
}
