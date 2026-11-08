/**
 * The full address of a share page. `uiBase` is the plugin's served folder (`/_plugins/<id>/ui/`) from
 * resolvePluginUiBase. Never build it from `import.meta.url`: the host runs plugin pages from a blob: address, where
 * `new URL` throws, so Copy link failed silently before 0.1.39.
 */
export function shareUrl(path: string, uiBase: string, origin: string): string {
  return new URL(path, new URL(uiBase, origin)).href;
}
