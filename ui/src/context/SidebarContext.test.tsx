// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIDEBAR_COLLAPSE_HINT_KEY, SidebarProvider, useSidebar } from "./SidebarContext";

const KEY = "paperclip.coordinator.sidebar-collapsed.v1:u1";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedValue: ReturnType<typeof useSidebar> | null = null;

function Capture() {
  capturedValue = useSidebar();
  return null;
}

function act(callback: () => void) {
  flushSync(callback);
}

function renderProvider(): { root: Root; host: HTMLDivElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <SidebarProvider>
        <Capture />
      </SidebarProvider>,
    );
  });
  return { root, host };
}

describe("SidebarContext", () => {
  let active: { root: Root; host: HTMLDivElement } | null = null;

  beforeEach(() => {
    localStorage.clear();
    capturedValue = null;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1280,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    if (active) {
      act(() => active!.root.unmount());
      active.host.remove();
      active = null;
    }
    localStorage.clear();
  });

  it("starts expanded with no scope, and legacy key never collapses", () => {
    localStorage.setItem("paperclip.sidebar.collapsed", "1");
    active = renderProvider();

    expect(capturedValue?.collapsed).toBe(false);
    act(() => capturedValue?.setCollapsed(true));
    expect(capturedValue?.collapsed).toBe(false);
    expect(localStorage.getItem("paperclip.sidebar.collapsed")).toBe("1");
  });

  it("collapses and persists per scope, and writes the last-scope hint", () => {
    active = renderProvider();

    act(() => capturedValue?.setCollapseScope(KEY));
    expect(capturedValue?.collapsed).toBe(false);
    act(() => capturedValue?.toggleCollapsed());
    expect(capturedValue?.collapsed).toBe(true);
    expect(localStorage.getItem(KEY)).toBe("1");
    expect(localStorage.getItem(SIDEBAR_COLLAPSE_HINT_KEY)).toBe(KEY);
    act(() => capturedValue?.setCollapsed(false));
    expect(localStorage.getItem(KEY)).toBe("0");
  });

  it("reads the hint synchronously so a collapsed user's first render is collapsed", () => {
    localStorage.setItem(SIDEBAR_COLLAPSE_HINT_KEY, KEY);
    localStorage.setItem(KEY, "1");
    const seen: boolean[] = [];
    function Spy() {
      seen.push(useSidebar().collapsed);
      return null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(<SidebarProvider><Spy /></SidebarProvider>));
    expect(seen[0]).toBe(true);
    act(() => root.unmount());
  });

  it("gives another user their own expanded state", () => {
    localStorage.setItem(KEY, "1");
    active = renderProvider();

    act(() => capturedValue?.setCollapseScope(KEY));
    expect(capturedValue?.collapsed).toBe(true);
    act(() => capturedValue?.setCollapseScope("paperclip.coordinator.sidebar-collapsed.v1:u2"));
    expect(capturedValue?.collapsed).toBe(false);
  });

  it("null scope expands without clearing the hint or the stored choice", () => {
    active = renderProvider();
    act(() => capturedValue?.setCollapseScope(KEY));
    act(() => capturedValue?.setCollapsed(true));
    act(() => capturedValue?.setCollapseScope(null));

    expect(capturedValue?.collapsed).toBe(false);
    expect(localStorage.getItem(SIDEBAR_COLLAPSE_HINT_KEY)).toBe(KEY);
    expect(localStorage.getItem(KEY)).toBe("1");
  });

  it("keeps the in-memory value when storage writes fail", () => {
    active = renderProvider();
    act(() => capturedValue?.setCollapseScope(KEY));
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
    act(() => capturedValue?.setCollapsed(true));
    spy.mockRestore();
    expect(capturedValue?.collapsed).toBe(true);
  });

  it("never collapses on mobile", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 500 });
    localStorage.setItem(SIDEBAR_COLLAPSE_HINT_KEY, KEY);
    localStorage.setItem(KEY, "1");
    active = renderProvider();

    expect(capturedValue?.isMobile).toBe(true);
    expect(capturedValue?.collapsed).toBe(false);
  });

  it("ignores peeking, force and route requests for collapse", () => {
    active = renderProvider();

    act(() => capturedValue?.setForceCollapsed(true));
    act(() => capturedValue?.setRouteRequestsCollapsed(true));
    act(() => capturedValue?.setPeeking(true));

    expect(capturedValue?.forceCollapsed).toBe(true);
    expect(capturedValue?.routeRequestsCollapsed).toBe(true);
    expect(capturedValue?.collapsed).toBe(false);
    expect(capturedValue?.peeking).toBe(false);
    expect(capturedValue?.collapseLocked).toBe(false);
  });

  it("retains sidebarOpen and toggleSidebar for the mobile drawer", () => {
    active = renderProvider();
    const initial = capturedValue?.sidebarOpen;

    act(() => capturedValue?.toggleSidebar());

    expect(capturedValue?.sidebarOpen).toBe(!initial);
  });
});
