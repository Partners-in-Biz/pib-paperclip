import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Shared body of the issue, agent, project and goal cards. */
export function RefCard({ label, icon, children }: { label: string; icon: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex h-full min-w-0 flex-col gap-1.5 overflow-hidden p-3">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      {children}
    </div>
  );
}

export function RefLoading() {
  return <p className="text-xs text-muted-foreground">Loading…</p>;
}

/** A ref the reader may not read, or one that no longer exists: nothing but this line is shown. */
export function RefNoAccess({ className }: { className?: string }) {
  return <p className={cn("text-sm font-medium text-muted-foreground", className)}>No access</p>;
}

export const REF_CARD_CLASS = "flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-md";
