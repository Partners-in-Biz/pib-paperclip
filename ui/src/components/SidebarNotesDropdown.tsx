import { useState } from "react";
import { ChevronRight, FileText, NotebookPen, PenTool, Plus } from "lucide-react";
import { NavLink } from "@/lib/router";
import { useDialogActions } from "@/context/DialogContext";
import { useSidebar } from "@/context/SidebarContext";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "@/lib/utils";
import { Flyout, FlyoutContent, FlyoutTrigger } from "./ui/flyout";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface SidebarNotesDropdownProps {
  /** Match CoordinatorSidebar styling when true, or ClassicSidebar styling when false. */
  coordinator?: boolean;
}

export function SidebarNotesDropdown({ coordinator = false }: SidebarNotesDropdownProps) {
  const { openNewNote } = useDialogActions();
  const { collapsed, peeking, isMobile, setSidebarOpen } = useSidebar();
  const rail = collapsed && !peeking;

  const initialOpen =
    typeof window !== "undefined" &&
    /\/(notes|planning-canvas)(\/|$)/.test(window.location.pathname);
  const [open, setOpen] = useState(initialOpen);
  const [flyoutOpen, setFlyoutOpen] = useState(false);

  function closeMobileIfNeeded() {
    if (isMobile) setSidebarOpen(false);
  }

  function handleNewNote() {
    openNewNote?.();
  }

  if (rail) {
    return (
      <Flyout open={flyoutOpen} onOpenChange={setFlyoutOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <FlyoutTrigger asChild>
              <button
                type="button"
                aria-label="Notes"
                className={cn(
                  coordinator
                    ? "design-sidebar-item flex w-auto items-center gap-2.5 rounded-lg py-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring"
                    : "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 text-(length:--text-compact) font-medium text-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                )}
              >
                <NotebookPen className="size-4 shrink-0" />
                <span className={SIDEBAR_RAIL_HIDDEN_LABEL}>Notes</span>
              </button>
            </FlyoutTrigger>
          </TooltipTrigger>
          <TooltipContent side="right">Notes</TooltipContent>
        </Tooltip>

        <FlyoutContent
          side={isMobile ? "bottom" : "right"}
          align="start"
          className="w-56 p-1"
          aria-label="Notes menu"
        >
          <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Notes
          </div>
          <div className="group/note-item relative flex items-center rounded-sm transition-colors hover:bg-accent">
            <NavLink
              to="/notes"
              onClick={() => {
                setFlyoutOpen(false);
                closeMobileIfNeeded();
              }}
              className={({ isActive }) =>
                cn(
                  "flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 pr-9 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isActive && "font-medium text-foreground",
                )
              }
            >
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              Note list
            </NavLink>
            <button
              type="button"
              aria-label="New note"
              title="New note"
              onClick={() => {
                setFlyoutOpen(false);
                handleNewNote();
              }}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus className="size-3.5" />
            </button>
          </div>

          <NavLink
            to="/planning-canvas"
            onClick={() => {
              setFlyoutOpen(false);
              closeMobileIfNeeded();
            }}
            className={({ isActive }) =>
              cn(
                "flex items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isActive && "bg-accent font-medium text-foreground",
              )
            }
          >
            <span className="flex items-center gap-2">
              <PenTool className="size-4 shrink-0 text-muted-foreground" />
              Planning Canvas
            </span>
          </NavLink>

          <div role="separator" className="my-1 border-t border-border" />
          <button
            type="button"
            onClick={() => {
              setFlyoutOpen(false);
              handleNewNote();
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="size-4 shrink-0 text-muted-foreground" />
            New note
          </button>
        </FlyoutContent>
      </Flyout>
    );
  }

  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-label="Notes menu"
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          coordinator
            ? "design-sidebar-item flex w-auto items-center justify-between gap-2 rounded-lg py-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring"
            : "flex items-center justify-between gap-2 mx-2 rounded-lg px-2 py-1.5 pointer-coarse:py-1 text-(length:--text-compact) font-medium text-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <NotebookPen className="size-4 shrink-0" />
          <span className="truncate">Notes</span>
        </span>
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
            open && "rotate-90",
          )}
        />
      </button>

      {open ? (
        <div className="ml-5 mr-2 mt-0.5 flex flex-col gap-0.5 border-l border-border/70 pl-2">
          {/* 1. Note list with inline hover + button (just like Tasks) */}
          <div className="group/note-list relative flex items-center">
            <NavLink
              to="/notes"
              onClick={closeMobileIfNeeded}
              className={({ isActive }) =>
                cn(
                  "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 pr-8 text-(length:--text-compact) font-medium transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-foreground/80",
                )
              }
            >
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">Note list</span>
            </NavLink>
            <button
              type="button"
              aria-label="New note"
              title="New note"
              onClick={handleNewNote}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity group-hover/note-list:opacity-100 group-focus-within/note-list:opacity-100 pointer-coarse:opacity-100 hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus className="size-3.5" />
            </button>
          </div>

          {/* 2. Planning Canvas */}
          <NavLink
            to="/planning-canvas"
            onClick={closeMobileIfNeeded}
            className={({ isActive }) =>
              cn(
                "flex min-w-0 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-(length:--text-compact) font-medium transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-foreground/80",
              )
            }
          >
            <span className="flex min-w-0 items-center gap-2">
              <PenTool className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">Planning Canvas</span>
            </span>
          </NavLink>

          {/* Direct Create Note button inside the dropdown */}
          <button
            type="button"
            onClick={handleNewNote}
            className="mt-0.5 flex items-center gap-2 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="size-3.5 shrink-0" />
            <span className="truncate">New note</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
