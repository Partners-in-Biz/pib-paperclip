/**
 * Signed preview links for the library, the board and the client cards (PAR-8102). One "asset-urls" call per list;
 * when it fails, or some links are missing, the page says so and asks again soon instead of waiting four minutes.
 */
import { useEffect, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { errorText } from "@partnersinbiz/pib-plugin-ui";
import { previewReply, URL_RETRY_MS, type PreviewState } from "./preview-state.js";

export { previewPlaceholder } from "./preview-state.js";

/** People only: the worker checks membership, and agents never get links. */
export function usePreviewUrls(companyId: string, ids: string[]): PreviewState {
  const assetUrls = usePluginAction("asset-urls");
  const [state, setState] = useState<PreviewState>({ urls: {}, error: null });
  const key = ids.join(",");
  useEffect(() => {
    if (!key) {
      setState({ urls: {}, error: null });
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      assetUrls({ companyId, assetIds: key.split(",") })
        .then((out: unknown) => {
          if (!live) return;
          const next = previewReply(out);
          // Keep links that still work when only some failed this time.
          setState((prev) => ({ urls: next.error ? { ...prev.urls, ...next.urls } : next.urls, error: next.error }));
          timer = setTimeout(load, next.retryInMs);
        })
        .catch((err: unknown) => {
          if (!live) return;
          setState((prev) => ({ urls: prev.urls, error: `Previews couldn't load: ${errorText(err)}` }));
          timer = setTimeout(load, URL_RETRY_MS);
        });
    };
    load();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [companyId, key]);
  return state;
}
