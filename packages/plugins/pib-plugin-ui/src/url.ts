/**
 * Tabs you can link to: `?tab=deals` opens that tab, and switching tabs
 * updates the address (keeping other parameters such as `?client=`), so
 * agents and other pages can post links straight to a tab.
 */
import { useEffect, useState } from "react";

/** The tab named in `?tab=`, or `fallback` when it is missing or unknown. */
export function tabFromSearch<T extends string>(search: string | null | undefined, ids: readonly T[], fallback: T): T {
  const value = new URLSearchParams(search ?? "").get("tab");
  return (ids as readonly string[]).includes(value ?? "") ? (value as T) : fallback;
}

/** `search` with `tab` set (or removed when it is the default tab). Returns "" or "?…". */
export function searchWithTab(search: string | null | undefined, tab: string, fallback: string): string {
  const params = new URLSearchParams(search ?? "");
  if (tab === fallback) params.delete("tab");
  else params.set("tab", tab);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/**
 * Tab state that follows the address. Pass the host's location search and
 * navigate (from `useHostLocation` / `useHostNavigation`) and the page path.
 */
export function useUrlTab<T extends string>(
  ids: readonly T[],
  fallback: T,
  host: { path: string; search: string; navigate: (to: string, options?: { replace?: boolean }) => void },
): [T, (next: T) => void] {
  const [tab, setTab] = useState<T>(() => tabFromSearch(host.search, ids, fallback));
  useEffect(() => {
    setTab(tabFromSearch(host.search, ids, fallback));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host.search]);
  const select = (next: T) => {
    setTab(next);
    host.navigate(`${host.path}${searchWithTab(host.search, next, fallback)}`, { replace: true });
  };
  return [tab, select];
}
