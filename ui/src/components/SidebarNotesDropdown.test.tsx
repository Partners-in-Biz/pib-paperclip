// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarNotesDropdown } from "./SidebarNotesDropdown";

const openNewNoteMock = vi.fn();

vi.mock("@/lib/router", () => ({
  NavLink: ({
    to,
    children,
    className,
    ...props
  }: {
    to: string;
    children: ReactNode;
    className?: string | ((state: { isActive: boolean }) => string);
  }) => (
    <a
      href={to}
      className={typeof className === "function" ? className({ isActive: false }) : className}
      {...props}
    >
      {children}
    </a>
  ),
}));

vi.mock("@/context/DialogContext", () => ({
  useDialogActions: () => ({
    openNewNote: openNewNoteMock,
  }),
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({
    collapsed: false,
    peeking: false,
    isMobile: false,
    setSidebarOpen: vi.fn(),
  }),
}));

describe("SidebarNotesDropdown", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    openNewNoteMock.mockReset();
  });

  afterEach(() => {
    container.remove();
  });

  it("expands to show Note list, Planning Canvas, and New note actions", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<SidebarNotesDropdown coordinator />);
    });

    const trigger = container.querySelector('button[aria-label="Notes menu"]') as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('a[href="/notes"]')).toBeNull();

    act(() => {
      trigger?.click();
    });

    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('a[href="/notes"]')?.textContent).toContain("Note list");
    expect(container.querySelector('a[href="/planning-canvas"]')?.textContent).toContain("Planning Canvas");

    const inlineNewNoteBtn = container.querySelector('button[aria-label="New note"]') as HTMLButtonElement | null;
    expect(inlineNewNoteBtn).not.toBeNull();
    act(() => {
      inlineNewNoteBtn?.click();
    });
    expect(openNewNoteMock).toHaveBeenCalledTimes(1);

    const dropdownNewNoteBtn = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "New note",
    );
    expect(dropdownNewNoteBtn).toBeDefined();
    act(() => {
      dropdownNewNoteBtn?.click();
    });
    expect(openNewNoteMock).toHaveBeenCalledTimes(2);

    act(() => {
      root.unmount();
    });
  });
});
