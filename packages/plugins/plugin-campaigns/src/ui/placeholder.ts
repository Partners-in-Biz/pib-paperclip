/** What a Campaigns view shows while its data is missing: the load error once the load failed, else the loading text. */
export function snapshotPlaceholder(loadError: string, loading = "Loading campaigns…"): string {
  return loadError || loading;
}
