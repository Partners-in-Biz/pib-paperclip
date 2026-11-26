import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface SidebarContextValue {
  // Mobile drawer + back-compat (existing behavior, unchanged).
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  isMobile: boolean;
  // Icon-rail collapse: a desktop-only user choice for the coordinator
  // sidebar, remembered per user and browser behind `setCollapseScope`.
  collapsed: boolean;
  // Null scope (classic layout, no user, routes that replace the sidebar)
  // means never collapsed.
  setCollapseScope: (storageKey: string | null) => void;
  setCollapsed: (next: boolean) => void;
  toggleCollapsed: () => void;
  // Retained compatibility value; always false now that the rail is retired.
  collapseLocked: boolean;
  // Retained compatibility value; there is no hover-to-expand.
  peeking: boolean;
  setPeeking: (next: boolean) => void;
  // Legacy requests remain observable but never collapse the navigation.
  forceCollapsed: boolean;
  setForceCollapsed: (next: boolean) => void;
  // Route-requested collapse retained for integration compatibility.
  routeRequestsCollapsed: boolean;
  setRouteRequestsCollapsed: (next: boolean) => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

const MOBILE_BREAKPOINT = 768;
// Last scope key the coordinator set. Read synchronously so a collapsed user's
// first paint is the rail, before the async session yields a userId.
export const SIDEBAR_COLLAPSE_HINT_KEY = "paperclip.coordinator.sidebar-collapsed.v1:last-scope";

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The in-memory value still changes when storage is unavailable.
  }
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < MOBILE_BREAKPOINT);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= MOBILE_BREAKPOINT);

  const [routeRequestsCollapsed, setRouteRequestsCollapsed] = useState(false);
  const [forceCollapsed, setForceCollapsed] = useState(false);
  const [scope, setScope] = useState<string | null>(() => readStorage(SIDEBAR_COLLAPSE_HINT_KEY));
  const [storedCollapsed, setStoredCollapsed] = useState<{ scope: string | null; value: boolean }>(() => {
    const hinted = readStorage(SIDEBAR_COLLAPSE_HINT_KEY);
    return { scope: hinted, value: hinted !== null && readStorage(hinted) === "1" };
  });

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
      setSidebarOpen(!e.matches);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const setCollapseScope = useCallback((key: string | null) => {
    setScope(key);
    if (key !== null) writeStorage(SIDEBAR_COLLAPSE_HINT_KEY, key);
    setStoredCollapsed({ scope: key, value: key !== null && readStorage(key) === "1" });
  }, []);

  // Mobile never collapses; force/route requests are observable only.
  const collapsed = !isMobile && scope !== null && storedCollapsed.scope === scope && storedCollapsed.value;
  const collapseLocked = false;
  const peeking = false;
  const setCollapsed = useCallback((next: boolean) => {
    if (scope === null) return;
    writeStorage(scope, next ? "1" : "0");
    setStoredCollapsed({ scope, value: next });
  }, [scope]);
  const toggleCollapsed = useCallback(() => setCollapsed(!collapsed), [setCollapsed, collapsed]);
  const setPeeking = useCallback((_next: boolean) => {}, []);

  const toggleSidebar = useCallback(() => setSidebarOpen((v) => !v), []);

  const value = useMemo<SidebarContextValue>(
    () => ({
      sidebarOpen,
      setSidebarOpen,
      toggleSidebar,
      isMobile,
      collapsed,
      setCollapseScope,
      setCollapsed,
      toggleCollapsed,
      collapseLocked,
      peeking,
      setPeeking,
      forceCollapsed,
      setForceCollapsed,
      routeRequestsCollapsed,
      setRouteRequestsCollapsed,
    }),
    [
      sidebarOpen,
      setSidebarOpen,
      toggleSidebar,
      isMobile,
      collapsed,
      setCollapseScope,
      setCollapsed,
      toggleCollapsed,
      collapseLocked,
      peeking,
      setPeeking,
      forceCollapsed,
      setForceCollapsed,
      routeRequestsCollapsed,
      setRouteRequestsCollapsed,
    ],
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar() {
  const ctx = useContext(SidebarContext);
  if (!ctx) {
    throw new Error("useSidebar must be used within SidebarProvider");
  }
  return ctx;
}
