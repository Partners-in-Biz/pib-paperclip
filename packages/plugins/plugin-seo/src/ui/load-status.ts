/** What stands in for a page's data until it is here: Loading… while the load runs, the server's own message once it has failed. */
export function loadStatusText(error: string | null): string {
  return error ?? "Loading…";
}
