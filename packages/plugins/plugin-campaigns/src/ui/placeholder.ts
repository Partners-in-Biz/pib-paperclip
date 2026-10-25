/** What the Campaigns page shows while its data is missing: the load error once the load failed, else "Loading". */
export function snapshotPlaceholder(loadError: string): string {
  return loadError || "Loading campaigns…";
}
