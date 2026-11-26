import { OptionSelect } from "@/components/OptionSelect";
import type { ReactNode } from "react";
import { TabBar, type TabSize } from "./TabBar";
import { useSidebar } from "../context/SidebarContext";

export interface PageTabItem {
  value: string;
  label: ReactNode;
}

interface PageTabBarProps {
  items: readonly PageTabItem[];
  value?: string;
  onValueChange?: (value: string) => void;
  align?: "center" | "start";
  size?: TabSize;
}

export function PageTabBar({ items, value, onValueChange, align = "center", size = "standard" }: PageTabBarProps) {
  const { isMobile } = useSidebar();

  if (isMobile && value !== undefined && onValueChange) {
    return (
      <OptionSelect
        ariaLabel="Page section"
        value={value}
        placeholder="Page section"
        searchPlaceholder="Search sections…"
        items={items.map((item) => ({ value: item.value, label: typeof item.label === "string" ? item.label : item.value }))}
        onChange={onValueChange}
        className="w-auto min-w-40"
        triggerClassName="h-9 text-base font-normal"
      />
    );
  }

  return (
    <TabBar items={items} size={size} className={align === "start" ? "justify-start" : undefined} />
  );
}
